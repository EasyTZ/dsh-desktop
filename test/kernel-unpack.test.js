'use strict';

// 内置 ustar 解包器的单测。
//
// 它是「系统 tar 不可用」时的唯一退路，而那条路径平时永远不跑 —— 没有测试的话，
// 等它真被用到时才发现写错了，用户看到的就是一个装不上的包。这里用真实的
// tar 生成归档（跟打包期同一条命令、同一个 --format=ustar），再用我们的解包器
// 还原，逐字节比对。

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractUstar, needsUnpack, resolveTarCommand, ARCHIVE_NAME } = require('../src/shared/kernel-unpack');
const { NODE_BIN } = require('../src/shared/kernel-paths');

/** 造一棵覆盖各种边界的小树。 */
function makeSourceTree(root) {
  const files = new Map();
  const put = (rel, content) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    files.set(rel.replace(/\\/g, '/'), content);
  };

  put('node.exe', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0xff, 0x00]));      // 二进制
  put('runtime/empty.txt', Buffer.alloc(0));                                // 空文件
  put('runtime/exact-block.bin', Buffer.alloc(512, 0x41));                  // 正好一个块，无补齐
  put('runtime/just-over.bin', Buffer.alloc(513, 0x42));                    // 跨块，要补齐 511 字节
  put('runtime/中文名 with space.txt', Buffer.from('中文内容\n', 'utf8'));   // 非 ASCII + 空格
  // 超过 100 字符的路径：ustar 必须靠 prefix 字段拆分，这是最容易写错的一条
  const deep = 'runtime/node_modules/@deepseek-ai/dsh/node_modules/@opentelemetry/'
    + 'otlp-transformer/node_modules/@opentelemetry/resources/build/esnext/detectors/index.js';
  assert.ok(deep.length > 100, '这条用例的意义就在于路径超过 100 字符');
  put(deep, Buffer.from('export const x = 1;\n'));
  return files;
}

test('内置解包器：还原出的文件与源逐字节一致（含超长路径 / 空文件 / 块边界）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unpack-'));
  const src = path.join(tmp, 'src');
  const out = path.join(tmp, 'out');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  try {
    const expected = makeSourceTree(src);
    const archive = path.join(tmp, ARCHIVE_NAME);
    // 跟 scripts/pack-kernel.mjs 同一条命令，Windows 上额外加 hdrcharset：那边的
    // bsdtar 在 ustar 下默认按**系统 ANSI 代码页**写非 ASCII 文件名，这里要验的是
    // 解包器对 UTF-8 名字的处理（真实内核树全是 ASCII 路径，pack-kernel 里有断言
    // 守着）。
    //
    // **只在 win32 加**：`--options` 是 bsdtar/libarchive 专属参数，Linux 上
    // `resolveTarCommand()` 落到 PATH 里的 GNU tar，它不认这个参数、直接报
    // `unrecognized option '--options'`，整个用例就挂了（实测 openEuler 的
    // GNU tar 1.34）。而这个参数本来就是为了绕过 Windows 那个代码页行为才加的
    // —— 别的平台的 tar 按进程 locale 写文件名，本来就是 UTF-8，不需要声明。
    const tarArgs = ['-cf', archive, '--format=ustar'];
    if (process.platform === 'win32') tarArgs.push('--options', 'hdrcharset=UTF-8');
    tarArgs.push('-C', src, '.');
    execFileSync(resolveTarCommand(), tarArgs, { windowsHide: true });

    await extractUstar(archive, out);

    for (const [rel, content] of expected) {
      const got = fs.readFileSync(path.join(out, rel));
      assert.deepStrictEqual(got, content, `内容不一致：${rel}`);
    }
    // 反向也查一遍：不该多出文件
    const seen = [];
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else seen.push(rel);
      }
    };
    walk(out, '');
    assert.strictEqual(seen.length, expected.size, `文件数不一致：${seen.join(', ')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('内置解包器：拒绝越界路径（tar 穿越）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unpack-evil-'));
  const out = path.join(tmp, 'out');
  fs.mkdirSync(out, { recursive: true });
  try {
    // 手搓一个头指向 ../escaped.txt 的归档：正常的 tar 不会生成这种条目，
    // 但解包器不能假设归档一定是我们自己造的。
    const header = Buffer.alloc(512, 0);
    header.write('../escaped.txt', 0, 'utf8');            // name
    header.write('000644 \0', 100, 'utf8');               // mode
    header.write('00000000000\0', 124, 'utf8');           // size = 0
    header[156] = 0x30;                                    // typeflag '0'
    header.write('ustar\0', 257, 'utf8');
    header.write('00', 263, 'utf8');
    // checksum：ustar 规定先把校验和字段填空格再累加
    header.write('        ', 148, 'utf8');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');

    const archive = path.join(tmp, 'evil.tar');
    fs.writeFileSync(archive, Buffer.concat([header, Buffer.alloc(1024, 0)]));

    await assert.rejects(() => extractUstar(archive, out), /越界路径/);
    assert.strictEqual(fs.existsSync(path.join(tmp, 'escaped.txt')), false, '不能写到目标目录外');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * 手搓一个只含单个普通文件的 ustar 归档。
 *
 * mode 用**字符串**传而不是数字：要能造出「字段全空」这种真实 tar 不会产出、但
 * 兜底解包器必须扛得住的畸形输入（见下面 mode=0 那个用例）。
 * @param {string} dir 归档落盘目录
 * @param {{name: string, content: Buffer, modeField?: string}} entry
 */
function makeUstarArchive(dir, { name, content, modeField }) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 'utf8');                                                  // name
  if (modeField) header.write(modeField, 100, 'utf8');                            // mode
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'utf8'); // size
  header[156] = 0x30;                                                             // typeflag '0'
  header.write('ustar\0', 257, 'utf8');
  header.write('00', 263, 'utf8');
  // 算校验和时 checksum 字段本身按 8 个空格计。
  header.write('        ', 148, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');

  const padding = Buffer.alloc(content.length % 512 === 0 ? 0 : 512 - (content.length % 512), 0);
  const archive = path.join(dir, `${name}.tar`);
  // 末尾两个全 0 块 = 归档结束标记。
  fs.writeFileSync(archive, Buffer.concat([header, content, padding, Buffer.alloc(1024, 0)]));
  return archive;
}

test('内置解包器：保留 ustar 头里的执行位（真 bug：Windows 上一直没读这个字段）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unpack-mode-'));
  const out = path.join(tmp, 'out');
  fs.mkdirSync(out, { recursive: true });
  try {
    const content = Buffer.from('#!/bin/sh\necho hi\n');
    // 真实内核树里 node / rg 就是 0755，而 fsp.open(dest, 'w') 给的是 umask 权限
    // （通常 0644）。不 chmod 就少执行位，POSIX 上内核直接起不来。
    const archive = makeUstarArchive(tmp, { name: 'exec-me', content, modeField: '000755 \0' });

    await extractUstar(archive, out);

    const dest = path.join(out, 'exec-me');
    assert.deepStrictEqual(fs.readFileSync(dest), content);
    if (process.platform === 'win32') {
      // win32 上 chmod 被刻意跳过（那边只能切只读位，帮不上忙还会误伤 0444 条目），
      // 这里只能确认解包本身没被搞炸。执行位是否真的保留留给 Linux CI 判定。
      assert.ok(fs.existsSync(dest));
    } else {
      const mode = fs.statSync(dest).mode & 0o777;
      assert.strictEqual(mode, 0o755, `执行位应被保留，实际 ${mode.toString(8)}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('内置解包器：mode 字段读不出来时不 chmod（chmod 0 会让文件谁都读不了）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unpack-mode0-'));
  const out = path.join(tmp, 'out');
  fs.mkdirSync(out, { recursive: true });
  try {
    const content = Buffer.from('data\n');
    // mode 字段留空 → readOctal 返回 0。真实 tar 不会这么写，但兜底解包器存在的
    // 理由就是应对意外归档；照着 0 去 chmod 会把文件权限抹成 000，内核换一种方式
    // 坏掉、而且报错完全指不到解包这一步。
    const archive = makeUstarArchive(tmp, { name: 'no-mode', content });

    await extractUstar(archive, out);

    const dest = path.join(out, 'no-mode');
    // 关键断言：还读得出来。权限具体是多少无所谓（取决于 umask），不能是 000。
    assert.deepStrictEqual(fs.readFileSync(dest), content);
    if (process.platform !== 'win32') {
      assert.notStrictEqual(fs.statSync(dest).mode & 0o777, 0, '权限被抹成 000 了');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('needsUnpack：有归档且内核不完整才要解包', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-needs-'));
  try {
    assert.strictEqual(needsUnpack(tmp), false, '什么都没有时不该解包');
    fs.writeFileSync(path.join(tmp, ARCHIVE_NAME), 'x');
    assert.strictEqual(needsUnpack(tmp), true, '有归档、内核不完整 → 要解包');
    // 补齐成一个「完整内核」的样子（node 可执行文件 + bin.js），归档就该被忽略
    fs.writeFileSync(path.join(tmp, NODE_BIN), 'x');
    const binDir = path.join(tmp, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'bin.js'), 'x');
    assert.strictEqual(needsUnpack(tmp), false, '内核已完整 → 不该重复解包');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
