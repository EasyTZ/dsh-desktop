'use strict';

// 终端面板纯逻辑层（lib/pure.js）的单测。pure.js 是 ESM（插件包 type: module），
// 而本文件是 CommonJS（根包无 type 字段），所以用动态 import 一次性加载。
// pure.js 被这里 import 后会被 tsc 一并纳入检查 —— 它必须过 strictNullChecks。

const test = require('node:test');
const assert = require('node:assert');
const { before } = require('node:test');

let pure;
before(async () => {
  // 终端插件已拆仓（git 依赖 vendor 进 node_modules），路径跟着迁移。
  pure = await import('../node_modules/@easytz/dsh-terminal-panel/lib/pure.js');
});

const text = (line) => (line.segments.length ? line.segments.map((s) => s.t).join('') : '');

// ---------------------------------------------------------------------------
// [stderr] 分隔（dsh-shell readOutput 的事实：stdout/stderr 拼在一个串里）
// ---------------------------------------------------------------------------

test('[stderr] 分隔：正常拆成 out/err 两段', () => {
  const parts = pure.splitStderr('out line\n[stderr]\nerr line\n');
  assert.strictEqual(parts.length, 2);
  assert.deepStrictEqual(parts[0], { text: 'out line\n', stream: 'out' });
  assert.deepStrictEqual(parts[1], { text: 'err line\n', stream: 'err' });
});

test('[stderr] 分隔：delta 里只有 stderr（stdout 为空）', () => {
  const parts = pure.splitStderr('[stderr]\nerr line\n');
  assert.strictEqual(parts.length, 1);
  assert.deepStrictEqual(parts[0], { text: 'err line\n', stream: 'err' });
});

test('[stderr] 分隔：stdout 末尾无换行时上游插入的分隔换行不进 out 内容', () => {
  // readOutput 对「stdout 无换行 + stderr」返回 `out\n[stderr]\nerr`——
  // 分隔换行只让 [stderr] 成为独立行，out 段以它结尾（tail 是完整行）。
  const parts = pure.splitStderr('tail\n[stderr]\nerr');
  assert.deepStrictEqual(parts[0], { text: 'tail\n', stream: 'out' });
  assert.deepStrictEqual(parts[1], { text: 'err', stream: 'err' });
});

test('[stderr] 分隔：stdout 里出现假的 [stderr] 行时取最后一个', () => {
  const parts = pure.splitStderr('a\n[stderr]\nb\n[stderr]\nc');
  assert.deepStrictEqual(parts[0], { text: 'a\n[stderr]\nb\n', stream: 'out' });
  assert.deepStrictEqual(parts[1], { text: 'c', stream: 'err' });
});

test('[stderr] 分隔：没有标记时原样返回 out 段', () => {
  const parts = pure.splitStderr('just out');
  assert.strictEqual(parts.length, 1);
  assert.deepStrictEqual(parts[0], { text: 'just out', stream: 'out' });
});

test('行模型：stdout/stderr 段分别带 stream 标记，流切换时半行收尾', () => {
  const model = pure.createLineModel();
  model.push('o1\nhalf');
  let lines = model.take();
  assert.deepStrictEqual(lines.map(text), ['o1']); // half 还是半行
  model.push('[stderr]\ne1\n');
  lines = model.take();
  // 流切换把 out 半行收尾成完整行，err 段从新行开始
  assert.deepStrictEqual(lines.map(text), ['half', 'e1']);
  assert.deepStrictEqual(lines.map((l) => l.stream), ['out', 'err']);
});

// ---------------------------------------------------------------------------
// 哨兵（sentinel）：cwd / 退出码靠它带回来，然后从显示里剥掉
// ---------------------------------------------------------------------------

test('哨兵：bash 方言正常解析出 cwd + 退出码，且不进入显示', () => {
  const model = pure.createLineModel();
  model.push('hello\n\x1eDSHX0:/home/user\x1e\n');
  const lines = model.take();
  assert.deepStrictEqual(lines.map(text), ['hello']);
  assert.deepStrictEqual(model.getSentinel(), { code: 0, cwd: '/home/user' });
});

test('哨兵：pwsh 方言（Windows 路径含冒号）', () => {
  const model = pure.createLineModel();
  model.push('\x1eDSHX1:D:\\Coding\\dsDesktop\x1e\n');
  assert.deepStrictEqual(model.take(), []);
  assert.deepStrictEqual(model.getSentinel(), { code: 1, cwd: 'D:\\Coding\\dsDesktop' });
});

test('哨兵：被 delta 从中间切成两半，跨两次 push 拼接后解析', () => {
  const model = pure.createLineModel();
  model.push('out\n\x1eDS');
  assert.deepStrictEqual(model.take().map(text), ['out']);
  model.push('HX5:/tmp\x1e\n');
  assert.deepStrictEqual(model.take(), []);
  assert.deepStrictEqual(model.getSentinel(), { code: 5, cwd: '/tmp' });
});

test('哨兵：收尾 \x1e 被切断，下一次 delta 补齐', () => {
  const model = pure.createLineModel();
  model.push('\x1eDSHX3:/a/b'); // 只有起始 RS，没有收尾
  assert.deepStrictEqual(model.take(), []);
  assert.strictEqual(model.getSentinel(), null); // 还没闭合
  model.push('\x1e\n');
  assert.deepStrictEqual(model.take(), []);
  assert.deepStrictEqual(model.getSentinel(), { code: 3, cwd: '/a/b' });
});

test('哨兵：命令输出里混入 RS 字符（\x1e 后不是 DSHX）不吞内容', () => {
  const model = pure.createLineModel();
  model.push('\x1ehello\n');
  const lines = model.take();
  // \x1e 是控制字符丢弃，hello 正常显示
  assert.deepStrictEqual(lines.map(text), ['hello']);
  assert.strictEqual(model.getSentinel(), null);
});

test('哨兵：干扰的 \x1eD 前缀不影响后续真正的哨兵', () => {
  const model = pure.createLineModel();
  model.push('\x1eD');
  assert.deepStrictEqual(model.take(), []);
  model.push('SHX2:/real\x1e\n');
  assert.deepStrictEqual(model.take(), []);
  assert.deepStrictEqual(model.getSentinel(), { code: 2, cwd: '/real' });
});

test('哨兵：完全没有哨兵时返回 null（调用方保持旧 cwd、退回 proc.exitCode）', () => {
  const model = pure.createLineModel();
  model.push('plain output\n');
  assert.deepStrictEqual(model.take().map(text), ['plain output']);
  assert.strictEqual(model.getSentinel(), null);
});

test('哨兵：未闭合就进程结束（flush）时丢弃，不产生行', () => {
  const model = pure.createLineModel();
  model.push('x\n\x1eDSHX9:/unclosed'); // 只有起始 RS，进程死了没等到收尾
  model.flush();
  assert.deepStrictEqual(model.take().map(text), ['x']);
  assert.strictEqual(model.getSentinel(), null);
});

test('行模型：尾部半行在 flush 时收为完整行', () => {
  const model = pure.createLineModel();
  model.push('no newline');
  assert.deepStrictEqual(model.take(), []);
  model.flush();
  assert.deepStrictEqual(model.take().map(text), ['no newline']);
});

// ---------------------------------------------------------------------------
// \r 进度条 / CRLF / \t / 控制字符
// ---------------------------------------------------------------------------

test('\\r 进度条：同一行多次重写只产生一个 replaceLast 行', () => {
  const model = pure.createLineModel();
  model.push('abc\rdef\rghi\n');
  const lines = model.take();
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(text(lines[0]), 'ghi');
  assert.strictEqual(lines[0].replaceLast, true);
});

test('CRLF 归一：\\r\\n 是一个换行，不触发进度条重写', () => {
  const model = pure.createLineModel();
  model.push('abc\r\n');
  const lines = model.take();
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(text(lines[0]), 'abc');
  assert.strictEqual(lines[0].replaceLast, false);
});

test('CRLF 被 delta 切开：\\r 在上一段末尾，\\n 在下一段开头', () => {
  const model = pure.createLineModel();
  model.push('abc\r');
  assert.deepStrictEqual(model.take(), []);
  model.push('\ndef\n');
  const lines = model.take();
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(text(lines[0]), 'abc');
  assert.strictEqual(text(lines[1]), 'def');
});

test('\\b 退格删掉上一个字符', () => {
  const model = pure.createLineModel();
  model.push('abcd\b\bX\n');
  assert.strictEqual(text(model.take()[0]), 'abX');
});

test('\\t 展开到 8 列制表位', () => {
  const model = pure.createLineModel();
  model.push('a\tb\n');
  assert.strictEqual(text(model.take()[0]), 'a       b'); // a 后 7 个空格到第 8 列
});

test('其余 C0 控制字符丢弃', () => {
  const model = pure.createLineModel();
  model.push('a\x01\x02b\x7f\n');
  assert.strictEqual(text(model.take()[0]), 'ab');
});

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

test('ANSI：SGR 基本色 / 亮色 / 加粗 / 重置', () => {
  const model = pure.createLineModel();
  model.push('\x1b[31mred\x1b[1mbold\x1b[0mplain\x1b[91mbright\x1b[0m\n');
  const line = model.take()[0];
  assert.deepStrictEqual(line.segments.map((s) => [s.t, s.cls]), [
    ['red', ['ansiFg1']],
    ['bold', ['ansiBold', 'ansiFg1']],
    ['plain', []],
    ['bright', ['ansiFg9']]
  ]);
});

test('ANSI：背景色 40-47 / 100-107', () => {
  const model = pure.createLineModel();
  model.push('\x1b[44mbg\x1b[0m\x1b[105mhi\x1b[0m\n');
  const line = model.take()[0];
  assert.deepStrictEqual(line.segments.map((s) => s.cls), [['ansiBg4'], ['ansiBg13']]);
});

test('ANSI：38;5;n 折算到最近的 16 色', () => {
  const model = pure.createLineModel();
  model.push('\x1b[38;5;196mX\x1b[0m\n');
  const line = model.take()[0];
  assert.deepStrictEqual(line.segments[0].cls, ['ansiFg9']); // 196 是纯亮红
});

test('ANSI：38;2;r;g;b 真彩色整段忽略不报错', () => {
  const model = pure.createLineModel();
  model.push('\x1b[38;2;10;20;30mX\x1b[0m\n');
  assert.strictEqual(text(model.take()[0]), 'X');
});

test('ANSI：未知 CSI 整段丢弃且不留残字符', () => {
  const model = pure.createLineModel();
  model.push('\x1b[2Kclear\x1b[1Aup\x1b[5B\n');
  assert.strictEqual(text(model.take()[0]), 'clearup');
});

test('ANSI：OSC 整段丢弃（BEL 与 ESC\\ 两种终止）', () => {
  const model = pure.createLineModel();
  model.push('\x1b]0;window title\x07X\n\x1b]2;other\x1b\\Y\n');
  const lines = model.take();
  assert.strictEqual(text(lines[0]), 'X');
  assert.strictEqual(text(lines[1]), 'Y');
});

test('ANSI：序列被 delta 从中间切断也能正确解析', () => {
  const model = pure.createLineModel();
  model.push('\x1b[3');
  assert.deepStrictEqual(model.take(), []);
  model.push('1mred\x1b[0m\n');
  const line = model.take()[0];
  assert.strictEqual(text(line), 'red');
  assert.deepStrictEqual(line.segments[0].cls, ['ansiFg1']);
});

// ---------------------------------------------------------------------------
// 超长行断行
// ---------------------------------------------------------------------------

test('单行超过 8000 字符强制断行', () => {
  const model = pure.createLineModel();
  model.push('a'.repeat(8001) + '\n');
  const lines = model.take();
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(text(lines[0]).length, 8000);
  assert.strictEqual(text(lines[1]), 'a');
});

// ---------------------------------------------------------------------------
// UTF-8 断字合并（上游 collector 在任意字节位置 toString("utf8") 的缓解）
// ---------------------------------------------------------------------------

test('UTF-8 断字：delta 末尾 U+FFFD + 下一次开头 U+FFFD 合并成一个', () => {
  const model = pure.createLineModel();
  model.push('a\uFFFD'); // 中文被切成两半：第一半以 U+FFFD 结尾
  model.push('\uFFFDb\n'); // 第二半以 U+FFFD 开头 —— 合并掉，不出现两个方块
  const line = model.take()[0];
  assert.strictEqual(text(line), 'a\uFFFDb');
  assert.strictEqual((text(line).match(/\uFFFD/g) || []).length, 1);
});

test('UTF-8 断字：不满足「上一段末尾 + 本次开头」时不合并', () => {
  const model = pure.createLineModel();
  model.push('a\uFFFD\n'); // 上一段以 \n 结尾，不算
  model.push('\uFFFDb\n');
  const lines = model.take();
  assert.strictEqual(text(lines[0]), 'a\uFFFD');
  assert.strictEqual(text(lines[1]), '\uFFFDb');
});

// ---------------------------------------------------------------------------
// 环形缓冲
// ---------------------------------------------------------------------------

test('环形缓冲：基本 push / slice 增量', () => {
  const buf = pure.createRingBuffer({ maxLines: 100, maxBytes: 1000000 });
  const l1 = { stream: 'out', segments: [{ t: 'a', cls: [] }] };
  const l2 = { stream: 'out', segments: [{ t: 'b', cls: [] }] };
  buf.push(l1);
  buf.push(l2);
  const s = buf.slice(0);
  assert.strictEqual(s.inWindow, true);
  assert.strictEqual(s.lines.length, 2);
  assert.deepStrictEqual(buf.slice(1).lines, [l2]);
  assert.deepStrictEqual(buf.slice(2).lines, []);
});

test('环形缓冲：溢出后 since 落在窗口外返回全量 + inWindow=false', () => {
  const buf = pure.createRingBuffer({ maxLines: 2, maxBytes: 1000000 });
  const mk = (t) => ({ stream: 'out', segments: [{ t, cls: [] }] });
  buf.push(mk('l1'));
  buf.push(mk('l2'));
  const seq = buf.push(mk('l3')); // 溢出：l1 被丢
  assert.strictEqual(seq, 3);
  assert.strictEqual(buf.truncated, true);
  const s0 = buf.slice(0); // 客户端没见过任何行，但 l1 已丢
  assert.strictEqual(s0.inWindow, false);
  assert.deepStrictEqual(s0.lines.map(text), ['l2', 'l3']);
  const s1 = buf.slice(1); // 见过 l1，其后行都在窗口内
  assert.strictEqual(s1.inWindow, true);
  assert.deepStrictEqual(s1.lines.map(text), ['l2', 'l3']);
});

test('环形缓冲：字节上限也触发溢出', () => {
  const buf = pure.createRingBuffer({ maxLines: 1000, maxBytes: 10 });
  const mk = (t) => ({ stream: 'out', segments: [{ t, cls: [] }] });
  buf.push(mk('1234567890')); // 10 字节
  buf.push(mk('x')); // 超限 → 丢头部
  assert.strictEqual(buf.truncated, true);
  assert.deepStrictEqual(buf.slice(0).lines.map(text), ['x']);
});

test('环形缓冲：reset 后 seq 不重置，slice 回到空窗口', () => {
  const buf = pure.createRingBuffer({ maxLines: 10, maxBytes: 1000000 });
  const mk = (t) => ({ stream: 'out', segments: [{ t, cls: [] }] });
  buf.push(mk('a'));
  const seq = buf.seq; // 1
  buf.reset();
  const s = buf.slice(seq);
  assert.strictEqual(s.inWindow, true);
  assert.strictEqual(s.lines.length, 0);
});

test('环形缓冲：takeOverflowNotice 一次性通知（Ctrl+L 清屏后插 meta 行用）', () => {
  const buf = pure.createRingBuffer({ maxLines: 1, maxBytes: 1000000 });
  const mk = (t) => ({ stream: 'out', segments: [{ t, cls: [] }] });
  buf.push(mk('a'));
  buf.push(mk('b')); // 溢出
  assert.strictEqual(buf.takeOverflowNotice(), true);
  assert.strictEqual(buf.takeOverflowNotice(), false); // 只通知一次
});

// ---------------------------------------------------------------------------
// 256 色折算
// ---------------------------------------------------------------------------

test('nearestBasicColor：0-15 原样返回，256 色折算到最近基准色', () => {
  assert.strictEqual(pure.nearestBasicColor(0), 0);
  assert.strictEqual(pure.nearestBasicColor(7), 7);
  assert.strictEqual(pure.nearestBasicColor(196), 9); // (255,0,0) → 亮红
  assert.strictEqual(pure.nearestBasicColor(255), 15); // 白
  assert.strictEqual(pure.nearestBasicColor(232), 0); // 近黑的灰
  assert.strictEqual(pure.nearestBasicColor(-5), 0); // 越界收敛
  assert.strictEqual(pure.nearestBasicColor(999), 15);
});

// ---------------------------------------------------------------------------
// Tab 补全的纯逻辑
// ---------------------------------------------------------------------------

test('tokenizeForCompletion：命令位与参数位', () => {
  const cmd = pure.tokenizeForCompletion('gi', 2, 'bash');
  assert.strictEqual(cmd.value, 'gi');
  assert.strictEqual(cmd.commandPosition, true);
  assert.strictEqual(cmd.start, 0);

  const arg = pure.tokenizeForCompletion('ls sr', 5, 'bash');
  assert.strictEqual(arg.value, 'sr');
  assert.strictEqual(arg.commandPosition, false);
  assert.strictEqual(arg.start, 3);

  // 管道 / 分号之后重新回到命令位
  assert.strictEqual(pure.tokenizeForCompletion('ls | gre', 8, 'bash').commandPosition, true);
  assert.strictEqual(pure.tokenizeForCompletion('a; b', 4, 'bash').commandPosition, true);
});

test('tokenizeForCompletion：引号内的空格不算分隔符', () => {
  const t = pure.tokenizeForCompletion('cat "my fi', 10, 'bash');
  assert.strictEqual(t.value, 'my fi');
  assert.strictEqual(t.start, 4); // 替换区间要含用户打出的那个引号
  assert.strictEqual(t.commandPosition, false);
});

test('tokenizeForCompletion：POSIX 认反斜杠转义，Windows 不认（反斜杠是路径分隔符）', () => {
  assert.strictEqual(pure.tokenizeForCompletion('cat my\\ fi', 10, 'bash').value, 'my fi');
  // pwsh：C:\Users 不能被啃成 C:Users
  const win = pure.tokenizeForCompletion('cd C:\\Us', 8, 'pwsh');
  assert.strictEqual(win.value, 'C:\\Us');
  assert.strictEqual(win.start, 3);
});

test('tokenizeForCompletion：光标在句中时只取光标前的那个 token', () => {
  const t = pure.tokenizeForCompletion('ls src bar', 6, 'bash');
  assert.strictEqual(t.value, 'src');
  assert.strictEqual(t.end, 6);
});

test('splitPathPrefix：两种分隔符都认', () => {
  assert.deepStrictEqual(pure.splitPathPrefix('src/comp'), { dir: 'src/', base: 'comp' });
  assert.deepStrictEqual(pure.splitPathPrefix('src\\comp'), { dir: 'src\\', base: 'comp' });
  assert.deepStrictEqual(pure.splitPathPrefix('comp'), { dir: '', base: 'comp' });
  assert.deepStrictEqual(pure.splitPathPrefix('src/'), { dir: 'src/', base: '' });
});

test('longestCommonPrefix：大小写不敏感时保留第一个候选的原始大小写', () => {
  assert.strictEqual(pure.longestCommonPrefix(['abc', 'abd'], false), 'ab');
  assert.strictEqual(pure.longestCommonPrefix(['Desktop', 'desktools'], true), 'Deskto');
  // 大小写敏感时 D 与 d 就不匹配，公共前缀为空
  assert.strictEqual(pure.longestCommonPrefix(['Desktop', 'desktools'], false), '');
  assert.strictEqual(pure.longestCommonPrefix(['only'], false), 'only');
  assert.strictEqual(pure.longestCommonPrefix([], false), '');
});

test('quoteToken：只有需要时才加引号，单引号按各自 shell 的规矩转义', () => {
  assert.strictEqual(pure.quoteToken('src/app.js', 'bash'), 'src/app.js');
  assert.strictEqual(pure.quoteToken('my file', 'pwsh'), "'my file'");
  assert.strictEqual(pure.quoteToken('my file', 'bash'), "'my file'");
  assert.strictEqual(pure.quoteToken("it's", 'pwsh'), "'it''s'");
  assert.strictEqual(pure.quoteToken("it's", 'bash'), "'it'\\''s'");
});

test('buildCompletion：单候选补全整个，目录不加空格、文件加', () => {
  const dir = pure.buildCompletion('src/', [{ name: 'main', trailing: '/' }], 'bash', false);
  assert.strictEqual(dir.insert, 'src/main/');
  assert.strictEqual(dir.appendSpace, false);

  const file = pure.buildCompletion('src/', [{ name: 'app.js', trailing: '' }], 'bash', false);
  assert.strictEqual(file.insert, 'src/app.js');
  assert.strictEqual(file.appendSpace, true);
});

test('buildCompletion：多候选只补到公共前缀，且不加空格', () => {
  const r = pure.buildCompletion('', [
    { name: 'index.js', trailing: '' },
    { name: 'index.test.js', trailing: '' }
  ], 'bash', false);
  assert.strictEqual(r.insert, 'index.');
  assert.strictEqual(r.appendSpace, false);
});

test('buildCompletion：补出来的路径含空格时整体加引号', () => {
  const r = pure.buildCompletion('', [{ name: 'My Documents', trailing: '\\' }], 'pwsh', true);
  assert.strictEqual(r.insert, "'My Documents\\'");
  assert.strictEqual(r.appendSpace, false);
});

test('buildCompletion：没有候选时不插入任何东西', () => {
  assert.deepStrictEqual(pure.buildCompletion('', [], 'bash', false), { insert: '', appendSpace: false });
});
