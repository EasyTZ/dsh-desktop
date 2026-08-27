'use strict';

// 插件管理面板客户端半的冒烟测试。理由同 terminal/git 两个 smoke：
// client.js 不在 typecheck 的 include 里，node --check 只查语法，而
// useCallback/useEffect 的依赖数组在 render 时立即求值——引用后面才声明的
// const 会触发 TDZ，组件整个渲染崩溃，表现就是「桌面插件标签页打不开」。
// 只有真实执行组件函数才会暴露。
//
// 这里还钉住两条产品要求（任务书 A.4）：
//   1) 有关掉的插件时 UI 必须提示「切换后重启生效」并提供重启按钮；
//   2) 管理面板自身不可关（自锁会拿走用户唯一的开关入口）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT = path.join(__dirname, '..', 'plugins', 'dsh-plugin-manager', 'lib', 'client.js');

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
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: { plugins: [] } }) }),
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
  window: undefined, document: undefined, fetch: undefined,
});

/** 装好插件、拿到注册进 settings.plugins.tab 的标签页组件。 */
function applyModule() {
  const mod = loadModule();
  const captured = {};
  const ctx = {
    effect: () => () => {},
    locale: { register() {}, bind: (ns) => (key) => `${ns}.${key}` },
    slots: {
      inject: (key, cb) => { cb(); return () => {}; },
      register: (opts, comp) => { captured[opts.name + ':' + opts.id] = comp; return () => {}; },
    },
  };
  mod.apply(ctx);
  const tab = captured['settings.plugins.tab:desktop'];
  assert.ok(tab, '标签页应注册进 settings.plugins.tab');
  return { mod, tab };
}

const t = (k) => (k.includes('pendingHint') ? 'pendingHint {n}' : k);
const PLUGINS = [
  { entryId: 'plugin-manager', packageName: 'dsh-plugin-manager', description: 'desc', version: '0.1.0', active: true, initialActive: true, self: true },
  { entryId: 'git', packageName: 'dsh-git', description: 'Git panel', version: '0.1.0', active: true, initialActive: true, self: false },
  { entryId: 'balance', packageName: 'dsh-ui-balance', description: null, version: null, active: false, initialActive: true, self: false },
];

test('client.js 冒烟：factory / apply / 标签页组件渲染全路径不崩', () => {
  try {
    const { mod, tab } = applyModule();
    assert.deepStrictEqual(mod.inject, ['slots', 'locale']);
    // 初始 state 是 loading，真实跑一遍标签页组件的最外层渲染路径。
    tab({ t });
  } finally {
    cleanup();
  }
});

test('安全模式下必须给出提示条，否则用户只看到一列「未激活」', () => {
  try {
    const { mod } = applyModule();
    const { PluginList } = mod.__test__;
    const base = {
      t, plugins: PLUGINS, pendingCount: 0, canRestart: true,
      busyId: null, error: null, onToggle() {}, onRestart() {},
    };

    const safe = flatten(PluginList({ ...base, safeMode: true }));
    const banner = safe.find((n) => String(n.props.children).includes('safeMode'));
    assert.ok(banner, '安全模式下必须渲染提示条');
    assert.strictEqual(banner.props.role, 'status', '提示条要能被读屏软件念出来');

    // 正常模式不能出现这条 —— 平时挂个「安全模式」横幅会把用户吓一跳。
    const normal = flatten(PluginList({ ...base, safeMode: false }));
    assert.ok(!normal.find((n) => String(n.props.children).includes('safeMode')),
      '非安全模式下不该出现安全模式提示条');
  } finally {
    cleanup();
  }
});

test('有待生效的改动时必须提示重启并给重启按钮（任务书 A.4）', () => {
  try {
    const { mod } = applyModule();
    const { PluginList } = mod.__test__;
    assert.ok(PluginList, 'PluginList 需要导出到 __test__ 才能验行为');

    // balance 被用户关掉（active:false ≠ initialActive:true）→ 1 项待生效。
    const pending = flatten(PluginList({
      t, plugins: PLUGINS, pendingCount: 1, canRestart: true,
      busyId: null, error: null, onToggle() {}, onRestart() {},
    }));
    const hint = pending.find((n) => String(n.props.children).includes('pendingHint'));
    assert.ok(hint, '应有「N 项改动待重启」提示');
    assert.match(String(hint.props.children), /1/, '待生效计数要显示出来');
    const restartBtn = pending.find((n) => n.type === 'button' && String(n.props.children).includes('restart'));
    assert.ok(restartBtn, '有改动时必须提供重启按钮');

    // 没有改动：按钮消失、给出「已同步」的静默信号。
    const synced = flatten(PluginList({
      t, plugins: PLUGINS.map((p) => ({ ...p, active: p.initialActive })), pendingCount: 0,
      canRestart: true, busyId: null, error: null, onToggle() {}, onRestart() {},
    }));
    assert.ok(synced.find((n) => String(n.props.children).includes('noPending')), '无改动时应显示「没有待生效的改动」');
    assert.strictEqual(synced.filter((n) => n.type === 'button' && String(n.props.children).includes('restart')).length, 0,
      '没有待生效改动时不给重启按钮');
  } finally {
    cleanup();
  }
});

test('管理面板自身不可关：自锁行没有开关，其余行有开关', () => {
  try {
    const { mod } = applyModule();
    const { PluginList, PluginRow, Switch } = mod.__test__;

    // 列表整体：3 个插件对应 3 行（伪 jsx 不展开自定义组件，按元素类型数）。
    const listTree = flatten(PluginList({
      t, plugins: PLUGINS, pendingCount: 0, canRestart: true,
      busyId: null, error: null, onToggle() {}, onRestart() {},
    }));
    assert.strictEqual(listTree.filter((n) => n.type === PluginRow).length, 3);

    // 自身那一行：明确的「不可关」标记，且没有开关。
    const selfTree = flatten(PluginRow({ t, plugin: PLUGINS[0], busy: false, onToggle() {} }));
    assert.ok(selfTree.find((n) => typeof n.props.className === 'string' && n.props.className === 'dspmSelfLocked'),
      '自锁行要有明确的「不可关」标记');
    assert.strictEqual(selfTree.filter((n) => n.type === Switch).length, 0, '自锁行不该有开关');

    // 被用户关掉的行：开关语义为关闭态。
    const offTree = flatten(PluginRow({ t, plugin: PLUGINS[2], busy: false, onToggle() {} }));
    const offSwitch = offTree.find((n) => n.type === Switch);
    assert.ok(offSwitch, '普通行要有开关');
    assert.strictEqual(offSwitch.props.on, false);

    // 正常打开的行：开关语义为开启态。
    const onTree = flatten(PluginRow({ t, plugin: PLUGINS[1], busy: false, onToggle() {} }));
    assert.strictEqual(onTree.find((n) => n.type === Switch).props.on, true);

    // 真跑一遍 Switch 组件的渲染路径：role/aria/data-on 是可达性语义的载体。
    const swTree = flatten(Switch({ on: false, disabled: false, label: 'x', onChange() {} }));
    const btn = swTree.find((n) => n.type === 'button');
    assert.ok(btn, 'Switch 要渲染成一个 button');
    assert.strictEqual(btn.props.role, 'switch');
    assert.strictEqual(btn.props['aria-checked'], false);
    assert.strictEqual(btn.props['data-on'], 'false');
  } finally {
    cleanup();
  }
});
