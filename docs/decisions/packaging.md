# 打包与发版

## 打包要点

`electron-builder.yml`：`asar` 只打 `src/**` + `package.json`（生产依赖只是 vendor 用的插件 git 依赖，`beforeBuild` 返回 `false` 跳过 install/rebuild）；`kernel/` 与 `plugins-dist/` 走 extraResources（`plugins-dist/profile/` 是 `scripts/pack-profile-plugins.mjs` 用 `npm pack` 打出的 tgz + 索引，首启离线播种、以及用户卸载后从市场装回来都要靠它）；`electronDist: node_modules/electron/dist` 复用本机 Electron。**首次** `npm install`（拉插件 git 依赖）需要联网，lockfile 未变时的重复构建不联网——这是拆仓主动接受的代价。

`collect-release.mjs` 按 `package.json` 的 `version` **精确匹配**产物名，改版本号时 dist/ 里的旧产物不会被误选；结束时还会报一次本次打进包的内核版本（产物文件名上只有应用版本号，而内核是独立升级的另一条线，发布说明里要写「内置内核 x.y.z」）。发版流程：改 `package.json` version → 在 CHANGELOG.md 加一节 → `npm run dist`。

**内核版本闸门**：`package.json` 的 `dshKernel.expected` 声明这一版要发哪个 dsh 内核，`prepare-kernel.mjs` 会核对本机全局 dsh，对不上**直接中止**。为什么需要它：插件是可复现的（钉 tag + lockfile 锁 commit），内核**不是**——它整个来自打包机上的全局 dsh，随手一次 `npm i -g @deepseek-ai/dsh` 就换了，同一个 app commit 在不同时间打包可能装进两个不同的内核，而外面贴的还是同一个应用版本号。用户报「1.4.0 有 bug」时，我们连自己发的是哪个内核都对不上账。升级内核因此变成一次有意的、跟着提交走的改动：改 `dshKernel.expected` 那一行。只想拿别的内核试打包用 `DSH_KERNEL_ANY=1`，那样打出来的包别拿去发布。
