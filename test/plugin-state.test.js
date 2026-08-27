'use strict';

// 插件开关状态的读写与合并逻辑（src/shared/plugin-state.js）。
//
// 「某插件是否激活」= 清单默认值（enabled 字段，缺省 true）被用户状态覆盖。
// 这个合并是插件管理面板与启动路径共用的唯一实现，任何一处自己写一份就会
// 分叉 —— 这里把每个分支都钉住。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadPluginState, manifestEnabled, isPluginEnabled, activePlugins, safeModePlugins,
} = require('../src/shared/plugin-state');

test('loadPluginState: 文件不存在按「没有任何覆盖」处理', () => {
  assert.deepStrictEqual(loadPluginState('/no/such/file.json'), {});
  assert.deepStrictEqual(loadPluginState(null), {});
});

test('loadPluginState: 内容损坏同样按空覆盖处理，不拖垮启动路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-test-'));
  const file = path.join(dir, 'plugin-state.json');
  fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8');
  assert.deepStrictEqual(loadPluginState(file), {});
  fs.writeFileSync(file, JSON.stringify([1, 2, 3]), 'utf8');
  assert.deepStrictEqual(loadPluginState(file), {}, '数组也不是合法状态');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadPluginState: 只认 boolean 值，其它类型一律丢弃', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-test-'));
  const file = path.join(dir, 'plugin-state.json');
  fs.writeFileSync(file, JSON.stringify({ git: false, junk: 'x', n: 1, ok: true }), 'utf8');
  assert.deepStrictEqual(loadPluginState(file), { git: false, ok: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('manifestEnabled: enabled 缺省视为 true（向后兼容旧清单）', () => {
  assert.strictEqual(manifestEnabled({}), true);
  assert.strictEqual(manifestEnabled({ enabled: true }), true);
  assert.strictEqual(manifestEnabled({ enabled: false }), false);
});

test('isPluginEnabled: 用户状态覆盖清单默认值', () => {
  const git = { entryId: 'git' };
  assert.strictEqual(isPluginEnabled(git, {}), true, '没被用户改过 → 跟清单默认走');
  assert.strictEqual(isPluginEnabled(git, { git: false }), false, '用户关掉覆盖默认');
  assert.strictEqual(isPluginEnabled({ entryId: 'x', enabled: false }, { x: true }), true, '用户打开覆盖默认关');
  assert.strictEqual(isPluginEnabled(git, null), true, '空状态照常');
});

test('activePlugins: 过滤掉被用户关掉的插件', () => {
  const plugins = [
    { entryId: 'git' },
    { entryId: 'balance' },
    { entryId: 'terminal-panel' },
  ];
  const active = activePlugins(plugins, { balance: false });
  assert.deepStrictEqual(active.map((p) => p.entryId), ['git', 'terminal-panel']);
});

test('safeModePlugins: 只留清单里标了 safeMode 的项', () => {
  const plugins = [
    { entryId: 'dsdesktop-plugin-manager', safeMode: true },
    { entryId: 'dsdesktop-git' },
    { entryId: 'dsdesktop-balance', safeMode: false },
  ];
  assert.deepStrictEqual(
    safeModePlugins(plugins).map((p) => p.entryId),
    ['dsdesktop-plugin-manager'],
  );
  assert.deepStrictEqual(safeModePlugins([]), []);
  assert.deepStrictEqual(safeModePlugins(undefined), [], '清单读不出来时不该抛');
});

test('safeModePlugins: 不受用户开关状态影响（逃生舱不能被用户设置反锁）', () => {
  // 这是安全模式的关键性质：用户之前关掉过管理面板、或状态文件损坏成任何样子，
  // 都不能让恢复入口进不去 —— 所以这个函数压根不接收 userState。
  assert.strictEqual(safeModePlugins.length, 1, 'safeModePlugins 只该接收清单一个参数');
  const plugins = [{ entryId: 'dsdesktop-plugin-manager', safeMode: true, enabled: false }];
  assert.deepStrictEqual(
    safeModePlugins(plugins).map((p) => p.entryId),
    ['dsdesktop-plugin-manager'],
    '清单默认关的项，只要标了 safeMode 也要在安全模式里激活',
  );
});

// 写侧（nextUserState）的用例在 test/plugin-manager-pure.test.js —— 写者是插件
// 管理面板的 node 半，它跑在内核进程里、import 不到 src/shared/，所以那半的纯
// 逻辑在 plugins/dsh-plugin-manager/lib/pure.js。
