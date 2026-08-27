'use strict';

// 插件开关状态的**读取与合并**（任务：插件管理面板可开关插件）。
//
// 状态不能写回 plugins.json——那是仓库里的文件，打进 asar/extraResources 后
// 运行时只读；落在 userData 下的独立 JSON，只记录被用户改过（偏离清单默认值）
// 的项。最终「某插件是否激活」= 清单默认值（enabled 字段，缺省 true），被
// 用户状态覆盖。
//
// 这里只有读侧：DshService 与 kernel-updater 生成激活 overlay 时都要算这个
// 合并结果，一处一份就会分叉。
//
// **写侧不在这里**，在 plugins/dsh-plugin-manager/lib/pure.js。不是遗漏：写者
// 只有插件管理面板一个，而它跑在**内核进程**里（源码被拷进内核 node_modules），
// import 不到 src/shared/。把写侧留一份在这边只会变成没有调用者的死代码，然后
// 和真正的写者悄悄分叉——这事已经发生过一次。两边共享的是「enabled 缺省为
// true」这条默认值规则，改这条要同时改 pure.js 的 manifestEnabled。

const fs = require('node:fs');

/**
 * 读用户开关状态。文件不存在（从没改过任何开关）或内容损坏时按「没有任何
 * 覆盖」处理，不让一个坏状态文件拖垮启动路径。
 * @param {string|null|undefined} statePath
 * @returns {Record<string, boolean>}
 */
function loadPluginState(statePath) {
  if (!statePath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // 只认 boolean 值的键：状态文件是给用户改开关的，不是自由格式的配置。
    const state = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') state[key] = value;
    }
    return state;
  } catch {
    return {};
  }
}

/**
 * 清单里的默认开关：enabled 缺省视为 true，保持对没有这个字段的旧清单向后
 * 兼容（清单是发行版意志：默认装什么就开什么）。
 * @param {{ enabled?: boolean }} plugin
 * @returns {boolean}
 */
function manifestEnabled(plugin) {
  return plugin?.enabled !== false;
}

/**
 * 某插件当前是否激活：用户状态覆盖清单默认值。
 * @param {{ entryId?: string, enabled?: boolean }} plugin
 * @param {Record<string, boolean>|null} [userState]
 * @returns {boolean}
 */
function isPluginEnabled(plugin, userState) {
  const entryId = plugin?.entryId;
  // 没有 entryId 的条目无从覆盖（清单校验层也会拦掉），退回清单默认值。
  if (typeof entryId !== 'string') return manifestEnabled(plugin);
  const override = userState?.[entryId];
  return override === undefined ? manifestEnabled(plugin) : Boolean(override);
}

/**
 * 只保留激活的插件（生成激活 overlay 时的过滤输入）。
 * @param {Array<{entryId: string}>} plugins
 * @param {Record<string, boolean>} [userState]
 */
function activePlugins(plugins, userState) {
  return (plugins ?? []).filter((plugin) => isPluginEnabled(plugin, userState));
}

/**
 * 安全模式下仍然激活的插件：清单里标了 `safeMode: true` 的项。
 *
 * 用途是「插件把内核搞崩」时的逃生舱。这类故障没有别的自愈路径 —— 回退内置
 * 内核没用（内置装着同一批插件、用同一份 overlay），删 %APPDATA% 也没用
 * （插件在安装目录、overlay 从清单重新生成），所以必须留一条只加载最小集合
 * 的启动路径，让用户能进去把出问题的插件关掉。
 *
 * **刻意不看用户开关状态**：安全模式是恢复入口，不该被用户之前的设置（或一份
 * 损坏的状态文件）挡在门外。
 *
 * 泛型透传元素类型：调用方拿回来的还是清单条目本身（带 packageName 等），
 * 直接就能喂给 writeActivationPatch。
 * @template {{ safeMode?: boolean }} T
 * @param {T[]|null|undefined} plugins
 * @returns {T[]}
 */
function safeModePlugins(plugins) {
  return (plugins ?? []).filter((plugin) => plugin?.safeMode === true);
}

module.exports = {
  loadPluginState,
  manifestEnabled,
  isPluginEnabled,
  activePlugins,
  safeModePlugins,
};
