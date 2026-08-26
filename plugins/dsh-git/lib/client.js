window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-git",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		const NS = "git";

		const zh = {
			"git.panel.label": "Git",
			"git.panel.close": "关闭",
			"git.panel.refresh": "刷新",
			"git.workspace.label": "工作区",
			"git.workspace.none": "没有可用的工作区",
			"git.status.loading": "加载中…",
			"git.status.notRepo": "当前工作区不是 Git 仓库",
			"git.status.gitNotFound": "未检测到 Git，请确认已安装并加入 PATH",
			"git.status.indexLocked": "Git 索引被占用，请稍后重试",
			"git.status.noIdentity": "未配置 Git 用户名/邮箱",
			"git.status.error": "加载失败",
			"git.branch.detached": "分离头指针",
			"git.branch.unborn": "尚无提交",
			"git.branch.label": "分支",
			"git.branch.switching": "切换中…",
			"git.section.changes": "变更",
			"git.section.collapse": "折叠",
			"git.section.expand": "展开",
			"git.history.pushed": "已推送",
			"git.history.unpushed": "未推送",
			"git.section.staged": "已暂存的更改",
			"git.section.unstaged": "更改",
			"git.section.untracked": "未跟踪的文件",
			"git.section.empty": "没有变更",
			"git.section.history": "最近提交",
			"git.history.empty": "暂无提交记录",
			"git.action.stage": "暂存此文件",
			"git.action.unstage": "取消暂存此文件",
			"git.commit.placeholder": "提交信息",
			"git.commit.submit": "提交",
			"git.commit.submitting": "提交中…",
			"git.commit.done": "已提交",
			"git.commit.nothingToCommit": "没有可提交的更改",
			"git.commit.untrackedOnly": "只有未跟踪的新文件，请先点文件旁的「+」暂存后再提交",
			"git.push.submit": "推送",
			"git.push.nothing": "没有待推送的提交",
			"git.push.pushing": "推送中…",
			"git.push.done": "已推送",
			"git.history.undo": "撤销这次提交",
			"git.history.undoConfirm": "确认撤销？",
			"git.history.undoing": "撤销中…",
			"git.history.undoneReset": "已撤销提交，改动已退回工作区",
			"git.history.undoneRevert": "已用 revert 撤销这次提交（生成了一条新提交，别忘了推送）",
			"git.commit.firstCommit": "这是仓库的第一个提交，没有更早的状态可以退回"
		};
		const en = {
			"git.panel.label": "Git",
			"git.panel.close": "Close",
			"git.panel.refresh": "Refresh",
			"git.workspace.label": "Workspace",
			"git.workspace.none": "No workspace available",
			"git.status.loading": "Loading…",
			"git.status.notRepo": "This workspace is not a Git repository",
			"git.status.gitNotFound": "Git not found — make sure it's installed and on PATH",
			"git.status.indexLocked": "Git index is locked, try again shortly",
			"git.status.noIdentity": "Git user name/email not configured",
			"git.status.error": "Failed to load",
			"git.branch.detached": "detached HEAD",
			"git.branch.unborn": "no commits yet",
			"git.branch.label": "Branch",
			"git.branch.switching": "Switching…",
			"git.section.changes": "Changes",
			"git.section.collapse": "Collapse",
			"git.section.expand": "Expand",
			"git.history.pushed": "Pushed",
			"git.history.unpushed": "Not pushed",
			"git.section.staged": "Staged Changes",
			"git.section.unstaged": "Changes",
			"git.section.untracked": "Untracked Files",
			"git.section.empty": "No changes",
			"git.section.history": "Recent Commits",
			"git.history.empty": "No commits yet",
			"git.action.stage": "Stage this file",
			"git.action.unstage": "Unstage this file",
			"git.commit.placeholder": "Commit message",
			"git.commit.submit": "Commit",
			"git.commit.submitting": "Committing…",
			"git.commit.done": "Committed",
			"git.commit.nothingToCommit": "No changes to commit",
			"git.commit.untrackedOnly": "Only untracked new files — stage them with “+” first",
			"git.push.submit": "Push",
			"git.push.nothing": "Nothing to push",
			"git.push.pushing": "Pushing…",
			"git.push.done": "Pushed",
			"git.history.undo": "Undo this commit",
			"git.history.undoConfirm": "Confirm undo?",
			"git.history.undoing": "Undoing…",
			"git.history.undoneReset": "Commit undone, changes are back in the working tree",
			"git.history.undoneRevert": "Undone via revert (created a new commit — remember to push it)",
			"git.commit.firstCommit": "This is the repository's first commit — there is no earlier state to go back to"
		};

		//#region 样式
		// 颜色全部走 dsh 的设计 token（--dsw-alias-*），保证浅色/深色主题下都不露馅；
		// 兜底值取自已验证可用的深色主题实测色，万一变量取不到也不会露出色差。
		const css = [
			".dsgFooterBtn{display:inline-flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);cursor:pointer;font-size:13px;font-family:inherit;transition:background .15s ease,color .15s ease}",
			".dsgFooterBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f9fafb)}",
			".dsgFooterBtnActive{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f9fafb)}",
			".dsgFooterBtn svg{flex:none;display:block}",
			".dsgFooterBtnLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			// 背景遮罩：点它关面板（类似对话框点空白处关闭）。z-index 只需要比 .dsgPanel
			// 低即可，两者都在 shell.overlay 那层里，不需要跟外面的世界比较。
			".dsgBackdrop{position:fixed;inset:0;z-index:1;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32));opacity:0;pointer-events:none;transition:opacity .16s ease}",
			".dsgBackdrop.dsgOpen{opacity:1;pointer-events:auto}",
			// 面板本体：定宽定高、四角圆润，跟对话框一个体量，不铺满桌面。用
			// translateY(-50%) 垂直居中，动画只叠加同一个 transform 里的位移分量，
			// 跟居中不冲突。挂载后常驻 DOM（见 GitPanel），开关只切 dsgOpen 这个
			// class，这样关闭时也能把内容一起淡出，而不是瞬间抽掉再空盒子飘走。
			".dsgPanel{position:fixed;top:50%;right:20px;z-index:2;width:420px;max-width:92vw;height:min(760px,88vh);display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay,#1b1b1c);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary,#f9fafb);font-size:13px;overflow:hidden;" +
			"opacity:0;pointer-events:none;transform:translateY(-50%) translateX(12px) scale(.98);transition:opacity .16s ease,transform .16s ease}",
			".dsgPanel.dsgOpen{opacity:1;pointer-events:auto;transform:translateY(-50%) translateX(0) scale(1)}",
			".dsgHeader{flex:none;display:flex;align-items:center;gap:6px;padding:12px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}",
			".dsgHeaderTitle{font-weight:600;font-size:14px;margin-right:auto}",
			".dsgIconBtn{flex:none;width:26px;height:26px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .15s ease,color .15s ease}",
			".dsgIconBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f9fafb)}",
			".dsgBody{flex:1;min-height:0;overflow-y:auto;padding:10px 12px 16px}",
			".dsgWorkspaceRow{margin-bottom:10px;position:relative}",
			".dsgBranchRow{display:flex;align-items:center;gap:6px;margin-bottom:12px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#cfd3d6);position:relative}",
			".dsgBranchRow svg{flex:none;color:var(--dsw-alias-label-tertiary,#8b949e)}",
			".dsgBranchAB{color:var(--dsw-alias-label-tertiary,#8b949e)}",
			// 自绘下拉：默认（workspace 用）铺满宽度、带边框；.dsgDropdownCompact
			// （branch 用）宽度跟内容走、静置时几乎看不出是个控件，跟旁边的纯文本
			// （detached/尚无提交）视觉一致，跟原来 .dsgBranchSelect 的观感对齐。
			".dsgDropdown{position:relative}",
			".dsgDropdownTrigger{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;height:30px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-1,#151517);color:var(--dsw-alias-label-primary,#f9fafb);font-size:12.5px;font-family:inherit;cursor:pointer;text-align:left}",
			".dsgDropdownTrigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
			".dsgDropdownTrigger:disabled{opacity:.6;cursor:default}",
			".dsgDropdownTrigger svg{flex:none;color:var(--dsw-alias-label-tertiary,#8b949e)}",
			".dsgDropdownValue{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsgDropdownCompact{display:inline-block}",
			// 分支下拉：原来是「几乎看不出是个可点控件」的紧凑态（无边框、2px 内边距），
			// 用户反馈太小不好点。给回边框与实体背景、加大到 26px 高，仍比工作区那个
			// 满宽下拉克制，但一眼能看出可点。
			".dsgDropdownCompact .dsgDropdownTrigger{width:auto;max-width:240px;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-1,#151517);border-radius:7px}",
			".dsgDropdownCompact .dsgDropdownTrigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
			// 弹层自己独立圆角 + 阴影 + 边框，颜色全走 token——这就是自绘下拉相对原生
			// select 的意义所在：这几样原生弹层基本不受 CSS 控制。
			".dsgDropdownMenu{position:absolute;top:calc(100% + 4px);left:0;z-index:10;min-width:160px;max-width:280px;max-height:220px;overflow-y:auto;background:var(--dsw-alias-bg-layer-2,#232326);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.36);padding:4px}",
			".dsgDropdown:not(.dsgDropdownCompact) .dsgDropdownMenu{right:0;width:auto;left:0}",
			".dsgDropdownOption{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);font-size:12.5px;font-family:inherit;text-align:left;cursor:pointer;white-space:nowrap}",
			".dsgDropdownOption:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f9fafb)}",
			// 当前分支/工作区：强调色 + 勾选图标，跟其余选项拉开明显差距，不能靠
			// 「稍微深一点的灰」这种弱对比——那正是之前被反馈「看不清」的原因。
			".dsgDropdownOptionActive{color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}",
			".dsgDropdownOptionSpacer{display:inline-block;width:12px;flex:none}",
			".dsgDropdownOptionLabel{overflow:hidden;text-overflow:ellipsis}",
			// checkout 被拦下时后端会把 git 的多行提示原样传回来（文件列表在第二行起），
			// pre-line 让 \n 真正换行，不然一长串挤在一行里根本看不出是哪个文件。
			".dsgBanner{padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#151517);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,#cfd3d6);font-size:12.5px;line-height:1.6;margin-bottom:12px;white-space:pre-line}",
			".dsgBannerErr{color:var(--dsw-alias-state-error-primary,#f0617a)}",
			".dsgSection{margin-bottom:14px}",
			".dsgSectionTitle{display:flex;align-items:center;justify-content:space-between;font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;color:var(--dsw-alias-label-tertiary,#8b949e);margin-bottom:6px}",
			".dsgFileRow{display:flex;align-items:center;gap:8px;padding:5px 4px;border-radius:6px}",
			".dsgFileRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
			".dsgFileRow:hover .dsgFileAction{opacity:1}",
			".dsgFileBadge{flex:none;width:16px;text-align:center;font-size:11px;font-weight:700;font-family:ui-monospace,monospace}",
			".dsgFilePath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#cfd3d6)}",
			".dsgFileAction{flex:none;width:22px;height:22px;border:none;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#f9fafb);cursor:pointer;font-size:13px;line-height:1;opacity:0;transition:opacity .15s ease,background .15s ease}",
			".dsgFileAction:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.14))}",
			".dsgEmpty{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12.5px;padding:4px}",
			".dsgCommitBox{margin:14px 0;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}",
			".dsgCommitInput{width:100%;resize:vertical;min-height:56px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-1,#151517);color:var(--dsw-alias-label-primary,#f9fafb);font-size:12.5px;font-family:inherit;box-sizing:border-box}",
			".dsgCommitInput:disabled{opacity:.6}",
			".dsgCommitFooter{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:8px}",
			".dsgCommitResult{font-size:12px;color:var(--dsw-alias-state-success-primary,#3fb950)}",
			".dsgCommitBtn{height:30px;padding:0 16px;border:none;border-radius:8px;background:var(--dsw-alias-button-primary-fill,#4d6bfe);color:var(--dsw-alias-label-primary-inverted,#fff);font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;transition:background .15s ease,opacity .15s ease}",
			// 推送是次级动作：描边按钮，跟实心的提交拉开层级，两个都常驻也不会打架。
			".dsgCommitBtnSecondary{background:transparent;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));color:var(--dsw-alias-label-primary,#f9fafb)}",
			".dsgCommitBtnSecondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
			".dsgCommitBtn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#5a77ff)}",
			".dsgCommitBtn:disabled{opacity:.45;cursor:default}",
			".dsgHistoryRow{padding:6px 4px;border-radius:6px}",
			".dsgHistoryRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
			".dsgHistoryTop{display:flex;align-items:baseline;gap:8px}",
			".dsgHistoryHash{flex:none;font-family:ui-monospace,monospace;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b949e)}",
			".dsgHistorySubject{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#f9fafb)}",
			".dsgHistoryMeta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e);margin-top:2px}",
			// 提交的推送状态：用户反馈「看不出哪些提交推过了」。未推送的用强调色实心点
			// + 文字，已推送的用弱化的空心点 —— 未推送是**需要用户行动**的状态，
			// 必须比已推送显眼，光靠灰度差分不出来。
			".dsgPushState{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:10.5px;line-height:1;padding:2px 6px;border-radius:999px;white-space:nowrap}",
			".dsgPushStateUnpushed{color:var(--dsw-alias-state-warn-primary,#e3a008);background:var(--dsw-alias-state-warn-bg,rgba(227,160,8,.12))}",
			".dsgPushStatePushed{color:var(--dsw-alias-label-tertiary,#8b949e)}",
			// 变更区可折叠：issue 里提到「更改文件的查看优先级不用那么高」。折叠头是
			// 整行可点的按钮，右侧是文件总数。
			".dsgCollapseHead{display:flex;align-items:center;gap:6px;width:100%;padding:4px 4px;margin-bottom:6px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;font-family:inherit;cursor:pointer;text-align:left}",
			".dsgCollapseHead:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-secondary,#cfd3d6)}",
			".dsgCollapseHead .dsgCollapseCount{margin-left:auto;font-weight:500}",
			".dsgCollapseChevron{flex:none;transition:transform .15s ease}",
			".dsgCollapseChevron.dsgCollapsed{transform:rotate(-90deg)}",
			// 武装态（等待第二次点击确认）用错误色实心填充+文字提醒——光换图标
			// 颜色太容易被忽略（按钮本来就小），实心背景+长出来的文字才不会被
			// 误以为「点了没反应」。跟标题栏关闭按钮 hover 变红是同一套危险确认
			// 语言，只是这里需要更明显，因为不是 hover 态而是需要主动注意到的
			// 状态变化。
			".dsgUndoBtn{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:22px;height:22px;padding:0 4px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;white-space:nowrap;cursor:pointer;transition:background .15s ease,color .15s ease}",
			".dsgUndoBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f9fafb)}",
			".dsgUndoBtn.dsgUndoBtnArmed{padding:0 8px;color:var(--dsw-alias-label-primary-inverted,#fff);background:var(--dsw-alias-state-error-primary,#f0617a)}",
			".dsgUndoBtn.dsgUndoBtnArmed:hover{background:var(--dsw-alias-state-error-primary,#f0617a)}",
			".dsgUndoBtn.dsgUndoBtnBusy{padding:0 8px;color:var(--dsw-alias-label-tertiary,#8b949e)}",
			".dsgUndoBtn:disabled{opacity:.7;cursor:default}",
			".dsgUndoBtnLabel{font-weight:500}"
		].join("");
		const tagId = "@deepseek-ai/dsh-git/panel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-git";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region 共享的开关状态（footer 按钮与浮层面板之间唯一的耦合）
		// 两个槽注册各自独立，唯一要同步的是「面板开没开」，用最小的手写 store +
		// useSyncExternalStore 代替额外状态管理库——跟 dsh 自己内部（PopupSelectView
		// 等）同一个模式，注册进 inject() 的是这个 store 引用本身，不是某次快照。
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
		//#endregion

		//#region 小图标
		function GitIcon({ size }) {
			return react_jsx_runtime.jsxs("svg", {
				viewBox: "0 0 24 24", width: size, height: size, fill: "none",
				stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round",
				children: [
					react_jsx_runtime.jsx("line", { x1: "6", y1: "3", x2: "6", y2: "15" }),
					react_jsx_runtime.jsx("circle", { cx: "18", cy: "6", r: "3" }),
					react_jsx_runtime.jsx("circle", { cx: "6", cy: "18", r: "3" }),
					react_jsx_runtime.jsx("path", { d: "M18 9a9 9 0 0 1-9 9" })
				]
			});
		}
		function CloseIcon() {
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16", width: 14, height: 14, fill: "none",
				stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round",
				children: react_jsx_runtime.jsx("path", { d: "M3 3 L13 13 M13 3 L3 13" })
			});
		}
		function RefreshIcon() {
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16", width: 14, height: 14, fill: "none",
				stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round",
				children: react_jsx_runtime.jsx("path", { d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" })
			});
		}
		function ChevronIcon() {
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16", width: 12, height: 12, fill: "none",
				stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round",
				children: react_jsx_runtime.jsx("path", { d: "M4 6l4 4 4-4" })
			});
		}
		function CheckIcon() {
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16", width: 12, height: 12, fill: "none",
				stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round",
				children: react_jsx_runtime.jsx("path", { d: "M3.5 8.5l3 3 6-7" })
			});
		}
		function UndoIcon() {
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16", width: 12, height: 12, fill: "none",
				stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round",
				children: react_jsx_runtime.jsx("path", { d: "M4 4.5L1.5 7l2.5 2.5M2 7h7.5a4 4 0 1 1 0 8H8" })
			});
		}
		//#endregion

		//#region 自绘下拉框
		// 原生 <select> 的展开弹层是 OS/Chromium 原生渲染的：border-radius 基本不生效，
		// <option> 的文字颜色也经常不听页面 CSS（Windows 上常见问题）——这正是「没圆角」
		// 和「非当前分支看不清」这两条反馈的根因。自己画整个下拉（按钮 + 绝对定位列表），
		// 颜色和圆角才是真正受控的，跟面板其它地方一致。workspace 和 branch 两处都用它，
		// 免得一个原生一个自绘、观感不统一。
		function Dropdown({ value, options, onChange, disabled, ariaLabel, compact }) {
			const [open, setOpen] = react.useState(false);
			const rootRef = react.useRef(null);

			react.useEffect(() => {
				if (!open) return;
				const onDocPointerDown = (e) => {
					if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
				};
				const onKeyDown = (e) => {
					if (e.key === "Escape") setOpen(false);
				};
				document.addEventListener("mousedown", onDocPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("mousedown", onDocPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			const current = options.find((o) => o.value === value);

			return react_jsx_runtime.jsxs("div", {
				ref: rootRef,
				className: "dsgDropdown" + (compact ? " dsgDropdownCompact" : ""),
				children: [
					react_jsx_runtime.jsxs("button", {
						type: "button",
						className: "dsgDropdownTrigger",
						disabled,
						"aria-label": ariaLabel,
						"aria-haspopup": "listbox",
						"aria-expanded": open,
						onClick: () => setOpen((o) => !o),
						children: [
							react_jsx_runtime.jsx("span", { className: "dsgDropdownValue", children: current ? current.label : "" }),
							react_jsx_runtime.jsx(ChevronIcon, {})
						]
					}),
					open ? react_jsx_runtime.jsx("div", {
						className: "dsgDropdownMenu",
						role: "listbox",
						"aria-label": ariaLabel,
						children: options.map((o) => react_jsx_runtime.jsxs("button", {
							type: "button",
							role: "option",
							"aria-selected": o.value === value,
							className: "dsgDropdownOption" + (o.value === value ? " dsgDropdownOptionActive" : ""),
							onClick: () => { onChange(o.value); setOpen(false); },
							children: [
								o.value === value ? react_jsx_runtime.jsx(CheckIcon, {}) : react_jsx_runtime.jsx("span", { className: "dsgDropdownOptionSpacer" }),
								react_jsx_runtime.jsx("span", { className: "dsgDropdownOptionLabel", children: o.label })
							]
						}, o.value))
					}) : null
				]
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

		//#region 状态展示辅助
		function statusLabel(code) {
			return code && code !== "." ? code : "?";
		}
		function statusColor(code) {
			if (code === "A") return "var(--dsw-alias-state-success-primary,#3fb950)";
			if (code === "D") return "var(--dsw-alias-state-error-primary,#f0617a)";
			if (code === "U") return "var(--dsw-alias-state-error-primary,#f0617a)";
			if (code === "M" || code === "R" || code === "C" || code === "T") return "var(--dsw-alias-state-warn-primary,#e3a008)";
			return "var(--dsw-alias-label-tertiary,#8b949e)";
		}
		function errorMessage(t, error) {
			if (!error) return t("git.status.error");
			switch (error.code) {
				case "not-a-repo": return t("git.status.notRepo");
				case "git-not-found": return t("git.status.gitNotFound");
				case "index-locked": return t("git.status.indexLocked");
				case "no-identity": return t("git.status.noIdentity");
				case "workspace-not-found": return t("git.workspace.none");
				case "nothing-to-commit": return t("git.commit.nothingToCommit");
				case "untracked-only": return t("git.commit.untrackedOnly");
				case "first-commit": return t("git.commit.firstCommit");
				default: return error.message || t("git.status.error");
			}
		}
		function formatDate(iso) {
			if (typeof iso !== "string" || iso.length < 16) return iso || "";
			// iso-strict 形如 2026-08-25T14:03:11+08:00，面板里只需要到分钟。
			return iso.slice(0, 16).replace("T", " ");
		}
		//#endregion

		function FileSection({ title, entries, mode, onAction, t }) {
			if (entries.length === 0) return null;
			return react_jsx_runtime.jsxs("div", { className: "dsgSection", children: [
				react_jsx_runtime.jsxs("div", { className: "dsgSectionTitle", children: [
					react_jsx_runtime.jsx("span", { children: title }),
					react_jsx_runtime.jsx("span", { children: entries.length })
				] }),
				entries.map((entry) => react_jsx_runtime.jsx("div", {
					className: "dsgFileRow",
					children: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
						react_jsx_runtime.jsx("span", { className: "dsgFileBadge", style: { color: statusColor(mode === "staged" ? entry.x : (mode === "untracked" ? "?" : entry.y)) }, children: statusLabel(mode === "staged" ? entry.x : (mode === "untracked" ? "?" : entry.y)) }),
						react_jsx_runtime.jsx("span", { className: "dsgFilePath", title: entry.path, children: entry.path }),
						react_jsx_runtime.jsx("button", {
							type: "button",
							className: "dsgFileAction",
							"aria-label": mode === "staged" ? t("git.action.unstage") : t("git.action.stage"),
							title: mode === "staged" ? t("git.action.unstage") : t("git.action.stage"),
							onClick: () => onAction(entry.path),
							children: mode === "staged" ? "−" : "+"
						})
					] })
				}, entry.path))
			] });
		}

		function CommitBox({ t, committing, pushing, message, onMessageChange, onCommit, onPush, canPush, ahead, resultMessage, actionError }) {
			// 不再拿「有没有已暂存的更改」硬锁提交按钮——git 自己会在没有暂存内容时
			// 拒绝，我们把那条拒绝原样翻成 actionError 显示出来即可。按钮长期灰着
			// 会被误认成「坏了」，不如让它一直可点、点了没东西可提交就明确告诉你。
			//
			// **提交与推送是两个常驻按钮**，不再共用一个位置来回切。早期那版是
			// 「消息框空着且本地领先远端时，按钮变成推送」，用户反馈（issue #1）说
			// 这不合理：有未推送的提交、同时又有新改动想提交时，界面只给推送，
			// 想提交得先在消息框里打字才能把按钮换回来 —— 本末倒置。两个按钮各自
			// 按自己的条件启用，用户想干哪件就点哪个。
			const busy = committing || pushing;
			const commitLabel = committing ? t("git.commit.submitting") : t("git.commit.submit");
			const pushLabel = pushing
				? t("git.push.pushing")
				: (ahead > 0 ? `${t("git.push.submit")} ↑${ahead}` : t("git.push.submit"));
			return react_jsx_runtime.jsxs("div", { className: "dsgCommitBox", children: [
				react_jsx_runtime.jsx("textarea", {
					className: "dsgCommitInput",
					placeholder: t("git.commit.placeholder"),
					value: message,
					disabled: busy,
					onChange: (e) => onMessageChange(e.target.value),
					rows: 3
				}),
				actionError ? react_jsx_runtime.jsx("div", { className: "dsgBanner dsgBannerErr", style: { marginTop: 8, marginBottom: 0 }, children: actionError }) : null,
				react_jsx_runtime.jsxs("div", { className: "dsgCommitFooter", children: [
					!actionError && resultMessage ? react_jsx_runtime.jsx("span", { className: "dsgCommitResult", children: resultMessage }) : null,
					// 推送放在提交左边、用次级样式：提交是这个面板里最常用的动作，
					// 主按钮位置（最右）留给它。
					react_jsx_runtime.jsx("button", {
						type: "button",
						className: "dsgCommitBtn dsgCommitBtnSecondary",
						disabled: busy || !canPush,
						title: canPush ? pushLabel : t("git.push.nothing"),
						onClick: onPush,
						children: pushLabel
					}),
					react_jsx_runtime.jsx("button", {
						type: "button",
						className: "dsgCommitBtn",
						disabled: busy || message.trim().length === 0,
						onClick: onCommit,
						children: commitLabel
					})
				] })
			] });
		}

		/**
		 * 撤销按钮走「点一下武装、再点一下才真正执行」的二次确认模式，不用原生
		 * confirm() 弹窗（在 Electron 里体验生硬），也不用额外的对话框组件——
		 * 三秒内没点第二下自动解除武装。只出现在最新一条提交（index === 0）上，
		 * 历史里更早的提交不提供撤销：reset 只能退最新一条，revert 理论上能对
		 * 任意提交做，但那是另一个功能，这次没做。
		 */
		function UndoCommitButton({ t, undoing, onUndo }) {
			const [armed, setArmed] = react.useState(false);
			const timerRef = react.useRef(null);
			react.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

			const onClick = react.useCallback((e) => {
				e.stopPropagation();
				if (undoing) return;
				if (!armed) {
					setArmed(true);
					timerRef.current = setTimeout(() => setArmed(false), 3000);
					return;
				}
				clearTimeout(timerRef.current);
				setArmed(false);
				onUndo();
			}, [armed, undoing, onUndo]);

			const label = undoing ? t("git.history.undoing") : (armed ? t("git.history.undoConfirm") : t("git.history.undo"));
			// 光换图标颜色太容易被忽略（按钮本来就小）——武装/执行中这两个非默认
			// 状态额外长出文字，视觉上明确变了，不会被当成「点了但没反应」。
			// 默认态保持纯图标，不占空间。
			const showLabel = armed || undoing;
			return react_jsx_runtime.jsxs("button", {
				type: "button",
				className: "dsgUndoBtn" + (armed ? " dsgUndoBtnArmed" : "") + (undoing ? " dsgUndoBtnBusy" : ""),
				disabled: undoing,
				onClick,
				title: label,
				"aria-label": label,
				children: [
					react_jsx_runtime.jsx(UndoIcon, {}),
					showLabel ? react_jsx_runtime.jsx("span", { className: "dsgUndoBtnLabel", children: label }) : null
				]
			});
		}

		function HistorySection({ t, commits, onUndo, undoing, unpushedCount = 0 }) {
			return react_jsx_runtime.jsxs("div", { className: "dsgSection", children: [
				react_jsx_runtime.jsx("div", { className: "dsgSectionTitle", children: react_jsx_runtime.jsx("span", { children: t("git.section.history") }) }),
				commits.length === 0
					? react_jsx_runtime.jsx("div", { className: "dsgEmpty", children: t("git.history.empty") })
					: commits.map((c, index) => {
						// 前 unpushedCount 条是还没推上去的（git log 倒序）。这条状态原来
						// 完全看不出来，用户反馈「分不清哪些提交推过了」（issue #1）。
						const unpushed = index < unpushedCount;
						return react_jsx_runtime.jsxs("div", { className: "dsgHistoryRow", children: [
							react_jsx_runtime.jsxs("div", { className: "dsgHistoryTop", children: [
								react_jsx_runtime.jsx("span", { className: "dsgHistoryHash", children: c.shortHash }),
								react_jsx_runtime.jsx("span", { className: "dsgHistorySubject", title: c.subject, children: c.subject }),
								index === 0 ? react_jsx_runtime.jsx(UndoCommitButton, { t, undoing, onUndo }) : null
							] }),
							react_jsx_runtime.jsxs("div", { className: "dsgHistoryMeta", children: [
								react_jsx_runtime.jsxs("span", {
									className: "dsgPushState " + (unpushed ? "dsgPushStateUnpushed" : "dsgPushStatePushed"),
									children: [
										react_jsx_runtime.jsx("span", { children: unpushed ? "●" : "○" }),
										react_jsx_runtime.jsx("span", { children: unpushed ? t("git.history.unpushed") : t("git.history.pushed") })
									]
								}),
								react_jsx_runtime.jsx("span", { children: ` ${c.author} · ${formatDate(c.date)}` })
							] })
						] }, c.hash);
					})
			] });
		}

		/**
		 * 面板真正的内容。首次打开后由 GitPanel 常驻挂载（为了关闭动画），所以这里
		 * 靠 open 自己判断要不要发请求——`open` 不是渲染开关，是「现在该不该请求」。
		 */
		function GitPanelBody({ t, onClose, workspacesList, sessionsList, open }) {
			const wsState = react.useSyncExternalStore(workspacesList.subscribe, workspacesList.getSnapshot);
			const sessState = react.useSyncExternalStore(sessionsList.subscribe, sessionsList.getSnapshot);
			const items = wsState.items || [];
			const [selectedId, setSelectedId] = react.useState(null);

			// 跟左侧当前打开的会话联动：sessState.current 是当前会话 id，反查哪个
			// workspace 的 sessionIds 里有它，那就是「用户现在实际在哪个项目」。
			// 切工作区时 dsh 的 connectWorkspace 会顺手开一个会话，current 立刻更新，
			// 这里就能跟着换——不用户手动在下拉里再选一遍，也不会因为选错仓库而
			// 把变更提交到别的项目里。没有打开的会话（比如新会话首页）时退回
			// recentWorkspaceId，跟原来的兜底逻辑一致。
			const linkedWorkspaceId = react.useMemo(() => {
				const currentSessionId = sessState.current;
				if (currentSessionId) {
					const owner = items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(currentSessionId));
					if (owner) return owner.workspaceId;
				}
				return wsState.recentWorkspaceId ?? (items[0] && items[0].workspaceId) ?? null;
			}, [sessState.current, items, wsState.recentWorkspaceId]);

			// 只在「联动目标变了」时才写 selectedId——用户在面板自己的下拉里临时看
			// 别的仓库时，不会被这条效果每次渲染都拽回去；真正切换活跃项目时，
			// linkedWorkspaceId 变化了，这里才会跟着更新。
			react.useEffect(() => {
				setSelectedId(linkedWorkspaceId);
			}, [linkedWorkspaceId]);

			const [view, setView] = react.useState({ status: "idle", error: null, data: null, commits: [], branches: [] });
			const [message, setMessage] = react.useState("");
			// 变更列表默认折叠（issue #1：它的查看优先级不该高过提交本身），但记住
			// 用户的选择 —— 想边看边挑文件暂存的人，不该每次打开面板都再点一次。
			const [changesOpen, setChangesOpenState] = react.useState(() => {
				try { return localStorage.getItem("dsg:changesOpen") === "1"; } catch { return false; }
			});
			const setChangesOpen = (next) => {
				setChangesOpenState(next);
				try { localStorage.setItem("dsg:changesOpen", next ? "1" : "0"); } catch { /* 忽略 */ }
			};
			const [committing, setCommitting] = react.useState(false);
			const [pushing, setPushing] = react.useState(false);
			// 提交成功显示「已提交 <hash>」、推送成功显示「已推送」——同一块地方，
			// 谁最后发生就显示谁，不用两个互斥的 state 各管各的。
			const [resultMessage, setResultMessage] = react.useState(null);
			const [switchingBranch, setSwitchingBranch] = react.useState(false);
			const [undoing, setUndoing] = react.useState(false);
			// commit/stage/unstage 的失败不该把整个文件列表清空重画成错误态，只在
			// 提交框旁边提一句——用户还看得见列表，能直接重试。
			const [actionError, setActionError] = react.useState(null);

			const refresh = react.useCallback(async (workspaceId) => {
				if (!workspaceId) {
					setView({ status: "idle", error: null, data: null, commits: [], branches: [] });
					return;
				}
				setView((prev) => ({ ...prev, status: "loading" }));
				try {
					const qs = `workspaceId=${encodeURIComponent(workspaceId)}`;
					const [statusRes, logRes, branchesRes] = await Promise.all([
						getJson(`/api/git/status?${qs}`),
						getJson(`/api/git/log?${qs}&limit=30`),
						getJson(`/api/git/branches?${qs}`)
					]);
					if (!statusRes.ok) {
						setView({ status: "error", error: statusRes.error, data: null, commits: [], branches: [] });
						return;
					}
					setView({
						status: "ready",
						error: null,
						data: statusRes.data,
						commits: logRes.ok ? logRes.data.commits : [],
						branches: branchesRes.ok ? branchesRes.data.branches : []
					});
				} catch (error) {
					setView({ status: "error", error: { code: "network", message: String(error?.message ?? error) }, data: null, commits: [], branches: [] });
				}
			}, []);

			// 只在面板打开时才拉数据——面板现在关闭后还留在 DOM 里（为了关闭动画），
			// 不加 open 这个判断会在后台白白多发请求。依赖里带 open 本身，是为了
			// 关闭再打开也能重新拉一遍：面板收起的这段时间外部可能有新的 git 操作
			// （比如用户在终端里手动提交），重新打开时不该还看着关闭前的旧快照。
			react.useEffect(() => {
				if (!open) return;
				setActionError(null);
				refresh(selectedId);
			}, [open, selectedId, refresh]);

			const runAction = react.useCallback(async (url, extra) => {
				if (!selectedId) return;
				setActionError(null);
				try {
					const result = await postJson(url, { workspaceId: selectedId, ...extra });
					if (!result.ok) {
						setActionError(errorMessage(t, result.error));
						return;
					}
					await refresh(selectedId);
				} catch (error) {
					setActionError(String(error?.message ?? error));
				}
			}, [selectedId, refresh, t]);

			const onStage = (path) => runAction("/api/git/stage", { paths: [path] });
			const onUnstage = (path) => runAction("/api/git/unstage", { paths: [path] });

			const onCommit = react.useCallback(async () => {
				if (!selectedId || message.trim().length === 0) return;
				setCommitting(true);
				setResultMessage(null);
				setActionError(null);
				try {
					const result = await postJson("/api/git/commit", { workspaceId: selectedId, message: message.trim() });
					if (result.ok) {
						setMessage("");
						const hash = result.data && result.data.shortHash;
						setResultMessage(hash ? `${t("git.commit.done")} ${hash}` : t("git.commit.done"));
						await refresh(selectedId);
					} else {
						setActionError(errorMessage(t, result.error));
					}
				} catch (error) {
					setActionError(String(error?.message ?? error));
				} finally {
					setCommitting(false);
				}
			}, [selectedId, message, refresh, t]);

			const onPush = react.useCallback(async () => {
				if (!selectedId || pushing) return;
				setPushing(true);
				setResultMessage(null);
				setActionError(null);
				try {
					const result = await postJson("/api/git/push", { workspaceId: selectedId });
					if (result.ok) {
						setResultMessage(t("git.push.done"));
						await refresh(selectedId);
					} else {
						setActionError(errorMessage(t, result.error));
					}
				} catch (error) {
					setActionError(String(error?.message ?? error));
				} finally {
					setPushing(false);
				}
			}, [selectedId, pushing, refresh, t]);

			const onUndoCommit = react.useCallback(async () => {
				if (!selectedId || undoing) return;
				setUndoing(true);
				setResultMessage(null);
				setActionError(null);
				try {
					const result = await postJson("/api/git/undo-commit", { workspaceId: selectedId });
					if (result.ok) {
						const mode = result.data && result.data.mode;
						setResultMessage(mode === "revert" ? t("git.history.undoneRevert") : t("git.history.undoneReset"));
						await refresh(selectedId);
					} else {
						setActionError(errorMessage(t, result.error));
					}
				} catch (error) {
					setActionError(String(error?.message ?? error));
				} finally {
					setUndoing(false);
				}
			}, [selectedId, undoing, refresh, t]);

			const onCheckout = react.useCallback(async (branch) => {
				if (!selectedId || switchingBranch) return;
				setSwitchingBranch(true);
				setActionError(null);
				try {
					const result = await postJson("/api/git/checkout", { workspaceId: selectedId, branch });
					if (result.ok) {
						await refresh(selectedId);
					} else {
						setActionError(errorMessage(t, result.error));
					}
				} catch (error) {
					setActionError(String(error?.message ?? error));
				} finally {
					setSwitchingBranch(false);
				}
			}, [selectedId, switchingBranch, refresh, t]);

			const data = view.data;
			const staged = data ? data.staged : [];
			const unstaged = data ? data.unstaged : [];
			const untracked = data ? data.untracked : [];
			const branches = view.branches;
			const changeCount = staged.length + unstaged.length + untracked.length;
			const hasChanges = changeCount > 0;
			// 推送按钮什么时候可用：有本地领先远端的提交（ahead>0），或者干脆还没
			// 建立跟踪关系（!hasUpstream——第一次推这个分支）。detached/unborn 没有
			// 「当前分支」可推，按钮置灰。真没有 remote 时点了会拿到 no-remote 的
			// 报错，不是灾难性后果，接受这点误触成本。
			const canPush = !!data && !data.detached && !data.unborn && (data.ahead > 0 || !data.hasUpstream);

			return react_jsx_runtime.jsxs("div", { className: "dsgPanel" + (open ? " dsgOpen" : ""), children: [
				react_jsx_runtime.jsxs("div", { className: "dsgHeader", children: [
					react_jsx_runtime.jsx("span", { className: "dsgHeaderTitle", children: t("git.panel.label") }),
					react_jsx_runtime.jsx("button", {
						type: "button", className: "dsgIconBtn", "aria-label": t("git.panel.refresh"), title: t("git.panel.refresh"),
						onClick: () => refresh(selectedId),
						children: react_jsx_runtime.jsx(RefreshIcon, {})
					}),
					react_jsx_runtime.jsx("button", {
						type: "button", className: "dsgIconBtn", "aria-label": t("git.panel.close"), title: t("git.panel.close"),
						onClick: onClose,
						children: react_jsx_runtime.jsx(CloseIcon, {})
					})
				] }),
				react_jsx_runtime.jsxs("div", { className: "dsgBody", children: [
					items.length > 1 ? react_jsx_runtime.jsxs("div", { className: "dsgWorkspaceRow", children: [
						react_jsx_runtime.jsx("label", { className: "dsgSectionTitle", children: t("git.workspace.label") }),
						react_jsx_runtime.jsx(Dropdown, {
							ariaLabel: t("git.workspace.label"),
							value: selectedId || "",
							onChange: setSelectedId,
							options: items.map((w) => ({ value: w.workspaceId, label: w.title }))
						})
					] }) : null,

					!selectedId ? react_jsx_runtime.jsx("div", { className: "dsgBanner", children: t("git.workspace.none") }) : null,

					selectedId && view.status === "loading" ? react_jsx_runtime.jsx("div", { className: "dsgBanner", children: t("git.status.loading") }) : null,

					selectedId && view.status === "error" ? react_jsx_runtime.jsx("div", { className: "dsgBanner dsgBannerErr", children: errorMessage(t, view.error) }) : null,

					selectedId && view.status === "ready" && data ? react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
						react_jsx_runtime.jsxs("div", { className: "dsgBranchRow", children: [
							react_jsx_runtime.jsx(GitIcon, { size: 13 }),
							// detached/unborn 时没有「当前分支」这个概念，用纯文本；否则给个可切换的
							// 下拉——分支列表非空才画下拉，避免空列表时渲染一个不能选的空 select。
							data.detached ? react_jsx_runtime.jsx("span", { children: t("git.branch.detached") })
								: data.unborn ? react_jsx_runtime.jsx("span", { children: t("git.branch.unborn") })
								: branches.length > 0 ? react_jsx_runtime.jsx(Dropdown, {
									compact: true,
									ariaLabel: t("git.branch.label"),
									value: data.branch || "",
									disabled: switchingBranch,
									onChange: onCheckout,
									options: branches.map((b) => ({ value: b.name, label: b.name }))
								})
								: react_jsx_runtime.jsx("span", { children: data.branch || "—" }),
							switchingBranch ? react_jsx_runtime.jsx("span", { className: "dsgBranchAB", children: t("git.branch.switching") })
								: (data.ahead > 0 || data.behind > 0) ? react_jsx_runtime.jsx("span", { className: "dsgBranchAB", children: `↑${data.ahead} ↓${data.behind}` }) : null
						] }),

						// 提交框紧跟分支行：这是面板里最高频的动作，用户反馈要「打开就能直接
						// 提交」，不该被一长串变更文件挤到下面去（issue #1）。
						react_jsx_runtime.jsx(CommitBox, {
							t, committing, pushing, message,
							onMessageChange: setMessage, onCommit, onPush, canPush,
							ahead: data.ahead, resultMessage, actionError
						}),

						!hasChanges ? react_jsx_runtime.jsx("div", { className: "dsgEmpty", children: t("git.section.empty") }) : null,

						hasChanges ? react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
							react_jsx_runtime.jsxs("button", {
								type: "button",
								className: "dsgCollapseHead",
								"aria-expanded": changesOpen,
								title: changesOpen ? t("git.section.collapse") : t("git.section.expand"),
								onClick: () => setChangesOpen(!changesOpen),
								children: [
									react_jsx_runtime.jsx("span", {
										className: "dsgCollapseChevron" + (changesOpen ? "" : " dsgCollapsed"),
										children: react_jsx_runtime.jsx(ChevronIcon, {})
									}),
									react_jsx_runtime.jsx("span", { children: t("git.section.changes") }),
									react_jsx_runtime.jsx("span", { className: "dsgCollapseCount", children: changeCount })
								]
							}),
							changesOpen ? react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
								react_jsx_runtime.jsx(FileSection, { title: t("git.section.staged"), entries: staged, mode: "staged", onAction: onUnstage, t }),
								react_jsx_runtime.jsx(FileSection, { title: t("git.section.unstaged"), entries: unstaged, mode: "unstaged", onAction: onStage, t }),
								react_jsx_runtime.jsx(FileSection, { title: t("git.section.untracked"), entries: untracked, mode: "untracked", onAction: onStage, t })
							] }) : null
						] }) : null,

						react_jsx_runtime.jsx(HistorySection, {
							t, commits: view.commits, onUndo: onUndoCommit, undoing,
							// 没有上游时所有提交都算未推送；有上游时 git log 是倒序，
							// 前 ahead 条就是本地领先远端的那些，不用额外再问一次 git。
							unpushedCount: data.hasUpstream ? data.ahead : view.commits.length,
							hasUpstream: data.hasUpstream
						})
					] }) : null
				] })
			] });
		}

		function GitFooterAction({ wide, t, store }) {
			const open = react.useSyncExternalStore(store.subscribe, store.getSnapshot);
			return react_jsx_runtime.jsxs("button", {
				type: "button",
				className: "dsgFooterBtn" + (open ? " dsgFooterBtnActive" : ""),
				"aria-label": t("git.panel.label"),
				"aria-pressed": open,
				title: t("git.panel.label"),
				onClick: () => store.toggle(),
				children: [
					react_jsx_runtime.jsx(GitIcon, { size: 16 }),
					wide ? react_jsx_runtime.jsx("span", { className: "dsgFooterBtnLabel", children: t("git.panel.label") }) : null
				]
			});
		}

		function GitPanel({ t, store, workspacesList, sessionsList }) {
			const open = react.useSyncExternalStore(store.subscribe, store.getSnapshot);
			// 第一次打开后就常驻挂载，开关只切 dsgOpen 这个 class（见 CSS transition）——
			// 这样关闭时面板和遮罩能一起淡出，而不是内容瞬间抽掉、只剩一个空壳子飘走。
			const [mounted, setMounted] = react.useState(false);
			react.useEffect(() => {
				if (open) setMounted(true);
			}, [open]);

			// Esc 关闭，跟点击背景遮罩关闭是同一件事的两种触发方式，效果都是 store.close()。
			react.useEffect(() => {
				if (!open) return;
				const onKeyDown = (e) => {
					if (e.key === "Escape") store.close();
				};
				document.addEventListener("keydown", onKeyDown);
				return () => document.removeEventListener("keydown", onKeyDown);
			}, [open, store]);

			if (!mounted) return null;
			return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
				children: [
					react_jsx_runtime.jsx("div", {
						className: "dsgBackdrop" + (open ? " dsgOpen" : ""),
						onClick: () => store.close()
					}),
					react_jsx_runtime.jsx(GitPanelBody, { t, workspacesList, sessionsList, open, onClose: () => store.close() })
				]
			});
		}

		const inject = ["slots", "locale", "workspaces", "sessions"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "git: dictionaries");
			const store = createOpenStore();

			ctx.slots.inject("sidebar.footer.action", () => {
				const dispose = ctx.slots.register({
					name: "sidebar.footer.action",
					id: "git",
					order: 100,
					locale: NS,
					inject: () => ({ store })
				}, GitFooterAction);
				return () => dispose();
			});

			ctx.slots.inject("shell.overlay", () => {
				const dispose = ctx.slots.register({
					name: "shell.overlay",
					id: "git-panel",
					locale: NS,
					inject: () => ({ store, workspacesList: ctx.workspaces.list, sessionsList: ctx.sessions.list })
				}, GitPanel);
				return () => dispose();
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		// 只给单测用（test/git-client-smoke.test.js）。这个文件不在 typecheck 覆盖内，
		// 而这两个组件承载着 issue #1 明确要求的行为（提交/推送两个常驻按钮、提交历史
		// 区分推送状态），必须有东西钉住，否则下次重构很容易无意改回去。
		exports.__test__ = { CommitBox, HistorySection };
		return module.exports;
	}
});
