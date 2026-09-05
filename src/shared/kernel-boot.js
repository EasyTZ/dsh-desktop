'use strict';

// 内核「起一次、等就绪」的等待逻辑。三处共用：正式启动（DshService）、热更新自检
// （KernelUpdater._verify）、构建期自检（scripts/verify-kernel.mjs）。
//
// 三处解析的是同一行上游输出（`dsh web: <url>`），格式一变只改这里。

const http = require('node:http');

// 内核启动后打印的地址行，`--port 0` 时端口只能从这里读回来。与 DshService 用的
// 是同一条正则（两边都在解析同一个上游输出，格式一变要一起改）。
const URL_LINE_RE = /dsh web:\s+(https?:\/\/\S+)/;
// 等这行出现的上限。超时说明内核连端口都没绑上，多半是启动阶段就崩了。
//
// 20 秒是**面向用户**的取舍：超时后 DshService 会退回「自己探端口」的老做法，
// 而这段时间用户正对着闪屏等，不能太长（见 dsh-service.js 的
// #fallbackToExplicitPort 注释）。
//
// **构建期自检不用这个值**：scripts/verify-kernel.mjs 有自己的、宽松得多的预算。
// 那边超时的后果是「构建失败」而不是「用户多等几秒」，CI runner 比开发机慢一截，
// 拿面向用户的紧预算去卡构建只会换来一堆假红。理由写在那个文件里。
const URL_LINE_TIMEOUT_MS = 20000;

/**
 * 等内核把地址行打出来。进程中途退出就立刻失败，不空等到超时 —— 那正是「新内核
 * 起不来」最常见的样子。
 * @param {{ value: string|null }} urlState
 * @param {{ value: unknown }} exitState
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function waitUrlLine(urlState, exitState, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (urlState.value) return resolve(urlState.value);
      if (exitState.value !== null) return reject(new Error('进程在打印地址行之前退出'));
      // 报错带上等了多久：这个值在运行时与构建期是两套预算，不写出来的话，
      // 看日志的人根本判断不出「是内核真的挂了」还是「预算给少了」。
      if (Date.now() > deadline) {
        return reject(new Error(`等不到内核打印地址行（等了 ${(timeoutMs / 1000).toFixed(0)}s）`));
      }
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

/**
 * 轮询 HTTP 直到就绪（<500），超时抛错。isDead 可选：进程已经退出时立刻失败，
 * 不必空等到超时。
 * @returns {Promise<void>}
 */
function waitHttpReady(url, timeoutMs, isDead) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        schedule();
      });
      req.on('error', schedule);
      req.setTimeout(2000, () => { req.destroy(); schedule(); });
    };
    const schedule = () => {
      if (typeof isDead === 'function' && isDead()) {
        return reject(new Error('进程在就绪前退出'));
      }
      if (Date.now() > deadline) return reject(new Error(`超时（${url}）`));
      setTimeout(attempt, 250);
    };
    attempt();
  });
}

module.exports = {
  URL_LINE_RE,
  URL_LINE_TIMEOUT_MS,
  waitUrlLine,
  waitHttpReady,
};
