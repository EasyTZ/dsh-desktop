'use strict';

// 每个 vendor 进来的插件，浏览器半的产物**能不能加载**。
//
// 这条测试补的是删掉 terminal-client-smoke.test.js 之后留下的那个缺口。各插件仓库
// 自己的 client-smoke 测的是**工作副本**，而安装包里装的是 `package.json` 钉住的
// 那个 tag 拉下来的产物 —— 两者相等是个假设，不是事实：tag 从脏工作区上切、
// `files` 字段漏了文件、vendor 过程中截断，都会让这份产物和插件仓库里绿着的那份
// 不是一个东西。只有主仓库同时 vendor 了全部五个，能一次把这个假设验一遍。
//
// **刻意只验到「加载得出来」为止**：往下的组件渲染要复刻五套各不相同的 props
// 契约，那份契约住在插件仓库里，抄一份到这边只会在每次插件改 props 时把这个仓库
// 也拖红——痛点落错了地方。组件级的 TDZ / 渲染崩溃由各插件仓库的 client-smoke 守，
// 这里守的是「装进包里的那份根本跑不起来」，而那种情况在用户机器上表现为黑屏。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeReact } = require('./helpers/fake-react');
const { loadProfilePluginManifest, resolvePluginSrcDir } = require('../src/shared/profile-plugins');

const ROOT = path.join(__dirname, '..');

/** 联调态下这里读到的是工作副本，非联调态是按 tag 拉下来的那份（同 plugin-http-baseline）。 */
function vendoredClients() {
  return loadProfilePluginManifest(path.join(ROOT, 'plugins')).flatMap((plugin) => {
    const dir = resolvePluginSrcDir({
      nodeModulesDir: path.join(ROOT, 'node_modules'),
      packageName: plugin.packageName,
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const client = pkg.exports?.['./client']?.default ?? null;
    // 插件可以只有 host 半，没有 `./client` 导出时跳过，而不是猜一个路径去读。
    return client === null ? [] : [{ packageName: plugin.packageName, file: path.join(dir, client) }];
  });
}

/**
 * 浏览器全局：factory 体内就会注入 CSS、读 localStorage，这些必须在场才跑得到 return。
 * `__ModuleLoader__` 一并在这里装好 —— 装完再往 `globalThis.window` 上补一个属性的话，
 * tsc 会按 DOM 的 Window 类型判 TS2339。
 * @param {(reg: any) => void} onLoad
 */
function installBrowserGlobals(onLoad) {
  const styleTag = { dataset: {}, style: {}, textContent: '' };
  Object.assign(globalThis, {
    window: { __ModuleLoader__: { load: onLoad }, getSelection: () => ({ toString: () => '' }) },
    document: {
      querySelector: () => null,
      createElement: () => styleTag,
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
      activeElement: null,
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  });
  return () => Object.assign(globalThis, {
    window: undefined, document: undefined, localStorage: undefined,
    fetch: undefined, requestAnimationFrame: undefined, cancelAnimationFrame: undefined,
  });
}

test('每个插件 vendor 进来的 client.js 都能加载出一个形状正确的模块', () => {
  const clients = vendoredClients();
  // 一个都没解析到，说明清单/解析路径出了问题，而不是「正好没有客户端插件」——
  // 那样这条测试会安静地零断言通过，等于防线消失了。
  assert.ok(clients.length > 0, '应至少解析出一个带浏览器半的插件');

  for (const { packageName, file } of clients) {
    const src = fs.readFileSync(file, 'utf8');
    const registrations = [];
    const restore = installBrowserGlobals((reg) => registrations.push(reg));
    try {
      const { jsxRuntime, hooks } = createFakeReact();
      const fakeRequire = (id) => {
        if (id === 'react/jsx-runtime') return jsxRuntime;
        if (id === 'react') return hooks;
        // createPortal 在这个假 DOM 里没有容器可挂，原样返回节点即可。
        if (id === 'react-dom') return { createPortal: (node) => node };
        throw new Error(`${packageName} 的 client.js require 了预料之外的模块: ${id}`);
      };

      // eslint-disable-next-line no-eval
      eval(src);
      assert.strictEqual(registrations.length, 1,
        `${packageName} 应恰好注册一次（0 次通常意味着产物被截断或根本没执行到 load）`);
      assert.strictEqual(typeof registrations[0].factory, 'function', `${packageName} 应注册一个 factory`);

      const mod = registrations[0].factory(fakeRequire);
      assert.strictEqual(typeof mod.apply, 'function', `${packageName} 的模块应导出 apply()`);
      assert.ok(Array.isArray(mod.inject), `${packageName} 的模块应导出 inject 数组`);
      assert.ok(mod.inject.every((name) => typeof name === 'string'),
        `${packageName} 的 inject 应该全是字符串服务名`);
    } finally {
      restore();
    }
  }
});
