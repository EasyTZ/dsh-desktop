# profile 层插件

### 自定义插件契约（最容易出错的地方）

**插件是用户的东西，不是内核的一部分。** 随包插件全部住在 `$DSH_HOME/profiles/web/`（patch 层栈的**第 2 层**，dsh 官方的 profile 层），由 pnpm 装成独立的包，自己 `insert` 自己的 loader 条目。桌面版只做三件事：**首启把随包的 tgz 装进去**、**按用户开关压一层停用 overlay**、**给插件市场提供装/卸的入口**。

这条边界是唯一的裁决标准，判据是**生命周期归谁**：跟着内核走的（换内核就没、用户删不掉）归内核；跟着用户走的（换内核还在、用户能自己删）归 profile。插件属于后者，所以：

- 换内核不影响插件 —— 它们根本不在内核目录里；
- 用户能在市场里卸载**任何**插件（`@easytz/dsh-market` 除外，见下）；
- 别人 `dsh plugin add @easytz/dsh-git` 装到的，和桌面版内置的是**同一个东西、同一种装法**。

（历史包袱已清空：曾经有一套「拷源码进内核 `node_modules` + 登记进内核 `package.json` + overlay 里 `- insert:`」的机制，随之而来的 `plugins/plugins.json`、`plugin-install.js`、`plugin-state.js`、`install-plugin.mjs`、`pack-plugins.mjs` 现已全部删除。它的问题不是不能跑，而是插件的命运被绑在内核上：内核一更新插件就得重装，用户也永远删不掉。别再重新引入。）

**清单**：`plugins/profile-plugins.json`，只有 `packageName` 和可选的 `required`。校验在 `loadProfilePluginManifest`（合法包名形状 + 不许重复）—— 包名会被摊进 `path.join`，不校验等于把「操作哪个目录」交给清单文本。

**`required: true` 只给 `@easytz/dsh-market`**：它是插件的管理入口。对账时只要缺失或版本落后于随包版本就会被强制装回，这正是「卸载市场也能自愈」的机制来源——市场自己的卸载接口不再挡自己（`PROTECTED_PACKAGES`），因为卸了也会在下次启动前被这条对账逻辑自动装回来。**不降级**：市场自己就是「一键更新」按钮的来源，用户在应用内把市场更新到比随包版本更新的版本后，这条自愈逻辑曾经会在下次启动时把它拉回随包版本——表现是「点了更新、重启后又变回旧版，且『有更新』提示还在」，已修（见 `planProfileReconcile` 的判据，跟非 required 插件「只升级不降级」是同一条）。真正的单向门是**停用**：那条走的是 overlay patch 而不是对账，市场的停用接口仍然把自己列进保护名单，因为停用没有对应的自愈路径。其余三个是**播种一次**：首启装进去，用户卸载了就不再自动装回来，但市场的「随应用分发」分组里随时能一键装回。

**播种账本**（`userData/profile-plugins-seeded.json`）是「从没装过」和「装过但被用户卸了」的区分手段 —— 同一随包版本缺失时尊重用户卸载；但桌面版带来更高的随包版本、而插件仍缺失时会重新播种默认插件。这样旧版、联调或历史安装失败留下的账本不会让默认插件永远消失，用户也仍可在新版中再次卸载。

**对账**（`reconcileProfilePlugins`，挂在启动路径上）：先按 entry id 清历史残留、再装。顺序不能反 —— 改名场景下新旧两个包声明同一个 entry id，先装会让 profile 短暂处于「两个都在」的状态，中途被打断下次启动就是 `duplicate loader entry id` + 黑屏。清不掉就**不装**（宁可少几个插件，也不要一个打不开的应用）。常态开销为零：版本一致时只读两个 `package.json` 就返回，不 spawn 任何进程。失败**不阻塞启动**。

**entry id 一律带 `dsdesktop-` 前缀**（每个插件自带的 `cordis.patch.yml` 里写）。`- insert:` 不去重，我们的 id 若与上游 bundle 里某条同名就是 `duplicate loader entry id` → 内核秒退。上游 130+ 个 id 里大量是 `git` / `session` / `settings` / `storage` 这类通用词，而内核会自己热更新 —— 不加前缀撞车只是时间问题，且发生在用户机器上、表现为黑屏。前缀取 `dsdesktop-` 而非 `desktop-`：上游已有 web / tui / headless 三个 surface，将来真加一个 desktop surface 时 `desktop-` 可能被它用掉。

**开关**：状态在 `userData/plugin-state.json`（`entryId → boolean`，只记偏离，缺省为启用）。写者是市场插件的 node 半（跑在内核进程里，靠 `DSH_DESKTOP_PLUGIN_STATE` 找到文件，绝不硬编码 `%APPDATA%`）；读者是 `src/shared/activation-patch.js`。**读不出来按「全部启用」处理** —— 状态文件损坏该表现为「插件都在」，而不是「插件都不见了」，后者没有任何提示能解释原因。

**停用只能靠 overlay**：profile 层插件是自己 insert 自己的条目的，我们既插不了也删不掉，唯一手段是从第 4 层压一条 `- id: X` + `disabled: true` 覆盖它（dsh 自己关遥测走的就是这条路，见 `resolveTelemetryPatch`）。所以 `userData/desktop.patch.yml` 现在**只做停用**，常态下是一份空的 `[]`（空文件会让 dsh 解析报错，必须写 `[]`）。`entryIdsForPackage` 负责「包名 → entry id」的桥接：读 profile 里那个包自带的 `cordis.patch.yml`。**只 patch 真实存在的 id** —— 用户卸载一个曾经停用过的插件之后，状态文件里那条 `false` 就是个不存在的 id。

**安全模式**：停用**除市场外的全部** profile 插件（`RECOVERY_PACKAGES`）。这是「插件把内核搞崩」唯一的逃生舱 —— 那类故障没有别的自愈路径，回退内置内核没用（插件在用户 profile 里，跟内核无关）。两个入口：崩溃对话框上的第三个按钮，以及托盘 / macOS 应用菜单上常驻的「进入安全模式」（`toggleSafeMode`）—— 后者是补的：「插件装完界面卡死 / 白屏但内核没退」这类故障不会触发崩溃对话框，用户没有任何入口能把插件关掉。托盘入口只重启**内核**（不 relaunch 整个应用），进之前先弹确认框，因为它会刷掉正在看的页面。三条设计约束：只存在于内存（`index.js` 的 `safeMode` 变量），重启应用即恢复正常 —— 所以托盘上的「退出安全模式（重启应用）」就是 `restartApp`，不需要第二份状态、也没有别的清理；**完全绕开用户开关判定**（插件集在那一步已选定，再过一遍开关只可能把恢复入口本身滤掉，而这功能恰恰是在「开关状态可能有问题」时用的）；外壳注入 `DSH_DESKTOP_SAFE_MODE=1`，市场面板据此显示提示条。进出安全模式都要 `refreshDesktopMenus()`：托盘、mac 应用菜单、Dock 菜单上那一项的文案跟着状态切换，三处由同一份 `trayMenuOpts()` 重建。

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

### 现有的四个插件

四个插件**全部**已拆仓、全部走 profile 层、全部可被用户卸载（市场除外）。本仓库通过 git 依赖 vendor 在 `node_modules/@easytz/` 下，只为打 tgz；运行时用的是用户 profile 里那份。

| 插件 | entry id | 干什么 | 接入的槽 |
|---|---|---|---|
| `@easytz/dsh-ui-balance` | `dsdesktop-balance` | 每条回复下方显示 DeepSeek 余额 | `conversation.chat.turnTail` |
| `@easytz/dsh-git` | `dsdesktop-git` | Git 面板（改动/暂存/提交/推送/切分支/撤销） | `sidebar.footer.action`（`order: 100`）+ `shell.overlay` |
| `@easytz/dsh-terminal-panel` | `dsdesktop-terminal-panel` | 终端面板（命令控制台） | `sidebar.footer.action`（`order: 90`）+ `shell.overlay` |
| `@easytz/dsh-market` | `dsdesktop-market` | 插件市场：已安装列表（分「随应用分发」/「从市场安装」两组）+ npm 检索 + 一键装卸 + 热开关 + 图片预览。`required: true`，无法卸载；安全模式下唯一加载的插件 | `sidebar.footer.action`（`order: 110`）+ `shell.overlay` |

**槽的两条通用规则**（翻上游类型声明与 frontend bundle 得来）：

- `list` 槽排序是 `(priority ?? 0)` 然后 `(order ?? 0)`，**都是升序，数字小的在上面**。`order` 是排位用的，`priority` 是遮蔽（shadowing）用的，别拿 `priority` 调顺序。
- **`shell.overlay` 默认 click-through**，条目必须自己 opt back into pointer events；而**关闭态必须 `pointer-events:none`** —— `opacity:0` 的元素照样拦点击，漏了这条就是「面板关着却点不动底下的 dsh」。`details` 与 `sidebar` 是 `single` 槽且已被上游占用，注册进去会替换整列，**禁用**。

### 插件市场（`@easytz/dsh-market`）的几条硬知识

它是唯一 `required: true` 的插件，也是整个插件体系的管理入口，所以它的失败模式比别的插件严重一档。

**对账跳过联调链接（`planProfileReconcile` 的 `isLinked` / `isLinkedIn`）。** 上面这条「实际版本 ≠ 随包版本
就装」的判据，在开发机上会跟联调打架：联调下「实际版本」读到的是工作副本 `package.json` 里的号，而工作
副本但凡领先随包 tgz 一个版本（开发期这是常态），判据就必然成立，于是每次启动都把市场的 junction 换成
tarball 解出来的实体目录 —— 联调静默失效，症状是「改代码怎么都不生效」，日志里只有一句关于别的包的
`ERR_PNPM_ENOENT`。所以对账现在先问一句「这个包在 profile 里是不是一个链接」，是就整条跳过。
发行版里不存在 junction，这个分支永远不命中，`required` 的自愈语义没有被削弱。开发侧的完整背景见
plugin-dev-loop.md。

**「卸载」在 dsDesktop 里现在是一次假卸载——这是最新的一次改动，别按旧版本的记忆去改。**

裸 dsh 环境（没有 `DSH_DESKTOP_PLUGIN_STATE`）走的还是原始设计：市场是 `required: true` 的随包插件，`planProfileReconcile` 会在每次启动前比对「实际装的版本」跟「随包版本」，缺失或落后就装回去（比随包版本更新则不动，那是用户自己更新的，不降级），卸载市场的后果是「下次重启前自动装回来」——`protectedPackages()`（卸载保护名单）因此不含市场自己，理由没变。

**但在 dsDesktop 里，`handleUninstall` 会在真正调用 `pnpm remove` 之前把市场自己的请求拦下来**（见 `dsh-market/lib/index.js` 的 `handleSelfUninstall`）：不删文件、不动 `dependencies`/`dsh.profile.bundles`，只是把自己的 entry id 写进跟别的插件共用的那份停用状态——跟「停用」走的是**同一个**覆盖层机制，只是用户点的按钮写着「卸载」。这么改是因为纯粹的「装回来」式自愈换来一个用户不想要的副作用：市场自己发的「一键更新」按钮点了之后，重启会被对账逻辑按版本号拉回随包版本（这条已经改成不降级修掉了，见 `planProfileReconcile` 的注释），但**卸载**这件事本身——用户明确点「卸载」就是想让它消失，不该在下次重启时被自动装回来烦人。

**`RECOVERY_PACKAGES` 的排除名单因此改成只在安全模式下才生效**（见 `dsh-service.js`）：正常模式不排除，市场能被这条假卸载真正停掉（`disabled: true` 会生效）；安全模式下换回排除，不管市场当前是不是被假卸载了，都强制当作「不停用」，保证逃生舱里市场永远在——**这也是用户唯一能把这条状态改回来的入口**：安全模式下市场正常加载，检测到自己被停用会专门显示一个「重新启用插件市场」按钮（`client.js` 里那个只在「安全模式 + 自己被停用」时才出现的分支），点了写回启用状态，走的是 `/profile-plugins/toggle`——这条接口原本无论方向都挡着市场自己，现在只挡「停用」方向，「启用」方向必须放行，否则这个恢复入口会把自己先锁死。

停用保护名单（`disableProtectedPackages()`）本身**没有变**：市场的开关在 UI 上仍然是隐藏的，「卸载」按钮是唯一能触发这条假停用的入口，不想让普通的开关也能碰它——那样会有两个用户猜不到差异的入口做同一件事。

**检索走 npm，不走 GitHub。** `registry.npmjs.org` 的 `-/v1/search` 按 `keywords:dsh-plugin` 检索（当前 3400+ 个包），GitHub 只用来补充 README 里的图片。理由：npm 是插件真正的分发渠道，包名、版本、`dsh.bundle` 声明这些**决定能不能装**的信息只有 registry 有；GitHub 那边搜到的仓库未必发过包。下载量走 `api.npmjs.org`，注意**它不支持 scope 包的批量接口**，scoped 包只能逐个查或干脆不显示。

**`installability` 的硬门槛只有一条**：`dsh.bundle.patch` 存在。没有它的包装上也永远不激活（见「写一个 dsh 插件」），与其让用户装完发现没反应，不如在列表里就标成不可安装。

**图片有三道关**：只认白名单域名、拒绝 badge 类 URL（shields.io 那种，全是徽章没信息量）、相对路径按仓库 raw 地址补全。国内 `raw.githubusercontent.com` 常年不通，面板里给了镜像开关，选择存在插件自己的设置里。

**已安装页分三组**，判据是「用户能拿它怎么办」而不是「它从哪来」：

| 组 | 装的是什么 | 有卸载按钮吗 |
|---|---|---|
| 桌面自带 | `removable: false` 的，只有宿主产品包（`@deepseek-ai/dsh` 等）——市场自己不在这一组 | 没有，标「桌面版内置，无法卸载」 |
| 随应用分发 | `profile-plugins.json` 里**当前没装**的那几个 | 给的是「装回来」（用随包 tgz，离线可用）；市场自己因为是 `required: true`，就算被卸载也不会出现在这一组——它靠启动时的对账自动装回，不需要也不会给这个手动按钮 |
| 从市场安装 | 其余全部，含用户自己从 npm 装的，以及市场自己 | 有；市场自己这一行没有停用开关（见上面「自锁保护」） |

已经装着的自带插件（含市场自己）就出现在第三组里，和 npm 装的混在一起 —— 这是故意的，它们本来就是同一种东西。第二组只在「有自带插件被卸掉了」时才出现。

**开关和卸载不共用状态、也不放同一排**。装卸是「一次一个、服务端串行跑 pnpm」，开关只是写一行 JSON、可以连点几个；混用状态会让开关被 pnpm 的忙状态挡住。排版上卸载是 `.dsmkRowFooter` 里一个独立的描边按钮，实机反馈过挤在一排容易误触。

**装/卸/开关都要重启内核才生效**，面板里必须明说。profile 的 bundle 层和停用 overlay 都只在 boot 时读一次，装完不重启就是「列表里有了、功能没有」，用户会以为装失败。

**客户端半必须有冒烟测试**（`test/client-smoke.test.js`），而且那个假 React 必须是**真的会渲染的**。写成「useState 原样返回初值 + useEffect 空函数」的空壳版，面板会永远停在 `status: "loading"` 的早退分支上，真正复杂的那棵树一行都不执行 —— 加这个测试时它一口气抓出三个已经躺在代码里的自由变量 bug（`desktop.plugins`、裸 `safeMode`、没声明的 `toggleError`），换成空壳版一个都抓不到，却照样全绿。详见该文件顶部的注释。
