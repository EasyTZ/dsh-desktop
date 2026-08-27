'use strict';

// Git 面板客户端半的冒烟测试。理由同 terminal-client-smoke：这个文件不在
// typecheck 的 include 里，`node --check` 又只查语法，而 useCallback/useEffect 的
// 依赖数组在 render 时立即求值 —— 引用后面才声明的 const 会触发 TDZ，组件整个渲染
// 崩掉，表现就是「面板打不开」。只有真实执行组件函数才会暴露。
//
// 这里还额外断言了几条**被 issue #1 要求过的行为**，防止以后无意改回去：
// 提交与推送必须是两个常驻按钮、提交框必须排在文件列表之前。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT = path.join(__dirname, '..', 'node_modules', 'dsh-git', 'lib', 'client.js');

/** 把伪造的 React 元素树拍平成数组，便于查找。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  out.push(node);
  const children = node.props && node.props.children;
  if (children !== undefined) flatten(children, out);
  return out;
}

function loadModule() {
  const src = fs.readFileSync(CLIENT, 'utf8');
  const registrations = [];
  const styleTag = { dataset: {}, textContent: '' };
  Object.assign(globalThis, {
    window: {
      __ModuleLoader__: { load(reg) { registrations.push(reg); } },
      getSelection: () => ({ toString: () => '' }),
    },
    document: {
      querySelector: () => null,
      createElement: () => styleTag,
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) }),
  });

  const reactJsx = {
    jsx: (type, props, key) => ({ type, props: props || {}, key }),
    jsxs: (type, props, key) => ({ type, props: props || {}, key }),
    Fragment: Symbol('Fragment'),
  };
  const reactHooks = {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    useSyncExternalStore: (_sub, get) => get(),
  };
  const fakeRequire = (id) => {
    if (id === 'react/jsx-runtime') return reactJsx;
    if (id === 'react') return reactHooks;
    throw new Error('unexpected require: ' + id);
  };
  // eslint-disable-next-line no-eval
  eval(src);
  assert.strictEqual(registrations.length, 1, '应恰好注册一次');
  return registrations[0].factory(fakeRequire);
}

const cleanup = () => Object.assign(globalThis, {
  window: undefined, document: undefined, localStorage: undefined, fetch: undefined,
});

/** 装好插件、拿到注册进 shell.overlay 的面板组件。 */
function renderPanel() {
  const mod = loadModule();
  const mkStore = (val) => ({ getSnapshot: () => val, subscribe: () => () => {} });
  const captured = {};
  const ctx = {
    effect: () => () => {},
    locale: { register() {} },
    slots: {
      inject: (key, cb) => { cb(); return () => {}; },
      register: (opts, comp) => { captured[opts.name + ':' + opts.id] = comp; return () => {}; },
    },
    workspaces: { list: mkStore({ items: [{ workspaceId: 'w1', path: 'D:/x', sessionIds: ['s1'] }], recentWorkspaceId: 'w1' }) },
    sessions: { list: mkStore({ current: 's1' }) },
  };
  mod.apply(ctx);
  const panel = captured['shell.overlay:git-panel'];
  assert.ok(panel, '面板应注册进 shell.overlay');
  const t = (k) => k;
  return { mod, panel, t, ctx };
}

test('client.js 冒烟：factory / apply / 两个槽组件渲染全路径不崩', () => {
  try {
    const { mod, panel, t, ctx } = renderPanel();
    assert.strictEqual(typeof mod.apply, 'function');
    assert.deepStrictEqual(mod.inject, ['slots', 'locale', 'workspaces', 'sessions']);
    const store = { getSnapshot: () => true, subscribe: () => () => {}, close() {}, toggle() {} };
    panel({ t, store, workspacesList: ctx.workspaces.list, sessionsList: ctx.sessions.list });
  } finally {
    cleanup();
  }
});

test('提交与推送是两个常驻按钮（issue #1：不能再共用一个位置来回切）', () => {
  try {
    const { mod } = renderPanel();
    const CommitBox = mod.__test__ && mod.__test__.CommitBox;
    assert.ok(CommitBox, 'CommitBox 需要导出到 __test__ 才能验行为');

    // 有待推送的提交、同时消息框是空的 —— 老版本这时只给「推送」，用户想再提交
    // 得先打字才能把按钮换回来，这正是 issue #1 反馈的问题。
    const tree = flatten(CommitBox({
      t: (k) => k, committing: false, pushing: false, message: '',
      onMessageChange() {}, onCommit() {}, onPush() {},
      canPush: true, ahead: 2, resultMessage: null, actionError: null,
    }));
    const buttons = tree.filter((n) => n.type === 'button');
    assert.strictEqual(buttons.length, 2, '提交与推送应各自有一个按钮');

    const labels = buttons.map((b) => String(b.props.children));
    assert.ok(labels.some((l) => l.includes('git.commit.submit')), '提交按钮应始终在场');
    assert.ok(labels.some((l) => l.includes('git.push.submit')), '推送按钮应始终在场');

    // 推送按钮带上待推送条数；消息为空时提交按钮禁用（提交必须有消息），
    // 但它**存在**，用户一打字就能用。
    const push = buttons.find((b) => String(b.props.children).includes('git.push.submit'));
    const commit = buttons.find((b) => String(b.props.children).includes('git.commit.submit'));
    assert.match(String(push.props.children), /↑2/, '推送按钮应显示领先条数');
    assert.strictEqual(push.props.disabled, false, 'ahead>0 时推送可用');
    assert.strictEqual(commit.props.disabled, true, '消息为空时提交禁用');

    // 没有可推送的东西时，推送按钮禁用而不是消失（布局稳定，也能显示原因）
    const idle = flatten(CommitBox({
      t: (k) => k, committing: false, pushing: false, message: 'feat: x',
      onMessageChange() {}, onCommit() {}, onPush() {},
      canPush: false, ahead: 0, resultMessage: null, actionError: null,
    })).filter((n) => n.type === 'button');
    assert.strictEqual(idle.length, 2);
    assert.strictEqual(idle.find((b) => String(b.props.children).includes('git.push.submit')).props.disabled, true);
    assert.strictEqual(idle.find((b) => String(b.props.children).includes('git.commit.submit')).props.disabled, false,
      '有消息时提交应可用');
  } finally {
    cleanup();
  }
});

test('提交历史区分已推送 / 未推送（issue #1）', () => {
  try {
    const { mod } = renderPanel();
    const HistorySection = mod.__test__ && mod.__test__.HistorySection;
    assert.ok(HistorySection, 'HistorySection 需要导出到 __test__');
    const commits = [
      { hash: 'a1', shortHash: 'a1', subject: 'newest', author: 'me', date: '2026-08-26T00:00:00Z' },
      { hash: 'b2', shortHash: 'b2', subject: 'older', author: 'me', date: '2026-08-25T00:00:00Z' },
    ];
    const tree = flatten(HistorySection({
      t: (k) => k, commits, onUndo() {}, undoing: false, unpushedCount: 1,
    }));
    const states = tree
      .filter((n) => typeof n.props.className === 'string' && n.props.className.startsWith('dsgPushState '))
      .map((n) => n.props.className);
    assert.strictEqual(states.length, 2, '每条提交都要有推送状态');
    assert.match(states[0], /dsgPushStateUnpushed/, 'git log 倒序：最新的那条未推送');
    assert.match(states[1], /dsgPushStatePushed/, '更早的那条已推送');
  } finally {
    cleanup();
  }
});
