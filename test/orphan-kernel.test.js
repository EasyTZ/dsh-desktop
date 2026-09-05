'use strict';

// 孤儿内核识别的单测。真正值得测的只有一件事：**什么时候敢下杀手**。
//
// 其余部分（读 /写 pid 文件）是薄薄的 IO 包装，且全都「失败即静默」，测了也只是
// 测 fs；而 `shouldKillOrphan` 是唯一有分支的地方，判错的后果是**杀掉一个无辜的
// 进程**——pid 会被系统回收再分配，这条判断就是防这个的。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  writeKernelPid, clearKernelPid, readKernelPid, shouldKillOrphan,
} = require('../src/shared/orphan-kernel');

const BIN = '/opt/app/resources/kernel/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js';
const record = { pid: 4242, binJs: BIN };

test('shouldKillOrphan: 命令行含记下的 bin.js 才动手', () => {
  assert.strictEqual(
    shouldKillOrphan(record, `/opt/app/resources/kernel/node ${BIN} web --port 0`), true,
    '就是我们那个内核，该杀',
  );
});

test('shouldKillOrphan: pid 被回收给了别的进程 → 绝不能杀', () => {
  // 这是这个函数存在的全部理由。进程活着 ≠ 还是我们那个内核。
  assert.strictEqual(shouldKillOrphan(record, '/usr/bin/postgres -D /var/lib/pgsql'), false);
  assert.strictEqual(shouldKillOrphan(record, 'node /home/me/some-other-project/server.js'), false);
});

test('shouldKillOrphan: 另一份安装的同名内核也不能杀', () => {
  // 同一台机器上可能同时装着别的位置的同一个应用（比如 AppImage 跑在 /tmp/.mount_xxx）。
  // 路径不同就不是我们记下的那个，一律不动。
  const other = '/tmp/.mount_AbCdEf/resources/kernel/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js';
  assert.strictEqual(shouldKillOrphan(record, `/tmp/.mount_AbCdEf/resources/kernel/node ${other} web`), false);
});

test('shouldKillOrphan: 拿不准一律不动手', () => {
  assert.strictEqual(shouldKillOrphan(record, null), false, '进程不在 / ps 读不到');
  assert.strictEqual(shouldKillOrphan(record, ''), false, '空命令行');
  assert.strictEqual(shouldKillOrphan(null, `node ${BIN}`), false, '没有记录');
});

test('readKernelPid: 写得进、读得回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-orphan-'));
  try {
    const file = path.join(dir, 'kernel.pid.json');
    assert.strictEqual(readKernelPid(file), null, '文件不存在 = 上次是善终的');

    writeKernelPid(file, record);
    assert.deepStrictEqual(readKernelPid(file), record);

    clearKernelPid(file);
    assert.strictEqual(readKernelPid(file), null, '清掉之后就该读不到');
    // 再清一次不该抛：stop() 可能被走到两次（崩溃恢复路径）。
    clearKernelPid(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readKernelPid: 内容坏掉时当作没有记录，不是抛异常', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-orphan-bad-'));
  try {
    const file = path.join(dir, 'kernel.pid.json');
    // 写到一半被断电、或是别的东西占了这个文件名 —— 一律「宁可漏杀」。
    for (const bad of ['', '{', 'null', '{"pid":0,"binJs":"/x"}', '{"pid":12}', '{"binJs":"/x"}',
      '{"pid":-1,"binJs":"/x"}', '{"pid":1.5,"binJs":"/x"}', '{"pid":12,"binJs":""}']) {
      fs.writeFileSync(file, bad);
      assert.strictEqual(readKernelPid(file), null, `坏内容应返回 null：${bad}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
