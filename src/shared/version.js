'use strict';

// 轻量 semver 比较（仅覆盖 dsh 实际使用的 x.y.z[-prerelease] 形式），
// 不引入 semver 依赖：主进程运行在 Electron 里，这里保持零依赖。

/** 把一个版本段切成数字部分数组（缺省补 0）。 */
function parseNums(seg) {
  return String(seg ?? '')
    .split('.')
    .map((s) => {
      const n = parseInt(s, 10);
      return Number.isNaN(n) ? 0 : n;
    });
}

/** 拆出 [main, prerelease]，例如 '0.1.1-rc.2' -> ['0.1.1', 'rc.2']。 */
function splitPrerelease(v) {
  const s = String(v ?? '').trim();
  const idx = s.indexOf('-');
  if (idx === -1) return [s, null];
  return [s.slice(0, idx), s.slice(idx + 1)];
}

/** 逐段比较两个数字数组，返回 -1/0/1。 */
function cmpNums(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 比较 prerelease 标识符：点分段，纯数字段按数值、否则按字典序。 */
function cmpPrerelease(a, b) {
  if (a === null && b === null) return 0;
  // 有 prerelease 的版本低于无 prerelease 的正式版。
  if (a === null) return 1;
  if (b === null) return -1;
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined && y === undefined) return 0;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const nx = parseInt(x, 10);
      const ny = parseInt(y, 10);
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else {
      if (x !== y) return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 比较两个版本号：a > b 返回正数，a < b 返回负数，相等返回 0。
 */
function compareSemver(a, b) {
  const [ma, pa] = splitPrerelease(a);
  const [mb, pb] = splitPrerelease(b);
  const main = cmpNums(parseNums(ma), parseNums(mb));
  if (main !== 0) return main;
  return cmpPrerelease(pa, pb);
}

/** a 是否比 b 新。 */
function isNewer(a, b) {
  return compareSemver(a, b) > 0;
}

module.exports = { compareSemver, isNewer };
