'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppUpdateChecker, AUTO_CHECK_INTERVAL_MS } = require('../src/main/app-updater');

// check() 决定用户会不会看到「有新版本」的提醒。判断错了要么永远提醒不出更新，
// 要么在版本相同/更旧时谎报有更新——后者会让用户对着「已经是最新版」的应用去点
// 一个不存在的更新。

const silent = { log() {}, warn() {}, error() {} };

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-app-updater-test-'));
  return { root, configPath: path.join(root, 'app-updater.json') };
}

const cleanup = (f) => fs.rmSync(f.root, { recursive: true, force: true });

/**
 * 造一个 checker，把网络请求与真实系统通知都换成可控的假实现。
 * 通知次数记在闭包变量里，不挂在实例上——挂了 tsc 的 checkJs 会因为
 * AppUpdateChecker 类型里没有这个字段而报错。
 * @returns {{ u: InstanceType<typeof AppUpdateChecker>, notifyCalls: Array<{version: string, releaseUrl: string|null}> }}
 */
function makeChecker(f, currentVersion, latest) {
  const notifyCalls = [];
  const u = new AppUpdateChecker({ logger: silent, currentVersion, configPath: f.configPath });
  u._fetchLatestRelease = async () => {
    if (latest instanceof Error) throw latest;
    return latest;
  };
  u._notify = (version, releaseUrl) => { notifyCalls.push({ version, releaseUrl }); };
  return { u, notifyCalls };
}

test('有更新时进入 available 并弹一次通知', async () => {
  const f = makeFixture();
  const { u, notifyCalls } = makeChecker(f, '1.5.1', { version: '1.6.0', url: 'https://example.com/v1.6.0' });
  const s = await u.check();
  assert.strictEqual(s.phase, 'available');
  assert.strictEqual(s.latestVersion, '1.6.0');
  assert.strictEqual(s.releaseUrl, 'https://example.com/v1.6.0');
  assert.strictEqual(notifyCalls.length, 1);
  cleanup(f);
});

test('版本相同时进入 up-to-date，不弹通知', async () => {
  const f = makeFixture();
  const { u, notifyCalls } = makeChecker(f, '1.5.1', { version: '1.5.1', url: null });
  const s = await u.check();
  assert.strictEqual(s.phase, 'up-to-date');
  assert.strictEqual(notifyCalls.length, 0);
  cleanup(f);
});

test('本地比 Release 还新时也算 up-to-date，不做降级提醒', async () => {
  const f = makeFixture();
  const { u } = makeChecker(f, '2.0.0', { version: '1.6.0', url: null });
  const s = await u.check();
  assert.strictEqual(s.phase, 'up-to-date');
  cleanup(f);
});

test('同一个新版本只提醒一次，之后每天自动检查不再重复打扰', async () => {
  const f = makeFixture();
  const { u, notifyCalls } = makeChecker(f, '1.5.1', { version: '1.6.0', url: null });
  await u.check();
  await u.check();
  assert.strictEqual(notifyCalls.length, 1, '第二次检查发现还是同一个新版本，不该再弹一次通知');
  cleanup(f);
});

test('GitHub 请求失败时进入 error，且不写 lastCheck', async () => {
  const f = makeFixture();
  const { u } = makeChecker(f, '1.5.1', new Error('ECONNRESET'));
  const s = await u.check();
  assert.strictEqual(s.phase, 'error');
  assert.strictEqual(u.shouldAutoCheck(), true, '失败的检查不能占用当天的检查额度');
  cleanup(f);
});

test('检查成功后触发节流，节流状态跨实例（模拟应用重启）持续有效', async () => {
  const f = makeFixture();
  const { u } = makeChecker(f, '1.5.1', { version: '1.6.0', url: null });
  assert.strictEqual(u.shouldAutoCheck(), true, '从没检查过就应该检查');
  await u.check();
  assert.strictEqual(u.shouldAutoCheck(), false, '刚查过就不该再查');

  const fresh = makeChecker(f, '1.5.1', { version: '1.6.0', url: null });
  assert.strictEqual(fresh.u.shouldAutoCheck(), false, 'lastCheck 应从 app-updater.json 读回来');
  cleanup(f);
});

test('过期的 lastCheck 会重新触发检查', async () => {
  const f = makeFixture();
  fs.writeFileSync(f.configPath, JSON.stringify({ lastCheck: Date.now() - AUTO_CHECK_INTERVAL_MS - 1000 }));
  const { u } = makeChecker(f, '1.5.1', { version: '1.6.0', url: null });
  assert.strictEqual(u.shouldAutoCheck(), true);
  cleanup(f);
});
