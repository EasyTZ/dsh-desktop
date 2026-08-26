window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-reveal-explorer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		const NS = "reveal-explorer";

		const zh = {
			"reveal.label": "在文件资源管理器中打开",
			"reveal.failed": "打开失败"
		};
		const en = {
			"reveal.label": "Reveal in File Explorer",
			"reveal.failed": "Failed to open"
		};

		// 挂在会话页头部「Session log 下载」旁边，跟它一样是个小图标胶囊按钮——
		// 尺寸、圆角、hover 都对齐那种量级，不会显得突兀。颜色全走 dsh 设计
		// token，浅色/深色主题自动对上。
		const css = [
			".drxBtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);cursor:pointer;transition:background .15s ease,color .15s ease}",
			".drxBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f9fafb)}",
			".drxBtn:disabled{opacity:.5;cursor:default}",
			".drxBtn.drxBtnErr{color:var(--dsw-alias-state-error-primary,#f0617a)}",
			".drxBtn svg{display:block}"
		].join("");
		const tagId = "@deepseek-ai/dsh-reveal-explorer/button.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-reveal-explorer";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		function FolderIcon() {
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16", width: 13, height: 13, fill: "none",
				stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round",
				children: react_jsx_runtime.jsx("path", { d: "M1.5 4.2c0-.6.5-1.1 1.1-1.1h3l1.1 1.3h6.7c.6 0 1.1.5 1.1 1.1v6.3c0 .6-.5 1.1-1.1 1.1H2.6c-.6 0-1.1-.5-1.1-1.1V4.2Z" })
			});
		}

		async function postJson(url, body) {
			const res = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			return res.json();
		}

		/**
		 * sessionId 是框架自动注入的（scope: 'session' 的槽），不用我们自己去猜
		 * 「当前会话」是哪个——这跟 dsh-git 那个全局悬浮面板不一样，那边没有
		 * session 上下文，只能反查 sessions.list.current。这里直接就是对的那个。
		 *
		 * workspaceId 还是要反查：session 本身不直接带 workspaceId，只能从
		 * workspaces.list 里找 sessionIds 包含它的那个 workspace。
		 */
		function RevealButton({ sessionId, workspacesList, t }) {
			const wsState = react.useSyncExternalStore(workspacesList.subscribe, workspacesList.getSnapshot);
			const items = wsState.items || [];
			const owner = items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId));

			const [state, setState] = react.useState("idle");
			const errorTimer = react.useRef(null);
			react.useEffect(() => () => { if (errorTimer.current) clearTimeout(errorTimer.current); }, []);

			const onClick = react.useCallback(async () => {
				if (!owner || state === "opening") return;
				setState("opening");
				try {
					const result = await postJson("/api/reveal-explorer", { workspaceId: owner.workspaceId });
					if (result.ok) {
						setState("idle");
					} else {
						setState("error");
						errorTimer.current = setTimeout(() => setState("idle"), 3000);
					}
				} catch {
					setState("error");
					errorTimer.current = setTimeout(() => setState("idle"), 3000);
				}
			}, [owner, state]);

			// 没找到归属的 workspace（理论上不该发生：会话头部本来就是有活跃会话
			// 才会渲染，而活跃会话必然挂在某个 workspace 下）——没有路径可开，
			// 与其显示一个必定失败的按钮，不如不渲染。
			if (!owner) return null;

			return react_jsx_runtime.jsx("button", {
				type: "button",
				className: "drxBtn" + (state === "error" ? " drxBtnErr" : ""),
				disabled: state === "opening",
				"aria-label": t("reveal.label"),
				title: state === "error" ? t("reveal.failed") : t("reveal.label"),
				onClick,
				children: react_jsx_runtime.jsx(FolderIcon, {})
			});
		}

		const inject = ["slots", "locale", "workspaces"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "reveal-explorer: dictionaries");
			ctx.slots.inject("conversation.session.header.utilities", () => {
				const dispose = ctx.slots.register({
					name: "conversation.session.header.utilities",
					id: "reveal-explorer",
					locale: NS,
					inject: () => ({ workspacesList: ctx.workspaces.list })
				}, RevealButton);
				return () => dispose();
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
