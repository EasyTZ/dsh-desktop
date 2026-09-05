# 上游与分层

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

**这一节原先是「Mac 的工作清单」，现在是「验证结果」。** 完整叙事见 [multiplatform.md](multiplatform.md)，这里只留跟分层有关的结论。

当初的判断是「平台假设集中在 L4 与 `kernel-paths.js`，**L1 / L2 无需改动**」。Windows + Linux 都做完之后回头看，这个判断**基本成立，但漏了一条**：

- ✅ **L2（五个插件）一个字节都没改。** 零依赖、无原生模块，`dsh-reveal-explorer` 与 `dsh-terminal-panel` 本来就写了 darwin / linux 分支。
- ✅ **L4 的活确实有限。** `kernel-paths.js` 收编了 `NODE_BIN`（原先五处各自拼 `node.exe`）；`taskkill` / `setAppUserModelId` / `ensureStartMenuShortcut` 的平台守卫当初就写对了，没动。
- ❌ **漏判的一条：L1「只读」不等于「跨平台自动成立」。** 内核树整个来自打包机的全局安装，而 dsh 有四族按平台解析的 `optionalDependencies`——Windows 机器上只有 `*-win32-x64`，别的平台压根没装进来。这是「一直以来只能出 Windows」的真正根因，也是这次最大的一块改动（改成按目标平台 `npm ci`）。
  > 教训：**「不改上游一行代码」保证的是 L1 的内容不变，不保证它在别的平台上装得出来。** 判断跨平台成本时，「我们不碰它」和「它跟平台无关」是两件事。

L3（preload 注入的标题栏）在 Windows / Linux 上无差别；macOS 要给红绿灯让位（`trafficLightPosition`），那部分随 mac 一起暂缓。

### 仍然待做

- **向上游提 slot PR**（各 UI 包声明了几十个槽，但没有窗口 chrome 的）。落地后标题栏从 L3 的 DOM 注入变成 L2 的客户端插件，上面「已知偏离」的第 1 条连同 `padding-top` 一起消失。
- **macOS** —— 见 [multiplatform.md](multiplatform.md) 末节。前置全部就绪，卡在借机器和签名实测上。
- **不做 universal 包**（mac）：`.app` 里塞的是 arch 特定的 `.node` / `rg` / `node`，universal 要么装两套内核树（体积 ×2），要么对整棵树 lipo（不现实）。只出 arm64。
- **Linux 桌面集成没验过**：系统托盘（libappindicator）与 AppImage 双击，验证机是 headless 的，只能确认「没崩」，不能确认「工作正常」。
