'use strict';

// 把内核 stderr 压成「人能看懂的几行」。
//
// dsh 的启动失败会打印一整棵嵌套的 [cause] 链：同一句话重复三四遍，中间夹着几十
// 行 at ... 堆栈帧。原样塞进弹框的结果是用户要在一屏乱码里找那句唯一有用的话
// （比如「.credentials.yaml 里 refs 的值必须是字符串」）。这里只保留消息行。

/** 堆栈帧：`    at foo (file:///...)`。 */
const STACK_FRAME_RE = /^\s*at\s/;
/** 结构噪音：单独的 {、}、}) 之类。 */
const NOISE_RE = /^[\s{}\])^~]*$/;
/** 嵌套 cause 前缀，去掉后用于判重。 */
const CAUSE_PREFIX_RE = /^\s*\[cause\]:\s*/;
/** 错误消息行：Error: / TypeError: / SomeException: 这种。 */
const MESSAGE_RE = /\w*(Error|Exception):\s/;
/** 去掉 `Error: ` / `TypeError: ` 这类前缀，只留消息本体（用于判重）。 */
const ERROR_PREFIX_RE = /^\w*(Error|Exception):\s*/;
/** 指向源码位置的裸行（紧跟在报错文件名后的那种）。 */
const FILE_POINTER_RE = /^\s*(file:\/\/\/|[A-Za-z]:).*:\d+$/;

/**
 * 从 stderr 里提炼出要展示的几行。
 *
 * @param {string|undefined|null} detail 原始 stderr
 * @param {{maxLines?: number, fallback?: string}} [opts]
 * @returns {string}
 */
function summarizeStderr(detail, opts = {}) {
  const { maxLines = 6, fallback = '内核没有输出任何错误信息。' } = opts;
  const text = String(detail ?? '').trim();
  if (!text) return fallback;

  // 端口绑不上单独说人话。原文长这样：
  //   failed to apply loader entry webserver (@deepseek-ai/dsh-host-webserver):
  //   listen EACCES: permission denied 127.0.0.1:53389
  // 照原样展示的话，用户只会看到一串 loader entry 术语，完全猜不到跟端口有关，
  // 更猜不到该怎么办 —— 而这恰恰是**用户自己能解决**的少数几类故障之一。
  const bind = /listen\s+(EACCES|EADDRINUSE)[^\n]*/i.exec(text);
  if (bind) {
    const isBusy = /EADDRINUSE/i.test(bind[0]);
    return [
      isBusy ? '内核要用的本地端口被别的程序占用了。' : '内核无法绑定本地端口（系统拒绝访问）。',
      '已经自动换端口重试过几次，仍然失败。常见原因：',
      '· Hyper-V / WSL2 / Docker 预留了大段端口（管理员运行 `netsh interface ipv4 show excludedportrange protocol=tcp` 可以查看）',
      '· 安全软件拦截了本机回环端口的监听',
      '重启电脑通常能让保留区间重新分配；若长期复现，请把上面那条命令的输出反馈给我们。',
      bind[0].trim(),
    ].join('\n');
  }

  const seen = new Set();
  const kept = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (STACK_FRAME_RE.test(line)) continue;
    if (NOISE_RE.test(line)) continue;
    if (FILE_POINTER_RE.test(line)) continue;

    // 嵌套 cause 会把同一句话重复多遍，只留第一次出现的。
    const normalized = line.replace(CAUSE_PREFIX_RE, '').trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    kept.push(normalized);
  }

  // 有真正的错误消息行时只留它们，把「throw new Error(...)」这类源码回显丢掉。
  const messages = kept.filter((l) => MESSAGE_RE.test(l));
  const picked = messages.length > 0 ? messages : kept;

  // 嵌套 cause 是逐层变短的同一句话：后面的通常是前面的子串，只留最完整的那条。
  const result = [];
  const bodies = [];
  for (const line of picked) {
    // 判重要比消息本体：外层是 "Error: dsh: ..."、内层是 "Error: ..."，带前缀比不出包含关系。
    const body = line.replace(ERROR_PREFIX_RE, '');
    if (bodies.some((b) => b.includes(body))) continue;
    bodies.push(body);
    result.push(line);
  }
  if (result.length > 0) return result.slice(0, maxLines).join('\n');

  // 全是堆栈、没有可读消息时，退回原文尾部，总比什么都不给强。
  return text.split(/\r?\n/).slice(-maxLines).join('\n');
}

/**
 * 内核是不是「端口绑不上」而退出的。
 *
 * 放在 shared 而不是 dsh-service：它是纯字符串判定，放这里才能单测，而这段逻辑
 * 决定了一个很贵的分支 —— 判错会让上层把用户辛苦下下来的热更新内核当成损坏品
 * 弃用掉（见 index.js 的回退分支）。
 *
 * EACCES：Windows 上 loopback bind 报权限拒绝，典型原因是端口落进系统保留区间
 * （Hyper-V / WSL2 / Docker 会动态预留大段端口），也可能是安全软件拦截。
 * EADDRINUSE：我们探测端口与内核真正 bind 之间被别的进程抢走了。
 * 两者都跟内核本身无关，换个端口通常就好。
 *
 * @param {string|undefined|null} detail 内核 stderr
 */
function isPortBindFailure(detail) {
  return /listen\s+(EACCES|EADDRINUSE)/i.test(String(detail ?? ''));
}

/**
 * 取 stderr 里那条 bind 报错本身，用于日志（整段 stderr 有几十行，日志里只留关键一行）。
 * @param {string|undefined|null} detail
 */
function firstBindErrorLine(detail) {
  const m = /listen\s+(?:EACCES|EADDRINUSE)[^\n]*/i.exec(String(detail ?? ''));
  return m ? m[0].trim() : 'listen 失败';
}

module.exports = { summarizeStderr, isPortBindFailure, firstBindErrorLine };
