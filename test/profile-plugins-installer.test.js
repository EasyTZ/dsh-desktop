'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ensurePnpmShim, withPnpmOnPath, resolveDshHome, profileDir,
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
