'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { summarizeStderr } = require('../src/shared/error-detail');

// 这个摘要直接决定「内核挂了的时候用户在弹框里看到什么」。dsh 的启动失败会打印
// 一整棵嵌套 [cause] 链（同一句话重复三四遍 + 几十行堆栈），原样展示等于没展示。

// 真实现场的结构：源码回显 + ^ 指针 + 逐层变短的同一句话 + 大量 at 帧。
const REAL_DSH_FAILURE = [
  'file:///D:/app/kernel/runtime/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1186',
  '\t\tthrow new Error(`${binName}: ${stage}: ${detail}${stack}`, { cause });',
  '\t\t      ^',
  '',
  'Error: dsh: plugin tree failed to load: failed to apply loader entry credentials'
    + ' (@deepseek-ai/dsh-credentials-local): credentials-local: the value for "refs" in'
    + ' C:/Users/me/.dsh/.credentials.yaml must be a string',
  'TypeError: credentials-local: the value for "refs" in C:/Users/me/.dsh/.credentials.yaml must be a string',
  '    at parseCredentialsDocument (file:///D:/app/kernel/lib/index.js:132:40)',
  '    at LocalCredentialProvider.loadInitial (file:///D:/app/kernel/lib/index.js:344:17)',
  '    at async [cordis.init] (file:///D:/app/kernel/lib/index.js:207:3) {',
  '  [cause]: Error: failed to apply loader entry credentials'
    + ' (@deepseek-ai/dsh-credentials-local): credentials-local: the value for "refs" in'
    + ' C:/Users/me/.dsh/.credentials.yaml must be a string',
  '      at updateError (file:///D:/app/kernel/lib/index.js:299:9)',
  '    [cause]: TypeError: credentials-local: the value for "refs" in'
    + ' C:/Users/me/.dsh/.credentials.yaml must be a string',
  '    }',
  '  }',
  '}',
  '',
  'Node.js v22.21.1',
].join('\n');

test('真实 dsh 启动失败：收敛成一条，且保留可操作信息', () => {
  const out = summarizeStderr(REAL_DSH_FAILURE);
  const lines = out.split('\n');
  assert.strictEqual(lines.length, 1, `嵌套 cause 应折叠成一条，实际:\n${out}`);
  // 用户要靠这三个信息定位问题：哪个文件、哪个字段、要什么。
  assert.match(out, /\.credentials\.yaml/);
  assert.match(out, /"refs"/);
  assert.match(out, /must be a string/);
});

test('丢弃堆栈帧', () => {
  const out = summarizeStderr(REAL_DSH_FAILURE);
  assert.doesNotMatch(out, /^\s*at\s/m, '不应出现 at ... 堆栈帧');
});

test('丢弃源码回显与 ^ 指针', () => {
  const out = summarizeStderr(REAL_DSH_FAILURE);
  assert.doesNotMatch(out, /throw new Error/, '不应出现源码回显');
  assert.doesNotMatch(out, /^\s*\^\s*$/m, '不应出现 ^ 指针行');
});

test('不同的错误消息不会被误合并', () => {
  const out = summarizeStderr([
    'Error: 端口被占用',
    '    at foo (file:///a.js:1:1)',
    'Error: 配置文件损坏',
  ].join('\n'));
  assert.strictEqual(out.split('\n').length, 2, '两条无关消息都要保留');
});

test('没有消息行时退回原文尾部，而不是返回空', () => {
  const stackOnly = [
    '    at a (file:///a.js:1:1)',
    '    at b (file:///b.js:2:2)',
  ].join('\n');
  const out = summarizeStderr(stackOnly);
  assert.ok(out.trim().length > 0, '宁可给堆栈也不能给空白');
  assert.match(out, /at a|at b/);
});

test('空输入给出兜底文案', () => {
  assert.strictEqual(summarizeStderr(''), '内核没有输出任何错误信息。');
  assert.strictEqual(summarizeStderr(undefined), '内核没有输出任何错误信息。');
  assert.strictEqual(summarizeStderr(null), '内核没有输出任何错误信息。');
  assert.strictEqual(summarizeStderr('   \n  '), '内核没有输出任何错误信息。');
});

test('maxLines 限制输出长度', () => {
  const many = Array.from({ length: 20 }, (_, i) => `Error: 第 ${i} 个互不相同的问题`).join('\n');
  assert.strictEqual(summarizeStderr(many, { maxLines: 3 }).split('\n').length, 3);
});

test('自定义兜底文案', () => {
  assert.strictEqual(summarizeStderr('', { fallback: '无输出' }), '无输出');
});

// 端口绑不上是**用户自己能解决**的少数几类故障之一（系统保留端口段 / 安全软件），
// 所以它不能被压成一句 loader entry 术语 —— 这几条锁住那份人话提示。
// 现场原文（用户反馈）：一整条 cordis loader 链，最后一句才是真因。
const REAL_BIND_FAILURE = [
  'Error: failed to apply loader entry include (cordis:include):',
  '  [cause]: Error: failed to apply loader entry webserver (@deepseek-ai/dsh-host-webserver):',
  '  [cause]: Error: listen EACCES: permission denied 127.0.0.1:53389',
  '    at Server.setupListenHandle [as _listen2] (node:net:1939:21)',
].join('\n');

test('端口绑定失败：说人话，并把原始那行留在末尾', () => {
  const out = summarizeStderr(REAL_BIND_FAILURE);
  assert.match(out, /端口/);
  // 必须给出用户能动手的线索，而不是只说"失败了"
  assert.match(out, /excludedportrange/);
  assert.match(out, /listen EACCES: permission denied 127\.0\.0\.1:53389/);
  // 不能把 loader entry 那串术语当成主要内容抛给用户
  assert.doesNotMatch(out.split('\n')[0], /loader entry/);
});

test('端口被占用与权限拒绝给的是不同的话', () => {
  const busy = summarizeStderr('Error: listen EADDRINUSE: address already in use 127.0.0.1:5173');
  assert.match(busy, /占用/);
  const denied = summarizeStderr(REAL_BIND_FAILURE);
  assert.match(denied, /拒绝访问/);
});

test('普通启动失败不会被误判成端口问题', () => {
  const out = summarizeStderr('Error: Cannot find module "@deepseek-ai/dsh-git"');
  assert.doesNotMatch(out, /端口/);
});

// isPortBindFailure 决定一个很贵的分支：判错会让上层把用户的热更新内核当成损坏品
// 弃用掉（index.js 的回退分支），所以正反两个方向都要锁住。
const { isPortBindFailure, firstBindErrorLine } = require('../src/shared/error-detail');

test('isPortBindFailure：两种绑定失败都认，其它启动失败一律不认', () => {
  assert.strictEqual(isPortBindFailure('Error: listen EACCES: permission denied 127.0.0.1:53389'), true);
  assert.strictEqual(isPortBindFailure('Error: listen EADDRINUSE: address already in use 127.0.0.1:51234'), true);
  // 模块解析失败是「内核真的坏了」，必须落到回退分支，不能被误判成端口问题
  assert.strictEqual(isPortBindFailure('Error [ERR_MODULE_NOT_FOUND]: Cannot find package'), false);
  assert.strictEqual(isPortBindFailure(''), false);
  assert.strictEqual(isPortBindFailure(null), false);
  assert.strictEqual(isPortBindFailure(undefined), false);
  // 只是提到了 EACCES 但不是 listen 出来的（比如读文件权限），不算端口问题
  assert.strictEqual(isPortBindFailure('Error: EACCES: permission denied, open .../config.yaml'), false);
});

test('firstBindErrorLine：从一大段 cause 链里只取那条 listen 行', () => {
  const detail = [
    'Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):',
    '  [cause]: Error: listen EADDRINUSE: address already in use 127.0.0.1:51234',
    '    at Server.setupListenHandle (node:net:1939:21)',
  ].join('\n');
  assert.strictEqual(firstBindErrorLine(detail), 'listen EADDRINUSE: address already in use 127.0.0.1:51234');
  assert.strictEqual(firstBindErrorLine('看不出原因'), 'listen 失败');
});
