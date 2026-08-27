'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadPluginManifest, readPluginPackage, installPlugin, registerDependency,
  renderActivationPatch, writeActivationPatch, writeSafeModePatch, resolvePluginSrcDir,
  cleanupLegacyPlugins, PLUGIN_LEDGER_KEY,
} = require('../src/shared/plugin-install');

// 插件安装必须做满两件事：拷贝源码 / 登记依赖。漏掉登记时 dsh 运行期的
// healProfilesModuleFallback 建不出解析软链，内核 import 插件即 ERR_MODULE_NOT_FOUND
// 秒退，桌面端表现为黑屏 —— 这正是 v1.1.1 补丁版本的事故原因。这里把契约钉死。
//
// 激活改由 `--patch` overlay 提供（renderActivationPatch / writeActivationPatch），
// 且只包含「用户没关掉的」插件 —— 用户开关状态覆盖清单默认值（enabled 字段，
// 缺省 true），合并逻辑在 src/shared/plugin-state.js。

const PKG = 'dsh-ui-test';
const silent = { log() {}, warn() {} };

/** 造一套「插件源码 + 目标 dsh 安装目录」的临时现场。 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-test-'));
  const pluginSrcDir = path.join(root, 'plugin-src');
  fs.mkdirSync(path.join(pluginSrcDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pluginSrcDir, 'package.json'),
    JSON.stringify({ name: PKG, version: '1.2.3' }, null, 2));
  fs.writeFileSync(path.join(pluginSrcDir, 'lib', 'index.js'), '// plugin entry\n');

  const target = path.join(root, 'target');
  const nodeModulesDir = path.join(target, 'node_modules');
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  const manifestPath = path.join(target, 'package.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ name: 'dsh', dependencies: {} }, null, 2));

  return { root, pluginSrcDir, nodeModulesDir, manifestPath };
}

const readDeps = (p) => JSON.parse(fs.readFileSync(p, 'utf8')).dependencies;

test('installPlugin: 拷贝 + 登记依赖，两件事一次做满', () => {
  const f = makeFixture();
  installPlugin({ ...f, logger: silent });

  const dst = path.join(f.nodeModulesDir, PKG);
  assert.ok(fs.existsSync(path.join(dst, 'lib', 'index.js')), '插件源码应被拷贝');
  assert.strictEqual(readDeps(f.manifestPath)[PKG], '1.2.3', '漏这步就是黑屏');

  fs.rmSync(f.root, { recursive: true, force: true });
});

test('installPlugin: 清单包名与插件 package.json 的 name 不一致时报错', () => {
  // 激活条目的 name 来自清单、模块来自插件源码——两边不一致等于激活一个不存在
  // 的模块，内核 boot 时秒退。必须在装的时候就拦下，而不是让用户看黑屏。
  const f = makeFixture();
  assert.throws(
    () => installPlugin({ ...f, expectedName: 'another-name', logger: silent }),
    /不一致/,
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('installPlugin: 不再改任何 bundle patch', () => {
  // 装插件是纯粹的「放进依赖树」，激活是启动参数的事。这条防的是有人手滑把
  // 激活逻辑挪回来 —— 那会让发行包重新被篡改，并与 overlay 撞出 duplicate id。
  const f = makeFixture();
  installPlugin({ ...f, logger: silent });
  const stray = fs.readdirSync(f.nodeModulesDir, { recursive: true })
    .filter((p) => String(p).endsWith('cordis.patch.yml'));
  assert.deepStrictEqual(stray, [], 'installPlugin 不该产出或触碰 patch 文件');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('installPlugin: 幂等，重复执行结果一致', () => {
  const f = makeFixture();
  installPlugin({ ...f, logger: silent });
  installPlugin({ ...f, logger: silent });
  assert.strictEqual(readDeps(f.manifestPath)[PKG], '1.2.3');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('registerDependency: 登记跟着实际源码走，旧号要被改写', () => {
  // 这条曾经断言的是反过来的「已存在就不覆盖」。那是错的：copyPluginSource 每次
  // 都把源码覆盖成最新的，登记却停在旧号，全局 dsh 的 package.json 就会长期写着
  // 一个和磁盘上实际内容对不上的版本。运行时不读这个号（healProfilesModuleFallback
  // 只看 key）所以不会出错，但排查问题时第一眼看的就是它 —— 会骗人的状态比没有更糟。
  const f = makeFixture();
  fs.writeFileSync(f.manifestPath,
    JSON.stringify({ name: 'dsh', dependencies: { [PKG]: '9.9.9' } }, null, 2));
  const wrote = registerDependency(f.manifestPath, PKG, '1.2.3');
  assert.strictEqual(wrote, true);
  assert.strictEqual(readDeps(f.manifestPath)[PKG], '1.2.3', '登记必须反映实际装进去的那份');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('cleanupLegacyPlugins: 有账本之后，第三方 dsh-* 插件绝不能被误删', () => {
  // 这是把「`dsh-` 前缀启发式」换成「记账」要买的唯一东西。旧判据的理由是「上游
  // 的包全在 @deepseek-ai scope 下」—— 对上游成立，对**用户**不成立：dsh 插件生态
  // 起来之后，用户完全可能自己 `dsh plugin add` 一个第三方 `dsh-foo` 到同一个全局
  // dsh 里。我们自己就在发四个 dsh- 开头的插件，等于亲手把这个命名空间做热了。
  const f = makeFixture();
  const nm = path.join(f.root, 'node_modules');
  const manifestPath = path.join(f.root, 'package.json');
  const mk = (name) => {
    const dir = path.join(nm, ...name.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  };
  ['dsh-git', 'dsh-dropped', 'dsh-foo'].forEach(mk);
  fs.writeFileSync(manifestPath, JSON.stringify({
    dependencies: {
      'dsh-git': '0.2.2',      // 清单里有 → 留
      'dsh-dropped': '0.1.0',  // 账本上有、清单里没有 → 清
      'dsh-foo': '1.0.0',      // 用户自己装的第三方 → 账本上没有 → 绝不能碰
    },
    // 账本：我们只装过这两个
    [PLUGIN_LEDGER_KEY]: ['dsh-git', 'dsh-dropped'],
  }, null, 2));

  const removed = cleanupLegacyPlugins({
    nodeModulesDir: nm,
    manifestPath,
    plugins: [{ packageName: 'dsh-git' }],
    logger: { log() {}, warn() {} },
  });

  assert.deepStrictEqual(removed, ['dsh-dropped']);
  assert.ok(fs.existsSync(path.join(nm, 'dsh-foo')), '第三方 dsh-* 插件必须原样保留');
  const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok('dsh-foo' in after.dependencies, '第三方插件的登记也不能摘');
  assert.deepStrictEqual(after[PLUGIN_LEDGER_KEY], ['dsh-git'], '账本要更新成当前清单');

  fs.rmSync(f.root, { recursive: true, force: true });
});

// ── 源码解析（拆仓后：plugins/ 与 node_modules/ 两处候选）──────────────────

test('resolvePluginSrcDir: 优先 plugins/，其次 node_modules/，都没有则报错', () => {
  const f = makeFixture();
  // 把「插件源码」直接摆进一个 node_modules 候选目录。
  const nm = path.join(f.root, 'node_modules');
  fs.mkdirSync(path.join(nm, PKG), { recursive: true });
  fs.copyFileSync(path.join(f.pluginSrcDir, 'package.json'), path.join(nm, PKG, 'package.json'));

  const hit = resolvePluginSrcDir({ nodeModulesDir: nm, packageName: PKG });
  assert.strictEqual(hit, path.join(nm, PKG), '没有 plugins/ 候选时应命中 node_modules');

  // plugins/ 优先于 node_modules/。
  const pd = path.join(f.root, 'plugins');
  fs.mkdirSync(path.join(pd, PKG), { recursive: true });
  fs.copyFileSync(path.join(f.pluginSrcDir, 'package.json'), path.join(pd, PKG, 'package.json'));
  assert.strictEqual(
    resolvePluginSrcDir({ pluginsDir: pd, nodeModulesDir: nm, packageName: PKG }),
    path.join(pd, PKG),
    'plugins/ 里的桌面专属副本应优先',
  );

  assert.throws(() => resolvePluginSrcDir({ packageName: 'no-such-plugin' }), /未找到插件源码/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

// ── 激活 overlay ────────────────────────────────────────────────────────────

test('renderActivationPatch: 每个插件一条 insert 条目', () => {
  const text = renderActivationPatch([{ packageName: PKG, entryId: 'mytest' }]);
  assert.match(text, /^- insert:$/m);
  assert.match(text, /- id: mytest/);
  assert.match(text, new RegExp(`name: '${PKG}'`));
});

test('renderActivationPatch: 空清单产出合法的空 patch 列表', () => {
  // patch 文件必须是合法 YAML 数组，空着也不能是空文件 —— 否则 dsh 解析报错。
  assert.match(renderActivationPatch([]), /^\[\]$/m);
});

test('renderActivationPatch: 被用户关掉的插件不出现在 overlay 里', () => {
  const plugins = [
    { packageName: 'dsh-git', entryId: 'git' },
    { packageName: 'dsh-ui-balance', entryId: 'balance' },
  ];
  const text = renderActivationPatch(plugins, { git: false });
  assert.ok(!text.includes('id: git'), '关掉的插件不该生成 insert 条目');
  assert.ok(text.includes('id: balance'), '没动过的插件照常激活');
});

test('renderActivationPatch: 全部关掉时仍是合法 YAML（空列表）', () => {
  // 极端情况：用户把每个插件都关了。overlay 不能变成空文件或残缺 YAML。
  const plugins = [
    { packageName: 'dsh-git', entryId: 'git' },
    { packageName: 'dsh-ui-balance', entryId: 'balance' },
  ];
  const text = renderActivationPatch(plugins, { git: false, balance: false });
  assert.match(text, /^\[\]$/m, '全关时输出合法空列表');
  assert.ok(!text.includes('- insert:'), '全关时不该再有 insert 块');
});

test('renderActivationPatch: 用户状态覆盖清单默认值（enabled 缺省视为 true）', () => {
  const plugins = [
    { packageName: 'dsh-git', entryId: 'git' },                       // 缺省 → 默认开
    { packageName: 'dsh-x', entryId: 'x', enabled: false },           // 清单默认关
  ];
  const text = renderActivationPatch(plugins, { git: false, x: true });
  assert.ok(!text.includes('id: git'), '用户关掉覆盖缺省开启');
  assert.ok(text.includes('id: x'), '用户打开覆盖清单默认关闭');
});

test('writeActivationPatch: 内容确定且可重复写', () => {
  const f = makeFixture();
  const out = path.join(f.root, 'nested', 'desktop.patch.yml');
  const plugins = [{ packageName: PKG, entryId: 'mytest' }];
  writeActivationPatch(out, plugins);
  const first = fs.readFileSync(out, 'utf8');
  writeActivationPatch(out, plugins, { mytest: true });
  assert.strictEqual(fs.readFileSync(out, 'utf8'), first, '同一份内容，两个写者不能分叉');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('readPluginPackage: 缺 name 字段要报错', () => {
  const f = makeFixture();
  fs.writeFileSync(path.join(f.pluginSrcDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  assert.throws(() => readPluginPackage(f.pluginSrcDir), /name/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('loadPluginManifest: 读到仓库真实清单且字段齐全', () => {
  const plugins = loadPluginManifest(path.join(__dirname, '..', 'plugins'));
  assert.ok(plugins.length > 0);
  for (const p of plugins) {
    assert.ok(p.packageName, 'packageName 必填');
    assert.ok(p.entryId, 'entryId 必填');
  }
});

test('清单里的 entryId 一律带 dsdesktop- 前缀，避免与上游 bundle 条目撞车', () => {
  // `- insert:` 不去重：我们的 entryId 若与上游 bundle 里某条同名，cordis loader
  // 会抛 duplicate loader entry id 让内核**秒退**（v1.1.1 同类事故）。上游的 id
  // 大量是 `git` / `session` / `settings` 这种通用词，而内核会自己热更新到新版本
  // —— 撞车只是时间问题，且发生在用户机器上、表现为黑屏。
  //
  // 前缀取 `dsdesktop-` 而非 `desktop-`：上游已有 web / tui / headless 三个
  // surface，将来真加一个 desktop surface 时 `desktop-` 反而可能被它用掉。
  const plugins = loadPluginManifest(path.join(__dirname, '..', 'plugins'));
  for (const p of plugins) {
    assert.ok(
      p.entryId.startsWith('dsdesktop-'),
      `entryId 必须以 dsdesktop- 开头，实际为 ${p.entryId}（见本用例注释）`,
    );
  }
});

/** 把一组条目写成临时 plugins.json，返回它所在的目录。 */
function manifestDir(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-manifest-test-'));
  fs.writeFileSync(path.join(dir, 'plugins.json'), JSON.stringify(entries));
  return dir;
}

test('loadPluginManifest: 重复 entryId 必须报错', () => {
  // 和「与上游 bundle 撞名」是同一种事故，只是撞的是自己人：`- insert:` 不去重，
  // cordis loader 见到重复 id 直接抛 duplicate loader entry id，内核秒退、桌面端
  // 黑屏。前缀规则挡的是对外撞车，这条挡的是清单内部撞车。
  const dir = manifestDir([
    { packageName: 'dsh-a', entryId: 'dsdesktop-x' },
    { packageName: 'dsh-b', entryId: 'dsdesktop-x' },
  ]);
  assert.throws(() => loadPluginManifest(dir), /重复的 entryId/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadPluginManifest: 重复 packageName 必须报错', () => {
  const dir = manifestDir([
    { packageName: 'dsh-a', entryId: 'dsdesktop-a' },
    { packageName: 'dsh-a', entryId: 'dsdesktop-a2' },
  ]);
  assert.throws(() => loadPluginManifest(dir), /重复的 packageName/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadPluginManifest: packageName 必须是合法包名（路径护栏）', () => {
  // packageName 会被 split('/') 摊进 path.join，再交给递归 rmSync —— 形状不校验
  // 就等于把「删哪个目录」的决定权交给清单文本。
  for (const bad of ['../evil', 'a/../../b', 'C:\\evil', './x', 'UPPER']) {
    const dir = manifestDir([{ packageName: bad, entryId: 'dsdesktop-x' }]);
    assert.throws(() => loadPluginManifest(dir), /不是合法包名/, `应拒绝 ${bad}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginManifest: scoped 包名照常放行', () => {
  const dir = manifestDir([{ packageName: '@scope/dsh-a', entryId: 'dsdesktop-a' }]);
  assert.strictEqual(loadPluginManifest(dir).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('registerDependency: 版本变了要改写登记，不能停在旧号', () => {
  // 源码每次都被 copyPluginSource 覆盖成最新的，登记若跳过就会长期写着旧版本号，
  // 排查问题时第一眼看到的就是这个骗人的号。
  const f = makeFixture();
  assert.strictEqual(registerDependency(f.manifestPath, PKG, '1.0.0'), true);
  assert.strictEqual(registerDependency(f.manifestPath, PKG, '1.0.0'), false, '同版本仍然幂等');
  assert.strictEqual(registerDependency(f.manifestPath, PKG, '2.0.0'), true, '版本变了必须改写');
  assert.strictEqual(readDeps(f.manifestPath)[PKG], '2.0.0');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('cleanupLegacyPlugins: 清掉改名遗留，保留清单内的与上游的', () => {
  const f = makeFixture();
  const nm = path.join(f.root, 'node_modules');
  const manifestPath = path.join(f.root, 'package.json');
  const mk = (name) => {
    const dir = path.join(nm, ...name.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  };
  ['@deepseek-ai/dsh-git', 'dsh-git', 'dsh-plugin-manager', 'dsh-dropped',
    '@deepseek-ai/dsh-workspace', 'commander'].forEach(mk);
  fs.writeFileSync(manifestPath, JSON.stringify({
    dependencies: {
      '@deepseek-ai/dsh-git': '0.1.0',        // 改名前的遗留 → 清
      'dsh-git': '0.1.1',                     // 清单里有 → 留
      'dsh-plugin-manager': '0.1.0',          // 清单里有 → 留
      'dsh-dropped': '0.1.0',                 // 我们装过但已下架 → 清
      '@deepseek-ai/dsh-workspace': '^0.1.1', // 上游的 → 绝不能碰
      commander: '^15.0.0',                   // 上游的 → 绝不能碰
    },
  }, null, 2));

  const removed = cleanupLegacyPlugins({
    nodeModulesDir: nm,
    manifestPath,
    plugins: [{ packageName: 'dsh-git' }, { packageName: 'dsh-plugin-manager' }],
    logger: { log() {}, warn() {} },
  });

  assert.deepStrictEqual(removed.sort(), ['@deepseek-ai/dsh-git', 'dsh-dropped']);
  const deps = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).dependencies;
  assert.deepStrictEqual(Object.keys(deps).sort(),
    ['@deepseek-ai/dsh-workspace', 'commander', 'dsh-git', 'dsh-plugin-manager']);
  assert.ok(!fs.existsSync(path.join(nm, '@deepseek-ai', 'dsh-git')), '遗留目录要删掉');
  assert.ok(fs.existsSync(path.join(nm, 'dsh-git')), '清单内的不能删');
  // 误删上游的包 = 内核起不来，这两条是这个函数最重要的护栏。
  assert.ok(fs.existsSync(path.join(nm, '@deepseek-ai', 'dsh-workspace')), '上游 scoped 包不能碰');
  assert.ok(fs.existsSync(path.join(nm, 'commander')), '上游非 scoped 包不能碰');

  // 迁移那一趟必须留下账本，否则下次又走启发式。
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8'))[PLUGIN_LEDGER_KEY],
    ['dsh-git', 'dsh-plugin-manager'],
  );

  // 幂等：再跑一次没有可清的，且不该改写 package.json。
  assert.deepStrictEqual(cleanupLegacyPlugins({
    nodeModulesDir: nm, manifestPath,
    plugins: [{ packageName: 'dsh-git' }, { packageName: 'dsh-plugin-manager' }],
    logger: { log() {}, warn() {} },
  }), []);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('cleanupLegacyPlugins: 登记已摘、目录还在的孤儿也要清掉', () => {
  // 真实踩到过：清理的第一版只遍历 dependencies，而那次运行 deps 摘对了、目录
  // 却因为传错了 node_modules 没删成 —— 再跑一次就永远找不到它们了。所以候选
  // 必须同时来自「登记」和「目录」两处。
  const f = makeFixture();
  const nm = path.join(f.root, 'node_modules');
  const manifestPath = path.join(f.root, 'package.json');
  fs.mkdirSync(path.join(nm, '@deepseek-ai', 'dsh-git'), { recursive: true });
  fs.mkdirSync(path.join(nm, 'dsh-dropped'), { recursive: true });
  fs.mkdirSync(path.join(nm, '@deepseek-ai', 'dsh-workspace'), { recursive: true });
  // dependencies 里干干净净——只剩目录是孤儿。
  fs.writeFileSync(manifestPath, JSON.stringify({ dependencies: { commander: '^15.0.0' } }, null, 2));

  const removed = cleanupLegacyPlugins({
    nodeModulesDir: nm, manifestPath, plugins: [], logger: { log() {}, warn() {} },
  });
  assert.deepStrictEqual(removed.sort(), ['@deepseek-ai/dsh-git', 'dsh-dropped']);
  assert.ok(!fs.existsSync(path.join(nm, '@deepseek-ai', 'dsh-git')));
  assert.ok(!fs.existsSync(path.join(nm, 'dsh-dropped')));
  assert.ok(fs.existsSync(path.join(nm, '@deepseek-ai', 'dsh-workspace')), '上游的仍不能碰');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('writeSafeModePatch: 只留 safeMode 插件，且不受用户状态影响', () => {
  const f = makeFixture();
  const out = path.join(f.root, 'safe.patch.yml');
  const plugins = [
    { packageName: 'dsh-plugin-manager', entryId: 'dsdesktop-plugin-manager', safeMode: true },
    { packageName: 'dsh-git', entryId: 'dsdesktop-git' },
  ];
  writeSafeModePatch(out, plugins);
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /- id: dsdesktop-plugin-manager/, '恢复入口必须在');
  assert.ok(!text.includes('dsdesktop-git'), '非 safeMode 插件不该出现');

  // 关键性质：安全模式是在「用户状态可能有问题」时用的逃生舱 —— 哪怕状态文件
  // 里把恢复入口关掉了（手改坏 / 损坏），也必须进得去。这条防的是将来有人
  // 「顺手」把 userState 透传进来。
  writeSafeModePatch(out, plugins.map((p) => ({ ...p, enabled: false })));
  assert.match(fs.readFileSync(out, 'utf8'), /- id: dsdesktop-plugin-manager/,
    '清单默认关也不能挡住安全模式');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('清单里必须至少有一个 safeMode 插件，否则安全模式进去是个空壳', () => {
  // 安全模式只加载 safeMode: true 的插件。一个都没有的话，用户点了「安全模式
  // 启动」会进到一个没有任何恢复入口的界面 —— 逃生舱变成了死路。当前扛这个
  // 角色的是插件管理面板（它自身也不可关，见 dsh-plugin-manager 的 self-locked）。
  const plugins = loadPluginManifest(path.join(__dirname, '..', 'plugins'));
  const recovery = plugins.filter((p) => p.safeMode === true);
  assert.ok(recovery.length > 0, '清单里至少要有一个 safeMode: true 的插件');
  assert.ok(
    recovery.some((p) => p.packageName === 'dsh-plugin-manager'),
    '插件管理面板必须留在安全模式里 —— 它是关掉出问题插件的唯一入口',
  );
});

test('loadPluginManifest: 字段缺失当场报错，不留给内核 boot 秒退', () => {
  const f = makeFixture();
  const badDir = path.join(f.root, 'bad');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'plugins.json'),
    JSON.stringify([{ entryId: 'x' }, { packageName: 'y' }], null, 2));
  assert.throws(() => loadPluginManifest(badDir), /packageName|entryId/);
  fs.rmSync(f.root, { recursive: true, force: true });
});
