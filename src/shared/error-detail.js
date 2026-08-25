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

module.exports = { summarizeStderr };
