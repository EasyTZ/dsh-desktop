'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { URL_LINE_RE, probeUrl } = require('../src/shared/kernel-boot');

// probeUrl 存在的唯一理由就是「别把 token 拼坏」，所以用例围着 token 转。
// 背景：探活曾经是 `url + '/'`，对裸地址是对的，对带 token 的地址会拼出
// `...?token=xxx/`，内核一律判 401 —— 而当时 401 被当成「就绪」，于是错拼从没
// 露头，直到 401 被正确地当成「没就绪」才变成致命卡死。

test('probeUrl: 带 token 的地址行，token 不能被改动', () => {
  const line = 'http://127.0.0.1:12918/?token=KZ4KjifCXYteYRJwaPgqsq2kybEPBIJb';
  const probe = probeUrl(line);
  assert.strictEqual(new URL(probe).searchParams.get('token'),
    'KZ4KjifCXYteYRJwaPgqsq2kybEPBIJb');
  // 尤其不能变成 `...token=xxx/`
  assert.ok(!probe.endsWith('/'), `探活地址不该以斜杠结尾：${probe}`);
});

test('probeUrl: 裸地址补成根路径', () => {
  assert.strictEqual(probeUrl('http://127.0.0.1:3142'), 'http://127.0.0.1:3142/');
});

test('probeUrl: 已经是根路径就保持原样', () => {
  assert.strictEqual(probeUrl('http://127.0.0.1:3142/'), 'http://127.0.0.1:3142/');
});

test('probeUrl: 非根路径归一到根（探活只认根）', () => {
  assert.strictEqual(probeUrl('http://127.0.0.1:3142/some/where?token=t'),
    'http://127.0.0.1:3142/?token=t');
});

test('probeUrl: 解析不了的输入原样返回，不抛', () => {
  assert.strictEqual(probeUrl('not a url'), 'not a url');
});

test('URL_LINE_RE 抓的是内核那行完整地址（含 token）', () => {
  const m = URL_LINE_RE.exec(
    'dsh web: http://127.0.0.1:12918/?token=hnlhPKwVdCCi2SaZDwf1LoCmajKTmoswg4k9tZ15FGs');
  assert.ok(m);
  assert.strictEqual(m[1],
    'http://127.0.0.1:12918/?token=hnlhPKwVdCCi2SaZDwf1LoCmajKTmoswg4k9tZ15FGs');
});

test('probeUrl 与 URL_LINE_RE 串起来：抓到的地址探活时 token 完好', () => {
  const m = URL_LINE_RE.exec('dsh web: http://127.0.0.1:12922/?token=abc123');
  assert.ok(m);
  assert.strictEqual(probeUrl(m[1]), 'http://127.0.0.1:12922/?token=abc123');
});
