# AGENTS.md

DeepSeek Harness Desktop：以 `@deepseek-ai/dsh`（下称 dsh）为内核的 Electron 桌面外壳，当前只出 Windows（Mac 在规划中）。定位是 dsh 的**桌面发行版**——不改上游一行代码，只决定打包什么、默认配置是什么、额外装哪些组件。

深度文档在 [CLAUDE.md](CLAUDE.md)：四层模型全貌、双层内核与回退、内核热更新、终端面板实测知识、插件契约细节都在那里，**改这些敏感区域前必读**。

## 常用命令

```powershell
npm start                # 开发态运行：外壳 spawn 本机全局 dsh（前置：npm i -g @deepseek-ai/dsh pnpm、npm install，Node ≥ 22）
npm test                 # 单元测试（node:test，零第三方依赖）
npm run typecheck        # tsc --checkJs 静态检查，必须 0 错误
npm run dist             # 打包（scripts/dist.mjs：自动临时解除联调 → 打包 → 恢复）
npm run dist:dir         # 只出 win-unpacked，快速验证打包态
npm run link-plugins     # 联调：node_modules/<插件> → 同级工作副本 ../<插件>（可常开）
npm run plugins-status   # 看插件当前是「钉 tag」还是「联调」
npm run refresh-plugins  # 改了 #tag 后强制重拉（npm 会缓存 git 依赖，直接 npm install 常拿到旧版）
```

跑单个测试文件：`node --test test/version.test.js`；按用例名：`node --test --test-name-pattern "prerelease" "test/*.test.js"`。

路径探测可被环境变量覆盖（脚本与 DshService 共用一套逻辑）：`DSH_INSTALL_DIR`、`DSH_NODE_EXE`、`DSH_BIN_JS`、`DSH_PNPM_DIR`。

## 目录与分层

```
src/main/     Electron 主进程（CommonJS，依赖 electron，不可单测）
src/preload/  预加载脚本（注入标题栏 / 暴露 updater 接口）
src/shared/   纯 Node 模块，主进程与构建脚本共用，也是单测落点
scripts/      构建期 CLI（ESM .mjs）
plugins/      桌面专属插件源码（如 dsh-plugin-manager）+ plugins.json 清单
test/         node:test 用例
```

通用插件（dsh-git / dsh-terminal-panel / dsh-ui-balance / dsh-reveal-explorer）已拆成独立仓库，经 `package.json` 的 git 依赖（钉 tag）vendor 进 `node_modules/`。`plugins.json` 是唯一清单（`packageName` / `entryId` / 可选 `enabled`），新增插件 = 源码就位（`plugins/` 或 git 依赖）+ 清单加一条；装/激活逻辑只有一份：`src/shared/plugin-install.js`。改插件代码的开发内环：`npm run link-plugins` 把 `node_modules/<插件>` 换成指向同级工作副本的 junction（Windows 用 junction 不用 symlink，前者免管理员权限），改完跑 `install-plugin` 即生效，不必 push/tag。**联调可以常开**——`dist` 会自己临时解除、打完恢复（`try/finally`，失败也恢复）。链接只换 `node_modules` 那一个目录，`package.json` / lockfile 始终写着钉住的 tag（它们是发版凭据，不能被联调改脏或误提交）。

四层模型，新需求先判断落在哪层：**L1 内核**（dsh 发行包，只读，一个字节都不改）、**L2 dsh 插件**（走官方扩展点：slot 注册表 + `--patch` overlay）、**L3 preload + IPC 桥**（越薄越好）、**L4 Electron 外壳**（窗口/托盘/快捷键/通知/内核生命周期，纯我们的）。能用配置解决的不写代码，能用插件解决的不改上游，实在要改上游的就提 PR。

## 铁律

- **没有编译步骤**：`src/` 原样打进 asar，这是打包设计的承重墙。不引编译产物、客户端插件不写 JSX（直接调 `jsx()` / `jsxs()` 取宿主的 React）。
- **不引第三方运行时依赖**：semver 比较是手写的（`src/shared/version.js`）。`dependencies` 里的插件 git 依赖是唯一例外——只被 vendor 源码、从不被运行时 require，不是运行时依赖，是「源码进包的运输方式」（拆仓主动接受的代价，见 CLAUDE.md）。
- 主进程 CommonJS + `'use strict'`，私有成员 `#` 前缀；`scripts/` 用 ESM。
- 注释写中文、解释「为什么」而非「做什么」——现有注释大量记录了踩过的坑，改代码前先读注释。
- 主进程与构建脚本都要用的逻辑放 `src/shared/`；定位全局安装一律走 `src/shared/dsh-locate.js`，不写死机器路径。

## 坑（都真实出过事故）

- **`install-plugin` 必须先于 `prepare-kernel`**：后者整目录 cpSync 全局 dsh，插件靠搭便车进内核，顺序反了产物里就没有插件。`dist` / `dist:dir` 已串好顺序，单独跑时自己注意。
- **插件安装 = 拷贝源码 + 登记进 dsh 的 `package.json` dependencies**，缺第 2 步 → `ERR_MODULE_NOT_FOUND` → 黑屏（v1.1.1 事故）。实现只有一份：`src/shared/plugin-install.js`。
- **`--patch` 参数必须排在 `--host` 之前**，否则被透传给 web app，报 `unknown option '--patch'` 直接退出。
- **绝不能往发行包自带的 `cordis.patch.yml` 写东西**：`insert:` 不去重，cordis loader 抛 `duplicate loader entry id` 让内核秒退。激活插件走 `--patch` overlay（落到 `userData/desktop.patch.yml`）。
- **内核目录 layout**：`<kernelDir>/node.exe` + `<kernelDir>/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`，内置 / 用户 / staging 三处共用。`runtime/` 这层子目录不能去掉——electron-builder 硬排除根部 `node_modules`。
- **Windows 上不用 `shell: true` 拼命令**（DEP0190）；`npm` 是 `.cmd` 不能直接 spawn，走 `dsh-locate.js` 封装的 `npmRootCommand()`。
- **客户端插件源码不在 typecheck 的 include 里**（`plugins/dsh-plugin-manager/lib/client.js`、拆仓后的 `node_modules/dsh-*/lib/client.js`），`useCallback`/`useEffect` 依赖数组的 TDZ 错误只有真实渲染才暴露——客户端插件要配 smoke 测试（参照 `test/terminal-client-smoke.test.js`），纯逻辑放 `lib/pure.js`（零 import，`test/` 可直接 import）。
- 客户端插件样式自己注入 `<style>`（按 `data-plugin-css` 去重），颜色一律用 dsh 的设计 token（`--dsw-alias-*`）。**token 名要核对**——它们定义在 `dsh-client-ui-theme` 的 `design-platform.css` 里（编译进客户端 bundle、运行时注入，静态 CSS 里搜不到），写错名字不会报错、只会静默走 `var()` 的兜底值，于是那处颜色永远不跟主题（`state-warning-primary` 就是错的，真名 `state-warn-primary`）。另外 `bg-layer-1/2/3` 在**浅色主题下全是白**，靠它们做「面与面的区分」在浅色下等于没做——要相对色调用 `interactive-bg-hover` / `interactive-bg-active`，要按钮面用 `button-ghost-active-fill`。
- **打包不能用联调中的源码**：`install-plugin` 与 `pack-plugins` 都带 `dereference` 拷贝，联调下会把工作副本当前内容（含未提交改动）摊进安装包，版本号却仍是 tag 的号。`scripts/dist.mjs` 自动收尾，并在解除前核对「工作区干净 + HEAD 落在钉住的 tag 上」——否则解除后拉回旧版本，打出的包**不含你的改动**而你以为含，是同一问题的另一面。
- **热更新时插件装不满就不许扶正**：`_installPlugins` 任一插件失败都要让整次更新失败。曾经是「warn 一声接着装」，漏出的洞是——装失败的若正好是被用户关掉的插件，它不在激活 overlay 里，`_verify` 自检根本不加载它、照样通过、新内核被扶正；等用户哪天重新打开它并重启就秒退黑屏，而事故和「更新内核」这个动作隔了好几天，完全对不上。
- **插件的 HTTP 路由要有统一安全基线**：每个注册 webServer 路由的插件都要有 `originAllowed`（跨源 → 403），有 POST 的还要有 `requireJson`（非 JSON → 415），两条配套缺一不可。`test/plugin-http-baseline.test.js` 跨四个仓库强制一致（连实现是否逐字相同都比）。**别为此抽公共包**——无编译、单文件、零依赖是这些插件能被别人抄走就用的前提，正确做法是复制 + 校验一致。该测试非联调态报红通常不是误报，而是「钉住的 tag 里还没这条防线」。
- **lockfile 里插件的 `resolved` 是 `git+ssh://`，别去"修"**：npm 对 GitHub 托管依赖一律这么写，显式改成 `git+https` 也会被归一化回去。实测全新 cache + ssh 不通时 `npm ci` 照样成功（npm 自动回落 https），不影响新机器或 CI。

## 改插件后要不要重启（实测）

- `lib/client.js`（UI / 样式）→ 跑完 `install-plugin` **立刻生效**，不用重启：`dsh-client-hmr` 轮询 bundle 变化后经 SSE 推 `rebuilt`，浏览器就地重挂该插件（连 `<style data-plugin>` 一起换）。
- `lib/index.js`（host 半、`/api/*` 路由）→ **必须重启内核**。实测轮询 60 秒无反应、日志无重载记录，重启后才生效——服务端的 `@cordisjs/plugin-hmr` 够不到被拷进 `node_modules` 的这份。
- `plugins.json` → **必须重启**，激活 overlay 只在启动时读一次。

## 发版

改 `package.json` 的 `version` → README「更新日志」加一节 → `npm run dist`，产物按版本号精确匹配收进 `release/`。

内核版本也要跟着走：`package.json` 的 `dshKernel.expected` 声明这一版发哪个 dsh 内核，`prepare-kernel` 核对本机全局 dsh，对不上直接中止。原因是内核不像插件那样可复现——它整个来自打包机上的全局 dsh，`npm i -g @deepseek-ai/dsh` 一下就换了，同一个 app commit 可能打出装着不同内核的包，而外面贴的还是同一个版本号。想拿别的内核试打包用 `DSH_KERNEL_ANY=1`（那样的包别发布）。`collect-release` 结束时会报本次内置的内核版本，写发布说明时直接抄。
