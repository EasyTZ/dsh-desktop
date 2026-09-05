# 插件的开发内环与发版

**顺序很重要**：`pack-profile-plugins` 必须先于 `verify-kernel`。自检要拿它产出的 tgz 把插件播种进隔离 `DSH_HOME`，否则验的是一个「没有插件的内核」，插件加载阶段的崩溃会整个溜过去。`dist` / `dist:dir` 已经排好了顺序，手动分步时要自己注意。

**随包 tarball 只许经镜像使用 —— 这条是不变式，别绕开。** 启动时先把 `plugins-dist/profile/` 的 tgz 与 `index.json` 整份镜像到 `<DSH_HOME>/.dsdesktop/bundled/`，之后所有人只认镜像：播种从镜像装、`DSH_DESKTOP_PROFILE_DIST`（市场的「装回自带插件」读它）改指镜像、清单里已经悬空的 `file:` 依赖按文件名改指镜像。

原因是 pnpm 会把 `file:` 依赖**按绝对路径**记进 profile 的 `package.json`。指向应用安装目录的话，应用一升级里面的 tarball 就换成新版本的文件名（版本号在文件名里），旧路径随之消失；卸载或挪走应用更是直接没了。此后 profile 里**任何**一次 pnpm 操作都会失败——pnpm 解析的是全部依赖，不是只解析这次要动的那个。用户看到的是「插件装不上也卸不掉」，而原因在一个跟他这次操作毫无关系的包上。

真实故障是这么发生的：重打了一次包（0.1.0 → 0.1.1，旧 tgz 被清掉）→ 用户在市场里卸载另一个插件 → pnpm 因为解析不到 market 的旧 tarball 而失败 → 卸到一半：`node_modules` 里的包没了、清单里的 `dependencies` 和 `dsh.profile.bundles` 还在 → 下次启动内核 `cannot resolve profile bundle` 直接退出，反复弹错。

**安全模式在这条路径上是失效的**，这点值得单独记住：它靠第 4 层 patch 给 entry id 压 `disabled: true`，而崩溃发生在 profile **组装阶段**，早于 patch 生效；何况包都没了，连它的 entry id 都读不到。所以这类故障只能在**起内核之前**自愈，不能指望逃生舱。启动路径上因此有三步，顺序不能乱，且整体排在「读随包索引」那步早退之前：镜像 → 修悬空 `file:` → 摘掉「声明了但装不出来」的 bundle 条目。

**插件不再搭内核的车**：`prepare-kernel` 拷的是纯内核，插件走另一条独立的线（tgz → 用户 profile）。升级全局 dsh 不影响插件，改插件也不用重打内核 —— 这正是迁到 profile 层的目的。

### 联调模式解决的是什么问题

先把「为什么需要它」说清楚，细节在下面几节。

插件不在应用里。内核启动时只认一个固定路径找插件：`<DSH_HOME>/profiles/web/node_modules/<包名>/`，
而 Node 找模块是**按物理路径**找的 —— 没有任何配置项能对内核说「这个插件请去 D 盘那个工作副本加载」。
于是形成一个死循环：想验证插件改动，就得让内核加载到新代码；想让它加载到，就得先把插件发布出去；
可你正是想在**发布之前**验证它。

联调把这个循环打破：**把内核要读的那个目录换成一个指向工作副本的 junction**，从此「内核读的目录」
和「你编辑的目录」是同一个。改完存盘就能验证，不必 push、不必打 tag、不必发 npm。

**联调时还要刻意用发行版将采用的内核验证一次。** dsh 0.1.2 的 workspace store 方法开始通过
`this` 读取内部快照；插件若把 `store.subscribe` / `store.getSnapshot` 直接作为裸函数传给
`useSyncExternalStore`，0.1.1 下看似正常，0.1.2 下点击入口才会崩。插件客户端必须用闭包调用
`store.subscribe(...)` / `store.getSnapshot()`，保留接收者；相关 smoke fixture 也必须让方法依赖
`this`，否则测试守不住这条兼容边界。只用机器上碰巧存在的旧全局内核跑 `npm start`，会把这类问题藏掉。

所以它只有两个状态，对应两件不同的事：

| 状态 | 内核跑的是哪份代码 | 用在什么时候 |
|---|---|---|
| 联调（linked） | 同级目录里的工作副本 | 开发、调试插件 |
| 钉 tag（pinned） | `package.json` 钉住的那一版 | 打包发版、体验真实用户拿到的东西 |

**它影响的只是「这台机器上现在跑哪份代码」，影响不到任何交付物**：`dist` 打包前会强制切到钉 tag 态
（见下面「自动解除联调」）。它是开发期的一根临时接线，打包时自动拔掉。

**注意联调是磁盘状态，不是某个进程的运行模式**：junction 铺在 `<DSH_HOME>` 下，重启机器也还在，
直到显式 `unlink-plugins`。而 `DSH_HOME` 缺省 `~/.dsh`、profile 名硬编码 `web`，两处都**没有
`app.isPackaged` 分支** —— 也就是说 `npm start` 和**装好的发行版应用**共用同一个 profile。
开着联调去启动安装版，它跑的同样是你的工作副本。

### 插件拆分后的开发内环

五个通用插件已拆成独立仓库（`EasyTZ/dsh-market`、`dsh-git`、`dsh-terminal-panel`、`dsh-ui-balance`、`dsh-reveal-explorer`），本仓库通过 `package.json` 里的 git 依赖（**钉 tag，不钉分支**——钉分支会让打包不可复现）vendor 进 `node_modules/`。改插件代码的两种方式：

- **发版**：改完插件仓库 → push + 打**新** tag → 回本仓库把 `package.json` 里对应的 `#tag` 升一下 → `npm run refresh-plugins`。**别用 `npm install`**：npm 缓存 git 依赖的解析结果，改了 `#tag` 之后经常不重新拉，装出来还是上一版——表现是「代码明明改了、装完却没变化」，很容易被误当成插件本身的 bug 排查半天。`refresh-plugins` 删目录再按显式 spec 装，绕开这条缓存路径（它也会拒绝在联调模式下运行）。
- **高频联调**：`npm run link-plugins`，改完**直接生效**，不用 push/tag，也没有任何拷贝或重装步骤（改 `lib/client.js` 内核 HMR 立刻推给浏览器，改 `lib/index.js` 重启内核）。`npm run plugins-status` 看当前状态，`npm run unlink-plugins` 解除并按 pin 恢复。

  **它链的是两处，缺一处就是半残**：`node_modules/<包名>`（源码侧 —— `pack-profile-plugins` 的 `npm pack` 和 HTTP 基线测试读这里）和 `<DSH_HOME>/profiles/web/node_modules/<包名>`（运行侧 —— 内核真正 `import` 的是这份）。只链源码侧的话改完代码什么都不会变，这是迁到 profile 层之后最容易踩的一脚。运行侧那份若 profile 里还没装过会跳过并提示先跑一次 `npm start`；`--off` 时运行侧只摘链接不补装，顺手把播种账本里对应的条目删掉，交给下次启动的对账按随包版本装回来。

链接**只换 `node_modules` 里那一个目录，不动 `package.json` / lockfile**——那两个文件是发版凭据，必须始终写着钉住的 tag，不能被联调改脏或误提交。Windows 上用 junction 而非 symlink：前者不需要管理员权限。

**联调链接会被 pnpm 悄悄拆掉，这是它最大的脆弱点。** 只要有任何东西往那个 profile 里写，pnpm 就会
重新 import 全部已链接的包，**把其中一部分或全部 junction 换成实体目录**，具体哪几个取决于它在哪一步
报错。触发源有三个，都很日常：市场面板上的安装/卸载按钮、命令行 `dsh plugin add/remove`、以及应用
启动时的对账。2026-09-03 一天之内撞了两次，两次都是 `@easytz/dsh-market` 被换成实体目录、另外四个
还是 junction，而 pnpm 中途以 `ERR_PNPM_ENOENT` 死掉。

症状是**「改代码怎么都不生效」**，而日志里唯一的线索是一句关于另一个包的 `ENOENT`，跟你正在改的插件
毫无关系 —— 极难自己联想到链接被拆了。应对只有一条：**任何东西往 profile 写过之后，跑一次
`npm run plugins-status`**，哪一行变回「运行 钉 tag」就重跑 `npm run link-plugins`。

开发**插件市场**时格外容易踩：面板上那两个按钮走的正是 `dsh plugin add/remove`，而你正是在用它测它。

**启动对账曾经必然拆掉市场的链接（已修，`planProfileReconcile` 的 `isLinked`）**：市场是随包清单里唯一
`required: true` 的，判据是「实际版本 ≠ 随包版本就装」。联调下「实际版本」读到的是工作副本
`package.json` 里那个号，而工作副本但凡领先随包 tgz 一个版本（开发期这是常态），判据就必然成立 ——
于是**每次启动**都把 junction 换成 tarball 解出来的实体目录。对账现在跳过所有联调链接；发行版里不存在
junction，那个分支永远不命中，`required` 的自愈语义没有被削弱。详见 profile-plugins.md。

**联调可以常开**：`dist` / `dist:dir` 走 `scripts/dist.mjs`，它自己会临时解除联调、用钉住的版本打包、结束后再恢复（`try/finally`，打包失败也恢复——否则人会在「以为还在联调」的状态下改半天不生效）。日常不需要手动 `unlink-plugins`。

打包必须用钉住的版本，因为 `pack-profile-plugins` 的 `npm pack` 打的是 `node_modules` 里**当前**那份：联调下那是指向工作副本的 junction，于是未提交的改动会被原样打进 tgz，而版本号仍写着 tag 的号——产物自称 v0.1.1、内容却不是 GitHub 上的 v0.1.1，事后既复现不了也追溯不了。`verify-plugin-pins.mjs` 仍留在链条里当兜底（检查一个符号链接就够了：不是链接就说明那份是 npm 按 lockfile 从钉住的 commit 拉的，本身可复现）。

**自动解除联调有个反向陷阱，`dist.mjs` 专门挡了**：插件工作副本若有未提交/未打 tag 的改动，解除后拉回的是钉住的旧版本，打出来的包**不含你的改动**，而你以为含——和「打出不可复现的包」是同一枚硬币的两面，产物都不是你以为的那个。所以解除前先核对：工作区干净、且 HEAD 正好落在 `package.json` 钉住的那个 tag 上，两者内容一致才放行；对不上就中止并告诉你该先去插件仓库收尾。

**这道核对原先整段包在「检测到联调」的分支里，等于把保险挂在联调状态上，而不是挂在打包这个动作上。**
可「插件改了、tag 还没打，于是产物里是旧版本」跟联调开没开毫无关系 —— 联调关着照样会发生，
而且**一声不吭**，比开着更危险（开着至少会中止）。现在非联调态也核对，只是**降级成警告**：
非联调态下「插件仓库有 WIP、但这次就是要用钉住的版本打包」是完全正当的用法（在做插件的下一版，
同时要发一个只改了外壳的应用版本），中止会把这条正当路径堵死；而联调态下同样的偏差要中止 ——
那时你一直在用工作副本调试、产物却是另一份，落差最大、最容易自欺。

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

- `dependencies` 不再为空（5 条插件 git 依赖），但这些依赖只被 vendor 源码、从不被运行时 require——真正跑插件的是内核进程里的那份拷贝。也因此根安装不解析插件的 peer（`.npmrc` 开了 `legacy-peer-deps`，插件 peer 由内核提供）。
- 首次拉取插件 tag 需要联网；lockfile 未变时重复构建仍不联网。

**lockfile 里插件的 `resolved` 是 `git+ssh://git@github.com/...`，这不是问题，别再去"修"它。** npm 的 `hosted-git-info` 对 GitHub 托管的依赖一律归一化成 ssh 形式写进 lock，把 `package.json` 的 spec 显式改成 `git+https://...` 也会被它改回 `github:` 简写。担心的是「新机器 / CI 没有 SSH key 时 `npm ci` 失败」—— 实测过了：**全新 npm cache + `GIT_SSH_COMMAND="exit 1"`（ssh 确认不通）下 `npm ci` 照样成功**，npm 对 hosted 依赖会自动回落到 https。测法：拿一个只含插件依赖的临时 `package.json` 生成 lock，`rm -rf node_modules` 后带上面两个条件跑 `npm ci`。

路径覆盖环境变量（脚本与 DshService 共用同一套探测逻辑）：`DSH_INSTALL_DIR`、`DSH_NODE_EXE`、`DSH_BIN_JS`、`DSH_PNPM_DIR`。
