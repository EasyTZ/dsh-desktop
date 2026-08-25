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
