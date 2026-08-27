window.__ModuleLoader__.load({
	id: "dsh-plugin-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		const NS = "plugin-manager";

		const zh = {
			"tab": "桌面插件",
			"intro": "以下插件随桌面版一起分发，可逐个开关。开关只影响下次内核启动——切换后需要重启应用才能生效。",
			"loading": "加载中…",
			"retry": "重试",
			"selfLocked": "自身不可关闭",
			"switchLabel": "开关 {name}",
			"pendingHint": "有 {n} 项改动，重启后生效",
			"noPending": "没有待生效的改动",
			"restart": "重启应用",
			"restartManual": "请手动重启应用以应用改动",
			"safeMode": "安全模式：本次启动只加载了本面板，其余插件一律跳过。把可疑插件关掉后重启应用即可恢复正常启动。"
		};
		const en = {
			"tab": "Desktop Plugins",
			"intro": "These plugins ship with the desktop build and can be toggled individually. Toggles apply to the next kernel start — restart the app to take effect.",
			"loading": "Loading…",
			"retry": "Retry",
			"selfLocked": "Always on (this panel)",
			"switchLabel": "Toggle {name}",
			"pendingHint": "{n} change(s) pending restart",
			"noPending": "No pending changes",
			"restart": "Restart app",
			"restartManual": "Restart the app manually to apply changes",
			"safeMode": "Safe mode: only this panel was loaded this time; all other plugins were skipped. Turn off the suspect plugin, then restart the app to boot normally."
		};

		//#region 样式
		// 颜色全部走 dsh 的设计 token（--dsw-alias-*），保证浅色/深色主题下都不露馅；
		// 兜底值取自已验证可用的深色主题实测色，万一变量取不到也不会露出色差。
		// 容器对齐上游 inventory 标签页的 .section（max-width:760px）。
		const css = [
			".dspmSection{width:100%;max-width:760px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,#f9fafb);font-size:13px}",
			".dspmIntro,.dspmStatus{margin:0;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:13px;line-height:20px}",
			".dspmFailure{margin:0;color:var(--dsw-alias-state-error-primary,#f0617a);font-size:13px;line-height:20px}",
			".dspmRetryBtn{align-self:flex-start;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));color:var(--dsw-alias-label-primary,#f9fafb);font:inherit;font-size:12.5px;cursor:pointer;background:transparent;border-radius:6px;padding:4px 10px}",
			".dspmRetryBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
			".dspmRows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}",
			// 关掉的行只降内容透明度、不缩布局：列表高度稳定，开关连读也省一眼。
			".dspmRow{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));background:var(--dsw-alias-bg-layer-3,#232326);border-radius:10px;padding:12px 14px;min-width:0}",
			".dspmRow.dspmRowOff .dspmRowMain{opacity:.62}",
			".dspmRowMain{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px;transition:opacity .15s ease}",
			".dspmRowTitle{display:flex;align-items:baseline;gap:7px;min-width:0}",
			".dspmRowName{font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary,#f9fafb);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dspmRowVersion{flex:none;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}",
			".dspmRowDesc{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			// 自身那一行没有开关，用虚线胶囊说明「不可关」：关掉面板自己等于把
			// 唯一的开关入口也关了，重启后只能手删状态文件才能救回来。
			".dspmSelfLocked{flex:none;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;line-height:16px;border:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.14));padding:2px 8px;border-radius:999px;white-space:nowrap}",
			".dspmSwitch{flex:none;position:relative;width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-1,#151517);cursor:pointer;padding:0;transition:background .15s ease,border-color .15s ease}",
			".dspmSwitch:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}",
			".dspmSwitch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}",
			".dspmSwitch[data-on=" + JSON.stringify("true") + "]{background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}",
			".dspmSwitch:disabled{cursor:default;opacity:.55}",
			".dspmSwitchKnob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;background:var(--dsw-alias-label-primary,#f9fafb);transition:transform .15s ease}",
			".dspmSwitch[data-on=" + JSON.stringify("true") + "] .dspmSwitchKnob{transform:translateX(14px)}",
			".dspmBannerWarn{color:var(--dsw-alias-state-warning-primary,#e5a13a);font-size:12.5px;line-height:1.6;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:8px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1,#151517)}",
			".dspmBannerErr{color:var(--dsw-alias-state-error-primary,#f0617a);font-size:12.5px;line-height:1.6;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:8px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1,#151517)}",
			// 待重启条常驻（0 改动时显示「没有待生效的改动」，给用户一个明确的
			// 「当前已同步」信号）；有改动时长出重启按钮。
			".dspmPending{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:10px;padding:10px 14px;background:var(--dsw-alias-bg-layer-1,#151517);color:var(--dsw-alias-label-secondary,#cfd3d6);font-size:12.5px}",
			".dspmPendingManual{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px;line-height:18px}",
			".dspmRestartBtn{flex:none;height:28px;padding:0 14px;border:none;border-radius:8px;background:var(--dsw-alias-button-primary-fill,#4d6bfe);color:var(--dsw-alias-label-primary-inverted,#fff);font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;transition:background .15s ease,opacity .15s ease}",
			".dspmRestartBtn:hover{background:var(--dsw-alias-button-primary-hover,#5a77ff)}",
			".dspmRestartBtn:disabled{opacity:.45;cursor:default}"
		].join("");
		const tagId = "dsh-plugin-manager/panel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-manager";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
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

		/** 重启入口是否可用：只有桌面外壳的 preload 会暴露 window.desktop。 */
		function restartAvailable() {
			return typeof window !== "undefined"
				&& !!window.desktop
				&& typeof window.desktop.restartApp === "function";
		}

		function LoadingState({ t }) {
			return react_jsx_runtime.jsx("div", { className: "dspmSection", children:
				react_jsx_runtime.jsx("p", { className: "dspmStatus", children: t("loading") })
			});
		}

		function ErrorState({ t, message, onRetry }) {
			return react_jsx_runtime.jsxs("div", { className: "dspmSection", children: [
				react_jsx_runtime.jsx("p", { className: "dspmFailure", role: "alert", children: message }),
				react_jsx_runtime.jsx("button", { type: "button", className: "dspmRetryBtn", onClick: onRetry, children: t("retry") })
			] });
		}

		//#region 开关
		// 原生 checkbox + appearance:none 在各 WebView 下的可用性参差，跟 Git 面板
		// 的自绘下拉同理：自己画整个开关，颜色和圆角才真正受控。
		function Switch({ on, disabled, label, onChange }) {
			return react_jsx_runtime.jsx("button", {
				type: "button",
				role: "switch",
				"aria-checked": on === true,
				"aria-label": label,
				className: "dspmSwitch",
				"data-on": on ? "true" : "false",
				disabled: disabled === true,
				onClick: () => onChange(!on),
				children: react_jsx_runtime.jsx("span", { className: "dspmSwitchKnob" })
			});
		}
		//#endregion

		function PluginRow({ t, plugin, busy, onToggle }) {
			return react_jsx_runtime.jsxs("li", {
				className: "dspmRow" + (plugin.active ? "" : " dspmRowOff"),
				children: [
					react_jsx_runtime.jsxs("div", { className: "dspmRowMain", children: [
						react_jsx_runtime.jsxs("div", { className: "dspmRowTitle", children: [
							react_jsx_runtime.jsx("span", { className: "dspmRowName", title: plugin.packageName, children: plugin.packageName }),
							plugin.version ? react_jsx_runtime.jsx("span", { className: "dspmRowVersion", children: "v" + plugin.version }) : null
						] }),
						plugin.description ? react_jsx_runtime.jsx("div", { className: "dspmRowDesc", title: plugin.description, children: plugin.description }) : null
					] }),
					plugin.self ? react_jsx_runtime.jsx("span", { className: "dspmSelfLocked", title: t("selfLocked"), children: t("selfLocked") })
						: react_jsx_runtime.jsx(Switch, {
							on: plugin.active === true,
							disabled: busy === true,
							label: t("switchLabel").replace("{name}", plugin.packageName),
							onChange: (next) => onToggle(plugin, next)
						})
				]
			});
		}

		/**
		 * 就绪态的全部内容（列表 + 待重启条）。拆成独立组件是为了冒烟测试能直接
		 * 渲染这条路径——client.js 不在 typecheck 范围内，只有真跑组件函数才暴露
		 * TDZ / 依赖数组类的运行时错误（见 test/plugin-manager-client-smoke.test.js）。
		 */
		function PluginList({ t, plugins, pendingCount, canRestart, busyId, error, safeMode, onToggle, onRestart }) {
			return react_jsx_runtime.jsxs("div", { className: "dspmSection", children: [
				safeMode ? react_jsx_runtime.jsx("div", { className: "dspmBannerWarn", role: "status", children: t("safeMode") }) : null,
				react_jsx_runtime.jsx("p", { className: "dspmIntro", children: t("intro") }),
				error ? react_jsx_runtime.jsx("div", { className: "dspmBannerErr", role: "alert", children: error }) : null,
				react_jsx_runtime.jsx("ul", { className: "dspmRows", children:
					plugins.map((plugin) => react_jsx_runtime.jsx(PluginRow, {
						t, plugin, busy: busyId === plugin.entryId, onToggle
					}, plugin.entryId))
				}),
				react_jsx_runtime.jsxs("div", { className: "dspmPending", children: [
					react_jsx_runtime.jsx("span", { children:
						pendingCount > 0 ? t("pendingHint").replace("{n}", String(pendingCount)) : t("noPending")
					}),
					pendingCount > 0 ? (canRestart
						? react_jsx_runtime.jsx("button", {
							type: "button", className: "dspmRestartBtn", onClick: onRestart, children: t("restart")
						})
						: react_jsx_runtime.jsx("span", { className: "dspmPendingManual", children: t("restartManual") }))
						: null
				] })
			] });
		}

		/**
		 * 设置 → 插件 → 桌面插件 标签页。挂 settings.plugins.tab（list 槽），
		 * 不去 sidebar.footer.action 再挤第三个按钮——footer 的纵向布局本来就
		 * 靠一条对上游类名的弱耦合撑着（见 CLAUDE.md「已知偏离」第 2 条），
		 * 而设置页的插件区正是上游为这类 UI 预留的官方入口。
		 */
		function PluginManagerTab({ t }) {
			const [view, setView] = react.useState({ status: "loading" });
			// 重试计数：递增触发 effect 重拉（loading 文案复用）。
			const [request, setRequest] = react.useState(0);

			react.useEffect(() => {
				let alive = true;
				getJson("/api/plugin-manager/plugins").then((result) => {
					if (!alive) return;
					if (!result || !result.ok) {
						setView({ status: "error", message: (result && result.error && result.error.message) || "failed" });
						return;
					}
					// initialActive 是「本次内核实际激活」的快照（来自激活 overlay），
					// 与它不一致的行就是「待重启生效」的改动。
					const plugins = ((result.data && result.data.plugins) || []).map((p) => ({ ...p, initialActive: p.active === true }));
					setView({ status: "ready", plugins, busyId: null, error: null, safeMode: (result.data && result.data.safeMode) === true });
				}).catch((err) => {
					if (alive) setView({ status: "error", message: String(err && err.message ? err.message : err) });
				});
				return () => { alive = false; };
			}, [request]);

			const onToggle = (plugin, next) => {
				setView((prev) => (prev.status !== "ready" ? prev : { ...prev, busyId: plugin.entryId, error: null }));
				postJson("/api/plugin-manager/plugins/toggle", { entryId: plugin.entryId, enabled: next }).then((result) => {
					setView((prev) => {
						if (prev.status !== "ready") return prev;
						if (!result || !result.ok) {
							return { ...prev, busyId: null, error: (result && result.error && result.error.message) || "failed" };
						}
						return {
							...prev, busyId: null, error: null,
							plugins: prev.plugins.map((p) => (p.entryId === plugin.entryId ? { ...p, active: next } : p))
						};
					});
				}).catch((err) => {
					setView((prev) => (prev.status !== "ready" ? prev : { ...prev, busyId: null, error: String(err && err.message ? err.message : err) }));
				});
			};

			const onRestart = () => {
				const desktop = typeof window !== "undefined" ? window.desktop : undefined;
				if (desktop && typeof desktop.restartApp === "function") desktop.restartApp();
			};

			const onRetry = () => {
				setView({ status: "loading" });
				setRequest((v) => v + 1);
			};

			if (view.status === "loading") return react_jsx_runtime.jsx(LoadingState, { t });
			if (view.status === "error") return react_jsx_runtime.jsx(ErrorState, { t, message: view.message, onRetry });
			const pendingCount = view.plugins.filter((p) => p.active !== p.initialActive).length;
			return react_jsx_runtime.jsx(PluginList, {
				t,
				plugins: view.plugins,
				pendingCount,
				canRestart: restartAvailable(),
				busyId: view.busyId,
				error: view.error,
				safeMode: view.safeMode === true,
				onToggle,
				onRestart
			});
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "plugin-manager: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.plugins.tab", () => {
				const dispose = ctx.slots.register({
					name: "settings.plugins.tab",
					id: "desktop",
					order: 20,
					label: () => t("tab"),
					locale: NS,
					inject: () => ({})
				}, PluginManagerTab);
				return () => dispose();
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		// 只给单测用（test/plugin-manager-client-smoke.test.js）。这个文件不在
		// typecheck 覆盖内，而这些组件承载着「切换后需重启生效」的明确产品要求，
		// 必须有东西钉住。
		exports.__test__ = { PluginList, PluginRow, Switch, LoadingState, ErrorState };
		return module.exports;
	}
});
