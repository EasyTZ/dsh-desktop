'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareActivationPatch } = require('../src/shared/activation-patch');

// 停用 overlay 的唯一写者。它同时服务两条路径（DshService 的正式启动、KernelUpdater
// 的热更新自检），所以它判错就是两处一起判错：多停一个插件用户看到功能凭空消失，
// 少停一个则「在市场里点了停用」不生效。

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesktop-activation-'));
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
}

/** 造一个装了 @x/a、@x/b 两个 profile 层插件的假 profile 目录。 */
function fakeProfile() {
  const dir = tmpdir();
  write(path.join(dir, 'package.json'), {
    dependencies: { '@x/a': '1.0.0', '@x/b': '1.0.0' },
    dsh: { profile: { bundles: ['@x/a', '@x/b'] } },
  });
  for (const [pkg, id] of [['@x/a', 'dsdesktop-a'], ['@x/b', 'dsdesktop-b']]) {
    const pkgDir = path.join(dir, 'node_modules', ...pkg.split('/'));
    write(path.join(pkgDir, 'package.json'), { dsh: { bundle: { patch: './cordis.patch.yml' } } });
    write(path.join(pkgDir, 'cordis.patch.yml'), `- id: ${id}\n`);
  }
  return dir;
}

test('prepareActivationPatch: 只停用用户显式关掉的那个', () => {
  const profileDir = fakeProfile();
  const out = tmpdir();
  const statePath = path.join(out, 'plugin-state.json');
  write(statePath, { 'dsdesktop-a': false });

  const patchPath = prepareActivationPatch({
    patchPath: path.join(out, 'desktop.patch.yml'), statePath, profileDir,
  });
  const text = fs.readFileSync(patchPath, 'utf8');
  assert.match(text, /dsdesktop-a/);
  assert.doesNotMatch(text, /dsdesktop-b/);
});

test('prepareActivationPatch: 安全模式停用 exclude 以外的全部，不看用户状态', () => {
  const profileDir = fakeProfile();
  const out = tmpdir();
  // 状态里把 a 标为「启用」：安全模式必须无视它，否则逃生舱会被用户状态左右。
  const statePath = path.join(out, 'plugin-state.json');
  write(statePath, { 'dsdesktop-a': true });

  const patchPath = prepareActivationPatch({
    patchPath: path.join(out, 'desktop.patch.yml'), statePath, profileDir,
    safeMode: true, exclude: ['@x/b'],
  });
  const text = fs.readFileSync(patchPath, 'utf8');
  assert.match(text, /dsdesktop-a/);
  assert.doesNotMatch(text, /dsdesktop-b/);
});

test('prepareActivationPatch: 一个都不停用时也要落一个 []（空文件会让 dsh 解析报错）', () => {
  const profileDir = fakeProfile();
  const out = tmpdir();

  const patchPath = prepareActivationPatch({
    patchPath: path.join(out, 'desktop.patch.yml'), statePath: null, profileDir,
  });
  // 这是绝大多数次启动的常态，不是边界情况。
  assert.ok(fs.readFileSync(patchPath, 'utf8').endsWith('[]\n'));
});
