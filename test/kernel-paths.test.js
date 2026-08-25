'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  kernelPaths, dshManifestPath, kernelNodeModulesDir, isKernelComplete,
  readKernelVersion, resolvePackagedKernel,
} = require('../src/shared/kernel-paths');

// 这段逻辑决定「启动哪个内核」。选错的后果是应用起不来，而且是在用户机器上
// 才暴露，所以这里把回退分支全部钉死。

/** 用一个「存在的路径集合」替代真实文件系统。 */
const fakeExists = (present) => (p) => present.includes(p);

/** 用一个「目录 -> 版本号」映射替代读 package.json；未列出的目录读不到版本。 */
const fakeVersions = (map) => (dir) => map[dir] ?? null;

const USER = path.join('C:', 'user');
const BUILTIN = path.join('C:', 'builtin');
/** 用户内核完整（node.exe + bin.js 都在）。 */
const userComplete = fakeExists([kernelPaths(USER).nodeExe, kernelPaths(USER).binJs]);

test('kernelPaths: runtime/ 这层子目录不能丢', () => {
  const p = kernelPaths(path.join('C:', 'k'));
  assert.ok(p.binJs.includes(`${path.sep}runtime${path.sep}`),
    'electron-builder 会排除 from 根部的 node_modules，少了 runtime/ 就打不进安装包');
  assert.ok(p.nodeExe.endsWith('node.exe'));
});

test('dshManifestPath / kernelNodeModulesDir 与 kernelPaths 同源', () => {
  const dir = path.join('C:', 'k');
  assert.ok(dshManifestPath(dir).startsWith(kernelNodeModulesDir(dir)));
  assert.ok(kernelPaths(dir).binJs.startsWith(kernelNodeModulesDir(dir)));
});

test('isKernelComplete: node.exe 与 bin.js 必须同时存在', () => {
  const dir = path.join('C:', 'k');
  const { nodeExe, binJs } = kernelPaths(dir);
  assert.strictEqual(isKernelComplete(dir, fakeExists([nodeExe, binJs])), true);
  assert.strictEqual(isKernelComplete(dir, fakeExists([nodeExe])), false, '只有 node.exe 不算完整');
  assert.strictEqual(isKernelComplete(dir, fakeExists([binJs])), false);
  assert.strictEqual(isKernelComplete(dir, fakeExists([])), false);
});

test('resolvePackagedKernel: 用户内核完整时优先用户内核', () => {
  const user = path.join('C:', 'user');
  const builtin = path.join('C:', 'builtin');
  const u = kernelPaths(user);
  const got = resolvePackagedKernel(user, builtin, fakeExists([u.nodeExe, u.binJs]));
  assert.strictEqual(got.source, 'user');
  assert.strictEqual(got.binJs, u.binJs);
});

test('resolvePackagedKernel: 用户内核残缺则回退内置', () => {
  const user = path.join('C:', 'user');
  const builtin = path.join('C:', 'builtin');
  // 只有 node.exe：热更新写到一半被打断的典型现场。
  const got = resolvePackagedKernel(user, builtin, fakeExists([kernelPaths(user).nodeExe]));
  assert.strictEqual(got.source, 'builtin');
  assert.strictEqual(got.binJs, kernelPaths(builtin).binJs);
});

test('resolvePackagedKernel: 没有用户内核目录时直接用内置', () => {
  const builtin = path.join('C:', 'builtin');
  const got = resolvePackagedKernel(null, builtin, fakeExists([]));
  assert.strictEqual(got.source, 'builtin');
});

// ── 版本倒挂 ────────────────────────────────────────────────────────────────
// 安装包不碰 %APPDATA%，所以「装了带更新出厂内核的新版客户端、但用户内核还停
// 在更早版本」是必然会发生的常态，不是边角情况。

test('resolvePackagedKernel: 出厂内核更新时反超旧用户内核', () => {
  const got = resolvePackagedKernel(USER, BUILTIN, userComplete, fakeVersions({
    [USER]: '0.1.0-rc.7',
    [BUILTIN]: '0.1.1-rc.2',
  }));
  assert.strictEqual(got.source, 'builtin', '出厂内核更新就该用出厂内核');
  assert.strictEqual(got.version, '0.1.1-rc.2');
  assert.strictEqual(got.supersededUserVersion, '0.1.0-rc.7', '被跳过的版本要报给调用方记日志');
});

test('resolvePackagedKernel: 用户内核更新时仍然优先用户内核', () => {
  const got = resolvePackagedKernel(USER, BUILTIN, userComplete, fakeVersions({
    [USER]: '0.1.1-rc.2',
    [BUILTIN]: '0.1.0-rc.7',
  }));
  assert.strictEqual(got.source, 'user', '热更新的意义就在这里，别把它反过来压掉');
  assert.strictEqual(got.version, '0.1.1-rc.2');
  assert.strictEqual(got.supersededUserVersion, null);
});

test('resolvePackagedKernel: 版本相同用用户内核', () => {
  const got = resolvePackagedKernel(USER, BUILTIN, userComplete, fakeVersions({
    [USER]: '0.1.1-rc.2',
    [BUILTIN]: '0.1.1-rc.2',
  }));
  assert.strictEqual(got.source, 'user', '只有「出厂严格更新」才反超，平局不动');
});

test('resolvePackagedKernel: prerelease 也要比对，不能只看 x.y.z', () => {
  const got = resolvePackagedKernel(USER, BUILTIN, userComplete, fakeVersions({
    [USER]: '0.1.1-rc.2',
    [BUILTIN]: '0.1.1-rc.9',
  }));
  assert.strictEqual(got.source, 'builtin');
  assert.strictEqual(got.supersededUserVersion, '0.1.1-rc.2');
});

test('resolvePackagedKernel: 任一侧版本读不出来就维持原行为（用户内核优先）', () => {
  // 保守分支：不为一个读取失败新增启动路径 —— 内核目录已经通过完整性检查了。
  const noUserVersion = resolvePackagedKernel(USER, BUILTIN, userComplete, fakeVersions({
    [BUILTIN]: '9.9.9',
  }));
  assert.strictEqual(noUserVersion.source, 'user');
  assert.strictEqual(noUserVersion.supersededUserVersion, null);

  const noBuiltinVersion = resolvePackagedKernel(USER, BUILTIN, userComplete, fakeVersions({
    [USER]: '0.1.0-rc.7',
  }));
  assert.strictEqual(noBuiltinVersion.source, 'user');
});

test('resolvePackagedKernel: 用户内核残缺时不比版本，直接回退内置', () => {
  // 残缺优先于版本：再新的残缺内核也启动不了。
  const got = resolvePackagedKernel(USER, BUILTIN, fakeExists([kernelPaths(USER).nodeExe]),
    fakeVersions({ [USER]: '9.9.9', [BUILTIN]: '0.1.0-rc.7' }));
  assert.strictEqual(got.source, 'builtin');
  assert.strictEqual(got.supersededUserVersion, null, '残缺不算「被反超」，那是另一回事');
});

test('readKernelVersion: 读得到取 version，读不到/格式不对返回 null', () => {
  const dir = path.join('C:', 'k');
  const ok = readKernelVersion(dir, (p) => {
    assert.strictEqual(p, dshManifestPath(dir), '必须从 layout 的唯一定义处取路径');
    return '{"version":"0.1.1-rc.2"}';
  });
  assert.strictEqual(ok, '0.1.1-rc.2');

  assert.strictEqual(readKernelVersion(dir, () => { throw new Error('ENOENT'); }), null);
  assert.strictEqual(readKernelVersion(dir, () => 'not json'), null);
  assert.strictEqual(readKernelVersion(dir, () => '{"name":"dsh"}'), null, '没有 version 字段');
});
