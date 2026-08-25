'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadPluginManifest, readPluginPackage, installPlugin, registerDependency,
  renderActivationPatch, writeActivationPatch,
} = require('../src/shared/plugin-install');

// 插件安装必须做满两件事：拷贝源码 / 登记依赖。漏掉登记时 dsh 运行期的
// healProfilesModuleFallback 建不出解析软链，内核 import 插件即 ERR_MODULE_NOT_FOUND
// 秒退，桌面端表现为黑屏 —— 这正是 v1.1.1 补丁版本的事故原因。这里把契约钉死。
//
// 激活改由 `--patch` overlay 提供，对应 renderActivationPatch / writeActivationPatch。

const PKG = '@deepseek-ai/dsh-ui-test';
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

  const dst = path.join(f.nodeModulesDir, '@deepseek-ai', 'dsh-ui-test');
  assert.ok(fs.existsSync(path.join(dst, 'lib', 'index.js')), '插件源码应被拷贝');
  assert.strictEqual(readDeps(f.manifestPath)[PKG], '1.2.3', '漏这步就是黑屏');

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

test('registerDependency: 已存在的版本不被覆盖', () => {
  const f = makeFixture();
  fs.writeFileSync(f.manifestPath,
    JSON.stringify({ name: 'dsh', dependencies: { [PKG]: '9.9.9' } }, null, 2));
  const wrote = registerDependency(f.manifestPath, PKG, '1.2.3');
  assert.strictEqual(wrote, false);
  assert.strictEqual(readDeps(f.manifestPath)[PKG], '9.9.9');
  fs.rmSync(f.root, { recursive: true, force: true });
});

// ── 激活 overlay ────────────────────────────────────────────────────────────

test('renderActivationPatch: 每个插件一条 insert 条目', () => {
  const f = makeFixture();
  const pluginsDir = path.dirname(f.pluginSrcDir);
  const text = renderActivationPatch(pluginsDir, [
    { srcDir: path.basename(f.pluginSrcDir), entryId: 'mytest' },
  ]);
  assert.match(text, /^- insert:$/m);
  assert.match(text, /- id: mytest/);
  assert.match(text, new RegExp(`name: '${PKG.replace('/', '\\/')}'`));
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('renderActivationPatch: 空清单产出合法的空 patch 列表', () => {
  // patch 文件必须是合法 YAML 数组，空着也不能是空文件 —— 否则 dsh 解析报错。
  assert.match(renderActivationPatch('/nowhere', []), /^\[\]$/m);
});

test('writeActivationPatch: 内容确定且可重复写', () => {
  const f = makeFixture();
  const pluginsDir = path.dirname(f.pluginSrcDir);
  const out = path.join(f.root, 'nested', 'desktop.patch.yml');
  const plugins = [{ srcDir: path.basename(f.pluginSrcDir), entryId: 'mytest' }];
  writeActivationPatch(out, pluginsDir, plugins);
  const first = fs.readFileSync(out, 'utf8');
  writeActivationPatch(out, pluginsDir, plugins);
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
    assert.ok(p.srcDir, 'srcDir 必填');
    assert.ok(p.entryId, 'entryId 必填');
  }
});
