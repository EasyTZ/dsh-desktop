'use strict';

const fs = require('node:fs');

// 单次启动的日志上限：够完整记录好几轮启动时序，没必要无限攒——这是给
// 「黑屏」这类偶发问题事后取证用的，不是常驻的运行日志。
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * 把 console.log/warn/error 原地包一层，同时落盘到 `logPath`。
 *
 * 打包后双击启动的 GUI 应用没有任何终端接着 stdout——console.log 等于
 * 写进了黑洞，偶发的「开机第一次打开黑屏」这类问题事后完全没法追。这里
 * 不改调用方一行代码（现有代码全是 `logger: console` 或直接 `console.log`），
 * 直接换掉 console 本身的三个方法，覆盖面最大、改动最小。
 *
 * 每次启动**覆盖式**新开一份、旧的存一份 `.old`：只留「这次 + 上次」两次
 * 启动的痕迹，够用来对比"这次黑屏"和"上次正常"两条时序。
 *
 * @param {string} logPath
 */
function installFileLogger(logPath) {
  try {
    if (fs.existsSync(logPath)) fs.renameSync(logPath, `${logPath}.old`);
  } catch {
    // 改名失败（比如上一份还被占用）不影响这次继续写，大不了两次内容叠在一起。
  }

  /** @type {number|null} */
  let fd = null;
  try {
    fd = fs.openSync(logPath, 'a');
  } catch {
    return; // 打不开就放弃落盘，console 本身照常工作，不能让日志功能拖垮启动。
  }

  let bytesWritten = 0;

  /** @param {string} level @param {any[]} args */
  const write = (level, args) => {
    if (bytesWritten > MAX_BYTES) return;
    const text = args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack ?? a.message;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(' ');
    const line = `[${new Date().toISOString()}] [${level}] ${text}\n`;
    try {
      fs.writeSync(/** @type {number} */ (fd), line);
      bytesWritten += Buffer.byteLength(line);
    } catch {
      // 磁盘满等极端情况：吞掉，不能因为日志写失败把应用搞崩。
    }
  };

  /** @param {string} level @param {(...args: any[]) => void} original */
  const wrap = (level, original) => (/** @type {any[]} */ ...args) => {
    original(...args);
    write(level, args);
  };

  console.log = wrap('log', console.log.bind(console));
  console.warn = wrap('warn', console.warn.bind(console));
  console.error = wrap('error', console.error.bind(console));
}

module.exports = { installFileLogger };
