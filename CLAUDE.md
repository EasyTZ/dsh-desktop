# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DeepSeek Harness Desktop：以 `@deepseek-ai/dsh`（下称 dsh）为内核的 Electron 外壳，当前出 Windows，Mac 在规划中。主进程是原生 CommonJS，构建脚本是 ESM `.mjs`，**没有编译步骤**——src/ 直接打进 asar，这是打包设计的承重墙，别轻易引入编译产物。

## 定位：我们是 dsh 的发行版

上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 是 MIT 开源的 cordis 插件化 monorepo，自带 web / tui / headless 三个 surface。本项目**不是**它的 fork，也不只是个启动器，而是它的**桌面发行版** —— 类比 Linux 发行版与内核的关系：不改上游一行代码，但决定打包什么、默认配置是什么、额外装哪些组件、怎么分发。

这个定位是所有架构决策的唯一裁决标准：

> **能用配置解决的不写代码，能用插件解决的不改上游，实在要改上游的就提 PR。**

上游 README 明确欢迎第三方插件（让插件仓库打 `dsh-plugin` topic），所以第三条是通路，不是空话。

### 四层模型

每层规定了**用什么机制实现**，新需求先判断落在哪层：

```
L4  桌面外壳      Electron 主进程                    纯我们的，上游永远不会有
    窗口/托盘/快捷键/通知/内核生命周期/安装包
L3  壳↔内核的桥   preload + IPC                      越薄越好，能挤进 L2 就挤
    自定义标题栏、updater UI
L2  桌面特有能力  dsh 插件（走官方扩展点）            我们的代码，跑在上游进程里
    余额显示（dsh-ui-balance）、原生集成…
L1  内核          @deepseek-ai/dsh registry 发行包    只读，一个字节都不改
```

**铁律：L1 只读；L2 只能通过官方扩展点接入。** 偏离这条铁律的代码就是下一次事故的种子 —— 篡改发行包也好、刮 DOM 也好，都会在上游某次改动后无声崩掉。

### dsh 的官方扩展点

patch 层自下而上叠（见发行包 `lib/profile-boot-*.js` 中 `composeProfile` 的注释）：

| 层 | 来源 | 谁的 |
|---|---|---|
| 1 | bundle 层（`dsh-base` → `dsh-web-app`） | **发行包自带，禁止改** |
| 2 | `$DSH_HOME/profiles/<name>/cordis.patch.yml` | 用户的 profile 层 |
| 3 | `$DSH_HOME/cordis.patch.yml` | 用户的机器级偏好 |
| 4 | **`--patch <path>` overlay（可重复，argv 顺序）** | **调用方的 —— 留给我们** |
| 5 | telemetry 开关 | — |

另有 `dsh plugin --profile <name> add <pkg>`（转发给 profile 目录里的 pnpm），是插件安装 + 依赖登记的官方做法。`$DSH_HOME/profiles/<name>/` 本身就是个 pnpm 包（`package.json` 带 `dsh.profile.bundles` + `cordis.patch.yml` + `pnpm-workspace.yaml`）。

客户端 UI 的官方接入点是 slot 注册表（`@deepseek-ai/dsh-client-ui-slots`，带 `SlotMap` 声明合并的类型契约）。槽由各个 UI 包各自声明，十几个包都有：`dsh-client-ui-conversation` 一家就 12 个（`conversation.chat.turnTail`、`conversation.composer`、`conversation.session.header.actions` …），`dsh-client-ui-layout` 有 4 个（`sidebar` / `conversation` / `details` / `shell.overlay`）。找槽就去对应包的 `lib/types/client/**/slots.d.ts` 翻。

**没有窗口 chrome 的槽** —— 这是我们该向上游提的第一个 PR。

### 上游是 developer preview

README 原文：*"iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**"* 版本线 `0.1.x-rc.N`，跨 minor 是常态（`0.1.0-rc.7` → `0.1.1-rc.2` 就真实发生过，热更新自己跨的）。

这里**刻意没有做版本闸门**（只放行白名单/上限版本）。权衡过：硬上限的维护成本落在一个人身上，每次上游发版都要手动验证 + 改常量，否则用户卡在旧内核拿不到上游修复；而最坏情况「内核起不来」已经有删除用户内核 + 回退内置兜底了。真正的缺口是「起得来但我们的集成坏了」，那类要靠集成点自检暴露，不是靠拦版本。

作为替代，`resolvePackagedKernel` 会做版本比较（见「双层内核与回退」），保证客户端自带的出厂内核不会被更旧的用户内核压住。

### 已知偏离（待收敛）

1. `src/preload/index.js` 的自定义标题栏是**透明悬浮层**，不再用 `#root{padding-top}` 挤开页面布局，而是直接叠在 dsh 页面顶部（省掉了旧版本靠 `[class*="sidebarCol"]` 弱耦合匹配侧边栏、只为了伪装背景色这一层刮 DOM 的代码）。代价转移到了另一处：叠加区域整体是 `-webkit-app-region:drag`，如果 dsh 某个页面顶部 32px 内恰好有真实可点击内容，会被挡住点不到。目前只用一张欢迎页截图判断过顶部是空的，**没有跑遍 dsh 的其他页面**（活跃会话、设置页等）——按钮点不到多半是这个原因，需要针对那块加 `-webkit-app-region:no-drag` 例外，或退回「reserve 空间」的旧方案（`git log` 里能翻到 `src/preload/index.js` 改动前的版本）。
2. 向上游提 slot PR（各 UI 包声明了几十个槽，但没有窗口 chrome 的），落地后标题栏从 L3 的 DOM 悬浮层变成 L2 的客户端插件，上面那条连同「叠加区域挡点击」的风险一起消失。

### 跨平台

平台假设集中在 L4 与 `kernel-paths.js`，**L1 / L2 无需改动** —— 这既是 Mac 的工作清单，也是对本分层的正面验证：

- `kernel-paths.js` / `prepare-kernel.mjs` —— `node.exe` 硬编码（layout 的唯一定义处，改这一处即可）
- `collect-release.mjs` —— 按 `.exe` 匹配产物
- `electron-builder.yml` —— 仅 win target
- `dsh-service.js` / `kernel-updater.js` 的 `taskkill`、`index.js` 的 `setAppUserModelId` 与 `ensureStartMenuShortcut` —— 均已带平台守卫
- Mac 特有：自绘标题栏要给红绿灯让位（`trafficLightPosition`）；`prepare-kernel` 拷的是 `process.execPath`，**必须在 Mac 上打包**（跨平台既拿不到 mac 的 node 二进制，也做不了签名/公证）

## 常用命令

```powershell
npm start                # 开发态运行：外壳 spawn 本机全局 dsh
npm test                 # 单元测试（node:test 内置，零第三方依赖）
npm run typecheck        # tsc --checkJs 静态检查（noEmit，不产出编译结果）
npm run install-plugin   # 把 plugins/ 下的自定义插件装进「本机全局 dsh」
npm run prepare-kernel   # 复制 node.exe + pnpm + 全局 dsh 依赖树到 kernel/
npm run dist             # install-plugin → prepare-kernel → electron-builder --win → collect-release
npm run dist:dir         # 同上但只出 win-unpacked（快速验证打包态）
npm run icon             # 仅在改了 build/logo.svg 后重新生成 icon.png/ico
```

跑单个测试文件：`node --test test/version.test.js`；按名字跑单个用例：`node --test --test-name-pattern "prerelease" "test/*.test.js"`。

打包机前置：Node ≥ 22、`npm i -g @deepseek-ai/dsh`、`npm i -g pnpm`。

**顺序很重要**：`install-plugin` 必须先于 `prepare-kernel`。`prepare-kernel` 是整目录 `cpSync` 全局 dsh 安装目录，插件源码与依赖登记是搭便车进入内核的；顺序反了产物里就没有插件。`dist` / `dist:dir` 已经把 `install-plugin` 串在最前面，靠脚本本身保证顺序，不用再靠人记住——单独跑 `prepare-kernel` 或手动分步操作时仍需自己注意这条。同理，每次 `npm i -g @deepseek-ai/dsh` 升级后都要重跑 `install-plugin`（这也是为什么 `dist` 每次都无条件带上它，而不是假设「上次装过就还在」）。

（激活条目不再搭这趟车 —— 它由启动时的 `--patch` overlay 提供。）

路径覆盖环境变量（脚本与 DshService 共用同一套探测逻辑）：`DSH_INSTALL_DIR`、`DSH_NODE_EXE`、`DSH_BIN_JS`、`DSH_PNPM_DIR`。

## 架构

```
src/main/     Electron 主进程（依赖 electron，不可单测）
src/preload/  预加载脚本（注入标题栏 / 暴露 updater 接口）
src/shared/   纯 Node 模块，不依赖 electron —— 主进程与构建脚本共用，也是单测的落点
scripts/      构建期 CLI（ESM）
test/         node:test 用例
```

`src/shared/` 存在的理由是「同一份逻辑曾经在两处各写一遍」：

- `kernel-paths.js` —— 内核目录 layout 的唯一定义处（内置 / 用户 / staging 共用），以及「启动哪个内核」的唯一裁决处
- `version.js` —— 手写 semver 比较（含 prerelease）。`kernel-paths` 与 `kernel-updater` 都要用，所以在 shared 不在 main
- `net.js` —— `findFreePort`（原先 dsh-service 与 kernel-updater 各一份）
- `dsh-locate.js` —— 定位全局 dsh / pnpm（原先两个构建脚本各一份）
- `plugin-install.js` —— 插件的装/激活/遗留清理（原先构建期与运行期各一份，漏了一步就是 v1.1.1 黑屏事故）
- `error-detail.js` —— 把内核 stderr 压成人能看懂的几行（dsh 的嵌套 [cause] 链原样展示等于没展示）

加新逻辑前先问：主进程和构建脚本会不会都要用？会就放 `src/shared/`，顺便能写测试。

外壳不渲染任何业务 UI：`DshService` spawn `node.exe .../dsh/lib/bin.js web --host 127.0.0.1 --port <随机空闲端口>`，轮询 HTTP 就绪后让 BrowserWindow `loadURL` 该回环地址。所有会话/文件/终端能力都来自 dsh 自身的 web 应用；外壳只贴自定义标题栏（`src/preload/index.js` 注入 DOM + CSS）、托盘、全局快捷键、系统通知和内核更新。

启动时序（`src/main/index.js`）：先弹闪屏 → 并行启动内核 → `dsh.on('ready')` 建主窗口 → 主窗口 `once('show')` 才关闪屏（避免空白帧）。

### 内核目录约定

三处（内置 / 用户 / staging）共用同一 layout，改动时必须同步：

```
<kernelDir>/node.exe
<kernelDir>/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js
```

`runtime/` 这层子目录不能去掉：electron-builder 硬排除 `from` 根部的 `node_modules`，套一层子目录才能打进 extraResources。

### 双层内核与回退

- **内置出厂内核**：`resources/kernel`（打包进安装包，只读兜底），开发态对应仓库根 `kernel/`。
- **用户内核**：`%APPDATA%/deepseek-desktop/kernel`，热更新产物，完整**且不比出厂内核旧**时优先。

`resolvePackagedKernel` 决定用哪层，判据有两条，顺序不能颠倒：先看完整性（`node.exe` + `bin.js`，残缺的再新也起不来），再比版本。

**「出厂内核更新时反超」不是优化，是修一个必然发生的版本倒挂**：安装包不碰 `%APPDATA%`，所以用户装了带更新出厂内核的新版客户端后，旧的用户内核仍然完整、仍然会被选中 —— 新客户端的 preload 与插件是照着新内核验证的，却跑在旧内核上，而这个错配只能等 24h 节流过期后的自动检查、并且用户点了更新才会消解。保守起见只在「能确证出厂更新」时反超：任一侧版本读不出来就维持用户内核优先，不为一个读取失败引入新的启动分支。被反超的用户内核**不删**（它没坏，只是旧了），将来热更新出更新版本时会自然重新胜出。

`kernel-updater.getCurrentVersion()` 必须走同一个 `resolvePackagedKernel`，否则更新中心显示的版本会和真正跑着的内核对不上。

用户内核**启动失败**时 `index.js` 会删掉它并回退内置重试一次（`kernelFallbackAttempted` 只允许一次，防止死循环）。注意这条只覆盖「起不来」；「起得来但我们的集成坏了」它一声不响 —— 那类故障要靠集成点自检暴露（见「已知偏离」）。

**内核崩溃绝不能静默**，这是本项目历史上最严重的体验问题，分两条路径：

- **就绪前退出** → `DshService` emit `error`（带 stderr 尾部）→ 触发用户内核回退；没有窗口时弹「启动失败」框并退出。
- **就绪后崩溃** → `exit` 事件带 `crashed` + `detail` → `index.js` 的 `reportKernelCrash` 弹「重启内核 / 退出」对话框。**不要改回 `loadURL('about:blank')`**：那会给用户一个没有任何说明、也没有恢复入口的黑屏。

配套的就绪判定同样关键：dsh 是「先绑端口、后加载 plugin tree」，端口能应答 ≠ 内核可用。`#pollReady` 因此要求响应码 < 500，并在宣告就绪前观察 `READY_SETTLE_MS` 确认进程仍存活。少了这一步，插件加载阶段的崩溃会被误判成就绪、后续崩溃被 `ready` 吞掉。

### 内核热更新（`kernel-updater.js`）

`pnpm add` 到 `<userKernel>-staging` → 重装插件 → 用隔离 `DSH_HOME` 真 boot 一次 web 自检 → `rename` 原子切换（失败回滚 `-old` 备份）。

- 用 pnpm 不用 npm：dsh 依赖闭包庞大且大量 peerDependencies，npm arborist 会耗内存/长时间无响应。`--node-linker=hoisted` 让依赖平铺到 `runtime/node_modules` 顶层。
- pnpm 因「忽略 build scripts」返回非零退出码属正常，靠 `err.ignoredBuilds` 放行；不要把它当失败。
- registry 在 `registry.npmmirror.com` / `registry.npmjs.org` 之间循环切换，选择持久化在 `userData/updater.json`（同文件存 `lastCheck`，自动检查 24h 一次）。
- `onRestart` 里必须先 `dsh.stop()` 再 `app.relaunch()`：`app.exit` 会跳过 `will-quit`，否则留下占端口的孤儿内核进程。

### 自定义插件契约（最容易出错的地方）

`plugins/plugins.json` 是唯一清单（`srcDir` / `entryId`），新增插件只加一项。实现**只有一份**，在 `src/shared/plugin-install.js`。

**装**（`installPlugin`，两件事，缺一不可）：

1. 拷贝源码到 dsh 的 `node_modules`；
2. **登记进 dsh 的 `package.json` dependencies**。

第 2 步是硬约束：dsh 运行时靠 `healProfilesModuleFallback` 遍历依赖闭包，在 `$DSH_HOME/profiles/node_modules` 建解析软链。只拷贝不登记 → 内核 `import` 时 `ERR_MODULE_NOT_FOUND` → 进程秒退 → 桌面端黑屏（v1.1.1 事故）。两条路径共用这份实现，各自只负责解析目录：`scripts/install-plugin.mjs`（构建期，全局 dsh，嵌套布局）与 `kernel-updater.js` 的 `_installPlugins`（运行期，热更新出的新内核，hoisted 布局）。

**激活**：走 dsh 官方的 `--patch` overlay（patch 层栈第 4 层）。`renderActivationPatch` 由清单生成条目，`writeActivationPatch` 落到 `userData/desktop.patch.yml`，`DshService` 与 `kernel-updater._verify` 各写一次同样的内容。**发行包自带的 `cordis.patch.yml` 不再被我们改。**

三个必须记住的坑：

- **`--patch` 必须排在 `--host` 之前**。`bin.js` 的 launcher 只解析自己的 flag，「第一个不认识的 token 开始就是内层参数」；`--host` 是 web app 的 flag，排它后面的 `--patch` 会被原样透传，然后 web app 报 `unknown option '--patch'` 直接退出。
- **绝不要再往发行包的 `cordis.patch.yml` 里写东西**。`- insert:` 不去重：bundle 里有一条、overlay 再给一条，cordis loader 会抛 `duplicate loader entry id` 让内核**秒退**，与 v1.1.1 同一类致命失败。v1.2.0 从 v1.1.x 升级时，用户 `%APPDATA%` 里被老版本篡改过的热更新内核就会撞上这个 —— 靠「秒退 → 删用户内核 → 回退内置 → 静默重启」自愈，代价是重下一次内核。
- **`_verify` 必须带 overlay**。不带就是验了一个「没有插件的内核」，而真正启动是带着 overlay 跑的 —— 插件加载阶段的崩溃会整个溜过自检。

### 写一个 dsh 插件

参照 `plugins/dsh-ui-balance/`。dsh 插件是**双面**的，两半在不同进程里跑，`package.json` 同时声明：

```jsonc
{
  "main": "lib/index.js",                       // node/host 半
  "exports": { "./client": "./lib/client.js" }, // 浏览器半
  "dsh": { "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-connection", "..."]  // 浏览器半依赖的其他客户端插件
  } },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1", "...": "^0.1.0-rc.7" }
}
```

**node 半**（`lib/index.js`）：默认导出一个 cordis `Service` 子类，`static inject = ["webServer"]` 声明依赖，构造时用 `ctx.effect(() => ..., "描述")` 注册资源（effect 的返回值是清理函数，热重载靠它）。取别的服务用 `ctx.get("credentials")` —— 可能是 `undefined`，必须判。

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

### 系统通知（`notifications.js`）

内核的 `/api/events.mux` **只有 WebSocket 下行，普通 HTTP GET 返回 426，没有 SSE 回退**。下行每帧是 `server-request` 信封，真正的 mux 帧在 `payload` 里。只在窗口失焦时弹通知，并同时闪烁任务栏。

Windows toast 还要求存在指向本应用、且 AppUserModelID 与 `app.setAppUserModelId` 一致的开始菜单快捷方式；安装版由 NSIS 建，绿色版/win-unpacked 由 `ensureStartMenuShortcut()` 首启补建（已存在则跳过，别改成每次重写——那是启动路径上的冗余磁盘写）。

## 打包要点

`electron-builder.yml`：`asar` 只打 `src/**` + `package.json`（本项目无生产依赖，`beforeBuild` 返回 `false` 跳过 install/rebuild）；`kernel/` 与 `plugins/` 走 extraResources（plugins 源码必须进包，热更新后要靠它重装插件）；`electronDist: node_modules/electron/dist` 复用本机 Electron，打包不联网。

`collect-release.mjs` 按 `package.json` 的 `version` **精确匹配**产物名，改版本号时 dist/ 里的旧产物不会被误选。发版流程：改 `package.json` version → 在 README「更新内容」加一节 → `npm run dist`。

## 约定

- 主进程代码用 CommonJS + `'use strict'`，私有成员用 `#` 前缀；`scripts/` 用 ESM。
- 注释写中文，且解释「为什么」而非「做什么」——现有注释里大量记录了踩过的坑（pnpm 退出码、runtime/ 子目录、WebSocket-only 事件流等），改这些地方前先读注释。
- 不引第三方运行时依赖（`version.js` 手写 semver 比较就是为此），保持 `dependencies` 为空；测试用 Node 内置 `node:test`。
- 不写死机器专属路径。定位全局安装一律走 `src/shared/dsh-locate.js`（`npm root -g` + APPDATA + 环境变量覆盖）。
- Windows 上不要用 `shell: true` 拼命令（触发 DEP0190）；`npm` 是 `.cmd`，Node 禁止直接 spawn，需显式走 `cmd.exe` —— 已封装在 `dsh-locate.js` 的 `npmRootCommand()`。
- 类型检查靠 `tsconfig.json` 的 `checkJs`（`npm run typecheck` 必须为 0 错误），**不引入编译步骤**：原因写在 tsconfig 顶部注释里。
