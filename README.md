# DeepSeek Harness Desktop

以 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 `dsh`）为内核的 Windows 桌面版 AI 编程助手。

- 双击即用，**不需要装 Node.js、不需要懂命令行**；
- 自带完整内核（`node` + `dsh`），拷到别的电脑也能跑；
- 内核可独立升级，不用等桌面版发新版。

---

## 📖 使用手册

### 第一步：下载

打开 [Releases 页面](https://github.com/EasyTZ/Deepseek-Harness-Desktop/releases)，找到最新版本，下载**下面两个里任选一个**：

| 文件 | 选它的理由 |
|---|---|
| `DeepSeek-Harness-Desktop-Setup-x.x.x.exe` | **安装包**：装完有桌面图标，新手选这个 |
| `DeepSeek-Harness-Desktop-Portable-x.x.x.zip` | **绿色版**：不用安装，解压即用，适合放 U 盘 |

### 第二步：安装

- **安装包**：双击 `.exe`，一路「下一步」→「完成」，桌面会出现图标。
- **绿色版**：右键 `.zip` →「全部解压」，打开解压出来的文件夹即可。

> 本程序没有做代码签名，Windows 可能提示「未知发布者」或被杀软拦一下，选择「仍要运行 / 允许」即可。

### 第三步：启动

双击「**DeepSeek Harness Desktop**」图标。

会先出现一个**启动窗口**（DeepSeek logo + 加载动画），几秒后自动进入主界面 —— 这是正常的，程序正在后台拉起本地服务。

### 第四步：填 API Key（第一次必须做）

1. 点窗口**左下角**的设置（齿轮图标）；
2. 打开「模型 / Models」那一页；
3. 填入 DeepSeek API Key（形如 `sk-xxxx`，在 [platform.deepseek.com](https://platform.deepseek.com) 申请）；
4. 保存。

> 不填也能打开界面，但一发消息就会失败 —— 调用模型需要这个 Key。

### 日常使用

| | |
|---|---|
| **关窗口不等于退出** | 点 ✕ 只是缩进右下角托盘，右键托盘图标才是「退出」 |
| **随时唤出** | `Ctrl + Alt + Space` 显示 / 隐藏窗口 |
| **看余额** | 每次 AI 回复的正下方会显示 DeepSeek 账户余额 |
| **后台通知** | 窗口在后台时，任务跑完或需要你确认会弹系统通知并闪任务栏 |
| **主题** | 浅色 / 深色 / 跟随系统 |

### 内核更新

「内核」就是真正干活的 dsh 本体。**它和桌面版分开升级** —— 桌面版没发新版，内核也能保持最新。

- **自动检查**：启动后台每天检查一次，有新版会弹出「DeepSeek 内核更新」窗口。
- **手动检查**：右键托盘图标 →「检查内核更新」。
- **更新流程**：点「立即更新」→ 显示进度 → 完成后点「立即重启」生效（点「稍后」也行，下次启动自动用新版）。
- **下载源**：默认走国内镜像 `registry.npmmirror.com`；更新窗口底部点源地址可切到官方源 `registry.npmjs.org`。
- **不会更新坏**：新内核要先通过一次真实启动自检才会被启用；万一启动异常，会自动回退到安装包自带的内核，不影响使用。
- **装新版桌面版时**：如果安装包自带的内核比你本地热更新的还新，会自动改用前者，不会出现「装了新版、内核反而是旧的」。

### 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 窗口关了找不到了 | 在右下角托盘，点一下图标即可 |
| 余额显示「查询失败」 | 没填 API Key，去「设置 → 模型」补上 |
| 双击没反应 / 被拦截 | 没做代码签名，选「仍要运行」；杀软误报可加白名单 |
| 从旧版升级后首次启动偏慢 | 正在自动切换到新版内核，等几秒即可，只会发生一次 |
| 启动失败并弹出错误框 | 错误框里有原因摘要；多为内核损坏，可在更新窗口点更新重装内核 |

---

## ✨ 功能特性

- 无边框窗口 + 自定义标题栏（DeepSeek 鲸鱼 logo）
- 系统托盘、单实例、全局快捷键
- 会话、文件、终端、搜索、子代理等完整 dsh 能力
- **内核独立热更新**：后台检测新版 dsh，一键升级，无需等应用发版
- 余额查询（每次对话后显示账户余额）
- 系统通知（任务完成 / 待确认）+ 任务栏闪烁
- 浅色 / 深色 / 跟随系统主题

---

## 📝 更新内容

### v1.2.0

- **修复「装了新版客户端，内核还是旧的」**：安装包不会动用户目录，此前本地热更新过的内核会一直优先于新版自带的内核，导致新版外壳跑在旧内核上。现在会比较两者版本，谁新用谁。
- **出厂内核升级到 dsh `0.1.1-rc.2`**（上一版为 `0.1.0-rc.7`）。
- **插件改用 dsh 官方机制接入**：不再改写内核自带的配置文件，改为启动时通过官方的 `--patch` 参数传入。好处是内核升级后插件不会失效，也不会因内核目录结构变化而出问题。
- **内核更新自检更严格**：升级后的可启动性校验现在连插件一起验，避免「验的时候没插件、真跑起来插件崩」。
- **修复内核异常回退时的长时间卡顿**：内核启动失败需要回退时，旧做法是同步删掉整个内核目录（3 万多个文件），实测会让程序假死十几秒、期间加载窗口还会提前消失、屏幕空白数秒。现在改为瞬时弃用 + 后台清理，加载动画全程保留，整个回退过程约 4 秒，基本无感。
- **修复标题栏的一处性能问题**：定位不到侧边栏时会一直监听页面变动、持续消耗性能，现已加超时保护。

### v1.1.1

修复启动后一直黑屏、无响应的问题：

- **根因**：余额插件 `@deepseek-ai/dsh-ui-balance` 只被拷贝进 dsh 的 `node_modules`、却没登记进依赖清单，内核启动时模块解析失败、进程秒退，外壳又未把崩溃反馈出来，导致闪屏永久挂起（黑屏卡死）。
- **修复插件登记**：`install-plugin` 现在会把插件写入 dsh 的 `package.json` 依赖，运行时自动建立解析软链。
- **修复启动提示**：内核在就绪前退出时，外壳收集 stderr 并弹出「启动失败」错误框，不再无声黑屏。

### v1.1.0

启动体验与打包优化：

- **启动闪屏（加载动画）**：双击图标后立即弹出带 DeepSeek logo 与加载动画的窗口，避免「点了没反应」的误解，主界面就绪后自动进入。
- **启动加速**：闪屏先行、内核并行启动，并跳过每次启动对开始菜单快捷方式的冗余重写。
- **打包复用本地 Electron**：electron-builder 直接使用本机已安装的 Electron，打包不再联网下载。

### v1.0.1

修复系统通知完全失效的问题：

- **事件流改用 WebSocket**：内核的 `/api/events.mux` 只提供 WebSocket 下行通道（普通 HTTP GET 返回 426，无 SSE 回退），原先用 HTTP 拉取导致永远收不到事件，「任务完成 / 待确认」通知从未真正触发。
- **新增任务栏闪烁**：任务完成且窗口失焦时，除系统通知外还会闪烁任务栏图标；窗口重新获得焦点后自动熄灭。
- **绿色版通知补丁**：首次启动自动补建开始菜单快捷方式（Windows 显示 toast 通知的前置条件），修复绿色版 / win-unpacked 下通知被系统静默丢弃的问题。

### v1.0.0

- 无边框窗口 + 自定义标题栏（DeepSeek 鲸鱼 logo，圆角可爱化样式）
- 窗口控制按钮：最小化 / 最大化（含还原状态图标切换）/ 关闭，柔和配色
- DeepSeek 官方鲸鱼图标（应用图标 + 系统托盘图标）
- 放大开始菜单 / 任务栏 / 托盘图标：裁掉 logo 透明留白，鲸鱼填满图标画布
- 应用更名：DeepSeek Harness Desktop
- 系统托盘、单实例、全局快捷键（`Ctrl + Alt + Space`）
- 自包含内核：内置 node + 完整 dsh 依赖树，无需预装 Node/dsh
- 余额查询插件：每次对话后在回复下方显示 DeepSeek 账户余额
- 系统通知：任务完成 / 待确认时后台弹系统通知（窗口失焦时）
- 打包：NSIS 安装包 + zip 绿色版

---

## 🧑‍💻 开发

仅开发者需要，普通用户跳过。

### 前置条件

1. [Node.js](https://nodejs.org) **≥ 22**；
2. 全局装 dsh 与 pnpm（开发态直接用本机 dsh；打包时要把它们拷进内核）：

```powershell
npm install -g @deepseek-ai/dsh
npm install -g pnpm
```

> 国内网络下载 Electron 慢，可先设镜像：
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
> ```

### 常用命令

```powershell
npm install              # 装依赖（首次会下 Electron）
npm start                # 开发态运行（外壳 spawn 本机全局 dsh）
npm test                 # 单元测试（node:test，零第三方依赖）
npm run typecheck        # tsc --checkJs 静态检查（无编译产物）
npm run install-plugin   # 把 plugins/ 下的插件装进本机全局 dsh
npm run dist             # 打包 → 产物收进 release/
npm run dist:dir         # 只出 win-unpacked，快速验证打包态
npm run icon             # 仅在改了 build/logo.svg 后重新生成图标
```

> 应用图标已随仓库提交，日常无需运行 `npm run icon`。

### 打包

```powershell
npm run install-plugin   # 顺序不能反：见下
npm run dist
```

产物落在 `release/`：`DeepSeek-Harness-Desktop-Setup-x.x.x.exe` 与 `...-Portable-x.x.x.zip`。

> **`install-plugin` 必须先于 `dist`**。`dist` 的第一步 `prepare-kernel` 是整目录拷贝全局 dsh 安装目录，插件源码与依赖登记是搭这趟车进入内核的；顺序反了产物里就没有插件。
>
> 同理，每次 `npm i -g @deepseek-ai/dsh` 升级后都要重跑一次 `install-plugin`，否则插件会被新版本覆盖丢失。

### 架构

Electron 外壳 + 自包含 dsh 内核。外壳**不渲染任何业务 UI**：

1. `spawn` 内核：`node.exe .../dsh/lib/bin.js web --patch <激活overlay> --host 127.0.0.1 --port <随机空闲端口>`；
2. 轮询 HTTP 就绪后，`BrowserWindow` 加载该回环地址。

所有会话 / 文件 / 终端能力都来自 dsh 自身的 web 应用；外壳只负责窗口、自定义标题栏、托盘、全局快捷键、系统通知和内核更新。

```
src/main/     Electron 主进程
src/preload/  预加载脚本（注入标题栏 / 暴露 updater 接口）
src/shared/   纯 Node 模块，主进程与构建脚本共用，也是单测落点
scripts/      构建期 CLI（ESM）
plugins/      自定义 dsh 插件源码 + 清单
```

本项目**没有编译步骤**，`src/` 直接打进 asar —— 这是打包设计的承重墙。

### 内核热更新机制

内核分两层：

- **内置出厂内核** —— 打包进安装包，只读兜底；
- **用户内核** —— `%APPDATA%/deepseek-desktop/kernel`，热更新产物。

启动时 `resolvePackagedKernel` 决定用哪层：先看完整性（残缺的再新也起不来），再比版本，出厂内核更新时会反超用户内核。用户内核启动失败会被删除并回退内置重试一次。

更新流程：内置 `pnpm` 以 `--node-linker=hoisted` 把目标版本装进 staging → 重装自定义插件 → 用隔离 `DSH_HOME` 真 boot 一次 web 自检（带插件 overlay）→ 通过后原子切换，失败回滚。

> 用 pnpm 而非 npm：dsh 依赖闭包庞大且大量 peerDependencies，npm 的 arborist 会耗尽内存或长时间无响应。

### 自定义插件

插件源码放 `plugins/<name>/`，**新增插件只需在 `plugins/plugins.json` 加一项**（`srcDir` 相对 `plugins/`，`entryId` 是激活条目 id）。构建期与运行期热更新共用这份清单。

安装（`installPlugin`）只做两件事：

1. 拷贝插件源码到 dsh 的 `node_modules`；
2. **把插件登记进 dsh 的 `package.json` `dependencies`**。

> ⚠️ 第 2 步不能省：dsh 运行时靠 `healProfilesModuleFallback` 遍历依赖闭包、在 `$DSH_HOME/profiles/node_modules` 建解析软链。只拷贝不登记，内核 `import` 该插件时会 `ERR_MODULE_NOT_FOUND`、进程秒退，桌面端表现为黑屏（v1.1.1 事故）。

**激活**走 dsh 官方的 `--patch` overlay：由清单生成一份激活条目文件，启动时作为参数传给内核。内核自带的 `cordis.patch.yml` **不被修改**。

> ⚠️ 绝不要再往内核自带的 `cordis.patch.yml` 里追加条目。`- insert:` 不去重，内核里有一条、overlay 再给一条，会抛 `duplicate loader entry id` 并让内核秒退。
>
> ⚠️ `--patch` 必须排在 `--host` 之前。dsh 的 launcher 只解析自己的参数，遇到第一个不认识的 token 就把后面全部原样透传给 web 应用，排在 `--host` 之后会被报 `unknown option`。

插件本身是**双面**的（node 半 + 浏览器半），写法参考 `plugins/dsh-ui-balance/` 与 `CLAUDE.md` 的「写一个 dsh 插件」一节。

---

## License

[MIT](LICENSE)
