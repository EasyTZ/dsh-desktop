// 插件开关状态的纯逻辑。**零 import**，好让 test/ 直接 import 跑（同 dsh-terminal-panel
// 的 lib/pure.js），也因此会被 tsc 顺带检查。
//
// 为什么这份语义不在 dsDesktop 的 src/shared/plugin-state.js 里：那边是外壳进程
// 的模块，本插件跑在**内核进程**里、源码被拷进内核的 node_modules，跨不过这条
// 进程/依赖边界。src/shared/plugin-state.js 只保留「读 + 合并」（外壳启动路径与
// 热更新自检要用），「写」这一半只有本插件一个写者，就放在写者这边。

/**
 * 清单里的默认开关：`enabled` 缺省视为 true，兼容没有这个字段的旧清单。
 * 必须与 src/shared/plugin-state.js 的 manifestEnabled 保持同义 —— 读侧按那边
 * 的规则合并，写侧算错默认值会写出多余的键。
 * @param {{ enabled?: boolean }} plugin
 * @returns {boolean}
 */
export function manifestEnabled(plugin) {
  return plugin?.enabled !== false;
}

/**
 * 把一项开关写进状态对象（纯函数，返回新对象）。
 *
 * 值等于清单默认值时**删除该键**而不是写进去：状态文件只记录「偏离默认」的项。
 * 这不是洁癖 —— 将来清单默认值翻转时，用户没主动改过的项要跟着清单走；把等于
 * 默认的值也写进去会把它钉死在旧默认上。
 *
 * @param {Record<string, boolean>} state 现有的原始覆盖值
 * @param {{ entryId: string, enabled?: boolean }} plugin 清单条目
 * @param {boolean} enabled 目标状态
 * @returns {Record<string, boolean>} 新的状态对象
 */
export function nextUserState(state, plugin, enabled) {
  const next = { ...state };
  if (Boolean(enabled) === manifestEnabled(plugin)) {
    delete next[plugin.entryId];
  } else {
    next[plugin.entryId] = Boolean(enabled);
  }
  return next;
}
