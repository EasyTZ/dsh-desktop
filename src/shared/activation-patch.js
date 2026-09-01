'use strict';

// 生成交给内核的 `--patch` overlay（patch 层栈的**第 4 层**，上游本来就留给调用方）。
//
// 这个文件曾经是 plugin-install.js 的一半。插件全部迁到 profile 层（A1）之后，
// 「装」这件事整个交给了 pnpm（见 profile-plugins.js），overlay 也从「插入我们的
// 插件」退化成只做一件事：**按用户意愿停用某些条目**。
//
// 为什么停用只能这么做：profile 层插件是自己 insert 自己的第 2 层条目的，我们既
// 插不了也删不掉，唯一的手段是从第 4 层压一条 `disabled: true` 覆盖它。dsh 自己
// 关遥测走的就是这条路（profile-boot 里的 resolveTelemetryPatch）。
//
// 两种停用共用这一份渲染：
//   · 用户在插件市场里点「停用」 —— 状态记在 userData/plugin-state.json；
//   · 安全模式 —— 关掉市场以外的全部 profile 插件，不看用户状态（那正是
//     「用户状态可能有问题」时用的逃生舱，再过一遍开关只可能把恢复入口也滤掉）。

const fs = require('node:fs');
const path = require('node:path');

/**
 * 读用户的插件开关状态：`entryId → boolean`，`false` 表示停用。
 *
 * 读不到按「没有任何覆盖」处理，也就是全部启用。这个方向是刻意的：状态文件损坏
 * 应该表现为「插件都在」，而不是「插件都不见了」——后者会让用户以为插件丢了，
 * 而且没有任何提示能解释为什么。
 *
 * @param {string|null} statePath
 * @returns {Record<string, boolean>}
 */
function loadPluginState(statePath) {
  if (!statePath) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const state = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'boolean') state[key] = value;
  }
  return state;
}

/** 用户状态里被显式置为停用的 entry id。 */
function disabledEntryIds(userState) {
  return Object.entries(userState ?? {})
    .filter(([, enabled]) => enabled === false)
    .map(([entryId]) => entryId);
}

/**
 * 渲染 overlay 文本。
 *
 * **空的时候必须输出 `[]`**，不能是空文件——dsh 解析 patch 会直接报错。迁移之后
 * 「没有任何条目要停用」是绝大多数次启动的常态，所以这条不是边界情况，是主路径。
 *
 * @param {string[]} disableIds 要停用的 loader entry id
 * @returns {string}
 */
function renderActivationPatch(disableIds) {
  const rows = (disableIds ?? []).map((id) => `- id: ${id}\n  disabled: true\n`).join('');
  return '# 由 dsDesktop 生成，请勿手改；插件开关见插件市场面板。\n' + (rows.length ? rows : '[]\n');
}

/**
 * 写 overlay（内容确定、幂等）。启动路径与热更新自检都调它，两处共用同一份内容
 * —— 同一份配置两个写者迟早会不一致。
 *
 * **调用方必须保证这些 id 真实存在于 profile 里**：dsh 自己给遥测生成 disable 补丁
 * 时也先查了 `hasRow`，说明 patch 一个不存在的 id 不是安全操作。用户卸载一个曾经
 * 停用过的插件之后，状态文件里那条 `false` 就是「不存在的 id」。
 *
 * @param {string} patchPath
 * @param {string[]} disableIds
 * @returns {string} patchPath
 */
function writeActivationPatch(patchPath, disableIds) {
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, renderActivationPatch(disableIds), 'utf8');
  return patchPath;
}

module.exports = {
  loadPluginState,
  disabledEntryIds,
  renderActivationPatch,
  writeActivationPatch,
};
