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

// ── 提交详情弹窗 ────────────────────────────────────────────────────────────

const DETAIL_DATA = {
  hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  shortHash: 'a1b2c3d',
  author: '我', email: 'me@example.com', date: '2026-08-27T10:11:12+08:00',
  subject: '第一行标题',
  body: '第二段正文\n\n第三段正文',
  files: [
    { path: 'src/a.js', from: null, status: 'M', insertions: 12, deletions: 3, binary: false },
    { path: 'src/new.js', from: null, status: 'A', insertions: 40, deletions: 0, binary: false },
    { path: 'docs/b.png', from: null, status: 'A', insertions: null, deletions: null, binary: true },
    { path: 'src/moved.js', from: 'src/old.js', status: 'R', insertions: 1, deletions: 1, binary: false },
  ],
  totals: { files: 4, insertions: 53, deletions: 4 },
};

test('提交行可点开详情，且键盘也能触发', () => {
  try {
    const { mod } = renderPanel();
    const { HistorySection } = mod.__test__;
    const opened = [];
    const commits = [{ hash: 'a1', shortHash: 'a1', subject: 's', author: 'me', date: '2026-08-26T00:00:00Z' }];
    const rows = flatten(HistorySection({
      t: (k) => k, commits, onUndo() {}, undoing: false, unpushedCount: 0,
      onOpenDetail: (c) => opened.push(c.hash),
    })).filter((n) => n.props.className === 'dsgHistoryRow');

    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    // 只挂 onClick 的 div 键盘用户够不到，这三件套缺一不可。
    assert.strictEqual(row.props.role, 'button', '行要能被识别成按钮');
    assert.strictEqual(row.props.tabIndex, 0, '行要能被 Tab 聚焦');
    row.props.onClick();
    assert.deepStrictEqual(opened, ['a1'], '点击应打开详情');
    row.props.onKeyDown({ key: 'Enter', preventDefault() {} });
    row.props.onKeyDown({ key: ' ', preventDefault() {} });
    assert.deepStrictEqual(opened, ['a1', 'a1', 'a1'], 'Enter / 空格都要能打开');
    let ignored = opened.length;
    row.props.onKeyDown({ key: 'a', preventDefault() {} });
    assert.strictEqual(opened.length, ignored, '其它按键不该触发');
  } finally {
    cleanup();
  }
});

test('详情弹窗：完整信息 + 文件清单 + 汇总', () => {
  try {
    const { mod } = renderPanel();
    const { CommitDetailDialog } = mod.__test__;
    assert.ok(CommitDetailDialog, 'CommitDetailDialog 需要导出到 __test__');
    const tree = flatten(CommitDetailDialog({
      t: (k) => k, state: { commit: { hash: DETAIL_DATA.hash }, status: 'ready', data: DETAIL_DATA },
      onClose() {}, onRetry() {},
    }));

    // 这个功能的起点就是「只看得见第一行」，所以正文必须出现在弹窗里。
    const msg = tree.find((n) => n.props.className === 'dsgDetailMsg');
    assert.ok(msg, '应有提交信息块');
    assert.match(String(msg.props.children), /第一行标题/);
    assert.match(String(msg.props.children), /第三段正文/, '正文（不只第一行）必须显示');

    // 文件行是子组件，假 React 不会替我们调用它——自己找出来再展开。
    const { CommitFileRow } = mod.__test__;
    const rows = tree.filter((n) => n.type === CommitFileRow);
    assert.strictEqual(rows.length, 4, '四个文件都要列出来');

    const rendered = rows.map((r) => flatten(CommitFileRow(r.props)));
    const pathOf = (nodes) => JSON.stringify(
      nodes.find((n) => n.props.className === 'dsgDetailPath').props.children);
    assert.ok(rendered.some((n) => pathOf(n).includes('src/old.js') && pathOf(n).includes('src/moved.js')),
      '重命名要显示「从哪来 → 到哪去」，只显示新名字等于丢了一半信息');

    // 二进制文件没有行数概念，不能显示成 +0 −0（那会被当成「没改动」）。
    const binary = rendered.find((n) => pathOf(n).includes('docs/b.png'));
    assert.ok(binary, '二进制文件那一行要渲染出来');
    const binaryStat = binary.find((n) => n.props.className === 'dsgDetailStat');
    assert.match(JSON.stringify(binaryStat.props.children), /git\.detail\.binary/,
      '二进制文件要标注出来，而不是显示 +0 −0');

    // 汇总（N 个文件 +X −Y）要出现，否则得自己数。
    assert.ok(tree.some((n) => n.props.className === 'dsgDetailSubCount'), '应有改动汇总');
  } finally {
    cleanup();
  }
});

test('详情弹窗：三个关闭出口都在（×、Esc、点遮罩）', () => {
  try {
    const { mod } = renderPanel();
    const { CommitDetailDialog } = mod.__test__;
    let closed = 0;
    const state = { commit: { hash: DETAIL_DATA.hash }, status: 'ready', data: DETAIL_DATA };
    const tree = flatten(CommitDetailDialog({ t: (k) => k, state, onClose: () => { closed += 1; }, onRetry() {} }));

    const mask = tree.find((n) => n.props.className === 'dsgDetailMask');
    assert.ok(mask, '应有遮罩');
    // 点遮罩自身关闭；点卡片内部（冒泡上来的）不能关。
    mask.props.onClick({ target: 'MASK', currentTarget: 'MASK' });
    assert.strictEqual(closed, 1, '点遮罩应关闭');
    mask.props.onClick({ target: 'CARD', currentTarget: 'MASK' });
    assert.strictEqual(closed, 1, '点卡片内部不该关闭');

    const closeBtn = tree.find((n) => n.props.className === 'dsgDetailClose');
    assert.ok(closeBtn, '应有关闭按钮');
    closeBtn.props.onClick();
    assert.strictEqual(closed, 2, '× 应关闭');

    const card = tree.find((n) => n.props.className === 'dsgDetailCard');
    assert.strictEqual(card.props.role, 'dialog');
    assert.strictEqual(card.props['aria-modal'], 'true');
  } finally {
    cleanup();
  }
});

test('详情弹窗：加载中与失败态都渲染得出来（失败时给重试）', () => {
  try {
    const { mod } = renderPanel();
    const { CommitDetailDialog } = mod.__test__;
    const commit = { hash: DETAIL_DATA.hash };

    const loading = flatten(CommitDetailDialog({
      t: (k) => k, state: { commit, status: 'loading' }, onClose() {}, onRetry() {},
    }));
    assert.ok(loading.some((n) => String(n.props.children).includes('git.detail.loading')));

    let retried = 0;
    const error = flatten(CommitDetailDialog({
      t: (k) => k, state: { commit, status: 'error', message: '炸了' },
      onClose() {}, onRetry: () => { retried += 1; },
    }));
    assert.ok(error.some((n) => String(n.props.children).includes('炸了')), '错误原因要显示出来');
    const retryBtn = error.find((n) => n.type === 'button' && String(n.props.children).includes('git.detail.retry'));
    assert.ok(retryBtn, '失败时要给重试入口');
    retryBtn.props.onClick();
    assert.strictEqual(retried, 1);
  } finally {
    cleanup();
  }
});
