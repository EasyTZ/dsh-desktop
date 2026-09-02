'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KernelUpdater, AUTO_CHECK_INTERVAL_MS } = require('../src/main/kernel-updater');
const { dshManifestPath } = require('../src/shared/kernel-paths');

// check() 决定用户看到「有新版本 / 已是最新 / 出错」中的哪一个。判断错了要么永远
// 提示不出更新，要么在内核已经损坏时告诉用户「一切正常」—— 后者尤其恶劣。

const silent = { log() {}, warn() {}, error() {} };

/** 造一个只有 package.json 的假内核目录；version 为 null 表示内核缺失。 */
function makeFixture(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-test-'));
  const kernelDir = path.join(root, 'kernel');
  if (version !== null) {
    const manifest = dshManifestPath(kernelDir);
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  }
  return { root, kernelDir, configPath: path.join(root, 'updater.json') };
}

/** 造一个 updater，并把 registry 查询换成固定返回值（测试不该联网）。 */
function makeUpdater(f, latest) {
  const u = new KernelUpdater({
    logger: silent,
    builtinKernelDir: f.kernelDir,
    configPath: f.configPath,
  });
  u._fetchLatest = async () => {
    if (latest instanceof Error) throw latest;
    return latest;
  };
  return u;
}

const cleanup = (f) => fs.rmSync(f.root, { recursive: true, force: true });

test('有更新时进入 available', async () => {
  const f = makeFixture('0.1.0-rc.7');
  const s = await makeUpdater(f, '0.1.1-rc.2').check();
  assert.strictEqual(s.phase, 'available');
  assert.strictEqual(s.currentVersion, '0.1.0-rc.7');
  assert.strictEqual(s.latestVersion, '0.1.1-rc.2');
  cleanup(f);
});

test('版本相同时进入 up-to-date', async () => {
  const f = makeFixture('0.1.1-rc.2');
  const s = await makeUpdater(f, '0.1.1-rc.2').check();
  assert.strictEqual(s.phase, 'up-to-date');
  cleanup(f);
});

test('本地比 registry 还新时也算 up-to-date，不做降级', async () => {
  const f = makeFixture('0.2.0');
  const s = await makeUpdater(f, '0.1.1-rc.2').check();
  assert.strictEqual(s.phase, 'up-to-date');
  cleanup(f);
});

test('读不到当前版本时必须报错，绝不能谎报「已是最新」', async () => {
  const f = makeFixture(null); // 内核目录不存在
  const s = await makeUpdater(f, '0.1.1-rc.2').check();
  assert.strictEqual(s.currentVersion, null);
  assert.notStrictEqual(s.phase, 'up-to-date', '内核都读不到了还说「已是最新」，是最坏的谎报');
  assert.strictEqual(s.phase, 'error');
  assert.match(String(s.error), /损坏|读不到/);
  cleanup(f);
});

test('registry 查询失败时进入 error，且不写 lastCheck', async () => {
  const f = makeFixture('0.1.0-rc.7');
  const u = makeUpdater(f, new Error('ECONNRESET'));
  const s = await u.check();
  assert.strictEqual(s.phase, 'error');
  assert.strictEqual(u.getLastCheck(), 0, '失败的检查不能占用当天的检查额度');
  cleanup(f);
});

test('检查成功后写入 lastCheck，并触发节流', async () => {
  const f = makeFixture('0.1.0-rc.7');
  const u = makeUpdater(f, '0.1.1-rc.2');
  assert.strictEqual(u.shouldAutoCheck(), true, '从没检查过就应该检查');
  await u.check();
  assert.ok(u.getLastCheck() > 0);
  assert.strictEqual(u.shouldAutoCheck(), false, '刚查过就不该再查');
  assert.strictEqual(u.shouldAutoCheck(0), true, '间隔为 0 时总是可以查');
  cleanup(f);
});

test('节流状态从磁盘恢复（跨进程重启仍然生效）', async () => {
  const f = makeFixture('0.1.0-rc.7');
  await makeUpdater(f, '0.1.1-rc.2').check();
  // 新实例模拟应用重启
  const fresh = makeUpdater(f, '0.1.1-rc.2');
  assert.strictEqual(fresh.shouldAutoCheck(), false, 'lastCheck 应从 updater.json 读回来');
  cleanup(f);
});

test('过期的 lastCheck 会重新触发检查', async () => {
  const f = makeFixture('0.1.0-rc.7');
  fs.writeFileSync(f.configPath, JSON.stringify({ lastCheck: Date.now() - AUTO_CHECK_INTERVAL_MS - 1000 }));
  assert.strictEqual(makeUpdater(f, '0.1.1-rc.2').shouldAutoCheck(), true);
  cleanup(f);
});

// —— 自检必须覆盖「新内核 + 我们的插件」 ——————————————————————
//
// 插件迁到 profile 层之后，「把插件拷进新内核」这一步整个不需要了：
// 插件住在用户 profile 里，换内核不影响它们。
//
// 但由此冒出一个**不会报错的洞**：自检用的是干净的 .verify-home，里面一个插件都
// 没有，于是自检只能证明「内核自己能起来」，证明不了「内核 + 我们的插件能一起
// 起来」——而后者才是用户真正会遇到的组合。补法是自检前把随包分发的插件播种进
// 那个隔离 home（_seedProfilePlugins），用的是和正式启动完全相同的那套对账。
