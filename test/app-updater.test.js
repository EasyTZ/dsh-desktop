'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppUpdateChecker, AUTO_CHECK_INTERVAL_MS, pickLatestTag } = require('../src/main/app-updater');

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

// pickLatestTag 是 GitHub 查不通时的兜底入口（读 Gitee 镜像的 tag 列表）。挑错了
// 会把补发的旧版本当成最新版，反过来劝用户「升级」回去——比查不到更糟。

test('从 Gitee tag 列表里挑出版本号最大的那个', () => {
  // 故意乱序，并且把最旧的一个放在最后：模拟事后补打的 tag。这个接口按创建
  // 时间给，不按版本排序，「取第一个」在这份数据上就会答错。
  const tags = [
    { name: 'v1.6.0' },
    { name: 'v1.7.9' },
    { name: 'v1.7.10' },
    { name: 'v1.5.2' },
  ];
  assert.strictEqual(pickLatestTag(tags), '1.7.10', '1.7.10 比 1.7.9 新，不能按字符串比');
});

test('不带 v 前缀的 tag 也认', () => {
  assert.strictEqual(pickLatestTag([{ name: '1.2.3' }]), '1.2.3');
});

test('忽略认不出版本号的 tag，不因为混进一个就整体失败', () => {
  assert.strictEqual(pickLatestTag([{ name: 'nightly' }, { name: 'v1.0.0' }, {}]), '1.0.0');
});

test('没有任何可用 tag 时返回 null，由调用方转成一次失败', () => {
  assert.strictEqual(pickLatestTag([]), null);
  assert.strictEqual(pickLatestTag([{ name: 'latest' }]), null);
  assert.strictEqual(pickLatestTag(null), null, 'Gitee 返回的不是数组时不能崩');
});

test('GitHub 断了会退到 Gitee，拿到版本号照样能提醒', async () => {
  const f = makeFixture();
  const u = new AppUpdateChecker({ logger: silent, currentVersion: '1.5.1', configPath: f.configPath });
  const notifyCalls = [];
  u._fetchFromGitHub = async () => { throw new Error('ETIMEDOUT'); };
  u._fetchFromGitee = async () => ({ version: '1.6.0', url: 'https://gitee.com/huo_sydney/dsh-desktop' });
  u._notify = (version, releaseUrl) => { notifyCalls.push({ version, releaseUrl }); };

  const s = await u.check();
  assert.strictEqual(s.phase, 'available');
  assert.strictEqual(s.latestVersion, '1.6.0');
  assert.strictEqual(s.releaseUrl, 'https://gitee.com/huo_sydney/dsh-desktop', '兜底时要给能打开的那个链接');
  assert.strictEqual(notifyCalls.length, 1);
  cleanup(f);
});

test('两条路都断才算失败', async () => {
  const f = makeFixture();
  const u = new AppUpdateChecker({ logger: silent, currentVersion: '1.5.1', configPath: f.configPath });
  u._fetchFromGitHub = async () => { throw new Error('ETIMEDOUT'); };
  u._fetchFromGitee = async () => { throw new Error('ECONNRESET'); };
  u._notify = () => {};

  const s = await u.check();
  assert.strictEqual(s.phase, 'error');
  assert.strictEqual(s.error, 'ECONNRESET', '错误信息应是最后一条路的，不是第一条的');
  assert.strictEqual(u.shouldAutoCheck(), true);
  cleanup(f);
});
