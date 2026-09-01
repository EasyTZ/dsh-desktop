'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ensurePnpmShim, withPnpmOnPath, resolveDshHome, profileDir,
  pruneUnresolvableBundles, materializeBundledDist, sweepMirror, repairDanglingFileSpecs, reconcileProfilePlugins,
} = require('../src/main/profile-plugins-installer');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesktop-shim-'));
}

test('resolveDshHome: DSH_HOME 覆盖，否则 ~/.dsh', () => {
  // 这条必须和上游 @deepseek-ai/dsh-home-paths 一致：我们往一个目录装、内核从另一个
  // 目录读的话，表现是「装了但面板不出现」，而且没有任何报错。
  assert.strictEqual(resolveDshHome({ DSH_HOME: 'D:\\custom' }), path.resolve('D:\\custom'));
  assert.strictEqual(resolveDshHome({}), path.join(os.homedir(), '.dsh'));
  assert.strictEqual(resolveDshHome({ DSH_HOME: '' }), path.join(os.homedir(), '.dsh'));
});

test('profileDir: 桌面版启动的是 web profile', () => {
  assert.strictEqual(
    profileDir({ DSH_HOME: path.join('D:', 'h') }),
    path.join(path.resolve(path.join('D:', 'h')), 'profiles', 'web'),
  );
});

test('ensurePnpmShim: 造出一个能被 PATH 找到的 pnpm 入口', () => {
  const dir = tmpdir();
  const cli = path.join(dir, 'pnpm.cjs');
  fs.writeFileSync(cli, '// pnpm', 'utf8');
  const shimDir = path.join(dir, 'shim');
  const got = ensurePnpmShim({ shimDir, nodeExe: 'C:\\node.exe', pnpmCliPath: cli });
  assert.strictEqual(got, shimDir);
  const shimFile = path.join(shimDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  assert.ok(fs.existsSync(shimFile), '垫片文件应该存在');
  const body = fs.readFileSync(shimFile, 'utf8');
  assert.ok(body.includes(cli), '垫片里应该指向随包分发的 pnpm.cjs');
  assert.ok(body.includes('C:\\node.exe'), '垫片里应该用内核自带的 node');
});

test('ensurePnpmShim: pnpm 不在包里时返回 null，而不是造一个指向空气的垫片', () => {
  const dir = tmpdir();
  assert.strictEqual(
    ensurePnpmShim({ shimDir: path.join(dir, 'shim'), nodeExe: 'node', pnpmCliPath: path.join(dir, 'nope.cjs') }),
    null,
  );
  assert.strictEqual(ensurePnpmShim({ shimDir: path.join(dir, 'shim'), nodeExe: null, pnpmCliPath: null }), null);
});

test('withPnpmOnPath: 垫片排在最前，且不会造出第二个 PATH 键', () => {
  // Windows 的环境变量名大小写不敏感，但 Node 的 env 对象是敏感的：直接写 'PATH'
  // 会在已有 'Path' 的对象里多造一个键，子进程读到的仍是原来那个，垫片形同虚设。
  const env = { Path: 'C:\\a;C:\\b', OTHER: '1' };
  const got = withPnpmOnPath(env, 'C:\\shim');
  assert.strictEqual(Object.keys(got).filter((k) => k.toUpperCase() === 'PATH').length, 1);
  assert.strictEqual(got.Path, `C:\\shim${path.delimiter}C:\\a;C:\\b`);
  assert.strictEqual(got.OTHER, '1');
});

test('withPnpmOnPath: 没有垫片时原样返回', () => {
  const env = { PATH: '/usr/bin' };
  assert.strictEqual(withPnpmOnPath(env, null), env);
});

test('withPnpmOnPath: 环境里根本没有 PATH 时也能建出来', () => {
  assert.strictEqual(withPnpmOnPath({}, '/shim').PATH, `/shim${path.delimiter}`);
});

// —— 起内核前的清单自愈 ——————————————————————————————
const quiet = { log() {}, warn() {} };

function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

test('pruneUnresolvableBundles: 卸载卸到一半留下的声明会被摘掉', () => {
  // 复刻真实故障：node_modules 里的包没了，清单里的两条声明还在，内核起不来。
  const dir = tmpdir();
  writeManifest(dir, {
    dependencies: { good: '1', 'dsh-cost-meter': '1.6.13' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'good', 'dsh-cost-meter'] } },
  });
  fs.mkdirSync(path.join(dir, 'node_modules', 'good'), { recursive: true });

  assert.deepStrictEqual(pruneUnresolvableBundles({ dir, logger: quiet }), ['dsh-cost-meter']);
  const next = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.deepStrictEqual(next.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'good']);
  assert.deepStrictEqual(Object.keys(next.dependencies), ['good']);
});

test('pruneUnresolvableBundles: scope 包名按目录层级查，别当成一整段', () => {
  const dir = tmpdir();
  writeManifest(dir, {
    dependencies: { '@easytz/dsh-git': '1' },
    dsh: { profile: { bundles: ['@easytz/dsh-git'] } },
  });
  fs.mkdirSync(path.join(dir, 'node_modules', '@easytz', 'dsh-git'), { recursive: true });
  assert.deepStrictEqual(pruneUnresolvableBundles({ dir, logger: quiet }), [], 'scope 包装着就不该被摘');
});

test('pruneUnresolvableBundles: 一切正常时不写盘（别无谓地动用户的清单）', () => {
  const dir = tmpdir();
  writeManifest(dir, { dependencies: { good: '1' }, dsh: { profile: { bundles: ['good'] } } });
  fs.mkdirSync(path.join(dir, 'node_modules', 'good'), { recursive: true });
  const before = fs.statSync(path.join(dir, 'package.json')).mtimeMs;
  assert.deepStrictEqual(pruneUnresolvableBundles({ dir, logger: quiet }), []);
  assert.strictEqual(fs.statSync(path.join(dir, 'package.json')).mtimeMs, before);
});

test('pruneUnresolvableBundles: 清单读不出来也不能抛（它挂在启动路径上）', () => {
  // 这条自愈的全部意义就是「别让应用起不来」，它自己更不该成为起不来的原因。
  const dir = tmpdir();
  assert.deepStrictEqual(pruneUnresolvableBundles({ dir, logger: quiet }), [], '没有清单');
  fs.writeFileSync(path.join(dir, 'package.json'), '{ 坏的', 'utf8');
  assert.deepStrictEqual(pruneUnresolvableBundles({ dir, logger: quiet }), [], '清单不是合法 JSON');
});

// —— 随包 tarball 的稳定镜像 ————————————————————————
//
// 这一组防的是同一个洞的三个入口：启动播种、市场里的「装回自带插件」、以及清单里
// 早就记下的历史路径。pnpm 把 file: 依赖按**绝对路径**记进 profile 的 package.json，
// 指向应用目录的话，应用一升级（文件名带版本号）那条路径就悬空，此后 profile 里
// 任何一次 pnpm 操作都失败 —— 用户看到的是「插件装不上也卸不掉」。

function writeDist(dir, entries) {
  fs.mkdirSync(dir, { recursive: true });
  for (const e of entries) fs.writeFileSync(path.join(dir, e.tarball), 'x');
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(entries), 'utf8');
  return dir;
}

test('materializeBundledDist: tarball 与索引都镜像进 dsh home', () => {
  const dist = writeDist(tmpdir(), [{ packageName: 'a', version: '1.0.0', tarball: 'a-1.0.0.tgz' }]);
  const home = tmpdir();
  const mirror = materializeBundledDist({ profileDistDir: dist, homeDir: home, logger: quiet });

  assert.ok(mirror, '镜像应建起来');
  assert.strictEqual(mirror, path.join(home, '.dsdesktop', 'bundled'));
  assert.ok(fs.existsSync(path.join(mirror, 'a-1.0.0.tgz')), 'tarball 要在');
  // 索引也要镜像：市场那两条「随包插件」路由读的就是它，否则它们还得回头看应用目录。
  assert.ok(fs.existsSync(path.join(mirror, 'index.json')), '索引要在');

  // 应用目录整个消失（升级、卸载、重新打包）之后，镜像仍然完好。
  fs.rmSync(dist, { recursive: true, force: true });
  assert.ok(fs.existsSync(path.join(mirror, 'a-1.0.0.tgz')), '镜像不随应用目录消失');
});

test('materializeBundledDist: 升级后清掉不再被引用的旧版本', () => {
  const home = tmpdir();
  const v1 = writeDist(tmpdir(), [{ packageName: 'a', version: '1.0.0', tarball: 'a-1.0.0.tgz' }]);
  materializeBundledDist({ profileDistDir: v1, homeDir: home, logger: quiet });
  const v2 = writeDist(tmpdir(), [{ packageName: 'a', version: '2.0.0', tarball: 'a-2.0.0.tgz' }]);
  const mirror = materializeBundledDist({ profileDistDir: v2, homeDir: home, logger: quiet });
  assert.ok(mirror, '镜像应建起来');
  assert.deepStrictEqual(fs.readdirSync(mirror).sort(), ['a-2.0.0.tgz', 'index.json']);
});

test('materializeBundledDist: 源目录不可用时返回 null（调用方退回应用目录）', () => {
  assert.strictEqual(
    materializeBundledDist({ profileDistDir: path.join(tmpdir(), '不存在'), homeDir: tmpdir(), logger: quiet }),
    null);
});

test('sweepMirror: 只删 .tgz，索引不碰', () => {
  const home = tmpdir();
  const dir = path.join(home, '.dsdesktop', 'bundled');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['a-1.0.0.tgz', 'a-0.9.0.tgz', 'index.json']) fs.writeFileSync(path.join(dir, n), 'x');
  sweepMirror({ homeDir: home, keep: ['a-1.0.0.tgz'], logger: quiet });
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a-1.0.0.tgz', 'index.json']);
});

test('sweepMirror: 目录不存在也不抛', () => {
  sweepMirror({ homeDir: tmpdir(), keep: [], logger: quiet });
});

// —— 已经记在清单里的老路径 ————————————————————————
test('repairDanglingFileSpecs: 悬空的 file: 依赖改指到镜像', () => {
  // 这是用户机器上**已经存在**的那份清单：镜像只保证今后装的落在 dsh home，
  // 老路径不会自己变。它一旦失效，pnpm 连 dsh plugin add 都跑不起来 ——
  // 「下次启动自动装回来」那条自愈路径本身被堵死，只能在跑 pnpm 之前先改对。
  const home = tmpdir();
  const mirror = path.join(home, '.dsdesktop', 'bundled');
  fs.mkdirSync(mirror, { recursive: true });
  fs.writeFileSync(path.join(mirror, 'a-1.0.0.tgz'), 'x');

  const dir = tmpdir();
  const alive = path.join(dir, 'alive.tgz');
  fs.writeFileSync(alive, 'x');
  writeManifest(dir, {
    dependencies: {
      a: 'file:D:/gone/app/plugins-dist/profile/a-1.0.0.tgz',
      b: `file:${alive.split(path.sep).join('/')}`,
      c: '^1.2.3',
    },
    dsh: { profile: { bundles: [] } },
  });

  assert.deepStrictEqual(repairDanglingFileSpecs({ dir, mirrorDir: mirror, logger: quiet }), ['a']);
  const next = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.strictEqual(next.dependencies.a, `file:${mirror.split(path.sep).join('/')}/a-1.0.0.tgz`);
  assert.strictEqual(next.dependencies.b, `file:${alive.split(path.sep).join('/')}`, '还指得到的不许动');
  assert.strictEqual(next.dependencies.c, '^1.2.3', '不是 file: 的不许动');
});

test('repairDanglingFileSpecs: 镜像里也没有的原样留着，不擅自删依赖', () => {
  // 删掉等于卸载一个可能还在正常工作的插件 —— 那比留着一条坏路径更糟。
  const home = tmpdir();
  const mirror = path.join(home, '.dsdesktop', 'bundled');
  fs.mkdirSync(mirror, { recursive: true });
  const dir = tmpdir();
  writeManifest(dir, { dependencies: { a: 'file:D:/gone/a-1.0.0.tgz' }, dsh: { profile: { bundles: [] } } });
  assert.deepStrictEqual(repairDanglingFileSpecs({ dir, mirrorDir: mirror, logger: quiet }), []);
  const next = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.strictEqual(next.dependencies.a, 'file:D:/gone/a-1.0.0.tgz');
});

test('repairDanglingFileSpecs: 没有镜像时什么都不做', () => {
  assert.deepStrictEqual(repairDanglingFileSpecs({ dir: tmpdir(), mirrorDir: null, logger: quiet }), []);
});

test('reconcileProfilePlugins: 三步自愈都要接上，且排在读随包索引的早退之前', async () => {
  // 这条测的是**接线**，不是那三个函数本身。它们哪一个没接上（或者被挪到早退之后），
  // 用户机器上就还是会出现「插件装不上也卸不掉」或者「内核起不来」——而单测全绿。
  const home = tmpdir();
  const dir = path.join(home, 'profiles', 'web');
  const dist = writeDist(tmpdir(), [{ packageName: 'a', version: '1.0.0', tarball: 'a-1.0.0.tgz' }]);
  writeManifest(dir, {
    dependencies: {
      // 悬空的老路径：pnpm 解析到它就整体失败，连自愈本身都跑不起来。
      a: 'file:D:/gone/app/plugins-dist/profile/a-1.0.0.tgz',
      // 声明了但 node_modules 里没有：内核起不来，安全模式也救不回。
      gone: '1',
    },
    dsh: { profile: { bundles: ['gone'] } },
  });
  await reconcileProfilePlugins({
    profileDistDir: dist,
    nodeExe: 'node', binJs: 'bin.js', pnpmCliPath: 'pnpm.cjs',
    shimDir: path.join(home, 'shim'),
    seedStatePath: path.join(home, 'seeded.json'),
    logger: quiet,
    env: { DSH_HOME: home },
  });
  const next = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const mirror = path.join(home, '.dsdesktop', 'bundled').split(path.sep).join('/');
  assert.strictEqual(next.dependencies.a, `file:${mirror}/a-1.0.0.tgz`, '悬空路径应改指镜像');
  assert.deepStrictEqual(next.dsh.profile.bundles, [], '装不出来的 bundle 条目应摘掉');
  assert.ok(fs.existsSync(path.join(home, '.dsdesktop', 'bundled', 'index.json')), '索引应已镜像');
});

test('reconcileProfilePlugins: 装的必须是镜像里那份，不是应用目录里那份', async () => {
  // 这一行是整个修复的要害：装的时候传哪个路径，pnpm 就把哪个路径按绝对路径记进
  // profile 的清单。传应用目录的话，应用一升级那条依赖就悬空，此后所有插件都装不上
  // 也卸不掉 —— 也就是用户遇到的那次故障。
  const home = tmpdir();
  const dist = writeDist(tmpdir(), [{ packageName: 'a', version: '1.0.0', tarball: 'a-1.0.0.tgz' }]);
  writeManifest(path.join(home, 'profiles', 'web'), { dependencies: {}, dsh: { profile: { bundles: [] } } });

  let seen = null;
  await reconcileProfilePlugins({
    profileDistDir: dist,
    nodeExe: 'node', binJs: 'bin.js', pnpmCliPath: 'pnpm.cjs',
    shimDir: path.join(home, 'shim'),
    seedStatePath: path.join(home, 'seeded.json'),
    logger: quiet,
    env: { DSH_HOME: home },
    runAdd: async ({ specs }) => { seen = specs; return { ok: true, output: '' }; },
  });

  const mirror = path.join(home, '.dsdesktop', 'bundled');
  assert.deepStrictEqual(seen, [path.join(mirror, 'a-1.0.0.tgz')]);
});
