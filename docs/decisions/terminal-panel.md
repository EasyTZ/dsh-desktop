# 终端面板

### 终端面板的几条硬知识（都是实测踩出来的）

- **它不是 PTY，是命令控制台**。上游的 PTY seam（`ctx.terminals`）要 `Agent` 做 owner、没有 resize，而且 web bundle 根本没 compose 它；`ShellProcess` 也没有写 stdin 的方法。所以 `vim` / `sudo` 密码 / `npm init` 问答跑不了 —— 这是设计边界，UI 里明说了，并给了「在系统终端中打开」当台阶。真要做满血版，验证过的路线是「PTY 放主进程（node-pty 是 N-API，Electron 里免重编，已实测）+ 自己的终端页面」，不是把它塞回内核。
- **`ctx.shell` 的 `readOutput()` 把 stderr 拼在 stdout 后面，用字面量 `[stderr]` 单独一行分隔**（pwsh-local / bash-local 的实现逐字相同）。不解析就会把这行当成输出显示；stdout/stderr 的真实交错顺序**拿不到**，只能按轮询批次近似。这是上游的**私有实现细节**，随时可能变 —— 属于我们主动接受的耦合。
- **每条命令是一个独立进程**，所以 `cd` 不会自然保留：cwd 与退出码靠追加在用户命令**末尾**的哨兵（RS 字符包裹）带回来。两个坑：哨兵**会被 delta 从中间切断**，解析必须是跨 delta 的状态机（见 `lib/pure.js`）；退出码必须哨兵自己带 —— 我们追加了语句，进程退出码已经不是用户命令的退出码了。
- **沙箱显式传 `danger-full-access`**。沙箱是用来约束**模型**的，用户自己敲 Enter 的命令不该被关起来；`ctx.shell` 的 `resolve` 尊重调用方传的 `sandboxPolicy`。
- **Windows 上是 `pwsh -NoLogo -NoProfile -NonInteractive`、mac 上是 `bash -c`**（不是 zsh，也不读 rc 文件）—— 这是 `dsh-base` bundle 按平台切 executor 的结果，不是我们选的。macOS 还有 PATH 塌陷问题（GUI 启动的 Electron 只继承到 `/usr/bin:/bin`），插件里有 best-effort 的登录 shell 探测兜着，彻底的修法在 L4。
- **Tab 补全是我们自己算的**（读目录 + 扫 PATH，不起 shell 进程 —— 起一个 PowerShell 实测近 300ms，按一次 Tab 等半秒没法用）。切词唯一的平台差异：POSIX 认反斜杠转义，**Windows 绝不能认**（`C:\Users\x` 会被啃掉一半）。
- **输入框全程可编辑，运行中也不要 `disabled` / `readOnly`**：`disabled` 的控件收不到键盘事件，会让 Ctrl+C 中断**整个失效**；`readOnly` 置灰则被用户当成「输入框失焦了」。两条都是实机反馈推翻过的写法。
- **吸底滚动的 effect 不能挂依赖数组**：新行是就地 `push` 到 view 对象上的（SSE handler 直接改 `view.lines` 再强制重渲染），`views` / `activeView` 的引用自始至终不变，挂了依赖数组它只在挂载时跑一次，表现是「有输出但视图一直停在顶部」。同理，行的 `key` 要用稳定 id 而不是数组下标，否则每来一行整个窗口的节点全量 diff。

### 改插件后要不要重启（实测钉死）

内核自带两套热重载，覆盖范围**不一样**，别一概而论：

| 改动 | 联调模式下 | 机制 |
|---|---|---|
| `lib/client.js`（UI / 样式 / 交互） | **立刻生效，不用重启** | `@deepseek-ai/dsh-client-hmr` 在 web 组合里无条件挂载：node 侧 interval `statSync` 轮询每个插件 bundle 比对 hash，变了就经 SSE（`GET /plugins/events`）推 `rebuilt` 帧，浏览器就地重挂那一个插件——**连自己注入的 `<style data-plugin>` 都会先移除再重注入**，所以改样式也不用刷新 |
| `lib/index.js`（host 半、`/api/*` 路由） | **必须重启内核** | 实测：改了一条路由的返回值，装进全局 dsh 后**轮询 60 秒无反应**，内核日志里没有任何重载记录；重启后立刻生效。服务端那套 `@cordisjs/plugin-hmr` 追的是它自己认定的源文件图，够不到被拷进 `node_modules` 的我们这份 |
| 装/卸插件、改开关 | **必须重启内核** | profile 的 bundle 层与停用 overlay 都只在 boot 时读一次。市场面板会明说这一点 |

这条差异直接决定联调的手感：只调样式/交互时改完就能看，动了路由就得重启。
