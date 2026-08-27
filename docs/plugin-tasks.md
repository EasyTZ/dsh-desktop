# 任务书：插件管理面板 + 插件仓库拆分

面向接手的 agent。两个任务**互相独立、可并行、不存在依赖关系**，可以分别交付。

阅读顺序：先读仓库根的 `CLAUDE.md`（尤其「四层模型」「自定义插件契约」两节），再读本文件。`CLAUDE.md` 里的铁律对本任务书全部有效，本文件不重复它，只补充这两个任务特有的事实与约束。

---

## 共同背景：插件现在是怎么装上去、怎么被打开的

这两件事在本项目里是**分开的两步**，务必先分清，否则两个任务都会走偏。

### 第一步「装」——把源码放进内核能解析到的地方

唯一实现在 `src/shared/plugin-install.js`，两条调用路径共用：

| 路径 | 位置 | 场景 | 目标目录布局 |
|---|---|---|---|
| 构建期 | `scripts/install-plugin.mjs` | 装进本机全局 dsh | 嵌套 |
| 运行期 | `src/main/kernel-updater.js:359` `_installPlugins()` | 装进热更新出的新内核 | hoisted |

`installPlugin()` 做且只做两件事，缺一不可：

1. `copyPluginSource()` —— 把插件源码 `cpSync` 到目标 `node_modules/<packageName>`；
2. `registerDependency()` —— 把插件登记进 dsh 的 `package.json` 的 `dependencies`。

第 2 步是硬约束（dsh 靠 `healProfilesModuleFallback` 遍历依赖闭包建解析软链），漏了就是 v1.1.1 黑屏事故。

### 第二步「打开」——生成激活 overlay

`renderActivationPatch()` 按清单生成 `- insert:` 条目，`writeActivationPatch()` 落盘到 `userData/desktop.patch.yml`（`src/main/index.js:49` 的 `ACTIVATION_PATCH_PATH`），启动时经 `--patch` 交给内核，作用在 patch 栈第 4 层。

有**两个写者**，写的是同样的内容，改动时必须同步：

- `src/main/dsh-service.js:220` `#prepareActivationPatch()` —— 正常启动路径
- `src/main/kernel-updater.js:390` `_activationPatch()` —— 热更新自检路径

### 清单

`plugins/plugins.json` 是唯一数据源，当前形如：

```json
[
  { "srcDir": "dsh-ui-balance",     "entryId": "balance" },
  { "srcDir": "dsh-git",            "entryId": "git" },
  { "srcDir": "dsh-reveal-explorer","entryId": "reveal-explorer" },
  { "srcDir": "dsh-terminal-panel", "entryId": "terminal-panel" }
]
```

`srcDir` 是相对 `plugins/` 的目录名，`entryId` 是激活条目的 cordis loader entry id。

---

# 任务 A：插件管理面板（可开关插件）

## A.1 目标

做一个新的 dsh 插件，提供一个面板，列出当前所有自定义插件，可以逐个开 / 关。关掉的插件下次内核启动时不再被激活。

**明确不做**：零重启的真·热切换。理由见 A.3，那是刻意排除的范围，不是没做完。

## A.2 为什么是「重启版」——已验证的内核事实

dsh 内核**确实自带热重载机制**，但它管不到我们这层。证据在发行包里（`kernel/runtime/node_modules/@deepseek-ai/dsh/lib/profile-boot-DG5t9aNs.js`）：

`runProfile()` 在 boot 之后挂了 hmr 插件，并调了两次 `watchUserPatches`（约 264–273 行）：

```js
await watchUserPatches(ctx, { binName: NAME, filename: composed.profile.patchPath, compose: composeLive });
await watchUserPatches(ctx, { binName: NAME, filename: homePatchPath(),           compose: composeLive });
```

被 watch 的只有两个文件：

- `composed.profile.patchPath` —— patch 栈**第 2 层**（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）
- `homePatchPath()` —— patch 栈**第 3 层**（`$DSH_HOME/cordis.patch.yml`）

而我们的 overlay 属于**第 4 层**（`composed.overlays`），在 `boot()` 时经 `structuredClone(allPatches(composed))` 一次性快照进去（约 247 行）。

**结论**：改 `desktop.patch.yml` 不会触发任何重载，内核对它的改动完全无感。想要零重启，唯一路径是去改用户的第 2 / 3 层文件——那两个文件不是我们的（第 2 层是用户 profile、第 3 层是用户机器级偏好），往里写东西违反 `CLAUDE.md` 的分层，且 `- insert:` 不去重、id 撞了内核会**秒退**（与 v1.1.1 同类的致命失败）。

所以：**切换后走重启内核，不要试图去写用户的 patch 层。**

## A.3 实施要求

### 数据模型

在 `plugins/plugins.json` 的条目上加一个可选字段表达「默认是否启用」（例如 `enabled`，缺省视为 `true`，保持对现有清单的向后兼容）。

用户的实际开关状态**不能写回 `plugins.json`**——那是仓库里的文件，打包进 asar/extraResources 后运行时不可写。状态要落在 `userData` 下的一个独立 JSON（例如 `userData/plugin-state.json`），形如 `{ "<entryId>": false }`，只记录被用户改过的项。

最终「某插件是否激活」= 清单默认值，被用户状态覆盖。这个合并逻辑**必须放在 `src/shared/`**（纯 Node、可单测），不要写进主进程或插件里。

### 生效路径

`renderActivationPatch()` 增加过滤：被关掉的插件不生成 `- insert:` 条目。注意它现在的签名是 `(pluginsDir, plugins)`，需要把「用户状态」传进来——两个写者（`dsh-service.js` / `kernel-updater.js`）都要同步改，不要只改一个。

**「装」这一步不要动**：被关掉的插件源码照样拷贝、照样登记依赖，只是不激活。理由：登记依赖是 `healProfilesModuleFallback` 的输入，随意摘除会引入新的解析失败面；而且重新打开时不需要再装一次。

### 重启

复用 `kernel-updater.js` 里 `onRestart` 已经验证过的顺序：**先 `dsh.stop()` 再 `app.relaunch()`**。`app.exit` 会跳过 `will-quit`，直接 relaunch 会留下占着端口的孤儿内核进程。

### UI

新插件放在 `plugins/dsh-plugin-manager/`（目录名与包名按任务 B 最终确定的命名规则来，若两个任务并行，以任务 B 的规则为准）。

- 槽的选择：`sidebar.footer.action` 已经被 git（`order: 100`）和 terminal-panel（`order: 90`）占了两个位置，footer 再加第三个按钮会让 `[class*="footerActions"]` 那条弱耦合的布局问题更严重（见 `CLAUDE.md`「已知偏离」第 2 条）。**优先考虑挂到别处**，或与现有入口合并。挂 `shell.overlay` 做面板本体是可以的。
- 面板需要向主进程要「当前状态」并写回。插件的 node 半跑在内核进程里，**碰不到 Electron API**，所以状态文件的读写要么由 node 半直接操作文件系统（路径需要通过环境变量或启动参数传给内核），要么走 webServer 路由 + 主进程。选前者更简单，但要注意路径必须由主进程注入，**不要在插件里硬编码 `%APPDATA%` 路径**。
- UI 里要明确告诉用户「切换后需要重启内核生效」，并提供重启按钮，不要让用户以为点完就生效了。

### 必须遵守

- 不写 JSX，直接调 `jsx()` / `jsxs()`（本项目无编译步骤）。
- 样式自己注入 `<style>`（按 `data-plugin-css` 去重），颜色用 dsh 设计 token。
- `shell.overlay` 关闭态必须 `pointer-events:none`。
- 照抄 `test/terminal-client-smoke.test.js` 写一个客户端冒烟测试——`lib/client.js` 不在 typecheck 范围内，TDZ 类错误只有真跑组件才暴露。

## A.4 验收标准

- [ ] `npm test` 全绿，且新增了覆盖「状态合并逻辑」和「关掉的插件不出现在 overlay 里」的用例
- [ ] `npm run typecheck` 0 错误
- [ ] 新插件有客户端冒烟测试
- [ ] 关掉一个插件 → 重启 → 该插件的 UI 确实消失；重新打开 → 重启 → 恢复
- [ ] 全部关掉的极端情况下，`renderActivationPatch` 产出的仍是合法 YAML（现有实现在空清单时输出 `[]`，这条路径要保留并测到）
- [ ] `desktop.patch.yml` 里不出现被关掉的插件 id
- [ ] 用户的 `$DSH_HOME/cordis.patch.yml` 与 profile 层 patch 文件**未被写入任何内容**（可人工确认）

---

# 任务 B：把四个插件拆成独立 GitHub 仓库

## B.1 目标

让**本仓库之外的 dsh 用户**能独立获取、安装这四个插件。拆完之后插件源码**只有一份**，在各自的独立仓库里；本仓库通过依赖引用它们，不再保留可编辑副本。

四个插件：

| 当前目录 | 当前包名 | entryId | 一句话 |
|---|---|---|---|
| `plugins/dsh-git` | `@deepseek-ai/dsh-git` | `git` | Git 面板 |
| `plugins/dsh-terminal-panel` | `@deepseek-ai/dsh-terminal-panel` | `terminal-panel` | 终端面板 |
| `plugins/dsh-ui-balance` | `@deepseek-ai/dsh-ui-balance` | `balance` | 余额显示 |
| `plugins/dsh-reveal-explorer` | `@deepseek-ai/dsh-reveal-explorer` | `reveal-explorer` | 在资源管理器中打开 |

## B.2 先决条件：必须改包名

四个插件的 `package.json` 现在都用 `@deepseek-ai/*` —— 那是**上游 DeepSeek 的 npm scope，我们没有发布权限**。原样推成公开仓库，等于让人误以为这是 DeepSeek 官方包。

**已决定：去掉 scope，改用裸包名。** 例如 `dsh-git`、`dsh-terminal-panel`、`dsh-ui-balance`、`dsh-reveal-explorer`（最终名以仓库创建时确定的为准）。

改名同时要注意：

- 只改插件**自己的** `name` 字段。`dsh.client.inject` 和 `peerDependencies` 里的 `@deepseek-ai/dsh-client-*`、`@deepseek-ai/cordis` 等**是真实的上游包，一个都不能改**。
- `copyPluginSource()` 按 `packageName.split('/')` 决定落盘路径，裸包名会从两层变一层，功能上没问题，但要确认 `registerDependency` 与内核解析都正常。

### 关于「用官方 scope 才能在插件列表里被找到」

**这个说法不成立，已在代码层面验证**：在打包进本仓库的这份内核里搜索 marketplace / 插件注册表 / 插件列表相关实现，**没有任何「插件市场」或按 scope 过滤的发现机制**。`dsh plugin add <pkg>` 只是把包名原样转给 pnpm，不查任何官方清单。

上游 README 里提到的唯一发现渠道是**给 GitHub 仓库打 `dsh-plugin` topic**，这是纯 GitHub 层面的约定，与 npm scope 无关。用裸包名不影响可发现性。

（此结论基于当前打包的内核版本；若上游未来新增了 scope 相关机制，需重新评估。）

## B.3 实施步骤

### 1. 建仓库

在 `EasyTZ` 账号下创建 4 个**公开**仓库。每个仓库要有：

- 插件源码（`lib/`、`package.json`）
- `LICENSE` —— 沿用 MIT，与本仓库一致
- `README.md` —— 见下方 B.4，这是外部用户唯一的说明书
- GitHub topic：`dsh-plugin`（上游点名的发现渠道）
- 至少一个 tag（如 `v0.1.0`）供外部固定版本引用

保留 git 历史是加分项（`git subtree split` 可以做到），但不是硬要求。

### 2. 改本仓库的依赖引用链

这是改动面最大的部分，涉及以下文件，**全部要改，漏一处就是打包出来的产物里没有插件**：

| 文件 | 改什么 |
|---|---|
| `package.json` | 新增 4 条 git 依赖，**必须钉 tag 或 commit，不能钉 `#main`**——钉分支会让打包不可复现 |
| `plugins/plugins.json` | `srcDir` 字段语义改变（从「`plugins/` 下的目录名」变成「包名」），建议改名为 `packageName` |
| `src/shared/plugin-install.js` | `pluginSrcDir` 的解析从 `plugins/<srcDir>` 改为 `node_modules/<packageName>`；`renderActivationPatch` 里 `readPluginPackage` 的路径同理 |
| `scripts/install-plugin.mjs` | 同上，路径解析跟着改 |
| `src/main/kernel-updater.js:374` | 同上 |
| `electron-builder.yml` | `extraResources` 里 `from: plugins` 这条源头变了。**热更新后重装插件依赖这份打进包的源码，必须确保它还在包里** |
| `test/plugin-install.test.js` | `:124` 有 `assert.ok(p.srcDir, 'srcDir 必填')`，字段改名后必须同步 |

### 3. 本地开发联调（推荐配置）

拆完后，如果每改一行插件代码都要 push + 打 tag + 回本仓库升版本号，开发内环会明显变慢。建议配置 `npm link`（或 `file:` 协议）把 `node_modules/<插件包名>` 指向本机的插件仓库工作副本，改完立刻能测；只在真正要发版时才 push + 打 tag，然后回本仓库更新钉住的版本号。

把这个流程写进本仓库 `CLAUDE.md` 的「常用命令」附近，否则下一个人会不知道怎么改插件。

### 4. 更新文档

`CLAUDE.md` 里这些说法拆分后会**过时，必须改**：

- 「`plugins/plugins.json` 是唯一清单（`srcDir` / `entryId`），新增插件只加一项」
- 「`prepare-kernel` 是整目录 `cpSync`，插件源码与依赖登记是搭便车进入内核的」（顺序约束是否仍成立需重新确认）
- 「不引第三方运行时依赖，保持 `dependencies` 为空」——**这条会被打破**，`dependencies` 里将出现 4 条插件依赖
- 「`electronDist: node_modules/electron/dist` 复用本机 Electron，打包不联网」——**这条也会被打破**，首次拉取插件 tag 需要联网（lockfile 未变时的重复构建仍不联网）

后两条是本次拆分**主动接受的代价**，要在 `CLAUDE.md` 里写清楚是权衡结果，不是待修的 bug。

## B.4 每个插件仓库的 README 必须写什么

外部用户拿到裸插件后，最容易卡住的地方是：**「装进去」和「打开它」是两件事**。

`dsh plugin --profile <name> add <pkg>` 只完成「装」。「打开」需要往 patch 文件里加一条 `- insert:` 条目——这段 YAML 在本项目里是由私有的 `renderActivationPatch()` 生成的，外部用户没有这个函数，必须照着文档手写。

所以每个 README 至少要有：

1. 这个插件是做什么的、截图
2. 依赖的 dsh 版本范围（从 `peerDependencies` 抄）
3. 安装命令
4. **激活方式**：明确给出要往 `cordis.patch.yml` 里加的 YAML 片段，含正确的 `id` 和 `name`，例如：
   ```yaml
   - insert:
       - id: git
         name: 'dsh-git'
   ```
5. 已知限制（例如终端面板不是 PTY，跑不了 `vim` / `sudo` 交互——这条在 `CLAUDE.md` 里有详细说明，要搬过去）
6. 平台支持情况（目前只在 Windows 上验证过）

## B.5 验收标准

- [ ] 4 个公开仓库建好，各有 LICENSE、README、`dsh-plugin` topic、至少一个 tag
- [ ] 四个插件的 `package.json` 中 `name` 已去除 `@deepseek-ai` scope；`inject` / `peerDependencies` 里的上游包名**原样未动**
- [ ] 本仓库 `plugins/` 下不再有插件源码副本（不存在两份可编辑源码）
- [ ] `npm test` 全绿、`npm run typecheck` 0 错误
- [ ] `npm run dist:dir` 能出包，且 `win-unpacked/resources/plugins/`（或改后的等价位置）里**确实有插件源码**——热更新重装插件靠它
- [ ] 启动打出来的包，四个插件的 UI 全部正常出现（这是唯一能证明「装 + 打开」两步都没断的验收）
- [ ] `CLAUDE.md` 中过时的四处说法已更新

---

## 附：两个任务都必须遵守的禁区

来自 `CLAUDE.md`，违反其中任何一条都会造成事故：

1. **L1 只读** —— 不改 dsh 发行包的任何一个字节，尤其**绝不往发行包自带的 `cordis.patch.yml` 里写东西**（`- insert:` 不去重，id 重复 → 内核秒退，v1.1.1 同类事故）。
2. **`--patch` 必须排在 `--host` 之前** —— 排后面会被当作 web app 的 flag 透传，内核报 `unknown option` 直接退出。
3. **`kernel-updater._verify` 必须带 overlay** —— 不带就是验了一个「没有插件的内核」，插件加载阶段的崩溃会整个溜过自检。
4. **两个 overlay 写者必须同步改** —— `dsh-service.js` 和 `kernel-updater.js` 各写一次同样的内容，只改一个迟早不一致。
5. **`installPlugin` 的两件事缺一不可** —— 拷贝源码 + 登记依赖，只拷不登记 = 黑屏。
6. **不写死机器专属路径**，定位全局安装一律走 `src/shared/dsh-locate.js`。
7. **注释写中文，解释「为什么」而非「做什么」**。
