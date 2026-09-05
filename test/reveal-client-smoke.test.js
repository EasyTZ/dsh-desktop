'use strict';

// dsh 0.1.2 把 workspace store 改成了依赖 `this` 的方法。React 调用
// useSyncExternalStore 的参数时不会保留对象接收者；这里真实渲染一次按钮，守住
// 「插件必须包一层再调用外部 store」这条兼容性边界。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeReact } = require('./helpers/fake-react');

const CLIENT = path.join(__dirname, '..', 'node_modules', '@easytz', 'dsh-reveal-explorer', 'lib', 'client.js');

test('reveal 客户端兼容依赖 this 的 workspace store', () => {
  const src = fs.readFileSync(CLIENT, 'utf8');
  const registrations = [];
  const captured = {};
  const injected = {};
  const styleTag = { dataset: {}, textContent: '' };
  Object.assign(globalThis, {
    window: { __ModuleLoader__: { load(reg) { registrations.push(reg); } } },
    document: {
      querySelector: () => null,
      createElement: () => styleTag,
      head: { appendChild() {} },
    },
  });

  try {
    const { jsxRuntime, hooks } = createFakeReact();
    const fakeRequire = (id) => {
      if (id === 'react/jsx-runtime') return jsxRuntime;
      if (id === 'react') return hooks;
      throw new Error(`unexpected require: ${id}`);
    };
    // eslint-disable-next-line no-eval
    eval(src);
    const mod = registrations[0].factory(fakeRequire);
    const workspaceStore = {
      value: { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }] },
      subscribe() { assert.ok(this.value); return () => {}; },
      getSnapshot() { return this.value; },
    };
    const ctx = {
      effect: () => () => {},
      locale: { register() {} },
      workspaces: { list: workspaceStore },
      slots: {
        inject: (_name, fn) => { fn(); return () => {}; },
        register: (opts, component) => {
          captured[opts.id] = component;
          injected[opts.id] = opts.inject();
          return () => {};
        },
      },
    };
    mod.apply(ctx);
    const button = captured['reveal-explorer'];
    assert.ok(button, '应注册会话头部按钮');
    assert.doesNotThrow(() => button({ sessionId: 's1', t: (key) => key, ...injected['reveal-explorer'] }));
  } finally {
    Object.assign(globalThis, { window: undefined, document: undefined });
  }
});
