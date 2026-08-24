# DeepSeek Harness Desktop

以 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）为内核的 Windows 桌面版 AI 编程助手。

- 双击即用，**不需要装 Node.js、不需要懂命令行**；
- 自带完整内核（`node` + `dsh`），拷到别的电脑也能跑。

---

## 📖 使用手册

### 第一步：下载

1. 打开下载页面：`https://github.com/EasyTZ/Deepseek-Harness-Desktop/releases`
2. 找到最新版本（数字最大的那个），下载**下面两个文件里任意一个**：

| 文件 | 选它的理由 |
|---|---|
| `DeepSeek-Harness-Desktop-Setup-x.x.x.exe` | **安装包**：装完有桌面图标，新手选这个 |
| `DeepSeek-Harness-Desktop-Portable-x.x.x.zip` | **绿色版**：不用安装，解压即用，适合放 U 盘 |

### 第二步：安装

- **如果你下的是安装包**：双击那个 `.exe`，一路点「下一步」→「完成」。桌面会出现图标。
- **如果你下的是绿色版**：右键那个 `.zip` →「全部解压」，打开解压出来的文件夹。

### 第三步：启动

- 双击「**DeepSeek Harness Desktop**」图标（桌面的，或绿色版文件夹里的 `DeepSeek Harness Desktop.exe`）。
- 会先弹出一个**启动加载窗口**（DeepSeek logo + 加载动画），几秒后自动进入主界面；这是正常的，说明程序正在后台启动本地服务。

### 第四步：配置 API Key（第一次必须做，否则不能对话）

1. 点窗口**左下角**的「设置」按钮（齿轮图标）；
2. 找到「模型」（或 Models）那一页；
3. 填入你的 DeepSeek API Key（形如 `sk-xxxx`，去 `platform.deepseek.com` 申请）；
4. 保存。

> 没配 Key 也能打开窗口看界面，但发消息会失败，因为调用模型需要这个 Key。

### 日常使用

- **关闭窗口 ≠ 退出**：点右上角 ✕ 只是缩到**右下角托盘**，程序还在后台；右键托盘图标可「退出」。
- **快捷键**：按 `Ctrl + Alt + Space` 随时唤出 / 隐藏窗口。
- **看余额**：每次对话结束后，AI 回复正下方会显示你 DeepSeek 账户的余额。
- **系统通知**：窗口在后台时，任务跑完 / 需要你确认会弹通知，点通知回到窗口。

### 常见问题

- **窗口关了找不到了？** → 看屏幕右下角托盘图标，点它。
- **余额显示「查询失败」？** → 没配 API Key，回「设置 → 模型」填。
- **双击没反应 / 报毒？** → 本程序没做代码签名，Windows 可能弹「未知发布者」，点「仍要运行」即可。

---

## ✨ 功能特性

- 无边框窗口 + 自定义标题栏（DeepSeek 鲸鱼 logo）
- 系统托盘、单实例、全局快捷键
- 会话、文件、终端、搜索、子代理等完整 dsh 能力
- 余额查询（每次对话后显示账户余额）
- 系统通知（任务完成 / 待确认）
- 浅色 / 深色 / 跟随系统主题

---

## 📝 更新内容

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

1. 安装 [Node.js](https://nodejs.org) **≥ 22**（自带 npm）；
2. 全局安装 DeepSeek Harness（开发态要用到本机 dsh）：

```powershell
npm install -g @deepseek-ai/dsh
```

> 国内网络下载慢，可先设镜像再装依赖：
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
> ```

### 环境与运行

```powershell
npm install              # 装依赖（首次会下 Electron）
npm start                # 开发态运行（用本机 dsh）
```

> 应用图标（`build/icon.png`、`build/icon.ico`）已随仓库提交，**无需每次生成**；只有改了 `build/logo.svg` 才需要运行 `npm run icon` 重新生成。

### 打包

```powershell
npm run install-plugin   # 先把余额插件装进开发态 dsh（一次性）
npm run dist             # 产出安装包 + 绿色版到 release/
```

> 产物：`release/DeepSeek-Harness-Desktop-Setup-x.x.x.exe`（安装包）和 `DeepSeek-Harness-Desktop-Portable-x.x.x.zip`（绿色版）。

### 架构（一句话）

Electron 外壳 + 自包含 dsh 内核：外壳 `spawn` 内置的 `node.exe .../dsh/lib/bin.js web`，就绪后加载本地回环地址。自定义插件放在 `plugins/`，通过 `install-plugin` 装进 dsh。

### 自定义插件

插件放在 `plugins/<name>/`，通过 `install-plugin` 装进 dsh。**新增插件只需在 `scripts/install-plugin.mjs` 的 `PLUGINS` 清单加一项**（`srcDir` / `patchFile` / `entryId`），脚本会自动完成三件事：

1. 拷贝插件源码到 dsh 的 `node_modules`；
2. 在目标 bundle patch 末尾追加激活条目；
3. 把插件登记进 dsh 的 `package.json` `dependencies`。

> ⚠️ 第 3 步不能省：dsh 运行时靠 `healProfilesModuleFallback` 遍历依赖闭包、在 `$DSH_HOME/profiles/node_modules` 建解析软链；只拷 `node_modules` 而不登记依赖，内核启动时 `import` 该插件会 `ERR_MODULE_NOT_FOUND`、进程秒退，桌面端表现为黑屏卡死。

> ⚠️ `install-plugin` 改的是本机全局 dsh 安装目录，**每次 `npm install -g @deepseek-ai/dsh` 升级后都要重跑一次**，否则插件（拷贝、激活条目、依赖登记）会被覆盖丢失。

---

## License

[MIT](LICENSE)
