# 写一个 dsh 插件

### 客户端半怎么测

客户端插件源码（`node_modules/@easytz/*/lib/client.js`）**不在 `npm run typecheck` 的 `include` 里**，`node --check` 又只查语法。`useCallback` / `useEffect` 的依赖数组在 render 时立即求值，引用一个后面才声明的 `const` 会触发 TDZ、组件整个渲染崩溃 —— 表现就是「面板打不开」，而这类错误只有真实执行组件函数才会暴露。`test/git-client-smoke.test.js` 就是这道防线：在 node 里伪造 `window` / React，真跑一遍 factory、`apply()` 与槽组件的渲染路径。新写客户端插件时照抄它（terminal / market 的同款在它们各自的仓库里）。

**假 React 要造到「真的会渲染」为止。** 最省事的写法（`useState` 原样返回初值、`useEffect` 空函数、子组件不往下调）会让带取数的面板永远停在 loading 的早退分支，测试全绿而面板打不开 —— market 那份就是踩了这个才补齐的：状态真存、effect 真跑（**且不要立刻调 teardown**，那会让每个 `let alive = true` 的取数 effect 直接短路）、遇到 `type` 是函数的节点往下调、`setState` 后重渲染直到稳定。判断有没有造够，看断言能不能写成「渲染结果里出现了某个插件名」，而不只是「没抛异常」。

app 仓库里的共用假 React 在 `test/helpers/fake-react.js`，新写 smoke 测试直接用它，不要再手搓空壳版。

**分工**：组件级的渲染崩溃由**各插件仓库**的 client-smoke 守（props 契约住在那边，抄到 app 只会一改就红）；app 这边只有 `test/vendored-client-load.test.js`，验「钉住那个 tag 的产物加载得出来」——tag 从脏工作区上切、`files` 漏文件、vendor 截断都会在这里报红，而那类故障在用户机器上表现为黑屏。

纯逻辑（行模型、ANSI、哨兵、补全切词）另外放在 `lib/pure.js`：**零 import**，`test/` 可以直接 `import`，也因此会被 tsc 顺带检查。

### 写一个 dsh 插件

最小参照 `node_modules/@easytz/dsh-ui-balance/`（vendor 位置），带面板与多路由的完整参照看 `node_modules/@easytz/dsh-git/`，最复杂的看 `node_modules/@easytz/dsh-market/`。dsh 插件是**双面**的，两半在不同进程里跑，`package.json` 同时声明：

```jsonc
{
  "main": "lib/index.js",                       // node/host 半
  "exports": { "./client": "./lib/client.js" }, // 浏览器半
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },  // 见下：**硬条件**，缺了装上也永远不激活
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-connection", "..."]  // 浏览器半依赖的其他客户端插件
    }
  },
  "files": ["lib", "cordis.patch.yml"],
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1", "...": "^0.1.0-rc.7" }
}
```

**node 半**（`lib/index.js`）：写成**函数形式**的插件 —— `export const name` / `export const inject = ["webServer"]` / `export function apply(ctx, config)`，在 `apply` 里用 `ctx.effect(() => ..., "描述")` 注册资源（effect 的返回值是清理函数，热重载靠它）。取别的服务用 `ctx.get("credentials")` —— 可能是 `undefined`，必须判。

**不要写成 `Service` 子类**，除非这个插件真的要向别人提供能力：`Service` 的构造函数会往 cordis 的全局服务表里注册一个名字，撞名直接抛、内核秒退（见上面的命名空间表）。cordis 的 `unwrapExports` 在没有 default 导出时回落到模块命名空间，`isApplicable` 认 `{ apply }` 形状，`runtime.callback(ctx, config)` —— 函数形式是被一等支持的，不是权宜之计。

**凡是不同部署可能取不同值的参数都要进 `Config`**（上游文档的原话），用 `import z from "@deepseek-ai/schemastery"`：

```js
export const Config = z.object({ baseURL: z.string().default("https://api.deepseek.com") });
```

全字段带 default 时激活 overlay 不需要写 `config:` 键，schemastery 会填默认值（验证过）。`dsh-ui-balance` 的 `baseURL` 就是这么来的 —— 写死它意味着用户把 dsh 指向兼容代理之后，余额面板不但查错 host，还会把他填在 `DEEPSEEK_API_KEY` 里的**别家 key** 发到 api.deepseek.com。判据是「上游自己把它做成配置了吗」：`dsh-llm-deepseek` 的 `Config` 里就有 `baseURL`，设置页有对应输入框。反过来 `POLL_MS`、`MAX_LOG_LIMIT` 这类是真常量，不必进 Config。

**`dependencies` 里不要写 `react`。** 浏览器半的 `require("react")` 是宿主 `__ModuleLoader__` 注入的 require，永远不经 Node 解析 —— 声明了只会让装它的人白拉一份 React。

**`dsh.bundle` + 自带 `cordis.patch.yml`：唯一的激活方式。** 每个插件自带一个只有一行 `- insert:` 的 `cordis.patch.yml`，并在 `package.json` 声明 `dsh.bundle.patch` 指向它。少了它，`dsh plugin add` 会打印

```
dsh: warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

包装进去了、**永远不激活**，用户得自己手写 patch。

这一条曾经只是「给上游用户的方便」（我们自己走另一套 overlay 插入），现在是**桌面版自己的挂载路径** —— 装进 profile 之后挂载完全由这份 patch 完成，我们的 overlay 只负责停用。它同时是插件市场的**唯一硬门槛**：`installability` 拿 `dsh.bundle.patch` 判定，搜索结果里没有它的包会被标成不可安装（装了也没用，不如提前说清楚）。

**模块顶层不许有会抛的同步 IO**（`readFileSync` / `execSync` / `statSync` …）。插件是被内核 `import` 进来的，顶层抛异常 = 内核在 boot 阶段秒退 = 桌面端黑屏。自愈路径只有一条：崩溃对话框上的**安全模式**（停用市场以外的全部插件）—— 回退内置内核没用，插件根本不在内核里。真要在顶层读文件就 `try/catch` 后退化成常量（例：`dsh-market` 的 `readOwnName()`），或者挪进 `apply` / 请求处理里——那里抛出来最多是这个插件不可用，不会带走整个内核。

**浏览器半**（`lib/client.js`）：**不是普通 ESM**。它由 `dsh-client-modules` 按 `/plugins/<id>/client.js` 单独服务，不进 `dsh-web-frontend` 的 bundle，所以写成 `window.__ModuleLoader__.load({ id, factory })`，在 factory 里 `require("react/jsx-runtime")` 取宿主的 React。导出 `apply(ctx)` 与 `inject`。挂槽：

```js
ctx.slots.inject("conversation.chat.turnTail", () => {
  const dispose = ctx.slots.register(
    { name: "conversation.chat.turnTail", id: "balance", select: () => ({}), locale: NS, inject: () => ({}) },
    BalanceTail);
  return () => dispose();
});
```

两条容易踩的：

- **不写 JSX，直接调 `jsx()` / `jsxs()`**。这不是风格洁癖 —— 本项目没有编译步骤，插件源码原样进 `node_modules` 再原样服务给浏览器，写了 JSX 没人替你编译。
- **样式自己注入 `<style>` 标签**（按 `data-plugin-css` 去重），颜色一律用 dsh 的设计 token（`--dsw-alias-label-secondary` 等），否则浅色/深色主题下会露馅。

宿主与浏览器半之间怎么通信，`dsh-ui-balance` 选了「node 半注册一条 `webServer` 路由，浏览器半 fetch 它」，而不是 Typert Remote —— 后者要依赖编译生成的 remote descriptor，同样与「无编译步骤」冲突。
