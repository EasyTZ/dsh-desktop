'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadProfilePluginManifest, loadProfilePluginIndex, planProfileReconcile, installedVersionIn,
  profileBundleEntryIds, loadSeedState, saveSeedState, planProfileCleanup, entryIdsForPackage,
  planBundlePrune, pruneBundles, planFileSpecRepair,
} = require('../src/shared/profile-plugins');

// profile 层插件的清单与对账。
//
// 这套逻辑决定的是「桌面要不要往用户的 profile 里装东西」，判错的两个方向都不好：
// 判少了 → 发行版承诺的市场面板不在，用户看到的是一个缺功能的应用；判多了 → 每次
// 启动都重跑一次 pnpm，冷启动白白多几秒。

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesktop-profile-'));
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
}

test('loadProfilePluginManifest: 清单缺失时返回空数组，不抛', () => {
  // 没有 profile 层插件的构建、或旧版本升上来的目录都会走到这里，不该因此起不来。
  assert.deepStrictEqual(loadProfilePluginManifest(tmpdir()), []);
});

test('loadProfilePluginManifest: 正常读取', () => {
  const dir = tmpdir();
  write(path.join(dir, 'profile-plugins.json'), [{ packageName: 'dsh-market' }]);
  assert.deepStrictEqual(loadProfilePluginManifest(dir), [{ packageName: 'dsh-market' }]);
});

test('loadProfilePluginManifest: 字段错了要大声失败', () => {
  const dir = tmpdir();
  write(path.join(dir, 'profile-plugins.json'), { packageName: 'x' });
  assert.throws(() => loadProfilePluginManifest(dir), /必须是数组/);

  write(path.join(dir, 'profile-plugins.json'), [{}]);
  assert.throws(() => loadProfilePluginManifest(dir), /缺少 packageName/);

  // 路径穿越形状的包名会被拼进 path.join，必须挡住
  write(path.join(dir, 'profile-plugins.json'), [{ packageName: '../../evil' }]);
  assert.throws(() => loadProfilePluginManifest(dir), /不是合法包名/);

  write(path.join(dir, 'profile-plugins.json'), [{ packageName: 'a' }, { packageName: 'a' }]);
  assert.throws(() => loadProfilePluginManifest(dir), /重复的 packageName/);
});

test('loadProfilePluginIndex: 缺失返回空；字段不全的条目被跳过而不是让整份索引失败', () => {
  const dir = tmpdir();
  assert.deepStrictEqual(loadProfilePluginIndex(dir), []);
  write(path.join(dir, 'index.json'), [
    { packageName: 'dsh-market', version: '0.1.0', tarball: 'dsh-market-0.1.0.tgz' },
    { packageName: 'broken' },                       // 缺 version/tarball
    { packageName: '../evil', version: '1.0.0', tarball: 'x.tgz' }, // 非法包名
  ]);
  assert.deepStrictEqual(loadProfilePluginIndex(dir), [
    // required 缺省补 false：对账的两套语义全靠这个字段分流，不能是 undefined
    { packageName: 'dsh-market', version: '0.1.0', tarball: 'dsh-market-0.1.0.tgz', required: false },
  ]);
});

test('planProfileReconcile: 没装的要装', () => {
  const desired = [{ packageName: 'dsh-market', version: '0.1.0', tarball: 't.tgz' }];
  assert.deepStrictEqual(planProfileReconcile(desired, () => null), desired);
});

test('planProfileReconcile: required 插件版本一致就什么都不做（常态，冷启动不该跑 pnpm）', () => {
  const desired = [{ packageName: 'dsh-market', version: '0.1.0', tarball: 't.tgz', required: true }];
  assert.deepStrictEqual(planProfileReconcile(desired, () => '0.1.0'), []);
});

test('planProfileReconcile: required 插件被卸了要装回来，版本漂了也要拉回来', () => {
  // 插件市场是唯一的 required：它没了就没有任何管理插件的界面，所以不接受「用户
  // 不想要」这种状态。降级也要执行——应用回退时插件要跟着回到配套版本。
  const desired = [{ packageName: 'dsh-market', version: '0.1.0', tarball: 't.tgz', required: true }];
  assert.deepStrictEqual(planProfileReconcile(desired, () => null, { 'dsh-market': '0.1.0' }), desired);
  assert.deepStrictEqual(planProfileReconcile(desired, () => '0.9.9', { 'dsh-market': '0.9.9' }), desired);
});

test('planProfileReconcile: 非 required 只播种一次——用户卸载后不再装回来', () => {
  // 这是整套机制里最要紧的一条。装回来的话「卸载」这个按钮就是假的：点完下次启动
  // 它又回来了，比没有这个按钮更让人恼火。
  const desired = [{ packageName: 'dsh-git', version: '0.4.0', tarball: 't.tgz' }];
  // 从没播过种 → 播
  assert.deepStrictEqual(planProfileReconcile(desired, () => null, {}), desired);
  // 播过种、现在没装 = 用户卸了 → 不动
  assert.deepStrictEqual(planProfileReconcile(desired, () => null, { 'dsh-git': '0.4.0' }), []);
});

test('planProfileReconcile: 播种过且还装着时，只升级不降级', () => {
  const desired = [{ packageName: 'dsh-git', version: '0.5.0', tarball: 't.tgz' }];
  const seeded = { 'dsh-git': '0.4.0' };
  // 随包版本更新了 → 升上去（用户能拿到修复）
  assert.deepStrictEqual(planProfileReconcile(desired, () => '0.4.0', seeded), desired);
  // 版本一致 → 不动
  assert.deepStrictEqual(planProfileReconcile(desired, () => '0.5.0', seeded), []);
  // 用户自己从市场装了更新的版本 → **不许降级**，他的选择优先
  assert.deepStrictEqual(planProfileReconcile(desired, () => '0.9.0', seeded), []);
});

test('planProfileReconcile: 装的比期望新也要拉回来（应用回退时）', () => {
  // 应用回退到旧版本时，profile 里留着的新版插件要被拉回这个应用版本对应的那一版，
  // 否则就出现「应用 1.3 + 插件 1.5」这种谁都没测过的组合。
  const desired = [{ packageName: 'dsh-market', version: '0.1.0', tarball: 't.tgz' }];
  assert.deepStrictEqual(planProfileReconcile(desired, () => '0.9.9'), desired);
});

test('planProfileReconcile: 多个插件各判各的，顺序不变', () => {
  const desired = [
    { packageName: 'a', version: '1.0.0', tarball: 'a.tgz' },
    { packageName: 'b', version: '2.0.0', tarball: 'b.tgz' },
    { packageName: 'c', version: '3.0.0', tarball: 'c.tgz' },
  ];
  const installed = { a: '1.0.0', b: '1.0.0', c: '2.9.9' };
  // 三个都播过种：a 版本一致不动；b 装的比随包旧要升；c 同理
  const seeded = { a: '1.0.0', b: '1.0.0', c: '2.9.9' };
  assert.deepStrictEqual(
    planProfileReconcile(desired, (n) => installed[n] ?? null, seeded).map((e) => e.packageName),
    ['b', 'c'],
  );
});

test('installedVersionIn: 读 profile 里实际装到的版本，读不到给 null', () => {
  const dir = tmpdir();
  write(path.join(dir, 'node_modules', 'dsh-market', 'package.json'), { name: 'dsh-market', version: '0.4.2' });
  assert.strictEqual(installedVersionIn(dir, 'dsh-market'), '0.4.2');
  assert.strictEqual(installedVersionIn(dir, 'not-installed'), null);

  // 装了但 package.json 坏了 —— 当成没装（重装一次比对着半截安装转圈强）
  write(path.join(dir, 'node_modules', 'broken', 'package.json'), 'not json');
  assert.strictEqual(installedVersionIn(dir, 'broken'), null);
});

test('installedVersionIn: scoped 包名按目录层级拆开', () => {
  const dir = tmpdir();
  write(path.join(dir, 'node_modules', '@scope', 'pkg', 'package.json'), { version: '1.2.3' });
  assert.strictEqual(installedVersionIn(dir, '@scope/pkg'), '1.2.3');
});

test('profileBundleEntryIds: 列出 profile 层插件声明的 entry id', () => {
  const dir = tmpdir();
  write(path.join(dir, 'package.json'), {
    dependencies: { 'plug-a': '1.0.0', 'plug-b': '1.0.0', 'not-a-bundle': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'plug-a', 'plug-b'] } },
  });
  write(path.join(dir, 'node_modules', 'plug-a', 'package.json'), { dsh: { bundle: { patch: './cordis.patch.yml' } } });
  write(path.join(dir, 'node_modules', 'plug-a', 'cordis.patch.yml'),
    "- insert:\n    - id: entry-a\n      name: 'plug-a'\n");
  write(path.join(dir, 'node_modules', 'plug-b', 'package.json'), { dsh: { bundle: { patch: './p.yml' } } });
  write(path.join(dir, 'node_modules', 'plug-b', 'p.yml'),
    "- insert:\n    - id: entry-b1\n      name: 'x'\n    - id: entry-b2\n      name: 'y'\n");

  assert.deepStrictEqual(profileBundleEntryIds(dir).sort(), ['entry-a', 'entry-b1', 'entry-b2']);
});

test('profileBundleEntryIds: 应用本体（不是 dependencies 的 bundle）绝不能被列进来', () => {
  // dsh-base / dsh-web-app 在 bundles 里但不是 dependencies。把它们 disable 掉不是
  // 「安全模式」，是「没有界面」。
  const dir = tmpdir();
  write(path.join(dir, 'package.json'), {
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  });
  assert.deepStrictEqual(profileBundleEntryIds(dir), []);
});

test('profileBundleEntryIds: exclude 里的包被放过（恢复入口自己）', () => {
  const dir = tmpdir();
  write(path.join(dir, 'package.json'), {
    dependencies: { 'dsh-market': '1.0.0', evil: '1.0.0' },
    dsh: { profile: { bundles: ['dsh-market', 'evil'] } },
  });
  for (const name of ['dsh-market', 'evil']) {
    write(path.join(dir, 'node_modules', name, 'package.json'), { dsh: { bundle: { patch: './c.yml' } } });
    write(path.join(dir, 'node_modules', name, 'c.yml'), `- insert:\n    - id: ${name}-entry\n`);
  }
  assert.deepStrictEqual(profileBundleEntryIds(dir, { exclude: ['dsh-market'] }), ['evil-entry']);
});

test('profileBundleEntryIds: 装了但没有 dsh.bundle / 读不到文件的包安静跳过', () => {
  const dir = tmpdir();
  write(path.join(dir, 'package.json'), {
    dependencies: { plain: '1.0.0', missing: '1.0.0', broken: '1.0.0' },
    dsh: { profile: { bundles: ['plain', 'missing', 'broken'] } },
  });
  write(path.join(dir, 'node_modules', 'plain', 'package.json'), { name: 'plain' });          // 没有 dsh.bundle
  write(path.join(dir, 'node_modules', 'broken', 'package.json'), { dsh: { bundle: { patch: './gone.yml' } } }); // patch 文件不存在
  assert.deepStrictEqual(profileBundleEntryIds(dir), []);
});

test('profileBundleEntryIds: profile 不存在时返回空数组，不抛', () => {
  assert.deepStrictEqual(profileBundleEntryIds(path.join(tmpdir(), 'nope')), []);
});

test('loadSeedState / saveSeedState: 往返一致，读不到给空账本', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'seeded.json');
  // 读不到按「什么都没播过」——最坏是重播一次种，比误判成播过、于是永远不装要好，
  // 后者表现为「插件凭空少了」且没有任何提示。
  assert.deepStrictEqual(loadSeedState(file), {});
  saveSeedState(file, { 'dsh-git': '0.4.0', 'dsh-market': '0.1.0' });
  assert.deepStrictEqual(loadSeedState(file), { 'dsh-git': '0.4.0', 'dsh-market': '0.1.0' });
});

test('loadSeedState: 内容坏了按空账本，不抛', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'seeded.json');
  fs.writeFileSync(file, 'not json', 'utf8');
  assert.deepStrictEqual(loadSeedState(file), {});
  fs.writeFileSync(file, '[1,2,3]', 'utf8');
  assert.deepStrictEqual(loadSeedState(file), {});
  fs.writeFileSync(file, '{"a": 1, "b": "1.0.0"}', 'utf8');
  assert.deepStrictEqual(loadSeedState(file), { b: '1.0.0' }, '非字符串的值要被丢掉');
});

test('saveSeedState: 目录不存在时自动建（首次启动 userData 里还没有这个文件）', () => {
  const file = path.join(tmpdir(), 'nested', 'deep', 'seeded.json');
  saveSeedState(file, { x: '1.0.0' });
  assert.deepStrictEqual(loadSeedState(file), { x: '1.0.0' });
});

test('真实清单：五个插件都在 A1，且只有插件市场是 required', () => {
  // 这条钉的是本次迁移的结论：四个插件与市场装的插件同一种管理模式（可自主装卸），
  // 唯独市场自己必须常驻——它没了就没有任何能装卸插件的界面。
  const plugins = loadProfilePluginManifest(path.join(__dirname, '..', 'plugins'));
  const names = plugins.map((p) => p.packageName).sort();
  assert.deepStrictEqual(names, [
    '@easytz/dsh-git', '@easytz/dsh-market', '@easytz/dsh-reveal-explorer',
    '@easytz/dsh-terminal-panel', '@easytz/dsh-ui-balance',
  ]);
  const required = plugins.filter((p) => p.required === true).map((p) => p.packageName);
  assert.deepStrictEqual(required, ['@easytz/dsh-market'], '只有插件市场可以是 required');
});

test('planProfileCleanup: 改名后旧包会撞 entry id，必须清掉', () => {
  // 这条是真事故的回归：改名之后 profile 里同时存在 dsh-git 与 @easytz/dsh-git，
  // 两个包声明同一个 entryId，`- insert:` 不去重 → cordis 抛 duplicate loader
  // entry id → 内核秒退、用户看到「内核启动失败」。
  const ids = {
    'dsh-git': ['dsdesktop-git'],
    '@easytz/dsh-git': ['dsdesktop-git'],
  };
  const desired = [{ packageName: '@easytz/dsh-git', version: '0.5.0', tarball: 't.tgz' }];
  const seeded = { 'dsh-git': '0.4.0', '@easytz/dsh-git': '0.5.0' };
  assert.deepStrictEqual(planProfileCleanup(desired, seeded, (n) => ids[n] ?? []), ['dsh-git']);
});

test('planProfileCleanup: 我们不再分发、但不撞 id 的包不许动', () => {
  // 判据是「撞 id」而不是「不在清单里」。后者会把「曾经随包分发、后来不再分发，
  // 但用户还在用」的插件也删掉 —— 那是替用户做决定。撞 id 不一样：两个包不可能
  // 共存，清掉我们自己留下的那个是唯一出路。
  const ids = { 'dropped-plugin': ['some-other-id'], '@easytz/dsh-git': ['dsdesktop-git'] };
  const desired = [{ packageName: '@easytz/dsh-git', version: '0.5.0', tarball: 't.tgz' }];
  assert.deepStrictEqual(
    planProfileCleanup(desired, { 'dropped-plugin': '1.0.0' }, (n) => ids[n] ?? []), [],
  );
});

test('planProfileCleanup: 用户自己装的包不归我们管，撞了也不删', () => {
  // 只看播种账本。账本里没有 = 不是我们放进去的 = 轮不到我们删。
  const ids = { 'user-installed': ['dsdesktop-git'], '@easytz/dsh-git': ['dsdesktop-git'] };
  const desired = [{ packageName: '@easytz/dsh-git', version: '0.5.0', tarball: 't.tgz' }];
  assert.deepStrictEqual(planProfileCleanup(desired, {}, (n) => ids[n] ?? []), []);
});

test('planProfileCleanup: 已经卸掉的残留（读不到 entry id）不用管', () => {
  const desired = [{ packageName: '@easytz/dsh-git', version: '0.5.0', tarball: 't.tgz' }];
  assert.deepStrictEqual(planProfileCleanup(desired, { 'gone': '1.0.0' }, () => []), []);
});

test('entryIdsForPackage: 读某个已装包声明的 entry id', () => {
  const dir = tmpdir();
  write(path.join(dir, 'node_modules', 'p', 'package.json'), { dsh: { bundle: { patch: './c.yml' } } });
  write(path.join(dir, 'node_modules', 'p', 'c.yml'), "- insert:\n    - id: e1\n      name: 'p'\n    - id: e2\n");
  assert.deepStrictEqual(entryIdsForPackage(dir, 'p'), ['e1', 'e2']);
  assert.deepStrictEqual(entryIdsForPackage(dir, 'missing'), []);
  assert.deepStrictEqual(entryIdsForPackage(dir, '../evil'), [], '非法包名不许拼进路径');
});

// —— 清单自愈 ————————————————————————————————————————
//
// 这一组防的是一次真实故障：用户在市场里卸载插件，`dsh plugin remove` 中途失败，
// node_modules 里的包没了、清单里的两条声明还在，下次启动内核直接抛
// `cannot resolve profile bundle` 退出。而且救不回来 —— 那是 profile 组装阶段，
// 早于第 4 层 patch 生效，安全模式靠压 `disabled: true` 关插件，这时压给谁都没用。

test('planBundlePrune: 声明了但装不出来的包要被摘掉', () => {
  const manifest = {
    dependencies: { '@easytz/dsh-git': '1', 'gone': '2' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@easytz/dsh-git', 'gone'] } },
  };
  const installed = new Set(['@easytz/dsh-git']);
  assert.deepStrictEqual(planBundlePrune(manifest, (n) => installed.has(n)), ['gone']);
});

test('planBundlePrune: 基础 bundle 不在 dependencies 里，一律不碰', () => {
  // `@deepseek-ai/dsh-base` 是从 dsh 安装目录解析的，profile 的 node_modules 里
  // 本来就没有。按「装没装」判会把它摘掉 —— 那等于把内核拆了。
  const manifest = {
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  };
  assert.deepStrictEqual(planBundlePrune(manifest, () => false), []);
});

test('planBundlePrune: 清单结构不对时返回空，不抛', () => {
  assert.deepStrictEqual(planBundlePrune(null, () => false), []);
  assert.deepStrictEqual(planBundlePrune({}, () => false), []);
  assert.deepStrictEqual(planBundlePrune({ dependencies: {} }, () => false), []);
  assert.deepStrictEqual(planBundlePrune({ dsh: { profile: { bundles: [] } } }, () => false), []);
});

test('pruneBundles: bundles 与 dependencies 两处都要摘', () => {
  // 只摘 bundles 的话，profile 里留着一条指向不存在的包的依赖，下一次 pnpm 操作
  // （用户装/卸任何一个插件）解析到它就整体失败 —— 故障从「起不来」变成「插件
  // 再也装不上」，一样难查。
  const manifest = {
    dependencies: { keep: '1', gone: '2' },
    dsh: { profile: { bundles: ['keep', 'gone'] } },
  };
  const { manifest: next, pruned } = pruneBundles(manifest, ['gone']);
  assert.deepStrictEqual(pruned, ['gone']);
  assert.deepStrictEqual(Object.keys(next.dependencies), ['keep']);
  assert.deepStrictEqual(next.dsh.profile.bundles, ['keep']);
  // 原对象不该被改（调用方可能还拿着它做别的判断）。
  assert.deepStrictEqual(manifest.dsh.profile.bundles, ['keep', 'gone']);
});

test('pruneBundles: 没东西要摘时原样返回', () => {
  const manifest = { dependencies: { a: '1' }, dsh: { profile: { bundles: ['a'] } } };
  const out = pruneBundles(manifest, []);
  assert.strictEqual(out.manifest, manifest);
  assert.deepStrictEqual(out.pruned, []);
});

test('planFileSpecRepair: 按文件名找替代，找不到就原样留着', () => {
  // file: 记的是绝对路径，路径变了但文件名（带版本号）没变，就是同一个包的同一版。
  const manifest = { dependencies: {
    a: 'file:D:/old/a-1.0.0.tgz',
    b: 'file:D:/old/b-2.0.0.tgz',
    c: 'file:D:/live/c-1.0.0.tgz',
    d: '^1.0.0',
  } };
  // 镜像里连 c 的同名文件也有 —— 这样「不判断路径是否还有效、一律改写」才会露馅。
  // 还指得到的依赖不该被动：它可能是用户自己从别处装的，重指到我们的镜像就换了包。
  const have = new Set(['a-1.0.0.tgz', 'c-1.0.0.tgz']);
  const { manifest: next, repaired } = planFileSpecRepair(
    manifest,
    (target) => target === 'D:/live/c-1.0.0.tgz',
    (base) => (have.has(base) ? `D:/mirror/${base}` : null),
  );
  assert.deepStrictEqual(repaired, ['a']);
  assert.strictEqual(next.dependencies.a, 'file:D:/mirror/a-1.0.0.tgz');
  assert.strictEqual(next.dependencies.b, 'file:D:/old/b-2.0.0.tgz', '镜像里没有的不许动');
  assert.strictEqual(next.dependencies.c, 'file:D:/live/c-1.0.0.tgz', '还指得到的不许动');
  assert.strictEqual(next.dependencies.d, '^1.0.0', '不是 file: 的不许动');
  assert.strictEqual(manifest.dependencies.a, 'file:D:/old/a-1.0.0.tgz', '原对象不该被改');
});

test('planFileSpecRepair: 反斜杠路径也要能取到文件名（Windows 上 pnpm 就这么写）', () => {
  const manifest = { dependencies: { a: 'file:D:\\old\\a-1.0.0.tgz' } };
  const { repaired } = planFileSpecRepair(manifest, () => false, (base) => (base === 'a-1.0.0.tgz' ? 'X' : null));
  assert.deepStrictEqual(repaired, ['a']);
});

test('planFileSpecRepair: 没有 dependencies 时原样返回', () => {
  const m = {};
  assert.strictEqual(planFileSpecRepair(m, () => false, () => null).manifest, m);
});
