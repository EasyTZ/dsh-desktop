# 内核的生命周期

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

### 系统通知（`notifications.js`）

内核的 `/api/events.mux` **只有 WebSocket 下行，普通 HTTP GET 返回 426，没有 SSE 回退**。下行每帧是 `server-request` 信封，真正的 mux 帧在 `payload` 里。只在窗口失焦时弹通知，并同时闪烁任务栏。

Windows toast 还要求存在指向本应用、且 AppUserModelID 与 `app.setAppUserModelId` 一致的开始菜单快捷方式；安装版由 NSIS 建，绿色版/win-unpacked 由 `ensureStartMenuShortcut()` 首启补建（已存在则跳过，别改成每次重写——那是启动路径上的冗余磁盘写）。

### 外壳自身版本更新（`app-updater.js`）

跟内核更新（`kernel-updater.js`）是两回事，别混在一起想：内核能在本地热更新替换（下载到用户可写目录、验证后原子切换），外壳是签名安装包 / 绿色版 zip，**运行中替换不了自己的 exe**，也没有中间态可用。所以 `AppUpdateChecker` 只做一件事——查 GitHub 最新 Release（`GET /repos/EasyTZ/dsh-desktop/releases/latest`）、跟 `app.getVersion()` 比对、发现新版就提醒，**不下载、不安装**：装成安装版还是绿色版、什么时候装，都还是用户自己的事。

**不用 `electron-updater`**：本项目定死了「不引第三方运行时依赖」（见「约定」一节），这条规则没有为外壳自更新单开例外；而且差分静默更新原本也要靠签了名的安装包才可靠，绿色版 zip 用不上。

提醒只有两处，都不新开应用内窗口：

- **系统通知**，`AppUpdateChecker._notify` 弹一次——`notifiedVersion` 记进 `userData/app-updater.json`，同一个新版本不会跟着每天一次的自动检查重复弹，那样是骚扰不是提醒。
- **托盘菜单常驻一项**「有新版本 vX.Y.Z」（`tray.js` 的 `appUpdate` 参数），查到就一直显示直到应用重启，不受通知的「只弹一次」节流——它是静态展示，不是主动打扰，用户没看到系统通知的话至少托盘里找得到。

跟内核更新用**各自独立**的节流文件（`app-updater.json` vs `updater.json`）与各自的 24h 间隔常量，互不影响；`_fetchLatestRelease` / `_notify` 拆成可覆盖的方法，测试（`test/app-updater.test.js`）靠换掉这两个方法在不联网、不弹真通知的前提下驱动 `check()`——手法照抄 `kernel-updater.test.js` 换 `_fetchLatest` 那一套。
