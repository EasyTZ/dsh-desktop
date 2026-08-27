// 插件管理面板「写状态」那一半的纯逻辑。
//
// 这份语义曾经在 src/shared/plugin-state.js 里有一份（setPluginEnabled），但真正
// 的写者是插件的 node 半，它跑在内核进程里 import 不到 src/shared/ —— 于是 shared
// 那份成了没有调用者的死代码，并且和真写者悄悄分叉了（真写者当时总是写显式值，
// 与文档宣称的「只记偏离」不符）。现在写侧只有 pure.js 一份，用例跟着它走。

const test = require('node:test');
const assert = require('node:assert');

/** @type {any} */
let pure;

test.before(async () => {
  pure = await import('../plugins/dsh-plugin-manager/lib/pure.js');
});

test('manifestEnabled: enabled 缺省视为 true（要与 shared 的同名规则同义）', () => {
  assert.strictEqual(pure.manifestEnabled({}), true);
  assert.strictEqual(pure.manifestEnabled({ enabled: true }), true);
  assert.strictEqual(pure.manifestEnabled({ enabled: false }), false);
});

test('nextUserState: 等于默认值删除键（状态只记偏离），偏离才写', () => {
  const git = { entryId: 'dsdesktop-git' };
  assert.deepStrictEqual(
    pure.nextUserState({ 'dsdesktop-balance': false }, git, true),
    { 'dsdesktop-balance': false },
    '开=默认：不该新增任何记录',
  );
  assert.deepStrictEqual(
    pure.nextUserState({}, git, false),
    { 'dsdesktop-git': false },
    '关≠默认：写入覆盖值',
  );
  assert.deepStrictEqual(
    pure.nextUserState({ 'dsdesktop-x': true }, { entryId: 'dsdesktop-x', enabled: false }, false),
    {},
    '关=清单默认关：删除已有记录',
  );
});

test('nextUserState: 纯函数，不改传入的状态对象', () => {
  const before = { 'dsdesktop-balance': false };
  const after = pure.nextUserState(before, { entryId: 'dsdesktop-git' }, false);
  assert.notStrictEqual(after, before, '返回新对象');
  assert.deepStrictEqual(before, { 'dsdesktop-balance': false }, '原对象未被改动');
});

test('nextUserState: 再次切回默认值会把之前写下的键删掉（不留残值）', () => {
  const git = { entryId: 'dsdesktop-git' };
  const off = pure.nextUserState({}, git, false);
  assert.deepStrictEqual(off, { 'dsdesktop-git': false });
  // 关键回归点：旧实现在这里会留下 `{ 'dsdesktop-git': true }`，把插件钉死在
  // 当前默认值上，将来清单默认值翻转时这个用户就跟不上了。
  assert.deepStrictEqual(pure.nextUserState(off, git, true), {});
});
