# 多端打包

Windows + Linux 已上线，macOS 暂缓。这份文件记录**做这件事时发现的、不写下来就会被重新踩一遍的东西**。具体的构建配置见 [packaging.md](packaging.md)。

## 承重判断：难的不是 Electron，是内核树

Electron 这一层几乎是免费的。平台假设总共十来处，动手前就有一半已经带了守卫（`ensureStartMenuShortcut` 的 win32 早退、`setAppUserModelId` 在非 Windows 上无操作、`dsh-locate.js` 的 `cmd.exe` 分支、pnpm 垫片的 POSIX 分支、`kernel-unpack.js` 的 tar 回落）。五个 profile 层插件（L2）**一个字节都没改**——它们零依赖、无原生模块，`dsh-reveal-explorer` 和 `dsh-terminal-panel` 本来就写了 darwin / linux 分支。这是对四层模型的一次正面验证。

真正要动手术的是内核树（L1）。

### 内核树曾经按平台锁死

`prepare-kernel.mjs` 原先直接 `cpSync` 打包机上的**全局安装**（`@deepseek-ai/dsh` 和 `pnpm` 两份都是）。而 dsh 的依赖里有四族按平台解析的 `optionalDependencies`：

```
@img/sharp-*  ·  @koromix/koffi-*  ·  @vscode/ripgrep-*  ·  node-addon-require-builtin-*
```

Windows 机器上的全局安装里**只有 `*-win32-x64` 变体，darwin / linux 一个都不在**。拿它去打 mac 包，装出来的内核是死的——这才是「一直以来只能出 Windows」的根因，而不是 electron-builder 配置里少写了几行 target。

`node-pty` 是唯一例外（六个平台的 prebuild 全装了），恰好**掩盖**了这件事：裁剪规则里那条「只留 `<platform>-<arch>`」看着像在裁掉别的平台，实际上别的平台压根没进来过。**别被它误导。**

改法与收益见 [packaging.md](packaging.md) 的「内核安装：从『拷全局安装』到『按声明干净安装』」。

## 内核归档只对 Windows 成立

内核被压成单个 `kernel.tar`（约 258 MB），首启时由主进程铺开。这个设计的**唯一**理由是 Windows 资源管理器解 zip 的耗时由**文件个数**决定——同一份内核树（15444 个文件）实测：

| 方式 | 耗时 |
|---|---|
| 资源管理器「全部解压缩」 | 181 秒 |
| .NET ZipFile | 21.7 秒 |
| 系统 tar | 12.3 秒 |

打成一个文件后用户那一步几乎瞬间完成，十几秒挪到首次启动、由我们自己解（有进度提示）。

**Linux 的 AppImage 是 squashfs 镜像，根本没有「逐文件解压」这一步**，前提不成立。所以非 Windows 目标直接把 `kernel/` 目录交给 `extraResources`，不打 tar。

现有代码天然支持这件事：`needsUnpack()` 的条件是「归档存在**且**内核不完整」，没有归档就返回 false，启动路径原样走过去——**主进程一行没改**。

macOS 将来也走这条，而且理由更硬：就地解包会往已签名的 `.app` 里写文件、删文件，签名当场失效，而 arm64 上签名失效等于**根本起不来**。

## glibc 基线：实测胜过推理

常规规则是「产物不能在比构建机更老的 glibc 上跑」。按这条推理，CI 的 `ubuntu-latest`（glibc 更新）打出来的 AppImage 装不上 openEuler 22.03（glibc 2.34）。

**实测结果是能跑。**

```
[dsh] 启动: /tmp/.mount_XXXX/resources/kernel/node .../bin.js web --port 0 --no-open
[app] dsh 就绪: http://127.0.0.1:39171
```

原因：**构建期不编译任何东西**。Electron 二进制是官方预编译的，内核里的原生模块（sharp / koffi / ripgrep / node-pty）全是 npm 上的预编译件，构建机只是把它们摆到一起。真正的 glibc 下限由这些预编译件决定，不由 runner 决定。

所以 CI 用默认 runner 就行，不需要为了压低基线去套旧的构建容器。**但这条结论依赖「不编译」这个前提**——哪天引入了需要 `node-gyp` 现场编译的依赖，就得重新验一次。

AppImage 的自挂载依赖 **FUSE 2**（`libfuse.so.2`）。目标机器上没有时，`--appimage-extract-and-run` 是现成的退路——排查时先试这个，能跑就说明是 FUSE 的事，不是包的事。

## Electron 44 不再有 postinstall

`electron-builder.yml` 配了 `electronDist: node_modules/electron/dist` 复用本机已下载的那份，所以这个目录**必须**存在。

而 **electron 44 的包里根本没有 `scripts` 字段**——二进制下载从 postinstall 改成了显式的 `bin: install-electron`。`npm install` / `npm ci` **都不会**产生 `dist/`。老版本靠 postinstall 装，升到 44 之后这条链断了，本机一直没暴露只是因为那个目录是更早以前留下来的。

第一次上 CI 就撞了这个：`npm ci` 9 秒装完 286 个包（117 MB 的 Electron 显然没下），随后 electron-builder 报 `The specified electronDist does not exist`。

修在 `dist.mjs`（调 electron-builder 之前补一次，幂等），**不是**只往 workflow 里加一步——这是**打包**的前置条件、不是 CI 的前置条件，全新 clone 的开发机同样会踩。本地和 CI 必须走同一条路径，否则两边分别踩坑。

> 这类「本机碰巧有、全新环境必炸」的隐性依赖，正是上 CI 最大的收益。跟干掉全局 `dsh` / `pnpm` 是同一件事的两面。

## Linux 特有的取舍

- **只出 AppImage**。deb / rpm 待定：AppImage 发行版无关，而我们的验证机是 openEuler（RPM 系），本来也测不了 deb。
- **托盘失败要能降级**。Linux 系统托盘依赖 libappindicator，部分发行版 / 桌面环境没装，`new Tray()` 会直接抛。托盘只是「最小化到后台」的入口，不该因为它拿不到就让整个应用起不来——`createTray()` 失败返回 `null`，调用方本来就处处判了 `if (tray)`。
- **图标要 ≥512**。`build/icon.png` 现在是 1024。注意 ICO 的目录项宽高是**单字节**，存不下大于 256 的尺寸，所以 `gen-icon.mjs` 里 ICO 和 PNG 是两套尺寸表，不是笔误。

### 已知缺口（别假装验过了）

验证机是 headless 的 openEuler（`multi-user.target`），所以：

- **系统托盘没有真正验证过**。实测「`new Tray()` 没有抛异常」，但这台机器到底装没装 libappindicator、是不是走了某种静默降级，没有查证。
- **AppImage 双击（桌面集成）没验过**，只验了命令行执行。
- 窗口渲染靠 `xvfb-run`，且**必须带 `--disable-gpu`**——不带的话 Electron 进程全起来却永远挂着、不报错。这只是无头环境的调试手段，**不要**写进 `src/main/index.js`：真实用户有 GPU，关掉硬件加速是实打实的体验损失。

## macOS：暂缓

不买 Apple Developer Program（99 USD/年），走免费的 ad-hoc 签名。需要先厘清一件容易搞错的事：

| | 要不要钱 | 作用 | 不做的后果 |
|---|---|---|---|
| ad-hoc 签名（`codesign -s -`） | 免费，只需 Xcode CLT | 让二进制**能被执行** | Apple Silicon 内核直接拒绝执行，不是弹窗，是起不来 |
| Developer ID + 公证 | 99 USD/年 | 让用户**双击就能开** | 首次要右键 → 打开，之后正常 |

所以 mac 上做不到「完全不签」，只能是「ad-hoc 签、不公证」。

一个减负的事实：npm 分发的那些 darwin 二进制本来就是发布方签好的（`rg`、sharp / koffi / node-pty 的 `.node`），Node.js 官方 mac 构建也是。保字节复制不破坏它们，**真正需要我们自己签的只有 `.app` 本身**。

**暂缓的理由**不是技术难度，是它卡在两个外部条件上：需要一台借来的 Mac（`verify-kernel` 要真启动内核、签名要 `codesign`，两件事都跨不了平台），且签名行为没人实测过。前置工作全部就绪——按目标平台干净安装、POSIX 正确性、内核不打 tar 的机制、CI 的 build/publish 分离结构、1024px 图标，都是为它铺好的。
