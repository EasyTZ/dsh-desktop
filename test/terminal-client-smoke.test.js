'use strict';

// 客户端插件冒烟测试：在 node 里伪造浏览器全局与 React，真实执行
// node_modules/@easytz/dsh-terminal-panel/lib/client.js（插件已拆仓，git 依赖 vendor）
// 的 factory、apply() 和组件渲染路径。
//
// 为什么需要它：client.js 不在 typecheck 的 include 里，node --check 只查语法，
// 而 useCallback/useEffect 的依赖数组在 render 时立即求值 —— 引用一个「后面才
// 声明的 const」会触发 TDZ，组件整个渲染崩溃，表现就是「终端面板打不开」。
// 这种运行时错误只有真实执行组件函数才能暴露，这个测试就是那道防线。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT = path.join(__dirname, '..', 'node_modules', '@easytz', 'dsh-terminal-panel', 'lib', 'client.js');

test('client.js 冒烟：factory/apply/组件渲染全路径不崩', () => {
  const src = fs.readFileSync(CLIENT, 'utf8');

  // —— 伪造浏览器全局 ——
  const styleTag = { dataset: {}, textContent: '' };
  const registrations = [];
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
      activeElement: null,
    },
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => 0,
  });
  // node --test 按文件隔离进程，这里仍把伪造的全局清掉，防同进程复用污染。
  const cleanup = () => Object.assign(globalThis, {
    window: undefined, document: undefined, localStorage: undefined, requestAnimationFrame: undefined,
  });

  try {
    // —— 伪造 React ——
    const reactJsx = {
      jsx: (type, props, key) => ({ type, props: props || {}, key }),
      jsxs: (type, props, key) => ({ type, props: props || {}, key }),
      Fragment: Symbol('Fragment'),
    };
    const reactHooks = {
      // 让 mounted/maximized 等初始 false 的 state 变 true，强制走「面板打开」渲染路径
      useState: (init) => [init === false ? true : (init ?? true), () => {}],
      useCallback: (fn) => fn,
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useRef: (init) => ({ current: init }),
      useReducer: (reducer, init) => [init, () => {}],
      useSyncExternalStore: (_sub, get) => get(),
    };
    const fakeRequire = (id) => {
      if (id === 'react/jsx-runtime') return reactJsx;
      if (id === 'react') return reactHooks;
      throw new Error('unexpected require: ' + id);
    };

    // —— 执行 factory ——
    // eslint-disable-next-line no-eval
    eval(src);
    assert.strictEqual(registrations.length, 1, '应恰好注册一次');
    const mod = registrations[0].factory(fakeRequire);
    assert.strictEqual(typeof mod.apply, 'function');
    assert.ok(Array.isArray(mod.inject));
    assert.deepStrictEqual(mod.inject, ['slots', 'locale', 'workspaces', 'sessions', 'theme']);

    // —— 伪造 ctx，捕获槽注册的组件 ——
    const mkStore = (val) => ({ getSnapshot: () => val, subscribe: () => () => {} });
    const captured = {};
    const ctx = {
      effect: () => () => {},
      locale: { register() {} },
      on: () => () => {},
      theme: { getTheme: () => ({ active: { colorScheme: 'dark' } }) },
      workspaces: { list: mkStore({ items: [], recentWorkspaceId: null }) },
      sessions: { list: mkStore({ current: undefined, ids: [], byId: {} }) },
      slots: {
        inject: (key, cb) => { cb(); return () => {}; },
        register: (opts, comp) => { captured[opts.name + ':' + opts.id] = comp; return () => {}; },
      },
    };
    mod.apply(ctx);
    const footerComp = captured['sidebar.footer.action:terminal-panel'];
    const panelComp = captured['shell.overlay:terminal-panel-overlay'];
    assert.ok(footerComp && panelComp, '两个槽的组件都应被注册');

    // —— 渲染（wide 两态 + 面板打开态，覆盖 TerminalPanelBody 全路径）——
    const t = (k) => k;
    footerComp({ wide: true, t, store: mkStore(true), badgeStore: mkStore(false) });
    footerComp({ wide: false, t, store: mkStore(false), badgeStore: mkStore(true) });
    const panelProps = {
      t,
      open: true,
      dark: true,
      store: mkStore(true),
      badgeStore: mkStore(false),
      themeStore: mkStore('dark'),
      workspacesList: ctx.workspaces.list,
      sessionsList: ctx.sessions.list,
    };
    panelComp(panelProps); // 有 view 的路径
    panelComp({ ...panelProps }); // 空态路径
  } finally {
    cleanup();
  }
});
