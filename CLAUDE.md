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
L2  桌面特有能力  dsh 插件（走官方扩展点）            我们的代码，跑在**用户的 profile** 里
    插件市场、Git 面板、终端面板、余额显示、在资源管理器中打开…
L1  内核          @deepseek-ai/dsh registry 发行包    只读，一个字节都不改
```

**L2 归用户，不归内核。** 五个插件都装在 `$DSH_HOME/profiles/web/`，和别人 `dsh plugin add` 装的第三方插件躺在同一个目录、用同一套机制管理。换内核不动它们，用户也能自己卸掉（插件市场自己除外）。这条边界的判据是**生命周期归谁** —— 详见「自定义插件契约」。

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

另有 `dsh plugin --profile <name> add <pkg>`（转发给 profile 目录里的 pnpm，顺手 reconcile `dsh.profile.bundles`），是插件安装 + 依赖登记的官方做法 —— **也是本项目装插件的唯一途径**，无论是首启播种自带的五个，还是用户在市场里点安装。`$DSH_HOME/profiles/<name>/` 本身就是个 pnpm 包（`package.json` 带 `dsh.profile.bundles` + `cordis.patch.yml` + `pnpm-workspace.yaml`）。

客户端 UI 的官方接入点是 slot 注册表（`@deepseek-ai/dsh-client-ui-slots`，带 `SlotMap` 声明合并的类型契约）。槽由各个 UI 包各自声明，十几个包都有：`dsh-client-ui-conversation` 一家就 12 个（`conversation.chat.turnTail`、`conversation.composer`、`conversation.session.header.actions` …），`dsh-client-ui-layout` 有 4 个（`sidebar` / `conversation` / `details` / `shell.overlay`）。找槽就去对应包的 `lib/types/client/**/slots.d.ts` 翻。

**没有窗口 chrome 的槽** —— 这是我们该向上游提的第一个 PR。

### 上游是 developer preview

README 原文：*"iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**"* 版本线 `0.1.x-rc.N`，跨 minor 是常态（`0.1.0-rc.7` → `0.1.1-rc.2` 就真实发生过，热更新自己跨的）。

这里**刻意没有做版本闸门**（只放行白名单/上限版本）。权衡过：硬上限的维护成本落在一个人身上，每次上游发版都要手动验证 + 改常量，否则用户卡在旧内核拿不到上游修复；而最坏情况「内核起不来」已经有删除用户内核 + 回退内置兜底了。真正的缺口是「起得来但我们的集成坏了」，那类要靠集成点自检暴露，不是靠拦版本。

作为替代，`resolvePackagedKernel` 会做版本比较（见「双层内核与回退」），保证客户端自带的出厂内核不会被更旧的用户内核压住。

### 已知偏离（待收敛）

1. `src/preload/index.js` 的自定义标题栏用 `#root{padding-top: TITLEBAR_HEIGHT}` 把整页面推低。「悬浮透明层」（不占布局、叠在 dsh 页面顶部）方案试过：视觉上更好看，但标题栏区域是 `-webkit-app-region:drag`，dsh 某页顶部若有真实内容会被盖住/挡住点击——实测命中会话页右上角的「Session log 下载」按钮（`@deepseek-ai/dsh-session-log-export`，注册在 `conversation.session.header.utilities`），且这个冲突是 dsh 自己的布局导致的，标题栏缩窄也躲不开。曾考虑用 `--patch` overlay 的 `disabled: true` 只关掉这一个内置条目（dsh 自己关遥测就是这么干的，技术可行），但它和 `/export` 命令共用同一个 fiber，关条目会连命令一起关掉，最终选择保留功能、退回 padding-top。代价：侧边栏顶部留白 = dsh 自己的留白 + 我们这一份，比悬浮方案明显更大——这是权衡后接受的，不是待修的 bug。标题栏背景仍然分两段：左段用 `[class*="sidebarCol"]` 弱耦合匹配侧边栏、`ResizeObserver` 跟踪宽度，颜色取 `--dsw-specific-sidebar-fill`；右段固定 `--dsw-alias-bg-base`。两者是 dsh 里不同的底色 token，标题栏必须跟着分段，用统一背景色会在侧边栏交界处露出色差（曾经改成统一色，被这条绊了一次）。探测失败（15s 超时）会经 `titlebar:sidebar-probe-failed` 让主进程记一行日志，不会无声失败，但耦合本身还在，是这条里最典型的「该往 L2 挤」的债。
2. `node_modules/@easytz/dsh-terminal-panel/lib/client.js` 的样式里有一条 `[class*="footerActions"]{flex-direction:column}`，是**第二处**对上游 CSS Modules 类名的弱耦合（第一处就是上面标题栏那条）。起因：`sidebar.footer.action` 的容器在上游是默认横向的 flex，Git / 终端 / 插件市场三个按钮会被挤成同行的窄按钮。上游一改名，它们就无声地挤回一行 —— 插件挂载时会探测一次，匹配不到在浏览器控制台留一行 `console.warn`（`probeFooterContainer`），但只有开控制台的人看得见，比标题栏那条（走 IPC 进主进程日志）弱。收敛路径同样是上游给一个「footer action 排列方向」的契约，或干脆自己不改布局、把两个入口合并成一个。
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
npm run link-plugins     # 联调：把源码侧与运行侧两处都链到同级工作副本
npm run unlink-plugins   # 手动解除联调（日常不需要，dist 会自己收尾）
npm run plugins-status   # 看插件当前是「钉 tag」还是「联调」
npm run refresh-plugins  # 改了 #tag 后强制重拉（绕开 npm 的 git 依赖缓存）
npm run prepare-kernel   # 复制 node.exe + pnpm + 全局 dsh 依赖树到 kernel/
npm run dist             # 打包（自动临时解除联调、打完自动恢复）
npm run dist:dir         # 同上但只出 win-unpacked（快速验证打包态）
npm run pack-profile-plugins  # 把 profile 层插件 npm pack 成 tgz，摊到 plugins-dist/profile/
npm run icon             # 仅在改了 build/logo.svg 后重新生成 icon.png/ico
```

跑单个测试文件：`node --test test/version.test.js`；按名字跑单个用例：`node --test --test-name-pattern "prerelease" "test/*.test.js"`。

打包机前置：Node ≥ 22、`npm i -g @deepseek-ai/dsh`、`npm i -g pnpm`、仓库根 `npm install`（拉插件 git 依赖，见下方「插件拆分后的开发内环」）。

**顺序很重要**：`pack-profile-plugins` 必须先于 `verify-kernel`。自检要拿它产出的 tgz 把插件播种进隔离 `DSH_HOME`，否则验的是一个「没有插件的内核」，插件加载阶段的崩溃会整个溜过去。`dist` / `dist:dir` 已经排好了顺序，手动分步时要自己注意。

**插件不再搭内核的车**：`prepare-kernel` 拷的是纯内核，插件走另一条独立的线（tgz → 用户 profile）。升级全局 dsh 不影响插件，改插件也不用重打内核 —— 这正是迁到 profile 层的目的。

### 插件拆分后的开发内环

四个通用插件已拆成独立仓库（`EasyTZ/dsh-git`、`dsh-terminal-panel`、`dsh-ui-balance`、`dsh-reveal-explorer`），本仓库通过 `package.json` 里的 git 依赖（**钉 tag，不钉分支**——钉分支会让打包不可复现）vendor 进 `node_modules/`。改插件代码的两种方式：

- **发版**：改完插件仓库 → push + 打**新** tag → 回本仓库把 `package.json` 里对应的 `#tag` 升一下 → `npm run refresh-plugins`。**别用 `npm install`**：npm 缓存 git 依赖的解析结果，改了 `#tag` 之后经常不重新拉，装出来还是上一版——表现是「代码明明改了、装完却没变化」，很容易被误当成插件本身的 bug 排查半天。`refresh-plugins` 删目录再按显式 spec 装，绕开这条缓存路径（它也会拒绝在联调模式下运行）。
- **高频联调**：`npm run link-plugins`，改完**直接生效**，不用 push/tag，也没有任何拷贝或重装步骤（改 `lib/client.js` 内核 HMR 立刻推给浏览器，改 `lib/index.js` 重启内核）。`npm run plugins-status` 看当前状态，`npm run unlink-plugins` 解除并按 pin 恢复。

  **它链的是两处，缺一处就是半残**：`node_modules/<包名>`（源码侧 —— `pack-profile-plugins` 的 `npm pack` 和 HTTP 基线测试读这里）和 `<DSH_HOME>/profiles/web/node_modules/<包名>`（运行侧 —— 内核真正 `import` 的是这份）。只链源码侧的话改完代码什么都不会变，这是迁到 profile 层之后最容易踩的一脚。运行侧那份若 profile 里还没装过会跳过并提示先跑一次 `npm start`；`--off` 时运行侧只摘链接不补装，顺手把播种账本里对应的条目删掉，交给下次启动的对账按随包版本装回来。

链接**只换 `node_modules` 里那一个目录，不动 `package.json` / lockfile**——那两个文件是发版凭据，必须始终写着钉住的 tag，不能被联调改脏或误提交。Windows 上用 junction 而非 symlink：前者不需要管理员权限。

**联调可以常开**：`dist` / `dist:dir` 走 `scripts/dist.mjs`，它自己会临时解除联调、用钉住的版本打包、结束后再恢复（`try/finally`，打包失败也恢复——否则人会在「以为还在联调」的状态下改半天不生效）。日常不需要手动 `unlink-plugins`。

打包必须用钉住的版本，因为 `pack-profile-plugins` 的 `npm pack` 打的是 `node_modules` 里**当前**那份：联调下那是指向工作副本的 junction，于是未提交的改动会被原样打进 tgz，而版本号仍写着 tag 的号——产物自称 v0.1.1、内容却不是 GitHub 上的 v0.1.1，事后既复现不了也追溯不了。`verify-plugin-pins.mjs` 仍留在链条里当兜底（检查一个符号链接就够了：不是链接就说明那份是 npm 按 lockfile 从钉住的 commit 拉的，本身可复现）。

**自动解除联调有个反向陷阱，`dist.mjs` 专门挡了**：插件工作副本若有未提交/未打 tag 的改动，解除后拉回的是钉住的旧版本，打出来的包**不含你的改动**，而你以为含——和「打出不可复现的包」是同一枚硬币的两面，产物都不是你以为的那个。所以解除前先核对：工作区干净、且 HEAD 正好落在 `package.json` 钉住的那个 tag 上，两者内容一致才放行；对不上就中止并告诉你该先去插件仓库收尾。

### 插件发到 npm

五个插件都以 `@easytz/` scope 发布在 npm 上（`easytz` 就是 npm 用户名，scope 因此对得上）。它们同时存在于三个地方，别搞混各自的用途：

| 渠道 | 谁用 | 内容来自 |
|---|---|---|
| GitHub tag | **本仓库打包**（`package.json` 里钉的是 `github:EasyTZ/<repo>#v<x.y.z>`） | 那个 tag |
| npm | 别人的 dsh（`dsh plugin add @easytz/dsh-git`）、市场里的搜索结果 | `npm publish` 当时的**工作区** |
| 随包 tgz | 桌面版首启离线安装 | `node_modules` 里当前那份（即 tag 那份） |

**发 npm 前必须确认工作区干净、且 HEAD 正好在要发的那个 tag 上。** `npm publish` 打的是工作区，不问 git 一个字 —— 在有未提交改动的树上发布，npm 上那个版本号的内容就和同名 tag 对不上，而本仓库的 pin 走的是 tag。这条已经踩过一次：`@easytz/dsh-market@0.1.0` 发出去时工作区领先 tag 一个 commit 加三个改动文件，于是 npm 的 0.1.0 含修复、tag v0.1.0 不含，只能另发 0.1.1 收场（0.1.0 撤不掉，见下）。

**撤包基本指望不上**：绕过 2FA 的 granular token 不允许 `npm unpublish`（npm 已明确禁止），要撤得用带 OTP 的交互式登录，且 72 小时内、撤掉的版本号 24 小时内不能复用。所以「发之前核对」是唯一可靠的一道闸，没有事后补救。

发布本身：`npm publish --access public`（scope 包默认私有，不带这个 flag 会被拒）。账号开了 2FA，日常用 granular token（`npm config set //registry.npmjs.org/:_authToken=…`）绕过。

拆仓带来的两个**主动接受的代价**（不是待修 bug）：

- `dependencies` 不再为空（4 条插件 git 依赖），但这些依赖只被 vendor 源码、从不被运行时 require——真正跑插件的是内核进程里的那份拷贝。也因此根安装不解析插件的 peer（`.npmrc` 开了 `legacy-peer-deps`，插件 peer 由内核提供）。
- 首次拉取插件 tag 需要联网；lockfile 未变时重复构建仍不联网。

**lockfile 里插件的 `resolved` 是 `git+ssh://git@github.com/...`，这不是问题，别再去"修"它。** npm 的 `hosted-git-info` 对 GitHub 托管的依赖一律归一化成 ssh 形式写进 lock，把 `package.json` 的 spec 显式改成 `git+https://...` 也会被它改回 `github:` 简写。担心的是「新机器 / CI 没有 SSH key 时 `npm ci` 失败」—— 实测过了：**全新 npm cache + `GIT_SSH_COMMAND="exit 1"`（ssh 确认不通）下 `npm ci` 照样成功**，npm 对 hosted 依赖会自动回落到 https。测法：拿一个只含插件依赖的临时 `package.json` 生成 lock，`rm -rf node_modules` 后带上面两个条件跑 `npm ci`。

路径覆盖环境变量（脚本与 DshService 共用同一套探测逻辑）：`DSH_INSTALL_DIR`、`DSH_NODE_EXE`、`DSH_BIN_JS`、`DSH_PNPM_DIR`。

## 架构

```
src/main/     Electron 主进程（依赖 electron，不可单测）
src/preload/  预加载脚本（注入标题栏 / 暴露 updater 接口）
src/shared/   纯 Node 模块，不依赖 electron —— 主进程与构建脚本共用，也是单测的落点
scripts/      构建期 CLI（ESM）
plugins/      只剩 profile-plugins.json 一份清单（插件源码全在独立仓库）
test/         node:test 用例
```

`src/shared/` 存在的理由是「同一份逻辑曾经在两处各写一遍」：

- `kernel-paths.js` —— 内核目录 layout 的唯一定义处（内置 / 用户 / staging 共用），以及「启动哪个内核」的唯一裁决处
- `version.js` —— 手写 semver 比较（含 prerelease）。`kernel-paths` 与 `kernel-updater` 都要用，所以在 shared 不在 main
- `net.js` —— `findFreePort`（原先 dsh-service 与 kernel-updater 各一份）
- `dsh-locate.js` —— 定位全局 dsh / pnpm（原先两个构建脚本各一份）
- `profile-plugins.js` —— profile 层插件的清单/索引解析、对账计划（`planProfileReconcile` / `planProfileCleanup`）、entry id 桥接。启动路径、热更新自检、构建脚本三处共用
- `activation-patch.js` —— 生成停用 overlay（第 4 层 patch）。`DshService` 与 `kernel-updater._verify` 都要写，同一份内容
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

`pnpm add` 到 `<userKernel>-staging` → 往隔离 `DSH_HOME` 里播种 profile 插件 → 用那个 home 真 boot 一次 web 自检 → `rename` 原子切换（失败回滚 `-old` 备份）。

**注意「重装插件」这一步已经没有了**：插件不在内核里，换内核不需要动它们。播种是为了让自检覆盖「新内核 + 我们的插件」这个真实组合，不是安装步骤 —— 隔离 home 用完就删。

- 用 pnpm 不用 npm：dsh 依赖闭包庞大且大量 peerDependencies，npm arborist 会耗内存/长时间无响应。`--node-linker=hoisted` 让依赖平铺到 `runtime/node_modules` 顶层。
- pnpm 因「忽略 build scripts」返回非零退出码属正常，靠 `err.ignoredBuilds` 放行；不要把它当失败。
- registry 在 `registry.npmmirror.com` / `registry.npmjs.org` 之间循环切换，选择持久化在 `userData/updater.json`（同文件存 `lastCheck`，自动检查 24h 一次）。
- `onRestart` 里必须先 `dsh.stop()` 再 `app.relaunch()`：`app.exit` 会跳过 `will-quit`，否则留下占端口的孤儿内核进程。

### 自定义插件契约（最容易出错的地方）

**插件是用户的东西，不是内核的一部分。** 五个插件全部住在 `$DSH_HOME/profiles/web/`（patch 层栈的**第 2 层**，dsh 官方的 profile 层），由 pnpm 装成独立的包，自己 `insert` 自己的 loader 条目。桌面版只做三件事：**首启把随包的 tgz 装进去**、**按用户开关压一层停用 overlay**、**给插件市场提供装/卸的入口**。

这条边界是唯一的裁决标准，判据是**生命周期归谁**：跟着内核走的（换内核就没、用户删不掉）归内核；跟着用户走的（换内核还在、用户能自己删）归 profile。插件属于后者，所以：

- 换内核不影响插件 —— 它们根本不在内核目录里；
- 用户能在市场里卸载**任何**插件（`@easytz/dsh-market` 除外，见下）；
- 别人 `dsh plugin add @easytz/dsh-git` 装到的，和桌面版内置的是**同一个东西、同一种装法**。

（历史包袱已清空：曾经有一套「拷源码进内核 `node_modules` + 登记进内核 `package.json` + overlay 里 `- insert:`」的机制，随之而来的 `plugins/plugins.json`、`plugin-install.js`、`plugin-state.js`、`install-plugin.mjs`、`pack-plugins.mjs` 现已全部删除。它的问题不是不能跑，而是插件的命运被绑在内核上：内核一更新插件就得重装，用户也永远删不掉。别再重新引入。）

**清单**：`plugins/profile-plugins.json`，只有 `packageName` 和可选的 `required`。校验在 `loadProfilePluginManifest`（合法包名形状 + 不许重复）—— 包名会被摊进 `path.join`，不校验等于把「操作哪个目录」交给清单文本。

**`required: true` 只给 `@easytz/dsh-market`**：它是插件的管理入口，删掉了就再也装不回来（那是一扇单向门）。所以对账时它每次都被强制拉齐版本，市场自己的卸载/停用接口里也把它列进 `PROTECTED_PACKAGES`。其余四个是**播种一次**：首启装进去，用户卸载了就不再自动装回来，但市场的「随应用分发」分组里随时能一键装回。

**播种账本**（`userData/profile-plugins-seeded.json`）是「从没装过」和「装过但被用户卸了」唯一的区分手段 —— 两种情况下 profile 里都是查无此包，没有账本就只能二选一：要么永远装不回、要么用户卸不掉。

**对账**（`reconcileProfilePlugins`，挂在启动路径上）：先按 entry id 清历史残留、再装。顺序不能反 —— 改名场景下新旧两个包声明同一个 entry id，先装会让 profile 短暂处于「两个都在」的状态，中途被打断下次启动就是 `duplicate loader entry id` + 黑屏。清不掉就**不装**（宁可少几个插件，也不要一个打不开的应用）。常态开销为零：版本一致时只读两个 `package.json` 就返回，不 spawn 任何进程。失败**不阻塞启动**。

**entry id 一律带 `dsdesktop-` 前缀**（每个插件自带的 `cordis.patch.yml` 里写）。`- insert:` 不去重，我们的 id 若与上游 bundle 里某条同名就是 `duplicate loader entry id` → 内核秒退。上游 130+ 个 id 里大量是 `git` / `session` / `settings` / `storage` 这类通用词，而内核会自己热更新 —— 不加前缀撞车只是时间问题，且发生在用户机器上、表现为黑屏。前缀取 `dsdesktop-` 而非 `desktop-`：上游已有 web / tui / headless 三个 surface，将来真加一个 desktop surface 时 `desktop-` 可能被它用掉。

**开关**：状态在 `userData/plugin-state.json`（`entryId → boolean`，只记偏离，缺省为启用）。写者是市场插件的 node 半（跑在内核进程里，靠 `DSH_DESKTOP_PLUGIN_STATE` 找到文件，绝不硬编码 `%APPDATA%`）；读者是 `src/shared/activation-patch.js`。**读不出来按「全部启用」处理** —— 状态文件损坏该表现为「插件都在」，而不是「插件都不见了」，后者没有任何提示能解释原因。

**停用只能靠 overlay**：profile 层插件是自己 insert 自己的条目的，我们既插不了也删不掉，唯一手段是从第 4 层压一条 `- id: X` + `disabled: true` 覆盖它（dsh 自己关遥测走的就是这条路，见 `resolveTelemetryPatch`）。所以 `userData/desktop.patch.yml` 现在**只做停用**，常态下是一份空的 `[]`（空文件会让 dsh 解析报错，必须写 `[]`）。`entryIdsForPackage` 负责「包名 → entry id」的桥接：读 profile 里那个包自带的 `cordis.patch.yml`。**只 patch 真实存在的 id** —— 用户卸载一个曾经停用过的插件之后，状态文件里那条 `false` 就是个不存在的 id。

**安全模式**：崩溃对话框上的第三个按钮，停用**除市场外的全部** profile 插件（`RECOVERY_PACKAGES`）。这是「插件把内核搞崩」唯一的逃生舱 —— 那类故障没有别的自愈路径，回退内置内核没用（插件在用户 profile 里，跟内核无关）。三条设计约束：只存在于内存（`index.js` 的 `safeMode` 变量），重启应用即恢复正常，不需要再造一个「怎么退出安全模式」的入口；**完全绕开用户开关判定**（插件集在那一步已选定，再过一遍开关只可能把恢复入口本身滤掉，而这功能恰恰是在「开关状态可能有问题」时用的）；外壳注入 `DSH_DESKTOP_SAFE_MODE=1`，市场面板据此显示提示条。

三个必须记住的坑：

- **`--patch` 必须排在 `--host` 之前**。`bin.js` 的 launcher 只解析自己的 flag，「第一个不认识的 token 开始就是内层参数」；`--host` 是 web app 的 flag，排它后面的 `--patch` 会被原样透传，然后 web app 报 `unknown option '--patch'` 直接退出。
- **绝不要再往发行包的 `cordis.patch.yml` 里写东西**。`- insert:` 不去重：bundle 里有一条、overlay 再给一条，cordis loader 会抛 `duplicate loader entry id` 让内核**秒退**，与 v1.1.1 同一类致命失败。v1.2.0 从 v1.1.x 升级时，用户 `%APPDATA%` 里被老版本篡改过的热更新内核就会撞上这个 —— 靠「秒退 → 删用户内核 → 回退内置 → 静默重启」自愈，代价是重下一次内核。
- **`_verify` 必须带 overlay**。不带就是验了一个「没有插件的内核」，而真正启动是带着 overlay 跑的 —— 插件加载阶段的崩溃会整个溜过自检。
- **`_verify` 必须先把插件播种进隔离 home**（`_seedProfilePlugins`），`verify-kernel.mjs` 同理。插件迁到 profile 层之后，「装插件」这一步不再属于内核更新，于是自检用的干净 `.verify-home` 里一个插件都没有 —— 自检只能证明「内核自己能起来」，证明不了「内核 + 我们的插件能一起起来」，而后者才是用户真正会跑的组合。这个洞**不会报错**，只会让自检悄悄变得没有意义，所以两处自检都走和正式启动完全相同的那套 `reconcileProfilePlugins`。构建期那次是**硬失败**（装不上就说明打出来的包也装不上），运行期那次是 best-effort（插件缺席远好过更新链路整个卡死）。

**三个会撞车的全局命名空间**（`test/plugin-http-baseline.test.js` 强制）：插件跑在**上游内核的进程里**，而内核会自己热更新。凡是「上游也往里写、撞了就抛」的全局命名空间，我们都必须主动避开 —— 撞上只是时间问题，且发生在用户机器上、表现为黑屏。已知三个，处理方式各不相同：

| 命名空间 | 撞了会怎样 | 我们的做法 |
|---|---|---|
| cordis loader 的 entry id | `duplicate loader entry id`，内核秒退 | 一律 `dsdesktop-` 前缀 |
| cordis 服务名（`ctx.provide`） | `service "x" has been registered at <...>`，boot 阶段抛、内核秒退 | **根本不占名字**：host 半一律写成文档里的函数形式（`export const inject` + `export function apply`），不是 `Service` 子类 |
| webServer 路由路径 | `webserver: duplicate exact route "..."`，同样是抛 | 统一挤在 `/api/dsdesktop/` 前缀下，路径由文件顶部的 `ROUTE` / `ROUTE_PREFIX` 常量拼出 |

第二条曾经是真实存在的雷：插件们分别注册过 `git`、`balance`、`terminalPanel`、`reveal-explorer`，而上游当前 70 个服务名全是 `fs` / `shell` / `web` / `storage` / `sessions` / `terminals` / `settings` 这类通用词 —— `git` 正落在词表正中间。这些插件**一个消费者都没有**（浏览器半是 fetch HTTP 路由拿数据的），占名字纯亏。对 `@easytz/dsh-market` 尤其要紧：它是安全模式下唯一被加载的插件，也就是「插件把内核搞崩」时的唯一逃生舱，逃生舱自己不能是崩溃源。

第三条的两半路径是**各写一遍**的（host 注册、client fetch），所以基线测试同时校验浏览器半只请求 `/api/dsdesktop/` 下的路径 —— 改了一边忘了另一边就是「面板打开后一片 404」。

**插件的 HTTP 路由安全基线**（四个插件必须一致，`test/plugin-http-baseline.test.js` 强制）：每个注册了 webServer 路由的插件都要有 `originAllowed`（Origin 存在且不等于本服务 origin → 403），有 POST 路由的还要有 `requireJson`（Content-Type 不是 application/json → 415）。两条是配套的：Origin 头在「无 preflight 的简单请求」里可以缺席，光靠 Origin 挡不住用 `text/plain` 发出来的跨源 POST。端口要在**请求时**动态取（`ctx.webServer.port`），constructor 阶段还是 `null`。

这条基线一度只有终端面板有，而 `dsh-git` 恰恰是唯一有 commit / push / undo-commit 这类**会改用户仓库**的写路由的插件 —— 同一个威胁四个仓库四种待遇，纯粹因为没有任何东西会因此变红。现在那条测试就是那个「会变红的东西」，它跨仓库比对四份 `originAllowed` 的实现是否逐字一致。**不要为此抽一个公共包**：无编译、单文件、零依赖是这些插件能被别人整个抄走就用的前提，正确做法是复制 + 校验一致。

注意这条测试读的是**当前解析到的**插件源码：联调态读工作副本，非联调态读按 tag 拉下来的那份。所以解除联调后它报红，通常不是误报，而是在说「钉住的 tag 里还没有这条防线」——安装包里装的就是那份没防线的代码，得发新 tag 并升 pin。

### 现有的五个插件

五个插件**全部**已拆仓、全部走 profile 层、全部可被用户卸载（市场除外）。本仓库通过 git 依赖 vendor 在 `node_modules/@easytz/` 下，只为打 tgz；运行时用的是用户 profile 里那份。

| 插件 | entry id | 干什么 | 接入的槽 |
|---|---|---|---|
| `@easytz/dsh-ui-balance` | `dsdesktop-balance` | 每条回复下方显示 DeepSeek 余额 | `conversation.chat.turnTail` |
| `@easytz/dsh-git` | `dsdesktop-git` | Git 面板（改动/暂存/提交/推送/切分支/撤销） | `sidebar.footer.action`（`order: 100`）+ `shell.overlay` |
| `@easytz/dsh-terminal-panel` | `dsdesktop-terminal-panel` | 终端面板（命令控制台） | `sidebar.footer.action`（`order: 90`）+ `shell.overlay` |
| `@easytz/dsh-reveal-explorer` | `dsdesktop-reveal-explorer` | 在系统文件管理器中打开工作区 | `conversation.session.header.utilities` |
| `@easytz/dsh-market` | `dsdesktop-market` | 插件市场：已安装列表（分「随应用分发」/「从市场安装」两组）+ npm 检索 + 一键装卸 + 热开关 + 图片预览。`required: true`，无法卸载；安全模式下唯一加载的插件 | `sidebar.footer.action`（`order: 110`）+ `shell.overlay` |

**槽的两条通用规则**（翻上游类型声明与 frontend bundle 得来）：

- `list` 槽排序是 `(priority ?? 0)` 然后 `(order ?? 0)`，**都是升序，数字小的在上面**。`order` 是排位用的，`priority` 是遮蔽（shadowing）用的，别拿 `priority` 调顺序。
- **`shell.overlay` 默认 click-through**，条目必须自己 opt back into pointer events；而**关闭态必须 `pointer-events:none`** —— `opacity:0` 的元素照样拦点击，漏了这条就是「面板关着却点不动底下的 dsh」。`details` 与 `sidebar` 是 `single` 槽且已被上游占用，注册进去会替换整列，**禁用**。

### 插件市场（`@easytz/dsh-market`）的几条硬知识

它是唯一 `required: true` 的插件，也是整个插件体系的管理入口，所以它的失败模式比别的插件严重一档。

**自锁保护不是可选项。** `PROTECTED_PACKAGES` 里必须包含 `readOwnName()` 读出来的自己 —— 曾经漏了这一条，结果市场把自己卸载掉了，用户的 profile 里再没有任何能装插件的东西，只能手工修。停用接口同理：安全模式的 `RECOVERY_PACKAGES` 也是它，逃生舱不能把自己关在门外。

**检索走 npm，不走 GitHub。** `registry.npmjs.org` 的 `-/v1/search` 按 `keywords:dsh-plugin` 检索（当前 3400+ 个包），GitHub 只用来补充 README 里的图片。理由：npm 是插件真正的分发渠道，包名、版本、`dsh.bundle` 声明这些**决定能不能装**的信息只有 registry 有；GitHub 那边搜到的仓库未必发过包。下载量走 `api.npmjs.org`，注意**它不支持 scope 包的批量接口**，scoped 包只能逐个查或干脆不显示。

**`installability` 的硬门槛只有一条**：`dsh.bundle.patch` 存在。没有它的包装上也永远不激活（见「写一个 dsh 插件」），与其让用户装完发现没反应，不如在列表里就标成不可安装。

**图片有三道关**：只认白名单域名、拒绝 badge 类 URL（shields.io 那种，全是徽章没信息量）、相对路径按仓库 raw 地址补全。国内 `raw.githubusercontent.com` 常年不通，面板里给了镜像开关，选择存在插件自己的设置里。

**已安装页分三组**，判据是「用户能拿它怎么办」而不是「它从哪来」：

| 组 | 装的是什么 | 有卸载按钮吗 |
|---|---|---|
| 桌面自带 | `removable: false` 的，目前只有市场自己 | 没有，标「桌面版内置，无法卸载」 |
| 随应用分发 | `profile-plugins.json` 里**当前没装**的那几个 | 给的是「装回来」（用随包 tgz，离线可用） |
| 从市场安装 | 其余全部，含用户自己从 npm 装的 | 有 |

已经装着的自带插件就出现在第三组里，和 npm 装的混在一起 —— 这是故意的，它们本来就是同一种东西。第二组只在「有自带插件被卸掉了」时才出现。

**开关和卸载不共用状态、也不放同一排**。装卸是「一次一个、服务端串行跑 pnpm」，开关只是写一行 JSON、可以连点几个；混用状态会让开关被 pnpm 的忙状态挡住。排版上卸载是 `.dsmkRowFooter` 里一个独立的描边按钮，实机反馈过挤在一排容易误触。

**装/卸/开关都要重启内核才生效**，面板里必须明说。profile 的 bundle 层和停用 overlay 都只在 boot 时读一次，装完不重启就是「列表里有了、功能没有」，用户会以为装失败。

**客户端半必须有冒烟测试**（`test/client-smoke.test.js`），而且那个假 React 必须是**真的会渲染的**。写成「useState 原样返回初值 + useEffect 空函数」的空壳版，面板会永远停在 `status: "loading"` 的早退分支上，真正复杂的那棵树一行都不执行 —— 加这个测试时它一口气抓出三个已经躺在代码里的自由变量 bug（`desktop.plugins`、裸 `safeMode`、没声明的 `toggleError`），换成空壳版一个都抓不到，却照样全绿。详见该文件顶部的注释。

### 终端面板的几条硬知识（都是实测踩出来的）

- **它不是 PTY，是命令控制台**。上游的 PTY seam（`ctx.terminals`）要 `Agent` 做 owner、没有 resize，而且 web bundle 根本没 compose 它；`ShellProcess` 也没有写 stdin 的方法。所以 `vim` / `sudo` 密码 / `npm init` 问答跑不了 —— 这是设计边界，UI 里明说了，并给了「在系统终端中打开」当台阶。真要做满血版，验证过的路线是「PTY 放主进程（node-pty 是 N-API，Electron 里免重编，已实测）+ 自己的终端页面」，不是把它塞回内核。
- **`ctx.shell` 的 `readOutput()` 把 stderr 拼在 stdout 后面，用字面量 `[stderr]` 单独一行分隔**（pwsh-local / bash-local 的实现逐字相同）。不解析就会把这行当成输出显示；stdout/stderr 的真实交错顺序**拿不到**，只能按轮询批次近似。这是上游的**私有实现细节**，随时可能变 —— 属于我们主动接受的耦合。
- **每条命令是一个独立进程**，所以 `cd` 不会自然保留：cwd 与退出码靠追加在用户命令**末尾**的哨兵（RS 字符包裹）带回来。两个坑：哨兵**会被 delta 从中间切断**，解析必须是跨 delta 的状态机（见 `lib/pure.js`）；退出码必须哨兵自己带 —— 我们追加了语句，进程退出码已经不是用户命令的退出码了。
- **沙箱显式传 `danger-full-access`**。沙箱是用来约束**模型**的，用户自己敲 Enter 的命令不该被关起来；`ctx.shell` 的 `resolve` 尊重调用方传的 `sandboxPolicy`。
- **Windows 上是 `pwsh -NoLogo -NoProfile -NonInteractive`、mac 上是 `bash -c`**（不是 zsh，也不读 rc 文件）—— 这是 `dsh-base` bundle 按平台切 executor 的结果，不是我们选的。macOS 还有 PATH 塌陷问题（GUI 启动的 Electron 只继承到 `/usr/bin:/bin`），插件里有 best-effort 的登录 shell 探测兜着，彻底的修法在 L4。
- **Tab 补全是我们自己算的**（读目录 + 扫 PATH，不起 shell 进程 —— 起一个 PowerShell 实测近 300ms，按一次 Tab 等半秒没法用）。切词唯一的平台差异：POSIX 认反斜杠转义，**Windows 绝不能认**（`C:\Users\x` 会被啃掉一半）。
- **输入框全程可编辑，运行中也不要 `disabled` / `readOnly`**：`disabled` 的控件收不到键盘事件，会让 Ctrl+C 中断**整个失效**；`readOnly` 置灰则被用户当成「输入框失焦了」。两条都是实机反馈推翻过的写法。
- **吸底滚动的 effect 不能挂依赖数组**：新行是就地 `push` 到 view 对象上的（SSE handler 直接改 `view.lines` 再强制重渲染），`views` / `activeView` 的引用自始至终不变，挂了依赖数组它只在挂载时跑一次，表现是「有输出但视图一直停在顶部」。同理，行的 `key` 要用稳定 id 而不是数组下标，否则每来一行整个窗口的节点全量 diff。

### 改插件后要不要重启（实测钉死）

内核自带两套热重载，覆盖范围**不一样**，别一概而论：

| 改动 | 联调模式下 | 机制 |
|---|---|---|
| `lib/client.js`（UI / 样式 / 交互） | **立刻生效，不用重启** | `@deepseek-ai/dsh-client-hmr` 在 web 组合里无条件挂载：node 侧 interval `statSync` 轮询每个插件 bundle 比对 hash，变了就经 SSE（`GET /plugins/events`）推 `rebuilt` 帧，浏览器就地重挂那一个插件——**连自己注入的 `<style data-plugin>` 都会先移除再重注入**，所以改样式也不用刷新 |
| `lib/index.js`（host 半、`/api/*` 路由） | **必须重启内核** | 实测：改了一条路由的返回值，装进全局 dsh 后**轮询 60 秒无反应**，内核日志里没有任何重载记录；重启后立刻生效。服务端那套 `@cordisjs/plugin-hmr` 追的是它自己认定的源文件图，够不到被拷进 `node_modules` 的我们这份 |
| 装/卸插件、改开关 | **必须重启内核** | profile 的 bundle 层与停用 overlay 都只在 boot 时读一次。市场面板会明说这一点 |

这条差异直接决定联调的手感：只调样式/交互时改完就能看，动了路由就得重启。

### 客户端半怎么测

客户端插件源码（`node_modules/@easytz/*/lib/client.js`）**不在 `npm run typecheck` 的 `include` 里**，`node --check` 又只查语法。`useCallback` / `useEffect` 的依赖数组在 render 时立即求值，引用一个后面才声明的 `const` 会触发 TDZ、组件整个渲染崩溃 —— 表现就是「面板打不开」，而这类错误只有真实执行组件函数才会暴露。`test/terminal-client-smoke.test.js` 就是这道防线：在 node 里伪造 `window` / React，真跑一遍 factory、`apply()` 与槽组件的渲染路径。新写客户端插件时照抄它（git 同款在本仓库，market 的在它自己的仓库里）。

**假 React 要造到「真的会渲染」为止。** 最省事的写法（`useState` 原样返回初值、`useEffect` 空函数、子组件不往下调）会让带取数的面板永远停在 loading 的早退分支，测试全绿而面板打不开 —— market 那份就是踩了这个才补齐的：状态真存、effect 真跑（**且不要立刻调 teardown**，那会让每个 `let alive = true` 的取数 effect 直接短路）、遇到 `type` 是函数的节点往下调、`setState` 后重渲染直到稳定。判断有没有造够，看断言能不能写成「渲染结果里出现了某个插件名」，而不只是「没抛异常」。

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

### 系统通知（`notifications.js`）

内核的 `/api/events.mux` **只有 WebSocket 下行，普通 HTTP GET 返回 426，没有 SSE 回退**。下行每帧是 `server-request` 信封，真正的 mux 帧在 `payload` 里。只在窗口失焦时弹通知，并同时闪烁任务栏。

Windows toast 还要求存在指向本应用、且 AppUserModelID 与 `app.setAppUserModelId` 一致的开始菜单快捷方式；安装版由 NSIS 建，绿色版/win-unpacked 由 `ensureStartMenuShortcut()` 首启补建（已存在则跳过，别改成每次重写——那是启动路径上的冗余磁盘写）。

## 打包要点

`electron-builder.yml`：`asar` 只打 `src/**` + `package.json`（生产依赖只是 vendor 用的插件 git 依赖，`beforeBuild` 返回 `false` 跳过 install/rebuild）；`kernel/` 与 `plugins-dist/` 走 extraResources（`plugins-dist/profile/` 是 `scripts/pack-profile-plugins.mjs` 用 `npm pack` 打出的 tgz + 索引，首启离线播种、以及用户卸载后从市场装回来都要靠它）；`electronDist: node_modules/electron/dist` 复用本机 Electron。**首次** `npm install`（拉插件 git 依赖）需要联网，lockfile 未变时的重复构建不联网——这是拆仓主动接受的代价。

`collect-release.mjs` 按 `package.json` 的 `version` **精确匹配**产物名，改版本号时 dist/ 里的旧产物不会被误选；结束时还会报一次本次打进包的内核版本（产物文件名上只有应用版本号，而内核是独立升级的另一条线，发布说明里要写「内置内核 x.y.z」）。发版流程：改 `package.json` version → 在 README「更新内容」加一节 → `npm run dist`。

**内核版本闸门**：`package.json` 的 `dshKernel.expected` 声明这一版要发哪个 dsh 内核，`prepare-kernel.mjs` 会核对本机全局 dsh，对不上**直接中止**。为什么需要它：插件是可复现的（钉 tag + lockfile 锁 commit），内核**不是**——它整个来自打包机上的全局 dsh，随手一次 `npm i -g @deepseek-ai/dsh` 就换了，同一个 app commit 在不同时间打包可能装进两个不同的内核，而外面贴的还是同一个应用版本号。用户报「1.4.0 有 bug」时，我们连自己发的是哪个内核都对不上账。升级内核因此变成一次有意的、跟着提交走的改动：改 `dshKernel.expected` 那一行。只想拿别的内核试打包用 `DSH_KERNEL_ANY=1`，那样打出来的包别拿去发布。

## 约定

- 主进程代码用 CommonJS + `'use strict'`，私有成员用 `#` 前缀；`scripts/` 用 ESM。
- 注释写中文，且解释「为什么」而非「做什么」——现有注释里大量记录了踩过的坑（pnpm 退出码、runtime/ 子目录、WebSocket-only 事件流等），改这些地方前先读注释。
- **不引第三方运行时依赖**（`version.js` 手写 semver 比较就是为此），测试用 Node 内置 `node:test`。`dependencies` 里的 4 条插件 git 依赖是唯一例外：它们只被 vendor 源码、从不被运行时 require，真正跑插件的是内核进程里的那份拷贝——不是运行时依赖，是「源码进包的运输方式」。
- 不写死机器专属路径。定位全局安装一律走 `src/shared/dsh-locate.js`（`npm root -g` + APPDATA + 环境变量覆盖）。
- Windows 上不要用 `shell: true` 拼命令（触发 DEP0190）；`npm` 是 `.cmd`，Node 禁止直接 spawn，需显式走 `cmd.exe` —— 已封装在 `dsh-locate.js` 的 `npmRootCommand()`。
- 类型检查靠 `tsconfig.json` 的 `checkJs`（`npm run typecheck` 必须为 0 错误），**不引入编译步骤**：原因写在 tsconfig 顶部注释里。
