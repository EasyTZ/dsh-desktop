# 打包与发版

## 打包要点

`electron-builder.yml`：`asar` 只打 `src/**` + `package.json`（生产依赖只是 vendor 用的插件 git 依赖，`beforeBuild` 返回 `false` 跳过 install/rebuild）；`kernel/` 与 `plugins-dist/` 走 extraResources（`plugins-dist/profile/` 是 `scripts/pack-profile-plugins.mjs` 用 `npm pack` 打出的 tgz + 索引，首启离线播种、以及用户卸载后从市场装回来都要靠它）；`electronDist: node_modules/electron/dist` 复用本机 Electron。**首次** `npm install`（拉插件 git 依赖）需要联网，lockfile 未变时的重复构建不联网——这是拆仓主动接受的代价。

`collect-release.mjs` 按 `package.json` 的 `version` **精确匹配**产物名，改版本号时 dist/ 里的旧产物不会被误选；结束时还会报一次本次打进包的内核版本（产物文件名上只有应用版本号，而内核是独立升级的另一条线，发布说明里要写「内置内核 x.y.z」）。发版流程：改 `package.json` version → 在 CHANGELOG.md 加一节 → 打 tag → push tag → CI 出包（`.github/workflows/release.yml`）。本地 `npm run dist` 保留，作为打 tag 前的快速验证手段。

## Electron 二进制要自己补

`electron-builder.yml` 里配了 `electronDist: node_modules/electron/dist`（复用本机已下载的那份，实现「一次安装、反复打包」，不再每次联网校验 SHASUMS256.txt）。代价是这个目录**必须**存在。

而 **electron 44 的包里根本没有 `scripts` 字段** —— 二进制下载从 postinstall 改成了显式的 `bin: install-electron`。也就是说 `npm install` / `npm ci` **都不会**产生 `dist/`。老版本 electron 靠 postinstall 装，升到 44 之后这条链断了，本机一直没暴露只是因为 `dist/` 是更早以前留下来的。

第一次上 CI 就撞了这个：`npm ci` 9 秒装完 286 个包（117MB 的 Electron 显然没下），然后 electron-builder 报 `The specified electronDist does not exist`。

修在 `dist.mjs`（调 electron-builder 之前补一次，幂等）而不是只在 workflow 里加一步 —— 这是**打包**的前置条件、不是 CI 的前置条件，全新 clone 的开发机同样会踩。本地和 CI 必须走同一条路径，否则两边分别踩坑。

顺带：electron-builder 检测到 CI 环境会**隐式开启发布**（日志里 "Implicit publishing triggered by CI detection"），也就是它会自己去建 / 改 GitHub Release。发布由 workflow 里那一步显式负责，两边同时动 Release 迟早出事，所以命令行写死 `--publish never`。这个隐式行为在 electron-builder v27 会被移除，早点写死反而少一次将来的意外。

## 为什么上 CI

`npm run dist` 里最有价值的一步是 `verify-kernel`——它会**真的启动一次内核**等就绪，这是唯一能捕获「裁剪把运行时真要用的文件删掉了」这类错误的手段，而这件事只能在目标平台上做（Windows 的内核布局、可执行位、路径分隔符都跟 macOS / Linux 不一样）。多端打包意味着这道自检要在四个平台上各做一次，本机手动切系统跑不现实，CI 矩阵是唯一合理的落点——仓库是公开的，GitHub Actions 免费、不限分钟数，没有额外成本。

先只上 Windows：流水线本身的坑（怎么拉插件的 git 依赖、npm 缓存、200MB+ 产物上传、Release 写权限）跟平台无关，在已知正确的平台上先趟掉，之后往矩阵里加 Linux / macOS 时只需要面对平台差异本身。

**内核安装：从「拷全局安装」到「按声明干净安装」**。旧版本 `prepare-kernel.mjs` 直接 `cpSync` 打包机上的全局 `@deepseek-ai/dsh` 与全局 `pnpm`，为此配了一道「内核版本闸门」（`package.json` 的 `dshKernel.expected` 声明这一版要发哪个内核，对不上就中止）——闸门是**症状的补丁**，不是解药：它存在的唯一理由是内核来自「打包机上碰巧装了什么」，随手一次 `npm i -g @deepseek-ai/dsh` 就换了内核，同一个 app commit 在不同时间打包可能装进两个不同版本，而外面贴的是同一个应用版本号；闸门只是把这种不可控挡在门外，没有让它变得可控。更根本的问题是：全局安装是打包机自己的平台（比如 Windows x64），拿它去打 mac/linux 包，那些平台专属的 optional 依赖（`@img/sharp-*`、`@koromix/koffi-*`、`@vscode/ripgrep-*` 等）根本没装进来，产物是死的——这才是「一直以来只能出 Windows」的根因。

现在的做法：内核的安装规格（精确版本号、lockfile）提交进仓库的 `kernel-src/`（`package.json` + `package-lock.json` + 一份显式关掉 `legacy-peer-deps` 的 `.npmrc`——根 `.npmrc` 那条设置是给 vendor 插件源码用的 npm 3-6 语义，内核树不能继承它，否则装出来的依赖树可能悄悄跟发布的那棵不一样，且不会有任何报错）。`prepare-kernel.mjs` 把它复制到一次性的 `kernel-staging/` 目录，按目标平台跑 `npm ci --omit=dev --os=<target> --cpu=<arch>`，再把装出来的 `pnpm`（落到 `kernel/pnpm`）和整棵 `node_modules`（落到 `kernel/runtime/node_modules`，装的时候会把大部分依赖 hoist 到顶层而不是像全局安装那样全嵌套在 `dsh/node_modules` 里，但 Node 的 `require()` 沿父目录逐级找 node_modules，两种布局都认）搬进 `kernel/`。

**闸门因此整段消失**：版本不再是「碰巧」，而是写在版本库里的一句声明（`kernel-src/package.json` 的 `dependencies`），没有可检查的东西了——升级内核就是改这一行、跟着提交走，天然满足闸门原本想保证的那件事。副作用：每次打包都要联网做一次 `npm ci`（原先只有首次全局安装要联网），这是有意接受的代价。

**解析面审计跟着搬到了 prepare-kernel**。这项检查（逐个 package.json 查 `main` / `bin` / `exports` 指向的文件在裁剪后还在不在）原先住在 `verify-kernel.mjs`，拿**打包机上的全局 dsh 安装**当「未裁剪的对照树」——上游自己有几个包的入口映射就是坏的（`@modelcontextprotocol/sdk` 的根导出、类型专用包 `@standard-schema/spec`），不比对的话会全线误报。

换成 `npm ci` 之后这个设计立刻失效，而且**是静默失效**：新布局把依赖 hoist 到 `runtime/node_modules` 顶层，不再嵌套在 `dsh/node_modules` 里，而审计只被传入 dsh 那一个子目录 —— 覆盖范围从 454 个包塌到 1 个，却照旧打印「通过」。这类「网破了还在报平安」的失效，比直接报错危险得多。

现在对照物改成**同一棵树裁剪前的快照**：`prepare-kernel` 在 `pruneKernel` 之前记下所有**当前能解析**的入口，裁剪后逐条复查，少一条就中止构建。三个好处 —— 问的问题（「裁剪弄坏了什么」）和量的东西完全对齐；上游本来就坏的入口从一开始就不进快照，不需要再写一遍「放行」判断；不依赖任何外部安装，于是 `verify-kernel` 也不再需要全局 dsh，「打包机不装全局依赖」这个目标才真正达成。当前基线：454 个包、1943 个入口。

**回滚**：这是目前唯一动了发版关键路径的改动，新旧两条路并存——`DSH_KERNEL_LEGACY=1 npm run prepare-kernel` 会跑回旧的「拷全局安装」路径（仍然需要预装全局 `dsh` / `pnpm`）。等三个平台（Windows / macOS / Linux）都通过 CI 矩阵真出过一次包之后，旧路径连同 `dsh-locate.js` 里构建期专用的 `findDshInstallSync` / `findPnpmDirSync` 一起删（`findDshBinJsAsync` 是开发态 `npm start` 用的，不受影响，不能删）。
