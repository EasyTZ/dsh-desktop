# 内核的生命周期

### 内核目录约定

三处（内置 / 用户 / staging）共用同一 layout，改动时必须同步：

```
<kernelDir>/<NODE_BIN>   # Windows 是 node.exe，其余平台是 node
<kernelDir>/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js
```

`runtime/` 这层子目录不能去掉：electron-builder 硬排除 `from` 根部的 `node_modules`，套一层子目录才能打进 extraResources。

### 双层内核与回退

- **内置出厂内核**：`resources/kernel`（打包进安装包，只读兜底），开发态对应仓库根 `kernel/`。
- **用户内核**：`%APPDATA%/deepseek-desktop/kernel`，热更新产物，完整**且不比出厂内核旧**时优先。

`resolvePackagedKernel` 决定用哪层，判据有两条，顺序不能颠倒：先看完整性（node 可执行文件 + `bin.js`，残缺的再新也起不来），再比版本。

**「出厂内核更新时反超」不是优化，是修一个必然发生的版本倒挂**：安装包不碰 `%APPDATA%`，所以用户装了带更新出厂内核的新版客户端后，旧的用户内核仍然完整、仍然会被选中 —— 新客户端的 preload 与插件是照着新内核验证的，却跑在旧内核上，而这个错配只能等 24h 节流过期后的自动检查、并且用户点了更新才会消解。保守起见只在「能确证出厂更新」时反超：任一侧版本读不出来就维持用户内核优先，不为一个读取失败引入新的启动分支。被反超的用户内核**不删**（它没坏，只是旧了），将来热更新出更新版本时会自然重新胜出。

`kernel-updater.getCurrentVersion()` 必须走同一个 `resolvePackagedKernel`，否则更新中心显示的版本会和真正跑着的内核对不上。

用户内核**启动失败**时 `index.js` 会删掉它并回退内置重试一次（`kernelFallbackAttempted` 只允许一次，防止死循环）。注意这条只覆盖「起不来」；「起得来但我们的集成坏了」它一声不响 —— 那类故障要靠集成点自检暴露（见「已知偏离」）。

**内核崩溃绝不能静默**，这是本项目历史上最严重的体验问题，分两条路径：

- **就绪前退出** → `DshService` emit `error`（带 stderr 尾部）→ 触发用户内核回退；没有窗口时弹「启动失败」框并退出。
- **就绪后崩溃** → `exit` 事件带 `crashed` + `detail` → `index.js` 的 `reportKernelCrash` 弹「重启内核 / 退出」对话框。**不要改回 `loadURL('about:blank')`**：那会给用户一个没有任何说明、也没有恢复入口的黑屏。

配套的就绪判定同样关键：dsh 是「先绑端口、后加载 plugin tree」，端口能应答 ≠ 内核可用。`#pollReady` 因此要求响应码 < 500，并在宣告就绪前观察 `READY_SETTLE_MS` 确认进程仍存活。少了这一步，插件加载阶段的崩溃会被误判成就绪、后续崩溃被 `ready` 吞掉。

### 就绪 = 能登录，不只是端口通（2026-09-07）

现象：**重启电脑后第一次打开必黑屏，退出重开就正常**，没有任何报错。查了两轮才落地，两个错误方向都值得记下来。

内核的 web 界面是**带鉴权**的：地址行 `dsh web: http://127.0.0.1:<port>/?token=<token>` 里的 token 才是入场券。拿它请求 `/` 会换到一个签名 cookie 并 303 跳到干净的 `/`；不带 token 也没 cookie 的请求，一律 **401**。于是「就绪」的真正含义是**能登录**，而不是端口有应答。

三个坑叠在一起：

1. `#pollReady` 只把 `>= 500` 当成没就绪，**401 被当成活着**。
2. 退回自选端口重试（`#fallbackToExplicitPort`）时，`this.url` 会先被填成不带 token 的裸地址好立刻开始探活。于是探活探到 401 → 判定就绪 → 主窗口拿着这个**永远换不到 cookie 的裸地址**加载 → 打开即黑屏，且不会有任何报错。
3. 探活请求是 `url + '/'` 拼出来的。对裸地址没问题，对带 token 的地址会拼出 `...?token=xxx/` —— token 尾巴多个斜杠，内核照样 401。因为坑 1 把 401 当成就绪，这个错拼一直没暴露。

而这一整套只在**冷启动**才触发：地址行在这台机器上实测要 20.1s / 20.6s / 21.4s（杀毒软件要现扫一万四千多个内核文件），正好贴着当时 20s 的 `URL_LINE_TIMEOUT_MS`——等到就一切正常，差零点几秒就掉进坑 2。「退出重开就好」是因为第二次文件缓存已热，几秒就起来了。

修法与随之定下的规矩：

- **401 不算就绪。** 它的语义是「还没登录成功」，把它当就绪就是把黑屏送到用户面前。
- **地址一律等地址行，任何路径都不填裸地址**（`#launch` 里 `this.url = null`）。端口谁定的不重要，token 只能从那行拿；拿不到就进不去，与其打开一个进不去的窗口，不如报错。
- **探活地址走 `probeUrl()`**（`shared/kernel-boot.js`），用 `new URL` 规范化并保留 query，禁止字符串拼接。`test/kernel-boot.test.js` 钉住这条。
- **两段各自计时**：等地址行 `URL_LINE_TIMEOUT_MS`（45s），拿到地址后探活 `READY_TIMEOUT_MS`（60s）。原先两段共用 30s，等地址行等得越久、留给探活的时间越少 —— 冷启动正是地址行最慢的时候，也正是最不该失去耐心的时候。
- 超时值别再往回缩。**缩短超时不会让慢机器变快，只会把「慢一点」变成「重来一次」**。

**排查方法上的教训**：一开始按「Electron/GPU 驱动在开机瞬间没就绪」查了一轮（这台机器确实有 AMD 显卡软件开机崩溃的日志，看着很像），改完 GPU 崩溃自愈后问题照旧 —— 现象相似不等于同因。真正让案子落地的是**主进程日志落盘**（`shared/file-logger.js`）：打包后双击启动的 GUI 应用没有终端接住 `console.log`，不落盘就等于没有证据，只能靠猜。这类偶发问题，先把日志留下来再动手。

### 内核热更新（`kernel-updater.js`）

`pnpm add` 到 `<userKernel>-staging` → 往隔离 `DSH_HOME` 里播种 profile 插件 → 用那个 home 真 boot 一次 web 自检 → `rename` 原子切换（失败回滚 `-old` 备份）。

**注意「重装插件」这一步已经没有了**：插件不在内核里，换内核不需要动它们。播种是为了让自检覆盖「新内核 + 我们的插件」这个真实组合，不是安装步骤 —— 隔离 home 用完就删。

- 用 pnpm 不用 npm：dsh 依赖闭包庞大且大量 peerDependencies，npm arborist 会耗内存/长时间无响应。`--node-linker=hoisted` 让依赖平铺到 `runtime/node_modules` 顶层。
- pnpm 因「忽略 build scripts」返回非零退出码属正常，靠 `err.ignoredBuilds` 放行；不要把它当失败。
- registry 在 `registry.npmmirror.com` / `registry.npmjs.org` 之间循环切换，选择持久化在 `userData/updater.json`（同文件存 `lastCheck`，自动检查 24h 一次）。
- `onRestart` 里必须先 `dsh.stop()` 再 `app.relaunch()`：`app.exit` 会跳过 `will-quit`，否则留下占端口的孤儿内核进程。

### 系统通知（`notifications.js`）

内核 0.1.2-rc.1 的 `/api/events.mux` 已由 `/api/remote.mux` 取代。它不是一上来就发下行帧：连上后要先用 `{ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }` 打开一路转发事件流，之后收到的 `{ type: 'item', streamId, value }` 里 `value` 才是事件帧。`/api` 全部要求签名 cookie；Electron 主进程的 Node/undici WebSocket 没有 cookie jar，所以 `notifications.js` 先拿地址行 token 请求 `/` 换 cookie，再显式放进 WebSocket 握手头。开发态仍可能用 0.1.1-rc.2 及更早的全局 dsh——那种地址行没有 token，`notifications.js` 会回退到旧 `/api/events.mux`，避免把 HTTP 200 当成鉴权失败反复重连。只在窗口失焦时弹通知，并同时闪烁任务栏。

Windows toast 还要求存在指向本应用、且 AppUserModelID 与 `app.setAppUserModelId` 一致的开始菜单快捷方式；安装版由 NSIS 建，绿色版/win-unpacked 由 `ensureStartMenuShortcut()` 首启补建（已存在则跳过，别改成每次重写——那是启动路径上的冗余磁盘写）。

### 外壳自身版本更新（`app-updater.js`）

跟内核更新（`kernel-updater.js`）是两回事，别混在一起想：内核能在本地热更新替换（下载到用户可写目录、验证后原子切换），外壳是签名安装包 / 绿色版 zip，**运行中替换不了自己的 exe**，也没有中间态可用。所以 `AppUpdateChecker` 只做一件事——查 GitHub 最新 Release（`GET /repos/EasyTZ/dsh-desktop/releases/latest`）、跟 `app.getVersion()` 比对、发现新版就提醒，**不下载、不安装**：装成安装版还是绿色版、什么时候装，都还是用户自己的事。

**不用 `electron-updater`**：本项目定死了「不引第三方运行时依赖」（见「约定」一节），这条规则没有为外壳自更新单开例外；而且差分静默更新原本也要靠签了名的安装包才可靠，绿色版 zip 用不上。

提醒只有两处，都不新开应用内窗口：

- **系统通知**，`AppUpdateChecker._notify` 弹一次——`notifiedVersion` 记进 `userData/app-updater.json`，同一个新版本不会跟着每天一次的自动检查重复弹，那样是骚扰不是提醒。
- **托盘菜单常驻一项**「有新版本 vX.Y.Z」（`tray.js` 的 `appUpdate` 参数），查到就一直显示直到应用重启，不受通知的「只弹一次」节流——它是静态展示，不是主动打扰，用户没看到系统通知的话至少托盘里找得到。

跟内核更新用**各自独立**的节流文件（`app-updater.json` vs `updater.json`）与各自的 24h 间隔常量，互不影响；`_fetchLatestRelease` / `_notify` 拆成可覆盖的方法，测试（`test/app-updater.test.js`）靠换掉这两个方法在不联网、不弹真通知的前提下驱动 `check()`——手法照抄 `kernel-updater.test.js` 换 `_fetchLatest` 那一套。
