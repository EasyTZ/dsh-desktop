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
    余额显示、Git 面板、终端面板、在资源管理器中打开…
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

1. `src/preload/index.js` 的自定义标题栏用 `#root{padding-top: TITLEBAR_HEIGHT}` 把整页面推低。「悬浮透明层」（不占布局、叠在 dsh 页面顶部）方案试过：视觉上更好看，但标题栏区域是 `-webkit-app-region:drag`，dsh 某页顶部若有真实内容会被盖住/挡住点击——实测命中会话页右上角的「Session log 下载」按钮（`@deepseek-ai/dsh-session-log-export`，注册在 `conversation.session.header.utilities`），且这个冲突是 dsh 自己的布局导致的，标题栏缩窄也躲不开。曾考虑用 `--patch` overlay 的 `disabled: true` 只关掉这一个内置条目（dsh 自己关遥测就是这么干的，技术可行），但它和 `/export` 命令共用同一个 fiber，关条目会连命令一起关掉，最终选择保留功能、退回 padding-top。代价：侧边栏顶部留白 = dsh 自己的留白 + 我们这一份，比悬浮方案明显更大——这是权衡后接受的，不是待修的 bug。标题栏背景仍然分两段：左段用 `[class*="sidebarCol"]` 弱耦合匹配侧边栏、`ResizeObserver` 跟踪宽度，颜色取 `--dsw-specific-sidebar-fill`；右段固定 `--dsw-alias-bg-base`。两者是 dsh 里不同的底色 token，标题栏必须跟着分段，用统一背景色会在侧边栏交界处露出色差（曾经改成统一色，被这条绊了一次）。探测失败（15s 超时）会经 `titlebar:sidebar-probe-failed` 让主进程记一行日志，不会无声失败，但耦合本身还在，是这条里最典型的「该往 L2 挤」的债。
2. `plugins/dsh-terminal-panel/lib/client.js` 的样式里有一条 `[class*="footerActions"]{flex-direction:column}`，是**第二处**对上游 CSS Modules 类名的弱耦合（第一处就是上面标题栏那条）。起因：`sidebar.footer.action` 的容器在上游是默认横向的 flex，Git 与终端两个按钮会被挤成同行的半宽按钮。上游一改名，两个按钮就无声地挤回一行 —— 插件挂载时会探测一次，匹配不到在浏览器控制台留一行 `console.warn`（`probeFooterContainer`），但只有开控制台的人看得见，比标题栏那条（走 IPC 进主进程日志）弱。收敛路径同样是上游给一个「footer action 排列方向」的契约，或干脆自己不改布局、把两个入口合并成一个。
3. 向上游提 slot PR（各 UI 包声明了几十个槽，但没有窗口 chrome 的），落地后标题栏从 L3 的 DOM 注入变成 L2 的客户端插件，第 1 条连同 padding-top 一起消失。

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

打包机前置：Node ≥ 22、`npm i -g @deepseek-ai/dsh`、`npm i -g pnpm`、仓库根 `npm install`（拉插件 git 依赖，见下方「插件拆分后的开发内环」）。

**顺序很重要**：`install-plugin` 必须先于 `prepare-kernel`。`prepare-kernel` 是整目录 `cpSync` 全局 dsh 安装目录，插件源码与依赖登记是搭便车进入内核的；顺序反了产物里就没有插件。`dist` / `dist:dir` 已经把 `install-plugin` 串在最前面，靠脚本本身保证顺序，不用再靠人记住——单独跑 `prepare-kernel` 或手动分步操作时仍需自己注意这条。同理，每次 `npm i -g @deepseek-ai/dsh` 升级后都要重跑 `install-plugin`（这也是为什么 `dist` 每次都无条件带上它，而不是假设「上次装过就还在」）。

（激活条目不再搭这趟车 —— 它由启动时的 `--patch` overlay 提供。）

### 插件拆分后的开发内环

四个通用插件已拆成独立仓库（`EasyTZ/dsh-git`、`dsh-terminal-panel`、`dsh-ui-balance`、`dsh-reveal-explorer`），本仓库通过 `package.json` 里的 git 依赖（**钉 tag，不钉分支**——钉分支会让打包不可复现）vendor 进 `node_modules/`。改插件代码的两种方式：

- **只想验证**：改完插件仓库 → push + 打 tag → 回本仓库把 `package.json` 里对应的 `#tag` 升一下 → `npm install`。
- **高频联调**（推荐）：把本仓库 `node_modules/<插件名>` 换成插件仓库工作副本的链接或 `file:` 依赖——`npm link ../dsh-git`（或把根依赖临时改成 `"dsh-git": "file:../dsh-git"`），改完立刻能测，不用每次 push/tag。**只在真正发版时才 push + 打 tag**，然后回本仓库更新钉住的版本号。

拆仓带来的两个**主动接受的代价**（不是待修 bug）：

- `dependencies` 不再为空（4 条插件 git 依赖），但这些依赖只被 vendor 源码、从不被运行时 require——真正跑插件的是内核进程里的那份拷贝。也因此根安装不解析插件的 peer（`.npmrc` 开了 `legacy-peer-deps`，插件 peer 由内核提供）。
- 首次拉取插件 tag 需要联网；lockfile 未变时重复构建仍不联网。

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

`plugins/plugins.json` 是唯一清单（`packageName` / `entryId` / 可选 `enabled`）。实现**只有一份**，在 `src/shared/plugin-install.js`。

**`entryId` 一律带 `dsdesktop-` 前缀**（由 `test/plugin-install.test.js` 强制）。`- insert:` 不去重，我们的 id 若与上游 bundle 里某条同名就是 `duplicate loader entry id` → 内核秒退。上游 130+ 个 id 里大量是 `git` / `session` / `settings` / `storage` 这类通用词，而内核会自己热更新到新版本 —— 不加前缀的话撞车只是时间问题，且发生在用户机器上、表现为黑屏。前缀取 `dsdesktop-` 而非 `desktop-`：上游已有 web / tui / headless 三个 surface，将来真加一个 desktop surface 时 `desktop-` 反而可能被它用掉。

源码位置（拆仓后有两处，`resolvePluginSrcDir` 统一解析）：桌面专属插件放 `plugins/<packageName>/`；通用插件作为 git 依赖 vendor 在 `node_modules/<packageName>/`。**新增插件**要做三件事：插件源码就位（两处之一）、`plugins.json` 加一条、若走 git 依赖还要在根 `package.json` 加依赖。装插件只按清单办事，不会去别处找源码。

用户开关状态（插件管理面板）在 `userData/plugin-state.json`，只记录**偏离清单默认值**的项：`enabled` 缺省视为 `true`（向后兼容旧清单），用户状态覆盖清单默认值；被关掉的插件**照样装、只是不激活**（激活 overlay 里不生成它的 `- insert:` 条目）。

读写两侧**刻意分处两地**，别把任何一边"收拢"回去：读侧（合并）在 `src/shared/plugin-state.js`，`DshService` 与 `kernel-updater` 生成 overlay 时都要用；写侧在 `plugins/dsh-plugin-manager/lib/pure.js`，因为唯一的写者是插件的 node 半，它跑在**内核进程**里、`import` 不到 `src/shared/`。曾经在 shared 也放过一份写侧实现，结果是没有调用者的死代码，并且和真写者悄悄分叉（真写者当时总写显式值，与"只记偏离"的文档不符）。两边唯一共享的是「`enabled` 缺省为 true」这条规则，改它要同时改 `pure.js` 的 `manifestEnabled`。

**装**（`installPlugin`，两件事，缺一不可）：

1. 拷贝源码到 dsh 的 `node_modules`；
2. **登记进 dsh 的 `package.json` dependencies**。

第 2 步是硬约束：dsh 运行时靠 `healProfilesModuleFallback` 遍历依赖闭包，在 `$DSH_HOME/profiles/node_modules` 建解析软链。只拷贝不登记 → 内核 `import` 时 `ERR_MODULE_NOT_FOUND` → 进程秒退 → 桌面端黑屏（v1.1.1 事故）。两条路径共用这份实现，各自只负责解析目录：`scripts/install-plugin.mjs`（构建期，全局 dsh，嵌套布局）与 `kernel-updater.js` 的 `_installPlugins`（运行期，热更新出的新内核，hoisted 布局）。

**安全模式**（`plugins.json` 的 `safeMode: true`）：崩溃对话框上的第三个按钮「安全模式启动」只加载标了这个字段的插件——当前只有插件管理面板，`test/plugin-install.test.js` 会强制清单里至少留一个。这是「插件把内核搞崩」唯一的逃生舱：那类故障**没有别的自愈路径**，回退内置内核没用（内置装着同一批插件、用同一份 overlay），删 `%APPDATA%` 也没用（插件在安装目录、overlay 每次启动从清单重新生成），不留这条路用户就只能等下一个版本。两条设计约束：安全模式**只存在于内存**（`index.js` 的 `safeMode` 变量），重启应用即回到正常模式，不需要再造一个「怎么退出安全模式」的入口；生成 overlay 走独立的 `writeSafeModePatch`，它**完全绕开开关判定**（用户状态与清单 `enabled` 都不看）——插件集在 `safeModePlugins` 那步已选定，再过一遍开关只可能把恢复入口本身滤掉，而这功能恰恰是在「开关状态可能有问题」时用的。外壳同时注入 `DSH_DESKTOP_SAFE_MODE=1`，面板据此显示提示条，否则用户只看到一列「未激活」会更慌。

**激活**：走 dsh 官方的 `--patch` overlay（patch 层栈第 4 层）。`renderActivationPatch` 由清单生成条目（被用户关掉的插件不生成），`writeActivationPatch` 落到 `userData/desktop.patch.yml`，`DshService` 与 `kernel-updater._verify` 各写一次同样的内容（**都带上用户开关状态**）。**发行包自带的 `cordis.patch.yml` 不再被我们改。**

三个必须记住的坑：

- **`--patch` 必须排在 `--host` 之前**。`bin.js` 的 launcher 只解析自己的 flag，「第一个不认识的 token 开始就是内层参数」；`--host` 是 web app 的 flag，排它后面的 `--patch` 会被原样透传，然后 web app 报 `unknown option '--patch'` 直接退出。
- **绝不要再往发行包的 `cordis.patch.yml` 里写东西**。`- insert:` 不去重：bundle 里有一条、overlay 再给一条，cordis loader 会抛 `duplicate loader entry id` 让内核**秒退**，与 v1.1.1 同一类致命失败。v1.2.0 从 v1.1.x 升级时，用户 `%APPDATA%` 里被老版本篡改过的热更新内核就会撞上这个 —— 靠「秒退 → 删用户内核 → 回退内置 → 静默重启」自愈，代价是重下一次内核。
- **`_verify` 必须带 overlay**。不带就是验了一个「没有插件的内核」，而真正启动是带着 overlay 跑的 —— 插件加载阶段的崩溃会整个溜过自检。

### 现有的五个插件

通用插件已拆仓（本仓库 vendor），源码在 `node_modules/` 下；`dsh-plugin-manager` 是桌面专属，源码在 `plugins/` 下。

| 插件 | entryId | 干什么 | 接入的槽 |
|---|---|---|---|
| `dsh-ui-balance` | `dsdesktop-balance` | 每条回复下方显示 DeepSeek 余额 | `conversation.chat.turnTail` |
| `dsh-git` | `dsdesktop-git` | Git 面板（改动/暂存/提交/推送/切分支/撤销） | `sidebar.footer.action`（`order: 100`）+ `shell.overlay` |
| `dsh-terminal-panel` | `dsdesktop-terminal-panel` | 终端面板（命令控制台） | `sidebar.footer.action`（`order: 90`）+ `shell.overlay` |
| `dsh-reveal-explorer` | `dsdesktop-reveal-explorer` | 在系统文件管理器中打开工作区 | `conversation.session.header.utilities` |
| `dsh-plugin-manager` | `dsdesktop-plugin-manager` | 设置页里列出自带插件并逐个开关（重启生效）；`safeMode: true`，是安全模式下唯一加载的插件 | `settings.plugins.tab`（`order: 20`） |

**槽的两条通用规则**（翻上游类型声明与 frontend bundle 得来）：

- `list` 槽排序是 `(priority ?? 0)` 然后 `(order ?? 0)`，**都是升序，数字小的在上面**。`order` 是排位用的，`priority` 是遮蔽（shadowing）用的，别拿 `priority` 调顺序。
- **`shell.overlay` 默认 click-through**，条目必须自己 opt back into pointer events；而**关闭态必须 `pointer-events:none`** —— `opacity:0` 的元素照样拦点击，漏了这条就是「面板关着却点不动底下的 dsh」。`details` 与 `sidebar` 是 `single` 槽且已被上游占用，注册进去会替换整列，**禁用**。

### 终端面板的几条硬知识（都是实测踩出来的）

- **它不是 PTY，是命令控制台**。上游的 PTY seam（`ctx.terminals`）要 `Agent` 做 owner、没有 resize，而且 web bundle 根本没 compose 它；`ShellProcess` 也没有写 stdin 的方法。所以 `vim` / `sudo` 密码 / `npm init` 问答跑不了 —— 这是设计边界，UI 里明说了，并给了「在系统终端中打开」当台阶。真要做满血版，验证过的路线是「PTY 放主进程（node-pty 是 N-API，Electron 里免重编，已实测）+ 自己的终端页面」，不是把它塞回内核。
- **`ctx.shell` 的 `readOutput()` 把 stderr 拼在 stdout 后面，用字面量 `[stderr]` 单独一行分隔**（pwsh-local / bash-local 的实现逐字相同）。不解析就会把这行当成输出显示；stdout/stderr 的真实交错顺序**拿不到**，只能按轮询批次近似。这是上游的**私有实现细节**，随时可能变 —— 属于我们主动接受的耦合。
- **每条命令是一个独立进程**，所以 `cd` 不会自然保留：cwd 与退出码靠追加在用户命令**末尾**的哨兵（RS 字符包裹）带回来。两个坑：哨兵**会被 delta 从中间切断**，解析必须是跨 delta 的状态机（见 `lib/pure.js`）；退出码必须哨兵自己带 —— 我们追加了语句，进程退出码已经不是用户命令的退出码了。
- **沙箱显式传 `danger-full-access`**。沙箱是用来约束**模型**的，用户自己敲 Enter 的命令不该被关起来；`ctx.shell` 的 `resolve` 尊重调用方传的 `sandboxPolicy`。
- **Windows 上是 `pwsh -NoLogo -NoProfile -NonInteractive`、mac 上是 `bash -c`**（不是 zsh，也不读 rc 文件）—— 这是 `dsh-base` bundle 按平台切 executor 的结果，不是我们选的。macOS 还有 PATH 塌陷问题（GUI 启动的 Electron 只继承到 `/usr/bin:/bin`），插件里有 best-effort 的登录 shell 探测兜着，彻底的修法在 L4。
- **Tab 补全是我们自己算的**（读目录 + 扫 PATH，不起 shell 进程 —— 起一个 PowerShell 实测近 300ms，按一次 Tab 等半秒没法用）。切词唯一的平台差异：POSIX 认反斜杠转义，**Windows 绝不能认**（`C:\Users\x` 会被啃掉一半）。
- **输入框全程可编辑，运行中也不要 `disabled` / `readOnly`**：`disabled` 的控件收不到键盘事件，会让 Ctrl+C 中断**整个失效**；`readOnly` 置灰则被用户当成「输入框失焦了」。两条都是实机反馈推翻过的写法。
- **吸底滚动的 effect 不能挂依赖数组**：新行是就地 `push` 到 view 对象上的（SSE handler 直接改 `view.lines` 再强制重渲染），`views` / `activeView` 的引用自始至终不变，挂了依赖数组它只在挂载时跑一次，表现是「有输出但视图一直停在顶部」。同理，行的 `key` 要用稳定 id 而不是数组下标，否则每来一行整个窗口的节点全量 diff。

### 客户端半怎么测

客户端插件源码（`plugins/dsh-plugin-manager/lib/client.js`、拆仓后的 `node_modules/dsh-*/lib/client.js`）**不在 `npm run typecheck` 的 `include` 里**，`node --check` 又只查语法。`useCallback` / `useEffect` 的依赖数组在 render 时立即求值，引用一个后面才声明的 `const` 会触发 TDZ、组件整个渲染崩溃 —— 表现就是「面板打不开」，而这类错误只有真实执行组件函数才会暴露。`test/terminal-client-smoke.test.js` 就是这道防线：在 node 里伪造 `window` / React，真跑一遍 factory、`apply()` 与槽组件的渲染路径。新写客户端插件时照抄它（git / plugin-manager 各有同款）。

纯逻辑（行模型、ANSI、哨兵、补全切词）另外放在 `lib/pure.js`：**零 import**，`test/` 可以直接 `import`，也因此会被 tsc 顺带检查。

### 写一个 dsh 插件

最小参照 `node_modules/dsh-ui-balance/`（拆仓后的 vendor 位置），带面板与多路由的完整参照看 `node_modules/dsh-git/`；桌面专属插件（不进独立仓库）的参照看 `plugins/dsh-plugin-manager/`。dsh 插件是**双面**的，两半在不同进程里跑，`package.json` 同时声明：

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

**模块顶层不许有会抛的同步 IO**（`readFileSync` / `execSync` / `statSync` …）。插件是被内核 `import` 进来的，顶层抛异常 = 内核在 boot 阶段秒退 = 桌面端黑屏，而这类失败**没有自愈路径**：删用户内核回退内置也没用（内置装着同一批插件、用同一份 overlay），删 `%APPDATA%` 也没用（插件在安装目录、overlay 从清单重新生成），只能等新版本。真要在顶层读文件就 `try/catch` 后退化成常量（例：`dsh-plugin-manager` 的 `readOwnName()`），或者挪进构造函数/请求处理里——那里抛出来最多是这个插件不可用，不会带走整个内核。

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

`electron-builder.yml`：`asar` 只打 `src/**` + `package.json`（生产依赖只是 vendor 用的插件 git 依赖，`beforeBuild` 返回 `false` 跳过 install/rebuild）；`kernel/` 与 `plugins-dist/` 走 extraResources（插件源码必须进包，热更新后要靠它重装插件；`plugins-dist/` 由 `scripts/pack-plugins.mjs` 按清单把 `plugins/` 与 `node_modules/` 两处源码摊平而成）；`electronDist: node_modules/electron/dist` 复用本机 Electron。**首次** `npm install`（拉插件 git 依赖）需要联网，lockfile 未变时的重复构建不联网——这是拆仓主动接受的代价。

`collect-release.mjs` 按 `package.json` 的 `version` **精确匹配**产物名，改版本号时 dist/ 里的旧产物不会被误选。发版流程：改 `package.json` version → 在 README「更新内容」加一节 → `npm run dist`。

## 约定

- 主进程代码用 CommonJS + `'use strict'`，私有成员用 `#` 前缀；`scripts/` 用 ESM。
- 注释写中文，且解释「为什么」而非「做什么」——现有注释里大量记录了踩过的坑（pnpm 退出码、runtime/ 子目录、WebSocket-only 事件流等），改这些地方前先读注释。
- **不引第三方运行时依赖**（`version.js` 手写 semver 比较就是为此），测试用 Node 内置 `node:test`。`dependencies` 里的 4 条插件 git 依赖是唯一例外：它们只被 vendor 源码、从不被运行时 require，真正跑插件的是内核进程里的那份拷贝——不是运行时依赖，是「源码进包的运输方式」。
- 不写死机器专属路径。定位全局安装一律走 `src/shared/dsh-locate.js`（`npm root -g` + APPDATA + 环境变量覆盖）。
- Windows 上不要用 `shell: true` 拼命令（触发 DEP0190）；`npm` 是 `.cmd`，Node 禁止直接 spawn，需显式走 `cmd.exe` —— 已封装在 `dsh-locate.js` 的 `npmRootCommand()`。
- 类型检查靠 `tsconfig.json` 的 `checkJs`（`npm run typecheck` 必须为 0 错误），**不引入编译步骤**：原因写在 tsconfig 顶部注释里。
