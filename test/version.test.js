'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { compareSemver, isNewer } = require('../src/shared/version');

// 内核热更新靠这个比较决定「要不要提示用户更新」。判断反了会导致把旧内核当新的
// 装进去，或者永远提示不出更新，因此这里覆盖到 prerelease 这类边界。

test('compareSemver: 主版本段逐段比较', () => {
  assert.ok(compareSemver('1.0.0', '0.9.9') > 0);
  assert.ok(compareSemver('0.2.0', '0.10.0') < 0, '数值比较而非字典序');
  assert.strictEqual(compareSemver('1.2.3', '1.2.3'), 0);
});

test('compareSemver: 缺省段按 0 补齐', () => {
  assert.strictEqual(compareSemver('1.2', '1.2.0'), 0);
  assert.ok(compareSemver('1.2.1', '1.2') > 0);
});

test('compareSemver: prerelease 低于同号正式版', () => {
  assert.ok(compareSemver('0.1.0-rc.7', '0.1.0') < 0);
  assert.ok(compareSemver('0.1.0', '0.1.0-rc.7') > 0);
});

test('compareSemver: prerelease 段数字按数值、非数字按字典序', () => {
  assert.ok(compareSemver('0.1.0-rc.2', '0.1.0-rc.10') < 0, 'rc.2 < rc.10');
  assert.ok(compareSemver('0.1.0-alpha', '0.1.0-beta') < 0);
  assert.ok(compareSemver('0.1.0-rc.1.1', '0.1.0-rc.1') > 0, '段更多者更大');
});

test('isNewer: 只在严格更新时为真', () => {
  assert.strictEqual(isNewer('0.1.1', '0.1.0'), true);
  assert.strictEqual(isNewer('0.1.0', '0.1.0'), false);
  assert.strictEqual(isNewer('0.1.0', '0.1.1'), false);
  // dsh 的实际版本形态
  assert.strictEqual(isNewer('0.1.0-rc.8', '0.1.0-rc.7'), true);
  assert.strictEqual(isNewer('0.1.0-rc.7', '0.1.0-rc.8'), false);
});

test('isNewer: 非法输入不抛异常（registry 返回异常值时不能崩）', () => {
  assert.doesNotThrow(() => isNewer('', '1.0.0'));
  assert.doesNotThrow(() => isNewer(undefined, '1.0.0'));
});
