# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DeepSeek Harness Desktop：以 `@deepseek-ai/dsh`（下称 dsh）为内核的 Electron 外壳，出 **Windows + Linux**（macOS 暂缓，见 docs/decisions/multiplatform.md）。主进程是原生 CommonJS，构建脚本是 ESM `.mjs`，**没有编译步骤**——src/ 直接打进 asar，这是打包设计的承重墙，别轻易引入编译产物。

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

## 常用命令

```powershell
npm start                # 开发态运行：外壳 spawn 本机全局 dsh
npm test                 # 单元测试（node:test 内置，零第三方依赖）
npm run typecheck        # tsc --checkJs 静态检查（noEmit，不产出编译结果）
npm run link-plugins     # 联调：把源码侧与运行侧两处都链到同级工作副本
npm run unlink-plugins   # 手动解除联调（日常不需要，dist 会自己收尾）
npm run plugins-status   # 看插件当前是「钉 tag」还是「联调」
npm run refresh-plugins  # 改了 #tag 后强制重拉（绕开 npm 的 git 依赖缓存）
npm run prepare-kernel   # 按 kernel-src/ 声明的版本，干净安装内核到 kernel/
npm run dist             # 打包（自动临时解除联调、打完自动恢复）；目标平台按当前系统猜
npm run dist -- --linux  # 显式指定目标平台（--win / --linux）。不是交叉编译：
                         # 打 AppImage 仍要在 Linux 上跑，这个参数只是让意图明确
npm run dist:dir         # 只出 unpacked 目录，不出安装包 / AppImage
npm run pack-profile-plugins  # 把 profile 层插件 npm pack 成 tgz，摊到 plugins-dist/profile/
npm run icon             # 仅在改了 build/logo.svg 后重新生成 icon.png/ico
```

跑单个测试文件：`node --test test/version.test.js`；按名字跑单个用例：`node --test --test-name-pattern "prerelease" "test/*.test.js"`。

打包机前置：Node ≥ 22、仓库根 `npm install`（拉插件 git 依赖，见下方「插件拆分后的开发内环」）。内核不再要求预装全局 `dsh` / `pnpm`——`prepare-kernel` 按 `kernel-src/` 声明的版本联网 `npm ci` 装出来，见 docs/decisions/packaging.md。Electron 二进制也不用管：**electron 44 起包里没有 postinstall**，`npm install` 不会下载它，`dist.mjs` 会在调 electron-builder 之前自己补上（幂等）。

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
- `profile-plugins-installer.js` —— 对账 + 自愈的执行侧（spawn dsh plugin add/remove、镜像 tarball、修清单）。启动路径、热更新自检、verify-kernel 三处共用
- `activation-patch.js` —— 生成停用 overlay（第 4 层 patch）。`DshService` 与 `kernel-updater._verify` 都要写，同一份内容
- `error-detail.js` —— 把内核 stderr 压成人能看懂的几行（dsh 的嵌套 [cause] 链原样展示等于没展示）

加新逻辑前先问：主进程和构建脚本会不会都要用？会就放 `src/shared/`，顺便能写测试。

外壳不渲染任何业务 UI：`DshService` spawn `<内核>/node .../dsh/lib/bin.js web --host 127.0.0.1 --port 0`（可执行文件名由 `kernel-paths.js` 的 `NODE_BIN` 决定，Windows 上带 `.exe`；`--port 0` 让内核自己向系统申请端口），轮询 HTTP 就绪后让 BrowserWindow `loadURL` 该回环地址。所有会话/文件/终端能力都来自 dsh 自身的 web 应用；外壳只贴自定义标题栏（`src/preload/index.js` 注入 DOM + CSS）、托盘、全局快捷键、系统通知和内核更新。

启动时序（`src/main/index.js`）：先弹闪屏 → 并行启动内核 → `dsh.on('ready')` 建主窗口 → 主窗口 `once('show')` 才关闪屏（避免空白帧）。

## 决策记录（改对应区域前必读）

| 要改什么 | 先读 |
|---|---|
| 上游扩展点、slot、CSS 类名弱耦合 | docs/decisions/upstream-and-layers.md |
| 多端打包：内核树为什么按平台锁死、glibc 基线、mac 暂缓的理由 | docs/decisions/multiplatform.md |
| 插件的联调 / 发版 / npm 发布 / 随包 tgz | docs/decisions/plugin-dev-loop.md |
| 内核目录、双层回退、热更新、通知、外壳自更新 | docs/decisions/kernel-lifecycle.md |
| profile 层插件契约、对账、安全模式、插件市场 | docs/decisions/profile-plugins.md |
| 终端面板、改插件要不要重启 | docs/decisions/terminal-panel.md |
| 写新插件、客户端半怎么测 | docs/decisions/writing-a-plugin.md |
| electron-builder、内核干净安装、CI 与发版流程 | docs/decisions/packaging.md |

## 约定

- 主进程代码用 CommonJS + `'use strict'`，私有成员用 `#` 前缀；`scripts/` 用 ESM。
- 注释写中文，且解释「为什么」而非「做什么」——现有注释里大量记录了踩过的坑（pnpm 退出码、runtime/ 子目录、WebSocket-only 事件流等），改这些地方前先读注释。
- **不引第三方运行时依赖**（`version.js` 手写 semver 比较就是为此），测试用 Node 内置 `node:test`。`dependencies` 里的 4 条插件 git 依赖是唯一例外：它们只被 vendor 源码、从不被运行时 require，真正跑插件的是内核进程里的那份拷贝——不是运行时依赖，是「源码进包的运输方式」。
- 不写死机器专属路径。定位全局安装一律走 `src/shared/dsh-locate.js`（`npm root -g` + APPDATA + 环境变量覆盖）。
- Windows 上不要用 `shell: true` 拼命令（触发 DEP0190）；`npm` 是 `.cmd`，Node 禁止直接 spawn，需显式走 `cmd.exe` —— 已封装在 `dsh-locate.js` 的 `npmRootCommand()`。
- 类型检查靠 `tsconfig.json` 的 `checkJs`（`npm run typecheck` 必须为 0 错误），**不引入编译步骤**：原因写在 tsconfig 顶部注释里。
- 踩坑叙事写进 docs/decisions/ 对应文件，CLAUDE.md 只放规则与索引；代码注释里的「为什么」保留一句结论 + 指向决策文件，不要整段重复。
