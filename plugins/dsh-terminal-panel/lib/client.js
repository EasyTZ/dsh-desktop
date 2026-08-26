window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-terminal-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		const NS = "terminal";

		const zh = {
			"terminal.panel.title": "终端",
			"terminal.panel.newTab": "新建终端标签",
			"terminal.panel.maximize": "最大化",
			"terminal.panel.restore": "还原窗口",
			"terminal.panel.close": "关闭终端面板",
			"terminal.tab.close": "关闭标签",
			"terminal.tab.maxReached": "标签数量已达上限（8 个）",
			"terminal.empty.noTabs": "还没有终端标签，点击右上角 + 新建",
			"terminal.empty.noWorkspace": "还没有打开工作区。打开一个工作区后，这里会自动为它开一个终端。",
			"terminal.empty.title": "在这里执行命令，输出会实时显示。",
			"terminal.empty.shell.pwsh": "当前 shell：pwsh（不加载 PowerShell 配置文件）",
			"terminal.empty.shell.bash": "当前 shell：bash（不是 zsh，且不加载 .bashrc）",
			"terminal.empty.noInteractive": "不支持需要交互输入的程序（vim、sudo 密码、npm init …）",
			"terminal.empty.hint": "Tab 补全路径与命令名，↑/↓ 翻历史",
			"terminal.input.placeholder": "输入命令，Enter 执行",
			"terminal.input.running": "命令运行中 · Ctrl+C 终止",
			"terminal.input.waiting": "该命令可能在等待输入 —— 本终端不支持交互输入，请 Ctrl+C 终止后改用 --yes 之类的非交互参数",
			"terminal.status.running": "运行中",
			"terminal.signal.stop": "停止",
			"terminal.external.open": "在系统终端中打开",
			"terminal.external.failed": "打开系统终端失败",
			"terminal.scroll.newOutput": "↓ {n} 行新输出",
			"terminal.error.create": "创建终端标签失败",
			"terminal.error.load": "加载终端会话失败",
			"terminal.error.busy": "上一条命令还在运行"
		};
		const en = {
			"terminal.panel.title": "Terminal",
			"terminal.panel.newTab": "New terminal tab",
			"terminal.panel.maximize": "Maximize",
			"terminal.panel.restore": "Restore",
			"terminal.panel.close": "Close terminal panel",
			"terminal.tab.close": "Close tab",
			"terminal.tab.maxReached": "Tab limit reached (8)",
			"terminal.empty.noTabs": "No terminal tabs yet — click + in the header to create one",
			"terminal.empty.noWorkspace": "No workspace open yet. Open one and a terminal will be created for it automatically.",
			"terminal.empty.title": "Run commands here; output streams in real time.",
			"terminal.empty.shell.pwsh": "Current shell: pwsh (PowerShell profile is not loaded)",
			"terminal.empty.shell.bash": "Current shell: bash (not zsh, and .bashrc is not loaded)",
			"terminal.empty.noInteractive": "Interactive programs are not supported (vim, sudo password, npm init …)",
			"terminal.empty.hint": "Tab completes paths and command names; ↑/↓ recalls history",
			"terminal.input.placeholder": "Type a command, Enter to run",
			"terminal.input.running": "Command running · Ctrl+C to interrupt",
			"terminal.input.waiting": "This command may be waiting for input — interactive input is not supported. Press Ctrl+C and use a non-interactive flag like --yes",
			"terminal.status.running": "Running",
			"terminal.signal.stop": "Stop",
			"terminal.external.open": "Open in system terminal",
			"terminal.external.failed": "Failed to open the system terminal",
			"terminal.scroll.newOutput": "↓ {n} new lines",
			"terminal.error.create": "Failed to create terminal tab",
			"terminal.error.load": "Failed to load terminal sessions",
			"terminal.error.busy": "The previous command is still running"
		};

		//#region 样式
		// 颜色全部走 dsh 的设计 token（--dsw-alias-*），兜底值取自已验证可用的深色
		// 主题实测色。ANSI 16 色调色板（Primer 系，说明书给定）定义在面板根元素上，
		// .dstDark 覆盖一份 —— 由 ctx.theme 驱动，不嗅探 body[data-ds-dark-theme]
		// （那是 DOM 耦合，正是 CLAUDE.md「已知偏离」里要还的债）。
		const css = [
			// —— footer 按钮 ——
			".dstFooterBtn{display:inline-flex;align-items:center;gap:8px;position:relative;width:100%;height:32px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);cursor:pointer;font-size:13px;font-family:inherit;transition:background .15s ease,color .15s ease}",
			".dstFooterBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f9fafb)}",
			".dstFooterBtnActive{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f9fafb)}",
			".dstFooterBtn svg{flex:none;display:block}",
			".dstFooterBtnLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			// sidebar footer actions 容器在上游是 flex（默认 row），Git/终端两个按钮
			// 会被挤压成同行的半宽按钮 —— 改成纵向，每个 action 独占一整行（用户
			// 明确要求不要同行排列）。[class*="footerActions"] 与上游 CSS module 的
			// hash class 弱耦合（同 CLAUDE.md 标题栏 [class*="sidebarCol"] 的先例）；
			// 本插件的样式运行时注入、晚于 bundle，同特异性下后写的规则生效。
			// 折叠态（56px 图标条）的 width:auto/justify-content:center 是上游另一条
			// 规则，只设了这两个属性，不冲突；按钮在此态下退化为纯图标纵向排列。
			"[class*=\"footerActions\"]{flex-direction:column;align-items:stretch}",
			// 小徽标：面板关闭期间有后台命令结束（尤其非零退出）时显示 6px 圆点。
			".dstBadge{position:absolute;top:4px;right:4px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#f0617a);pointer-events:none}",
			// —— 面板 ——
			// shell.overlay 层默认 click-through，面板必须自己 opt back into pointer
			// events；面板之外的区域绝不能拦截点击（非模态，终端要和主界面同时用）。
			// 关闭态（仅切 class、常驻挂载）必须 pointer-events:none —— opacity 0 的
			// 元素依然会拦截点击，不关掉它「面板关闭时底下 dsh 界面能正常点击」这条
			// 验收就过不了（这是本类插件最容易出的 bug）。
			// 位置/尺寸：right 20 bottom 20，max 760x520；最大化切 inset 24px。
			".dstPanel{position:fixed;right:20px;bottom:20px;z-index:20;width:min(760px,calc(100vw - 40px));height:min(520px,70vh);display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay,#1b1b1c);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary,#f9fafb);font-size:13px;overflow:hidden;pointer-events:none;opacity:0;transform:translateY(8px);transition:opacity .16s ease,transform .16s ease}",
			".dstPanel.dstOpen{opacity:1;pointer-events:auto;transform:translateY(0)}",
			".dstPanel.dstMax{inset:24px;width:auto;height:auto}",
			// —— header 40px ——
			".dstHeader{flex:none;display:flex;align-items:center;gap:6px;height:40px;padding:0 10px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}",
			".dstHeaderTitle{font-weight:600;font-size:14px;margin-right:auto}",
			".dstIconBtn{flex:none;width:26px;height:26px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .15s ease,color .15s ease}",
			".dstIconBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f9fafb)}",
			// —— tabs 32px ——
			".dstTabs{flex:none;display:flex;align-items:center;gap:4px;height:32px;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}",
			// 标签同样不能用 transparent 底 + interactive-bg-hover 这套：前者就是面板
			// 底色本身（完全没有边界），后者是个很淡的叠加层，浅色主题下几乎看不见，
			// 而且它跟 hover 用的是同一个 token —— 激活态和悬浮态还分不开。
			// 改成中性灰描边（对纯白与近黑都有对比，一个值通吃两个主题），激活态再
			// 叠一圈强调色边框 + 更深的填充，三种状态（普通/悬浮/激活）互不混淆。
			// box-sizing 必须显式写：给原本 border:none 的定高元素加边框会把高度撑大。
			".dstTab{flex:none;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;max-width:220px;height:24px;padding:0 8px;border:1px solid rgba(128,128,128,.32);border-radius:6px;background:rgba(128,128,128,.12);color:var(--dsw-alias-label-secondary,#cfd3d6);font-size:12px;font-family:inherit;cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease}",
			".dstTab:hover{background:rgba(128,128,128,.24);border-color:rgba(128,128,128,.55)}",
			".dstTabActive{background:rgba(128,128,128,.34);border-color:#0550ae;color:var(--dsw-alias-label-primary,#f9fafb)}",
			".dstDark .dstTabActive{border-color:#6cb6ff}",
			".dstTabDot{flex:none;font-size:8px;color:var(--dsw-alias-label-tertiary,#8b949e)}",
			".dstTabActive .dstTabDot{color:var(--dsw-alias-state-success-primary,#3fb950)}",
			".dstTabRunning .dstTabDot{color:var(--dsw-alias-state-warn-primary,#e3a008)}",
			".dstTabLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dstTabClose{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b949e);cursor:pointer;font-size:12px;line-height:1;padding:0}",
			".dstTabClose:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#f9fafb)}",
			// —— 输出区 ——
			// 输出区背景比面板底色深一档，形成「画布」感；不硬编码黑底（浅色主题下
			// 会很难看）。等宽字体 + pre-wrap，长行折行而不是横向滚动。
			".dstOutput{position:relative;flex:1;min-height:0;overflow-y:auto;background:var(--dsw-alias-bg-layer-1,#151517);padding:8px 10px;font-family:ui-monospace,SFMono-Regular,'Cascadia Mono',Menlo,Consolas,'Liberation Mono',monospace;font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}",
			".dstLine{min-height:1.55em}",
			// stderr 行：左侧 2px 竖条 + 文字色偏红，不整行涂红（那太吵）。
			".dstLineErr{border-left:2px solid var(--dsw-alias-state-error-primary,#f0617a);padding-left:6px;margin-left:-2px;color:var(--dsw-alias-state-error-primary,#f0617a)}",
			// meta 行（我们插的提示）：默认灰色小字；命令回显加粗用主色；失败结束行红色。
			".dstLineMeta{color:var(--dsw-alias-label-tertiary,#8b949e)}",
			".dstLineMeta.dstLineCmd{color:var(--dsw-alias-label-primary,#f9fafb);font-weight:600}",
			".dstLineMeta.dstLineCmd .dstPromptMark{color:var(--dsw-alias-label-tertiary,#8b949e);font-weight:400}",
			".dstLineMeta.dstLineCmdErr{color:var(--dsw-alias-state-error-primary,#f0617a);font-weight:600}",
			// 空态：灰色小字，居中偏上。
			".dstEmpty{position:absolute;top:40px;left:0;right:0;text-align:center;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12.5px;line-height:2;pointer-events:none}",
			".dstEmpty .dstEmptyTitle{color:var(--dsw-alias-label-secondary,#cfd3d6)}",
			// 吸底 pill：用户上滚时浮在右下角，点它回到底部。
			".dstScrollPill{position:sticky;float:right;bottom:8px;margin-top:-30px;margin-right:4px;z-index:2;height:24px;padding:0 10px;border:none;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#232326);color:var(--dsw-alias-label-primary,#f9fafb);font-size:11.5px;font-family:inherit;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3);transition:background .15s ease}",
			".dstScrollPill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.14))}",
			// —— 输入区 ——
			".dstInputRow{flex:none;display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}",
			".dstPrompt{flex:none;font-family:ui-monospace,monospace;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,#8b949e);padding-top:1px}",
			".dstInput{flex:1;min-width:0;resize:none;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary,#f9fafb);font-family:ui-monospace,SFMono-Regular,'Cascadia Mono',Menlo,Consolas,'Liberation Mono',monospace;font-size:13px;line-height:20px;padding:0}",
			// 输入框全程可编辑、全程正常色：命令跑着时也能接着打下一条（终端的手感）。
			// 曾经运行中置灰（readOnly + 这条规则里的 :read-only），实测被当成「输入框
			// 失焦了」——每条命令都要新起一个 PowerShell 进程（实测冷启动近 300ms），
			// 那段置灰窗口正好长到让人以为界面卡了。禁用态只留给真正不可用的场合。
			".dstInput:disabled{color:var(--dsw-alias-label-tertiary,#8b949e)}",
			".dstInput::placeholder{color:var(--dsw-alias-label-tertiary,#8b949e)}",
			".dstWaitingHint{flex:none;padding:6px 12px;background:var(--dsw-alias-bg-layer-2,#232326);color:var(--dsw-alias-state-warn-primary,#e3a008);font-size:12px;line-height:1.5;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}",
			// —— 状态栏 26px ——
			".dstStatusBar{flex:none;display:flex;align-items:center;gap:8px;height:26px;padding:0 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));font-size:11.5px;color:var(--dsw-alias-label-secondary,#cfd3d6)}",
			// 当前路径：整条用强调色，shell 名保持弱化。强调色深浅主题各取一个
			// （浅色深蓝 / 深色亮蓝，都来自面板里已有的 Primer 调色板），比直接上
			// 纯白或纯黑克制，也不会在任一主题下糊进底色。
			".dstStatusCwd{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}",
			".dstStatusShell{color:var(--dsw-alias-label-tertiary,#8b949e)}",
			".dstStatusPath{font-weight:600;color:#0550ae}",
			".dstDark .dstStatusPath{color:#6cb6ff}",
			".dstStatusRight{flex:none;display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-state-warn-primary,#e3a008)}",
			// 停止按钮：命令运行中可见（可发现性，不依赖用户记得 Ctrl+C），hover 变红
			// 表示这是危险操作。
			// 底色用中性灰半透明而不是 bg-layer-2：后者在深色下比面板底亮一档没问题，
			// 但浅色主题里它跟面板底几乎是同一个白，按钮就糊进背景了（Git 面板的推送
			// 按钮踩过这个坑）。中等灰对纯白和近黑都有对比，一个值通吃两个主题。
			".dstStopBtn{flex:none;display:inline-flex;align-items:center;justify-content:center;height:20px;padding:0 8px;border:1px solid rgba(128,128,128,.5);border-radius:5px;background:rgba(128,128,128,.16);color:var(--dsw-alias-label-secondary,#cfd3d6);font-size:11px;font-family:inherit;cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease}",
			".dstStopBtn:hover{background:var(--dsw-alias-state-error-primary,#f0617a);color:var(--dsw-alias-label-primary-inverted,#fff)}",
			".dstSpinner{width:11px;height:11px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:dstSpin .8s linear infinite;box-sizing:border-box}",
			"@keyframes dstSpin{to{transform:rotate(360deg)}}",
			// —— ANSI 调色板（面板根元素定义，.dstDark 覆盖）——
			// 类名是 ansiFg0-15 / ansiBg0-15，颜色按主题切换，跟 dsh 自己的 token 同一哲学。
			".dstPanel{--dst-ansi-0:#57606a;--dst-ansi-1:#cf222e;--dst-ansi-2:#116329;--dst-ansi-3:#7d4e00;--dst-ansi-4:#0550ae;--dst-ansi-5:#8250df;--dst-ansi-6:#1b7c83;--dst-ansi-7:#6e7781;--dst-ansi-8:#6e7781;--dst-ansi-9:#a40e26;--dst-ansi-10:#1a7f37;--dst-ansi-11:#9a6700;--dst-ansi-12:#0969da;--dst-ansi-13:#a475f9;--dst-ansi-14:#3192aa;--dst-ansi-15:#8c959f}",
			".dstPanel.dstDark{--dst-ansi-0:#6b7280;--dst-ansi-1:#f47067;--dst-ansi-2:#57ab5a;--dst-ansi-3:#c69026;--dst-ansi-4:#539bf5;--dst-ansi-5:#b083f0;--dst-ansi-6:#39c5cf;--dst-ansi-7:#cdd9e5;--dst-ansi-8:#768390;--dst-ansi-9:#ff938a;--dst-ansi-10:#6bc46d;--dst-ansi-11:#daaa3f;--dst-ansi-12:#6cb6ff;--dst-ansi-13:#dcbdfb;--dst-ansi-14:#56d4dd;--dst-ansi-15:#ffffff}",
			".dstPanel .ansiBold{font-weight:600}",
			".dstPanel .ansiDim{opacity:.65}",
			".dstPanel .ansiItalic{font-style:italic}",
			".dstPanel .ansiUnderline{text-decoration:underline}",
			".dstPanel .ansiFg0{color:var(--dst-ansi-0)}.dstPanel .ansiFg1{color:var(--dst-ansi-1)}.dstPanel .ansiFg2{color:var(--dst-ansi-2)}.dstPanel .ansiFg3{color:var(--dst-ansi-3)}.dstPanel .ansiFg4{color:var(--dst-ansi-4)}.dstPanel .ansiFg5{color:var(--dst-ansi-5)}.dstPanel .ansiFg6{color:var(--dst-ansi-6)}.dstPanel .ansiFg7{color:var(--dst-ansi-7)}.dstPanel .ansiFg8{color:var(--dst-ansi-8)}.dstPanel .ansiFg9{color:var(--dst-ansi-9)}.dstPanel .ansiFg10{color:var(--dst-ansi-10)}.dstPanel .ansiFg11{color:var(--dst-ansi-11)}.dstPanel .ansiFg12{color:var(--dst-ansi-12)}.dstPanel .ansiFg13{color:var(--dst-ansi-13)}.dstPanel .ansiFg14{color:var(--dst-ansi-14)}.dstPanel .ansiFg15{color:var(--dst-ansi-15)}",
			".dstPanel .ansiBg0{background:var(--dst-ansi-0)}.dstPanel .ansiBg1{background:var(--dst-ansi-1)}.dstPanel .ansiBg2{background:var(--dst-ansi-2)}.dstPanel .ansiBg3{background:var(--dst-ansi-3)}.dstPanel .ansiBg4{background:var(--dst-ansi-4)}.dstPanel .ansiBg5{background:var(--dst-ansi-5)}.dstPanel .ansiBg6{background:var(--dst-ansi-6)}.dstPanel .ansiBg7{background:var(--dst-ansi-7)}.dstPanel .ansiBg8{background:var(--dst-ansi-8)}.dstPanel .ansiBg9{background:var(--dst-ansi-9)}.dstPanel .ansiBg10{background:var(--dst-ansi-10)}.dstPanel .ansiBg11{background:var(--dst-ansi-11)}.dstPanel .ansiBg12{background:var(--dst-ansi-12)}.dstPanel .ansiBg13{background:var(--dst-ansi-13)}.dstPanel .ansiBg14{background:var(--dst-ansi-14)}.dstPanel .ansiBg15{background:var(--dst-ansi-15)}"
		].join("");
		const tagId = "@deepseek-ai/dsh-terminal-panel/panel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-terminal-panel";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region 共享 store（footer 按钮与浮层面板之间唯一的耦合）
		function createOpenStore() {
			let open = false;
			const listeners = new Set();
			const notify = () => listeners.forEach((fn) => fn());
			return {
				getSnapshot: () => open,
				subscribe: (fn) => {
					listeners.add(fn);
					return () => listeners.delete(fn);
				},
				toggle: () => { open = !open; notify(); },
				close: () => { if (open) { open = false; notify(); } }
			};
		}
		// 徽标：面板关闭期间有后台命令结束（非零退出）时置位，打开面板即清除。
		function createBadgeStore() {
			let badge = false;
			const listeners = new Set();
			const notify = () => listeners.forEach((fn) => fn());
			return {
				getSnapshot: () => badge,
				subscribe: (fn) => {
					listeners.add(fn);
					return () => listeners.delete(fn);
				},
				set: () => { if (!badge) { badge = true; notify(); } },
				clear: () => { if (badge) { badge = false; notify(); } }
			};
		}
		// 主题快照：读 ctx.theme.getTheme()，订阅 cordis 的 theme/change 事件。
		// getSnapshot 返回 'light'/'dark' 原始字符串，值稳定，useSyncExternalStore 不会空转。
		function createThemeStore(ctx) {
			return {
				getSnapshot: () => ctx.theme.getTheme().active.colorScheme,
				subscribe: (fn) => ctx.on("theme/change", () => fn())
			};
		}
		//#endregion

		//#region 图标
		// `>_`：一个 chevron + 下划线，stroke-width 1.5，与 Git 图标同一套线条语言。
		function TerminalIcon({ size }) {
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16", width: size, height: size, fill: "none",
				stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round",
				children: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
					react_jsx_runtime.jsx("path", { d: "M2.5 4.5 6 8l-3.5 3.5" }),
					react_jsx_runtime.jsx("path", { d: "M7.5 11.5h6" })
				] })
			});
		}
		function CloseIcon() {
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16", width: 14, height: 14, fill: "none",
				stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round",
				children: react_jsx_runtime.jsx("path", { d: "M3 3 L13 13 M13 3 L3 13" })
			});
		}
		function PlusIcon() {
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16", width: 14, height: 14, fill: "none",
				stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round",
				children: react_jsx_runtime.jsx("path", { d: "M8 3v10M3 8h10" })
			});
		}
		// 「在系统终端中打开」：一个方框 + 右上角外指的箭头（跟 dsh 里"跳出去"的
		// 通用语义一致），线条粗细与其它图标对齐。
		function ExternalIcon() {
			return react_jsx_runtime.jsxs("svg", {
				viewBox: "0 0 16 16", width: 14, height: 14, fill: "none",
				stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round",
				children: [
					react_jsx_runtime.jsx("path", { d: "M13 9.5v3.5H3V3h3.5" }),
					react_jsx_runtime.jsx("path", { d: "M9.5 2.5H13.5V6.5M13.5 2.5L8 8" })
				]
			});
		}
		function MaximizeIcon() {
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16", width: 14, height: 14, fill: "none",
				stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round",
				children: react_jsx_runtime.jsx("path", { d: "M2.5 6.5v-4h4M13.5 9.5v4h-4" })
			});
		}
		function RestoreIcon() {
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16", width: 14, height: 14, fill: "none",
				stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round",
				children: react_jsx_runtime.jsx("path", { d: "M3.5 6.5h6v6h-6zM6.5 3.5h6v6" })
			});
		}
		//#endregion

		//#region 数据请求
		async function getJson(url) {
			const res = await fetch(url);
			return res.json();
		}
		async function postJson(url, body) {
			const res = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			return res.json();
		}
		//#endregion

		//#region SSE 连接与行缓冲
		// 每个标签一条 EventSource（面板打开期间全开，任何标签都实时）；断线按指数
		// 退避重连，重连时带 since（lastSeq）让服务端补齐缺口。面板关闭只断连接，
		// 不销毁会话（会话状态在 node 半）。
		const HISTORY_LIMIT = 200;
		const LINE_KEEP = 5000; // 与 node 半环形缓冲同上限，避免无界增长

		// 历史按**工作区**存，不能按会话 id 存：会话 id 是每次新建时 mint 的 UUID、
		// 且随内核进程消亡，按它存等于「重启应用后 ↑ 永远是空的」，还会在
		// localStorage 里留下一堆再也不会被读到的孤儿键（只增不减）。前缀带 v2 是
		// 为了能把老键一次性清掉（见 migrateHistoryKeys）。
		const HISTORY_PREFIX = "dst:term:hist2:";
		const LEGACY_HISTORY_PREFIX = "dst:term:hist:";

		/** 工作区未知时的兜底桶（正常路径下拿得到 workspaceId）。 */
		function historyKey(workspaceId) {
			return HISTORY_PREFIX + (workspaceId || "default");
		}

		/** 一次性清掉按会话 id 存的老键。无条件删，不做形状猜测。 */
		function migrateHistoryKeys() {
			try {
				const stale = [];
				for (let i = 0; i < localStorage.length; i++) {
					const key = localStorage.key(i);
					if (key && key.startsWith(LEGACY_HISTORY_PREFIX)) stale.push(key);
				}
				for (const key of stale) localStorage.removeItem(key);
			} catch {
				// localStorage 不可用（隐私模式等）时忽略：历史本来就是锦上添花。
			}
		}

		function loadHistory(workspaceId) {
			try {
				const raw = localStorage.getItem(historyKey(workspaceId));
				const arr = raw ? JSON.parse(raw) : [];
				return Array.isArray(arr) ? arr.filter((s) => typeof s === "string").slice(-HISTORY_LIMIT) : [];
			} catch {
				return [];
			}
		}
		function saveHistory(workspaceId, history) {
			try {
				localStorage.setItem(historyKey(workspaceId), JSON.stringify(history.slice(-HISTORY_LIMIT)));
			} catch {
				// localStorage 配额满时静默丢弃（历史丢了不影响功能）
			}
		}
		function pushHistory(workspaceId, history, command) {
			const next = history.slice(-HISTORY_LIMIT);
			if (next[next.length - 1] !== command) next.push(command);
			saveHistory(workspaceId, next);
			return next;
		}

		// 行的稳定 key。渲染窗口是最近 2000 行，用数组下标当 key 的话，每来一行所有
		// 下标就平移一位，React 得把 2000 个节点全量 diff 一遍 —— 重输出场景下每帧
		// 如此。打一个自增 id 上去，React 只需要处理真正新增的那几行。
		let lineKeySeq = 0;
		function stampKey(line) {
			if (line.__k === undefined) line.__k = ++lineKeySeq;
			return line;
		}
		function stampKeys(lines) {
			for (const line of lines) stampKey(line);
			return lines;
		}

		function createView(meta) {
			return {
				id: meta.id,
				token: meta.token,
				workspaceId: meta.workspaceId || null,
				cwd: meta.cwd,
				shellKind: meta.shellKind,
				state: meta.state || "idle",
				currentCommand: meta.currentCommand || null,
				lastExit: meta.lastExit || null,
				lines: [],
				lastSeq: 0,
				es: null,
				reconnectTimer: null,
				reconnectAttempts: 0,
				closed: false,
				startedAt: 0,
				lastOutputAt: 0,
				exitCode: null,
				durationMs: null,
				history: loadHistory(meta.workspaceId || null),
				historyIdx: -1
			};
		}

		// rAF 合批：SSE 帧（80ms 一次轮询）直接 setState 会让 React 频繁重渲染，
		// 攒到一帧统一触发，滚动/渲染才跟得上。
		let rafPending = new Set();
		let rafScheduled = false;
		function scheduleRender(view) {
			rafPending.add(view);
			if (rafScheduled) return;
			rafScheduled = true;
			requestAnimationFrame(() => {
				rafScheduled = false;
				const batch = [...rafPending];
				rafPending.clear();
				for (const v of batch) v.onRender && v.onRender();
			});
		}

		function scheduleReconnect(view) {
			if (view.closed) return;
			if (view.reconnectTimer) clearTimeout(view.reconnectTimer);
			const delay = Math.min(1000 * Math.pow(2, view.reconnectAttempts), 15000);
			view.reconnectAttempts += 1;
			view.reconnectTimer = setTimeout(() => {
				view.reconnectTimer = null;
				connectStream(view);
			}, delay);
		}

		function connectStream(view) {
			if (view.closed) return;
			if (view.es) {
				view.es.close();
				view.es = null;
			}
			const url = `/api/terminal/stream?id=${encodeURIComponent(view.id)}&token=${encodeURIComponent(view.token)}&since=${view.lastSeq}`;
			let es;
			try {
				es = new EventSource(url);
			} catch {
				scheduleReconnect(view);
				return;
			}
			view.es = es;
			es.addEventListener("hello", (e) => {
				const data = JSON.parse(e.data);
				view.lastSeq = Math.max(view.lastSeq, data.seq);
				// truncated 时历史不全，整段替换；否则增量追加（窗口内）。
				if (data.truncated) view.lines = stampKeys(data.lines);
				else if (data.lines.length > 0) view.lines = view.lines.concat(stampKeys(data.lines));
				view.state = data.state;
				view.cwd = data.cwd;
				view.currentCommand = data.currentCommand;
				view.reconnectAttempts = 0;
				scheduleRender(view);
			});
			es.addEventListener("lines", (e) => {
				const data = JSON.parse(e.data);
				view.lastSeq = Math.max(view.lastSeq, data.seq);
				for (const line of data.append) {
					if (line.replaceLast && view.lines.length > 0) {
						// \r 进度条重写当前行：替换尾部而不是追加。key 沿用被替换那行的
						// —— 它是「同一行的重写」，复用 key 让 React 原地更新而不是拆了重建。
						const prev = view.lines[view.lines.length - 1];
						line.__k = prev.__k !== undefined ? prev.__k : ++lineKeySeq;
						view.lines[view.lines.length - 1] = line;
					} else {
						view.lines.push(stampKey(line));
					}
				}
				if (view.lines.length > LINE_KEEP) view.lines = view.lines.slice(-LINE_KEEP);
				view.lastOutputAt = Date.now();
				scheduleRender(view);
			});
			es.addEventListener("status", (e) => {
				const data = JSON.parse(e.data);
				view.lastSeq = Math.max(view.lastSeq, data.seq);
				view.state = data.state;
				view.cwd = data.cwd;
				view.currentCommand = data.currentCommand;
				view.exitCode = data.exitCode;
				view.durationMs = data.durationMs;
				if (data.state === "running") view.startedAt = Date.now();
				scheduleRender(view);
			});
			es.onerror = () => {
				// 连接错误：服务端主动 end（close 路由）或网络抖动。关闭后按退避重连；
				// 会话被 close 时 view.closed 已置位，不再重连。
				es.close();
				if (view.es === es) view.es = null;
				scheduleReconnect(view);
			};
		}

		function disconnectStream(view) {
			view.closed = true;
			if (view.reconnectTimer) {
				clearTimeout(view.reconnectTimer);
				view.reconnectTimer = null;
			}
			if (view.es) {
				view.es.close();
				view.es = null;
			}
		}
		//#endregion

		//#region footer 按钮
		// 侧边栏 footer 容器的弱耦合探测。样式里那条
		// `[class*="footerActions"]{flex-direction:column}` 靠的是上游 CSS Modules
		// 类名里保留的原始片段（同 CLAUDE.md 里标题栏 [class*="sidebarCol"] 的先例）。
		// 上游一改名，Git 与终端两个按钮就会**无声地**挤回同一行 —— 至少让控制台
		// 留一句话，别让人对着变形的界面猜。
		let footerProbeDone = false;
		function probeFooterContainer() {
			if (footerProbeDone) return;
			footerProbeDone = true;
			if (!document.querySelector('[class*="footerActions"]')) {
				console.warn('[dsh-terminal-panel] 未匹配到侧边栏 footer 容器（[class*="footerActions"]），'
					+ "上游可能已改动该类名；侧边栏底部按钮的纵向排列会失效。");
			}
		}

		function TerminalFooterAction({ wide, t, store, badgeStore }) {
			const open = react.useSyncExternalStore(store.subscribe, store.getSnapshot);
			const badge = react.useSyncExternalStore(badgeStore.subscribe, badgeStore.getSnapshot);
			// 挂载后探一次（此时容器一定已经在 DOM 里 —— 我们就长在它里面）。
			react.useEffect(probeFooterContainer, []);
			return react_jsx_runtime.jsxs("button", {
				type: "button",
				className: "dstFooterBtn" + (open ? " dstFooterBtnActive" : ""),
				"aria-label": t("terminal.panel.title"),
				"aria-pressed": open,
				title: t("terminal.panel.title"),
				onClick: () => store.toggle(),
				children: [
					react_jsx_runtime.jsx(TerminalIcon, { size: 16 }),
					wide ? react_jsx_runtime.jsx("span", { className: "dstFooterBtnLabel", children: t("terminal.panel.title") }) : null,
					badge ? react_jsx_runtime.jsx("span", { className: "dstBadge" }) : null
				]
			});
		}
		//#endregion

		//#region 面板内容
		function TerminalPanel({ t, store, badgeStore, themeStore, workspacesList, sessionsList }) {
			const open = react.useSyncExternalStore(store.subscribe, store.getSnapshot);
			// 首次打开后常驻挂载，开关只切 dstOpen class —— 关闭时内容一起淡出，
			// 而不是瞬间抽掉只剩空壳（与 Git 面板同一个做法）。
			const [mounted, setMounted] = react.useState(false);
			react.useEffect(() => {
				if (open) setMounted(true);
			}, [open]);

			// 主题：面板根元素切 dstDark（ANSI 调色板两套）。
			const scheme = react.useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot);
			const dark = scheme === "dark";

			if (!mounted) return null;
			return react_jsx_runtime.jsx(TerminalPanelBody, { t, open, dark, store, badgeStore, workspacesList, sessionsList });
		}

		function TerminalPanelBody({ t, open, dark, store, badgeStore, workspacesList, sessionsList }) {
			const wsState = react.useSyncExternalStore(workspacesList.subscribe, workspacesList.getSnapshot);
			const sessState = react.useSyncExternalStore(sessionsList.subscribe, sessionsList.getSnapshot);
			const items = wsState.items || [];
			const [, forceRender] = react.useReducer((x) => x + 1, 0);

			// 当前工作区推导（与 Git 面板同源）：当前会话 id 反查哪个 workspace 的
			// sessionIds 含它；查不到退回 recentWorkspaceId，再退回 items[0]。
			const linkedWorkspaceId = react.useMemo(() => {
				const currentSessionId = sessState.current;
				if (currentSessionId) {
					const owner = items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(currentSessionId));
					if (owner) return owner.workspaceId;
				}
				return wsState.recentWorkspaceId ?? (items[0] && items[0].workspaceId) ?? null;
			}, [sessState.current, items, wsState.recentWorkspaceId]);

			// 新会话元数据进来时更新已有 view（行数据保留），或新建 view。
			const [views, setViews] = react.useState([]);
			const [activeId, setActiveId] = react.useState(null);
			const [maximized, setMaximized] = react.useState(() => {
				try { return localStorage.getItem("dst:term:max") === "1"; } catch { return false; }
			});
			const [input, setInput] = react.useState("");
			const [follow, setFollow] = react.useState(true);
			const [pendingCount, setPendingCount] = react.useState(0);
			const [notice, setNotice] = react.useState(null); // 操作失败等一次性提示
			const outputRef = react.useRef(null);
			const inputRef = react.useRef(null);
			const followRef = react.useRef(true);
			const lastLineCountRef = react.useRef(0);
			// 上一次渲染时的活动标签 id：切标签要重置跟随态与行计数，否则两个标签的
			// 滚动位置和「N 行新输出」的计数会互相污染。
			const lastViewIdRef = react.useRef(null);
			// 程序改写输入框内容后要摆的光标位置（Tab 补全用）。受控 textarea 的 value
			// 要等 React 渲染完才生效，所以只能记下来、在 [input] 的 effect 里落实。
			const caretRef = react.useRef(null);
			// 徽标轮询的锚点：只认「面板关闭之后」新发生的非零退出。
			const lastExitAtRef = react.useRef(0);
			// 「可能在等待输入」计时：每次有新输出就重置。
			const waitingTimerRef = react.useRef(null);
			const [waitingHint, setWaitingHint] = react.useState(false);
			// 会话列表是否已经从服务端取回。自动建标签必须等它——否则面板刚打开、
			// views 还是空的那一瞬间就会建一个，跟随后恢复出来的会话变成两个。
			const [sessionsLoaded, setSessionsLoaded] = react.useState(false);
			// document 级 Ctrl+C 兜底监听读最新 activeView（effect 闭包不能直接用 state）。
			const activeViewRef = react.useRef(null);

			// 打开面板：恢复会话列表、清徽标；关闭：断掉所有 SSE（不销毁会话，
			// 会话状态在 node 半，重开时带 since 重连补齐）。
			react.useEffect(() => {
				if (!open) {
					// 关闭时把「会话列表已加载」标记清掉：下次打开要重新等服务端回话，
					// 否则自动建标签那条会拿着上一轮的结论抢跑，跟恢复出来的会话打架。
					setSessionsLoaded(false);
					for (const v of viewsRef.current) disconnectStream(v);
					// 徽标轮询：面板关闭期间检测新结束的非零退出命令。
					lastExitAtRef.current = Date.now();
					const timer = setInterval(async () => {
						try {
							const res = await getJson("/api/terminal/sessions");
							if (!res.ok || !res.data) return;
							for (const s of res.data.sessions) {
								if (s.lastExit && s.lastExit.code !== 0 && s.lastExit.at > lastExitAtRef.current) {
									badgeStore.set();
									lastExitAtRef.current = s.lastExit.at;
								}
							}
						} catch {
							// 网络错误静默（下一次轮询再试）
						}
					}, 5000);
					return () => clearInterval(timer);
				}
				badgeStore.clear();
				let alive = true;
				getJson("/api/terminal/sessions").then((res) => {
					if (!alive) return;
					if (!res.ok) {
						setNotice(t("terminal.error.load"));
						return;
					}
					const list = res.data.sessions;
					setViews((prev) => {
						// 服务端已不存在的会话（比如被 close）从本地移除。
						const aliveIds = new Set(list.map((s) => s.id));
						const next = prev.filter((v) => aliveIds.has(v.id));
						for (const s of list) {
							const found = next.find((v) => v.id === s.id);
							if (found) {
								found.cwd = s.cwd;
								found.shellKind = s.shellKind;
								found.state = s.state || found.state;
								found.currentCommand = s.currentCommand != null ? s.currentCommand : found.currentCommand;
								found.lastExit = s.lastExit || null;
								if (s.state === "idle") found.startedAt = 0;
							} else {
								next.push(createView(s));
							}
						}
						return next;
					});
					if (alive) setSessionsLoaded(true);
				}).catch(() => {
					if (alive) {
						setNotice(t("terminal.error.load"));
						setSessionsLoaded(true);
					}
				});
				return () => { alive = false; };
			}, [open, badgeStore, t]);

			// views 变化时同步到 ref（open effect 的 else 分支要读最新列表）。
			const viewsRef = react.useRef(views);
			react.useEffect(() => { viewsRef.current = views; }, [views]);

			// 每个 view 绑定渲染回调；面板打开期间所有标签保持 SSE（任何标签都实时）。
			// 依赖 [open, views]：打开面板与新建标签都会触发重连；connectStream 幂等
			// （自己先关旧连接），低频率下无妨。
			react.useEffect(() => {
				if (!open) return;
				for (const v of views) {
					v.onRender = forceRender;
					v.closed = false;
					connectStream(v);
				}
			}, [open, views]);

			// activeId 校正：指向的标签被关闭或会话列表刷新后失效时，落到第一个。
			react.useEffect(() => {
				if (!open) return;
				setActiveId((cur) => (views.some((v) => v.id === cur) ? cur : (views[0] ? views[0].id : null)));
			}, [open, views]);

			// notice 是一次性提示，4s 后自动消失。
			react.useEffect(() => {
				if (!notice) return;
				const timer = setTimeout(() => setNotice(null), 4000);
				return () => clearTimeout(timer);
			}, [notice]);

			const activeView = react.useMemo(
				() => views.find((v) => v.id === activeId) || null,
				[views, activeId]
			);
			react.useEffect(() => { activeViewRef.current = activeView; }, [activeView]);
			// 派生值必须声明在使用它的 useCallback/effect 之前 —— 依赖数组在 render
			// 时立即求值，写后面会触发 TDZ（Cannot access before initialization）让
			// 整个组件渲染崩溃（真实事故，修复过）。
			const running = !!activeView && activeView.state === "running";

			// 打开面板时聚焦输入框（用户要求回车提交后能持续输入）。
			react.useEffect(() => {
				if (!open) return;
				const timer = setTimeout(() => inputRef.current?.focus(), 50);
				return () => clearTimeout(timer);
			}, [open]);

			const setMax = (m) => {
				setMaximized(m);
				try { localStorage.setItem("dst:term:max", m ? "1" : "0"); } catch { /* 忽略 */ }
			};

			// —— 新建标签 ——
			const createTab = react.useCallback(async () => {
				if (!linkedWorkspaceId) {
					setNotice(t("terminal.error.create"));
					return;
				}
				try {
					const res = await postJson("/api/terminal/session", { workspaceId: linkedWorkspaceId });
					if (!res.ok) {
						setNotice(res.error?.message || t("terminal.error.create"));
						return;
					}
					const meta = res.data;
					// 会话已存在（服务端计数），本地建 view 并激活；SSE 由 views effect 统一建立。
					setViews((prev) => {
						if (prev.length >= 8) {
							setNotice(t("terminal.tab.maxReached"));
							return prev;
						}
						return [...prev, createView(meta)];
					});
					setActiveId(meta.id);
					setInput("");
					inputRef.current?.focus();
				} catch {
					setNotice(t("terminal.error.create"));
				}
			}, [linkedWorkspaceId, t]);

			// 打开面板就自动为当前工作区开一个标签 —— 用户反馈「打开工作区本来就该
			// 有一个对应的终端，不该还要先点 +」。三条门槛缺一不可：
			//   · 会话列表已经取回（否则会跟服务端恢复出来的会话重复建）；
			//   · 确实一个标签都没有；
			//   · 有当前工作区（没选工作区时交给空态文案去引导，那才是该出现 + 的场合）。
			// 判据是「**当前工作区**有没有对应的标签」，不是「有没有任何标签」：切到另一个
			// 工作区时，手上那个标签的 cwd 还指着上一个项目，等于没有可用的终端。
			// autoCreatedForRef 记住本次打开已经为哪个工作区自动建过，于是：重开面板不会
			// 重复建；用户手动关掉某个工作区的标签，也不会被立刻重建（关不掉）。
			const autoCreatedForRef = react.useRef(null);
			react.useEffect(() => {
				if (!open) {
					autoCreatedForRef.current = null;
					return;
				}
				if (!sessionsLoaded || !linkedWorkspaceId) return;
				if (autoCreatedForRef.current === linkedWorkspaceId) return;
				if (views.some((v) => v.workspaceId === linkedWorkspaceId)) {
					autoCreatedForRef.current = linkedWorkspaceId;
					return;
				}
				autoCreatedForRef.current = linkedWorkspaceId;
				void createTab();
			}, [open, sessionsLoaded, views, linkedWorkspaceId, createTab]);

			// —— 关闭标签 ——
			const closeTab = react.useCallback(async (id) => {
				const view = viewsRef.current.find((v) => v.id === id);
				if (!view) return;
				disconnectStream(view);
				// 服务端：kill 进程 + 移除会话；失败也继续本地移除（会话可能已消失）。
				try {
					await postJson("/api/terminal/close", { id: view.id, token: view.token });
				} catch { /* 忽略 */ }
				setViews((prev) => prev.filter((v) => v.id !== id));
				setActiveId((cur) => (cur === id ? null : cur));
			}, []);

			// 输入框高度同步：onChange 里那套只覆盖「用户敲键」，而清空、翻历史、切标签
			// 都是程序改 value，不同步的话框会留着上一次的多行高度（空框却很高）。
			// onChange 那份同步设置保留着 —— 打字时靠它当场生效，不会等一帧才回弹。
			react.useEffect(() => {
				const ta = inputRef.current;
				if (!ta) return;
				ta.style.height = "auto";
				if (input.length > 0) ta.style.height = Math.min(ta.scrollHeight, 6 * 20 + 4) + "px";
				// Tab 补全后把光标摆到填入内容之后（不摆的话浏览器会把它扔到末尾，
				// 在句中补全时就跑位了）。
				if (caretRef.current !== null) {
					const pos = caretRef.current;
					caretRef.current = null;
					try { ta.setSelectionRange(pos, pos); } catch { /* 忽略 */ }
				}
			}, [input]);

			// —— 执行 ——
			const exec = react.useCallback(async (raw) => {
				const view = activeView;
				if (!view) return;
				const command = raw.replace(/\s+$/, "");
				if (command.length === 0) return;
				// 本地拦截两条，不发给 shell：clear/cls 等价 Ctrl+L；exit 关闭标签。
				const trimmed = command.trim();
				const localOnly = trimmed === "clear" || trimmed === "cls" || trimmed === "exit";
				// 运行中不放行回车，但**保留已输入的内容** —— 输入框全程可编辑，用户
				// 可以边等边把下一条打好，命令一结束直接回车。
				if (!localOnly && view.state === "running") {
					setNotice(t("terminal.error.busy"));
					return;
				}
				// 回车瞬间就清空，不等 POST 往返：每条命令都要新起一个 shell 进程
				// （Windows 上实测冷启动近 300ms），等往返回来再清会让输入框僵住小半秒，
				// 被当成「失焦了」。失败再把内容还回去。
				setInput("");
				if (trimmed === "clear" || trimmed === "cls") {
					await clearScreen(view);
					return;
				}
				if (trimmed === "exit") {
					closeTab(view.id);
					return;
				}
				try {
					const res = await postJson("/api/terminal/exec", { id: view.id, token: view.token, command });
					if (!res.ok) {
						setNotice(res.error?.message || t("terminal.error.busy"));
						setInput(raw);
						return;
					}
					view.history = pushHistory(view.workspaceId, view.history, command);
					view.historyIdx = -1;
					view.startedAt = Date.now();
					view.lastOutputAt = Date.now();
					// 输入框已在提交瞬间清空，焦点从未离开，这里不用再动它。
				} catch {
					setNotice(t("terminal.error.busy"));
					setInput(raw);
				}
				// clearScreen 声明在后面，不能进依赖数组（依赖数组 render 时立即求值 →
				// TDZ → 整个组件渲染崩）。它接受 view 参数、不吃闭包里的 view，
				// 少一个依赖不会拿到过期状态。
			}, [activeView, closeTab, t]);

			// —— Ctrl+C / Ctrl+L ——
			const sendSignal = react.useCallback(async () => {
				const view = activeView;
				if (!view || view.state !== "running") return;
				// ^C 这一行由 node 半插入（signal 路由），这里只管发信号。
				try {
					await postJson("/api/terminal/signal", { id: view.id, token: view.token });
				} catch { /* 忽略 */ }
			}, [activeView]);

			// document 级 Ctrl+C 兜底：焦点不在输入框（点过输出区、标签、停止按钮）时
			// 命令依然能中断。输入框自己处理（那里有「选中文本则复制」的判定）；页面
			// 有选中文本（比如想复制一段输出）时不抢，让浏览器复制优先。
			// 必须放在 sendSignal 定义之后 —— 依赖数组在 render 时立即求值。
			react.useEffect(() => {
				if (!open) return;
				const onKey = (e) => {
					if (!(e.ctrlKey && (e.key === "c" || e.key === "C"))) return;
					const ae = document.activeElement;
					// contenteditable 也要排除：面板是非模态的，焦点可能落在 dsh 自己或
					// 别的客户端插件的富文本输入区里，那里习惯性按一下没有选区的 Ctrl+C
					// 不该把终端里跑着的命令杀掉 —— 而且这个因果用户根本看不出来。
					if (ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT" || ae.isContentEditable)) return;
					const sel = window.getSelection();
					if (sel && sel.toString().length > 0) return;
					const view = activeViewRef.current;
					if (view && view.state === "running") {
						e.preventDefault();
						sendSignal();
					}
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [open, sendSignal]);

			// —— 在系统终端中打开 ——
			// 面板跑不了交互式程序（vim / sudo 密码 / npm init 的问答），这是命令
			// 控制台的硬边界。与其让用户卡在那儿，不如给个台阶：带**当前 cwd**
			// 跳到系统自带的终端里去（用户可能已经 cd 到很深的地方，回工作区根
			// 目录等于让他重走一遍）。
			const openExternal = react.useCallback(async () => {
				const view = activeView;
				if (!view) return;
				try {
					const res = await postJson("/api/terminal/open-external", { id: view.id, token: view.token });
					if (!res.ok) setNotice(res.error?.message || t("terminal.external.failed"));
				} catch {
					setNotice(t("terminal.external.failed"));
				}
			}, [activeView, t]);

			const clearScreen = react.useCallback(async (view) => {
				if (!view) return;
				try {
					await postJson("/api/terminal/clear", { id: view.id, token: view.token });
				} catch { /* 忽略 */ }
				view.lines = [];
				lastLineCountRef.current = 0;
				forceRender();
			}, []);

			// —— Tab 补全 ——
			// 行为对齐 bash / PowerShell：第一次 Tab 补到公共前缀，补不动了再按才列
			// 候选。候选列表是浏览器半自己插的一条 meta 行（不进 node 的环形缓冲，
			// 刷新/重连就没了）—— 它是一次性的交互反馈，不是命令输出。
			const appendLocalLine = react.useCallback((view, text) => {
				view.lines.push(stampKey({ stream: "meta", segments: [{ t: text, cls: [] }] }));
				if (view.onRender) view.onRender();
			}, []);
			// Tab 连按会并发发请求，只认最后一次的结果（补全是"当前输入"的函数，
			// 过期响应填进去就是错的）。
			const completeSeqRef = react.useRef(0);
			const complete = react.useCallback(async (ta) => {
				const view = activeView;
				if (!view) return;
				const seq = ++completeSeqRef.current;
				let res;
				try {
					res = await postJson("/api/terminal/complete", {
						id: view.id,
						token: view.token,
						input: ta.value,
						cursor: ta.selectionStart
					});
				} catch { return; }
				if (seq !== completeSeqRef.current || !res.ok || !res.data) return;
				const d = res.data;
				if (d.items.length === 0) return;
				const current = ta.value.slice(d.start, d.end);
				const next = d.insert + (d.appendSpace ? " " : "");
				if (d.insert.length > 0 && next !== current) {
					// 有进展就填进去，光标落在填入内容之后（caretRef 由 [input] 那个
					// effect 负责落实 —— 受控 input 的 value 要等 React 渲染完才生效）。
					caretRef.current = d.start + next.length;
					setInput(ta.value.slice(0, d.start) + next + ta.value.slice(d.end));
					return;
				}
				// 补不动了：列候选（跟 shell 一样，两列以上就摊开来看）。
				if (d.items.length > 1) {
					appendLocalLine(view, d.items.join("  ") + (d.truncated ? "  …（候选过多，已截断）" : ""));
				}
			}, [activeView, appendLocalLine]);

			// —— 输入历史 ——
			const historyBack = react.useCallback(() => {
				const view = activeView;
				if (!view || view.history.length === 0) return;
				const next = view.historyIdx === -1 ? view.history.length - 1 : Math.max(0, view.historyIdx - 1);
				view.historyIdx = next;
				setInput(view.history[next]);
			}, [activeView]);
			const historyForward = react.useCallback(() => {
				const view = activeView;
				if (!view || view.historyIdx === -1) return;
				const next = view.historyIdx + 1;
				if (next >= view.history.length) {
					view.historyIdx = -1;
					setInput("");
				} else {
					view.historyIdx = next;
					setInput(view.history[next]);
				}
			}, [activeView]);

			// —— 滚动跟随 ——
			const handleScroll = react.useCallback(() => {
				const el = outputRef.current;
				if (!el) return;
				const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
				if (atBottom && !followRef.current) {
					followRef.current = true;
					// followRef 管逻辑、follow state 管渲染（pill 的显隐）：只改 ref
					// 不改 state，pill 永远不会出现（漏过一次，就是这个原因）。
					setFollow(true);
					setPendingCount(0);
				} else if (!atBottom && followRef.current) {
					followRef.current = false;
					setFollow(false);
				}
			}, []);
			const goBottom = react.useCallback(() => {
				followRef.current = true;
				setFollow(true);
				setPendingCount(0);
				const el = outputRef.current;
				if (el) el.scrollTop = el.scrollHeight;
			}, []);

			// 渲染后：跟随模式滚到底；非跟随模式累积新行数显示 pill。
			//
			// **这个 effect 不能挂依赖数组。** 新行是就地 push 到 view 对象上的（SSE
			// handler 直接改 view.lines，再用 forceRender 触发重渲染），views 数组和
			// activeView 的引用自始至终不变 —— 挂 [activeView] 的话它只在首次挂载跑
			// 一次，之后永远不会重跑，表现就是「有输出但视图一直停在顶部」。
			react.useEffect(() => {
				const view = activeView;
				const el = outputRef.current;
				if (!view || !el) return;
				const count = view.lines.length;
				// 切标签：重置计数与跟随态，直接落到底部。
				if (lastViewIdRef.current !== view.id) {
					lastViewIdRef.current = view.id;
					lastLineCountRef.current = count;
					followRef.current = true;
					setFollow(true);
					setPendingCount(0);
					el.scrollTop = el.scrollHeight;
					return;
				}
				if (!followRef.current && count > lastLineCountRef.current) {
					setPendingCount((p) => p + (count - lastLineCountRef.current));
				}
				lastLineCountRef.current = count;
				if (followRef.current) el.scrollTop = el.scrollHeight;
			});

			// 「可能在等待输入」提示：运行超过 10s 且期间零输出。用 2s 轮询驱动。
			react.useEffect(() => {
				clearInterval(waitingTimerRef.current);
				waitingTimerRef.current = setInterval(() => {
					const view = activeView;
					if (!view || view.state !== "running") {
						if (waitingHint) setWaitingHint(false);
						return;
					}
					setWaitingHint(Date.now() - view.lastOutputAt > 10000);
				}, 2000);
				return () => clearInterval(waitingTimerRef.current);
			}, [activeView, waitingHint]);

			// —— 输入区 ——
			const onKeyDown = react.useCallback((e) => {
				const ta = e.currentTarget;
				// 运行中不再另开一条分支：输入框全程可编辑，打字、翻历史都照常，
				// 只有回车会被 exec 里的 busy 判定挡下（并保留已输入的内容）。
				if (e.key === "Tab") {
					// 必须 preventDefault：Tab 的默认行为是把焦点移走，一按补全就丢焦点。
					e.preventDefault();
					complete(ta);
					return;
				}
				if (e.key === "Enter" && !e.shiftKey) {
					e.preventDefault();
					exec(ta.value);
					return;
				}
				if (e.key === "ArrowUp" && ta.selectionStart === 0) {
					e.preventDefault();
					historyBack();
					return;
				}
				if (e.key === "ArrowDown" && ta.selectionStart === ta.value.length) {
					e.preventDefault();
					historyForward();
					return;
				}
				if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
					// 有选中文本时让浏览器复制，不抢 Ctrl+C。
					if (ta.selectionStart !== ta.selectionEnd) return;
					e.preventDefault();
					sendSignal();
					return;
				}
				if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
					e.preventDefault();
					clearScreen(activeView);
				}
			}, [exec, complete, historyBack, historyForward, sendSignal, clearScreen, activeView]);

			// textarea 高度自适应（1 行起，最多 6 行）。
			const onInputChange = react.useCallback((e) => {
				const ta = e.target;
				ta.style.height = "auto";
				ta.style.height = Math.min(ta.scrollHeight, 6 * 20 + 4) + "px";
				setInput(ta.value);
			}, []);

			const showEmpty = !activeView || activeView.lines.length === 0;
			const renderLines = activeView ? activeView.lines.slice(-2000) : [];
			// 渲染层只画最近 2000 行（说明书要求；更早的在 node 环形缓冲里也已经丢了）。

			return react_jsx_runtime.jsxs("div", {
				className: "dstPanel" + (open ? " dstOpen" : "") + (dark ? " dstDark" : "") + (maximized ? " dstMax" : ""),
				children: [
					// header
					react_jsx_runtime.jsxs("div", { className: "dstHeader", children: [
						react_jsx_runtime.jsx("span", { className: "dstHeaderTitle", children: t("terminal.panel.title") }),
						// 没有标签时没有 cwd 可用，按钮就没有意义，隐藏掉。
						activeView ? react_jsx_runtime.jsx("button", {
							type: "button", className: "dstIconBtn",
							"aria-label": t("terminal.external.open"), title: t("terminal.external.open"),
							onClick: openExternal,
							children: react_jsx_runtime.jsx(ExternalIcon, {})
						}) : null,
						react_jsx_runtime.jsx("button", {
							type: "button", className: "dstIconBtn",
							"aria-label": t("terminal.panel.newTab"), title: t("terminal.panel.newTab"),
							onClick: createTab,
							children: react_jsx_runtime.jsx(PlusIcon, {})
						}),
						react_jsx_runtime.jsx("button", {
							type: "button", className: "dstIconBtn",
							"aria-label": maximized ? t("terminal.panel.restore") : t("terminal.panel.maximize"),
							title: maximized ? t("terminal.panel.restore") : t("terminal.panel.maximize"),
							onClick: () => setMax(!maximized),
							children: maximized ? react_jsx_runtime.jsx(RestoreIcon, {}) : react_jsx_runtime.jsx(MaximizeIcon, {})
						}),
						react_jsx_runtime.jsx("button", {
							type: "button", className: "dstIconBtn",
							"aria-label": t("terminal.panel.close"), title: t("terminal.panel.close"),
							onClick: () => store.close(),
							children: react_jsx_runtime.jsx(CloseIcon, {})
						})
					] }),
					// tabs
					views.length > 0 ? react_jsx_runtime.jsx("div", { className: "dstTabs", children: views.map((v, i) => react_jsx_runtime.jsxs("button", {
						type: "button",
						className: "dstTab" + (v.id === activeId ? " dstTabActive" : "") + (v.state === "running" ? " dstTabRunning" : ""),
						"aria-label": v.id === activeId ? t("terminal.panel.title") : "",
						onClick: () => {
							setActiveId(v.id);
							// 切到被断开的标签（面板关闭期间）时重连；输入框是共享草稿，
							// 切标签清掉，避免把上一个标签没发出去的半句话带到这边。
							setInput("");
							if (v.closed) { v.closed = false; connectStream(v); }
							inputRef.current?.focus();
						},
						children: [
							react_jsx_runtime.jsx("span", { className: "dstTabDot", children: "●" }),
							react_jsx_runtime.jsx("span", { className: "dstTabLabel", children: v.currentCommand || `${i + 1} ${v.shellKind}` }),
							v.id === activeId ? react_jsx_runtime.jsx("span", {
								className: "dstTabClose",
								"aria-label": t("terminal.tab.close"), title: t("terminal.tab.close"),
								onClick: (e) => { e.stopPropagation(); closeTab(v.id); },
								children: "×"
							}) : null
						]
					}, v.id)) }) : null,
					// 输出区
					react_jsx_runtime.jsxs("div", {
						className: "dstOutput",
						ref: outputRef,
						onScroll: handleScroll,
						children: [
							showEmpty ? react_jsx_runtime.jsx("div", { className: "dstEmpty", children: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
								// 没标签时分两种情况：没选工作区 → 说明「打开工作区就会自动开」
								// （这才是唯一该出现空态的场合）；有工作区却没标签 → 只可能是
								// 用户自己把标签都关了，那就照旧提示点 +。
								views.length === 0
									? react_jsx_runtime.jsx("div", { children: linkedWorkspaceId ? t("terminal.empty.noTabs") : t("terminal.empty.noWorkspace") })
									: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
										react_jsx_runtime.jsx("div", { className: "dstEmptyTitle", children: t("terminal.empty.title") }),
										react_jsx_runtime.jsx("div", { children: activeView && activeView.shellKind === "pwsh" ? t("terminal.empty.shell.pwsh") : t("terminal.empty.shell.bash") }),
										react_jsx_runtime.jsx("div", { children: t("terminal.empty.noInteractive") }),
										// Tab 补全是看不见的功能，空态提一句，否则没人会去按。
										react_jsx_runtime.jsx("div", { children: t("terminal.empty.hint") })
									] })
							] }) }) : null,
							renderLines.map((line, i) => {
								const text0 = line.segments.length > 0 ? line.segments[0].t : "";
								let cls = "dstLine";
								if (line.stream === "err") cls += " dstLineErr";
								else if (line.stream === "meta") {
									cls += " dstLineMeta";
									if (text0.startsWith("❯")) cls += " dstLineCmd";
									else if (text0.startsWith("✗")) cls += " dstLineCmdErr";
								}
								return react_jsx_runtime.jsx("div", {
									className: cls,
									children: text0.startsWith("❯")
										? react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
											react_jsx_runtime.jsx("span", { className: "dstPromptMark", children: "❯" }),
											react_jsx_runtime.jsx("span", { children: text0.slice(1) }),
											...line.segments.slice(1).map((seg, j) => react_jsx_runtime.jsx("span", { className: seg.cls.join(" "), children: seg.t }, j + 1))
										] })
										: line.segments.map((seg, j) => react_jsx_runtime.jsx("span", { className: seg.cls.join(" "), children: seg.t }, j))
								}, line.__k);
							}),
							!follow && pendingCount > 0 ? react_jsx_runtime.jsx("button", {
								type: "button", className: "dstScrollPill",
								onClick: goBottom,
								children: t("terminal.scroll.newOutput").replace("{n}", String(pendingCount))
							}) : null
						]
					}),
					// 等待输入提示
					waitingHint && running ? react_jsx_runtime.jsx("div", { className: "dstWaitingHint", children: t("terminal.input.waiting") }) : null,
					notice ? react_jsx_runtime.jsx("div", { className: "dstWaitingHint", style: { color: "var(--dsw-alias-state-error-primary,#f0617a)" }, children: notice }) : null,
					// 输入区
					react_jsx_runtime.jsxs("div", { className: "dstInputRow", children: [
						react_jsx_runtime.jsx("span", { className: "dstPrompt", children: "❯" }),
						react_jsx_runtime.jsx("textarea", {
							className: "dstInput",
							rows: 1,
							value: input,
							ref: inputRef,
							// 不用 disabled 也不用 readOnly：前者收不到键盘事件（Ctrl+C 中断
							// 会整个失效），后者会置灰、被当成失焦。运行中照样能打字，只是
							// 回车不放行（exec 里的 busy 判定），提交由 placeholder 与状态栏
							// 的停止按钮提示。
							placeholder: running ? t("terminal.input.running") : t("terminal.input.placeholder"),
							spellCheck: false,
							autoComplete: "off",
							onChange: onInputChange,
							onKeyDown
						})
					] }),
					// 状态栏
					react_jsx_runtime.jsxs("div", { className: "dstStatusBar", children: [
						activeView ? react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
							react_jsx_runtime.jsxs("span", { className: "dstStatusCwd", title: activeView.cwd, children: [
								react_jsx_runtime.jsx("span", { className: "dstStatusShell", children: `${activeView.shellKind} · ` }),
								react_jsx_runtime.jsx("span", { className: "dstStatusPath", children: activeView.cwd })
							] })
						] }) : react_jsx_runtime.jsx("span", { className: "dstStatusCwd" }),
						running ? react_jsx_runtime.jsxs("span", { className: "dstStatusRight", children: [
							// 停止按钮：运行中可见，不依赖用户记得 Ctrl+C（可发现性）。
							react_jsx_runtime.jsx("button", {
								type: "button", className: "dstStopBtn",
								"aria-label": t("terminal.signal.stop"), title: t("terminal.signal.stop"),
								onClick: () => { sendSignal(); inputRef.current?.focus(); },
								children: t("terminal.signal.stop")
							}),
							react_jsx_runtime.jsx("span", { className: "dstSpinner" }),
							react_jsx_runtime.jsx("span", { children: t("terminal.status.running") })
						] }) : null
					] })
				]
			});
		}
		//#endregion

		const inject = ["slots", "locale", "workspaces", "sessions", "theme"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "terminal-panel: dictionaries");
			// 清掉旧版按会话 id 存的历史键（它们永远不会再被读到，只会越堆越多）。
			migrateHistoryKeys();
			const store = createOpenStore();
			const badgeStore = createBadgeStore();
			const themeStore = createThemeStore(ctx);

			ctx.slots.inject("sidebar.footer.action", () => {
				const dispose = ctx.slots.register({
					name: "sidebar.footer.action",
					id: "terminal-panel",
					// order: 90 —— 排序先 priority 后 order 都升序，数字小的在上面；
					// Git 是 100，终端要排在 Git 上面（留了间隔，将来还能往中间插）。
					order: 90,
					locale: NS,
					inject: () => ({ store, badgeStore })
				}, TerminalFooterAction);
				return () => dispose();
			});

			ctx.slots.inject("shell.overlay", () => {
				const dispose = ctx.slots.register({
					name: "shell.overlay",
					id: "terminal-panel-overlay",
					locale: NS,
					inject: () => ({ store, badgeStore, themeStore, workspacesList: ctx.workspaces.list, sessionsList: ctx.sessions.list })
				}, TerminalPanel);
				return () => dispose();
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
