// 终端面板的纯逻辑层：ANSI 解析、行模型、哨兵解析、环形缓冲。
//
// 本文件刻意零 import：它是本插件唯一的自动化安全网，test/ 直接 import 它做单测，
// typecheck 的 include 虽然不覆盖 plugins/，但被 test 文件 import 进来的模块会被
// tsc 一并纳入检查 —— 所以这里必须过 strictNullChecks / noUnusedLocals。
//
// 所有函数都是「状态机工厂 + 纯函数」形态：跨 delta 的状态（半行、未闭合的 ANSI
// 序列、被切开的哨兵）由调用方持有一个工厂产出的实例，每次喂一段增量文本。
// 命令输出是一个字节流被 80ms 轮询切成任意边界，任何「一行内」假设都会碎。

/** 单行超过该字符数强制断行，防止一行几 MB 把渲染拖死。 */
export const LINE_MAX_CHARS = 8000;
/** 环形缓冲行数上限。 */
export const RING_MAX_LINES = 5000;
/** 环形缓冲字节上限（UTF-8 字节数估计）。 */
export const RING_MAX_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 256 色 → 16 色折算（SGR 38;5;n / 48;5;n）
// ---------------------------------------------------------------------------

// 6×6×6 立方体的 6 个档位（xterm 256 色标准）。
const CUBE_STEPS = [0, 95, 135, 175, 215, 255];
// 16 色的教科书 RGB（与 xterm 的默认调色板一致），下标即色号 0-15。
const BASIC_RGB = [
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]
];

/**
 * 把 xterm 256 色号折算到最近的 16 色。0-15 本身就在 16 色内，直接返回；
 * 16-231 是立方体色，232-255 是灰阶，两者都转 RGB 后与 16 个基准色求欧氏
 * 距离取最近。CSS 里只定义 16 组前景/背景色变量，所以这里必须收敛。
 * @param {number} n 0-255
 * @returns {number} 0-15
 */
export function nearestBasicColor(n) {
  n = Math.max(0, Math.min(255, Math.floor(n) || 0));
  if (n < 16) return n;
  let r; let g; let b;
  if (n < 232) {
    const v = n - 16;
    r = CUBE_STEPS[Math.floor(v / 36)];
    g = CUBE_STEPS[Math.floor(v / 6) % 6];
    b = CUBE_STEPS[v % 6];
  } else {
    const v = 8 + (n - 232) * 10;
    r = g = b = v;
  }
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 16; i++) {
    const br = BASIC_RGB[i][0] - r;
    const bg = BASIC_RGB[i][1] - g;
    const bb = BASIC_RGB[i][2] - b;
    const d = br * br + bg * bg + bb * bb;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// [stderr] 标记拆分（dsh-shell readOutput 的事实）
// ---------------------------------------------------------------------------

/**
 * 在一次 delta 内拆出 stdout / stderr 两段。`dsh-pwsh-local` / `dsh-bash-local`
 * 的 readOutput 把 stderr 用字面量 `[stderr]` 拼在 stdout 后面（stdout 末尾无换行
 * 时会先插入一个分隔换行），所以规则是：**找最后一行内容恰好等于 `[stderr]` 的
 * 位置**，它之后全部算 stderr，标记行本身剥掉。用户命令自己打印一行 `[stderr]`
 * 会误判 —— 只影响着色，接受（与上游注释同一态度）。
 *
 * 注意只按行精确匹配，`[stderr]xxx` 这种中间混入的不算标记行。
 *
 * @param {string} text 一次 readOutput 的 delta
 * @returns {Array<{ text: string, stream: 'out' | 'err' }>} 拆出的段（可能只有一段）
 */
export function splitStderr(text) {
  if (!text.includes("[stderr]")) return [{ text, stream: "out" }];
  const parts = text.split("\n");
  let idx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === "[stderr]") { idx = i; break; }
  }
  if (idx === -1) return [{ text, stream: "out" }];
  const outParts = parts.slice(0, idx);
  const errParts = parts.slice(idx + 1);
  const result = [];
  // [stderr] 是独立行，所以它前面必有 \n（或字符串开头）。out 段因此总以 \n
  // 结尾 —— 用 join 会丢掉这个结尾换行，行模型会把 out 内容误当成半行，必须补回。
  //
  // 已知近似（真实输出里会出现）：上游 readOutput 只有在 stdout 末尾无换行时才补
  // 分隔换行，所以「npm 一边刷进度条（\r 不换行）一边往 stderr 报 warning」时，
  // 被 \r 重写中的那半行会在这里被收尾成独立一行 —— stdout/stderr 的真实交错
  // 顺序上游根本拿不到（两条流各自收集再拼接），这是 API 的固有限制，不是 bug。
  if (outParts.length > 0) {
    result.push({ text: outParts.join("\n") + "\n", stream: "out" });
  }
  const errText = errParts.join("\n");
  if (errText.length > 0) {
    result.push({ text: errText, stream: "err" });
  }
  return result;
}

// ---------------------------------------------------------------------------
// SGR 解析辅助
// ---------------------------------------------------------------------------

function defaultSgr() {
  return { bold: false, dim: false, italic: false, underline: false, fg: null, bg: null };
}

/** 从 SGR 状态生成类名数组（颜色在 CSS 里按主题定义，这里只出类名）。 */
function sgrCls(sgr) {
  const c = [];
  if (sgr.bold) c.push("ansiBold");
  if (sgr.dim) c.push("ansiDim");
  if (sgr.italic) c.push("ansiItalic");
  if (sgr.underline) c.push("ansiUnderline");
  if (sgr.fg !== null) c.push("ansiFg" + sgr.fg);
  if (sgr.bg !== null) c.push("ansiBg" + sgr.bg);
  return c;
}

/**
 * 应用一条 CSI ... m 的参数串。支持：0/1/2/3/4/22/23/24/39/49、30–37、90–97、
 * 40–47、100–107、38;5;n / 48;5;n（折算 16 色）；38;2 真彩色与其余参数忽略。
 * @param {string} paramsStr CSI 参数串（不含终结字节）
 * @param {{ bold: boolean, dim: boolean, italic: boolean, underline: boolean, fg: number | null, bg: number | null }} sgr
 */
function applySgr(paramsStr, sgr) {
  const params = paramsStr === "" ? [0] : paramsStr.split(";").map((s) => (s === "" ? 0 : Number(s)));
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) {
      const d = defaultSgr();
      sgr.bold = d.bold; sgr.dim = d.dim; sgr.italic = d.italic;
      sgr.underline = d.underline; sgr.fg = d.fg; sgr.bg = d.bg;
    } else if (p === 1) sgr.bold = true;
    else if (p === 2) sgr.dim = true;
    else if (p === 3) sgr.italic = true;
    else if (p === 4) sgr.underline = true;
    else if (p === 22) { sgr.bold = false; sgr.dim = false; }
    else if (p === 23) sgr.italic = false;
    else if (p === 24) sgr.underline = false;
    else if (p === 39) sgr.fg = null;
    else if (p === 49) sgr.bg = null;
    else if (p >= 30 && p <= 37) sgr.fg = p - 30;
    else if (p >= 90 && p <= 97) sgr.fg = p - 90 + 8;
    else if (p >= 40 && p <= 47) sgr.bg = p - 40;
    else if (p >= 100 && p <= 107) sgr.bg = p - 100 + 8;
    else if (p === 38 || p === 48) {
      const mode = params[i + 1];
      const n = params[i + 2];
      if (mode === 5 && typeof n === "number" && Number.isFinite(n)) {
        const idx = nearestBasicColor(n);
        if (p === 38) sgr.fg = idx; else sgr.bg = idx;
        i += 2;
      } else if (mode === 2) {
        // 真彩色 38;2;r;g;b —— 说明书只要求 38;5;n，整段跳过。
        i += 4;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 行模型（ANSI 状态机 + 哨兵剥离 + 逐字符行模型，一次处理）
// ---------------------------------------------------------------------------

// 哨兵解析的三个状态：空闲 / 已见 \x1e 期待 "DSHX" / 哨兵内容中。
const S_IDLE = 0;
const S_PENDING = 1;
const S_IN = 2;

/**
 * 行模型工厂。持有跨 delta 的半行、ANSI 序列状态、哨兵状态；每喂一段文本，
 * 产出的完整行在 take() 里取走。这是「输出解析」一节全部步骤的落地：
 * UTF-8 断字合并 → 换行归一（\r\n）→ [stderr] 拆分 → 哨兵剥离 → ANSI 解析 →
 * 逐字符行模型（\n 收行 / \r 重写 / \b 退格 / \t 制表位 / 控制字符丢弃）→
 * 超长行强制断行。
 *
 * 输出的行：`{ stream: 'out' | 'err', segments: [{ t, cls }], replaceLast: boolean }`。
 * replaceLast 为 true 的行表示它是对「前一行」的重写（\r 进度条），客户端应替换
 * 而不是追加。
 *
 * @returns {{ push: (text: string) => void, flush: () => void, take: () => Array<object>, getSentinel: () => { code: number, cwd: string } | null }}
 */
export function createLineModel() {
  // —— 半行状态 ——
  /** 当前半行的段（t = 文本，cls = 类名数组，clsKey = 用于合并相邻同款式段的指纹）。 */
  let segs = [];
  /** 当前半行的字符总数（含段内文本），用于超长断行。 */
  let curLen = 0;
  /** 当前半行属于哪个流。流切换时半行要收尾（stdout/stderr 交错顺序拿不到，接受近似）。 */
  let curStream = "out";
  /** 上一字符是 \r（可能构成 \r\n 换行，要等下一个字符才能裁决）。 */
  let crPending = false;
  /** 半行内见过独立的 \r（进度条重写），下一个完整行标记 replaceLast。 */
  let pendingReplace = false;
  /** UTF-8 断字合并的跨 delta 记忆（上一段是否以 U+FFFD 结尾）。 */
  let prevEndsReplacement = false;

  // —— ANSI 状态机 ——
  // escState：0 普通 / 1 刚见 ESC / 2 CSI 参数中 / 3 OSC / 4 DCS 等字符串 / 5 ESC \ 结尾
  let escState = 0;
  let escBuf = "";
  let sgr = defaultSgr();

  // —— 哨兵状态机 ——
  let sentinelMode = S_IDLE;
  let sentinelBuf = "";
  // 哨兵行被剥离后，它自己的 \n 会触发收行 —— 若当前行内容为空，这次收行应跳过
  // （否则每条命令后面都多一个空行）。标记「刚消费过一个哨兵」，下一次收行时消费。
  let sentinelJustClosed = false;
  /** 最后一个完整哨兵；进程结束后由调用方读取并更新 cwd/退出码。 */
  /** @type {{ code: number, cwd: string } | null} */
  let lastSentinel = null;

  /** 本批产出的完整行（push/flush 累积，take 取走）。 */
  let out = [];

  function emitSegs(stream, segList, replaceLast) {
    out.push({
      stream,
      segments: segList.map((s) => ({ t: s.t, cls: s.cls })),
      replaceLast
    });
  }

  function emitLine(noReplace) {
    // 空行（比如输出里的连续换行）也 emit —— 渲染时是空白行，有意义。
    emitSegs(curStream, segs, noReplace ? false : pendingReplace);
    segs = [];
    curLen = 0;
    pendingReplace = false;
  }

  /** 把哨兵失配时被吞掉的可见字符补回显示。 */
  function pushVisible(text) {
    for (const ch of text) {
      if (curLen >= LINE_MAX_CHARS) emitLine(true); // 物理断行不是 \r 重写，不能带 replaceLast
      const cls = sgrCls(sgr);
      const key = cls.join(" ");
      const last = segs.length ? segs[segs.length - 1] : null;
      if (last && last.clsKey === key) {
        last.t += ch;
      } else {
        segs.push({ t: ch, cls, clsKey: key });
      }
      curLen += 1;
    }
  }

  /** 处理一个非 ESC 的普通可见字符或控制字符（\n 之外）。 */
  function handleOrdinary(ch) {
    if (crPending) {
      crPending = false;
      if (ch === "\n") { emitLine(); return; }
      // 独立的 \r：重置当前行并标记 replaceLast，再继续处理 ch。
      segs = [];
      curLen = 0;
      pendingReplace = true;
    }
    if (ch === "\n") {
      // 哨兵行整行被剥掉后这里 segs 为空：跳过这次收行，不产生空行。
      if (sentinelJustClosed && curLen === 0 && segs.length === 0) {
        sentinelJustClosed = false;
        return;
      }
      sentinelJustClosed = false;
      emitLine();
      return;
    }
    if (ch === "\r") { crPending = true; return; }
    if (ch === "\b") {
      // 退一格：从最后一段末尾删一个字符；段空了就弹掉。
      while (segs.length > 0) {
        const last = segs[segs.length - 1];
        if (last.t.length > 1) { last.t = last.t.slice(0, -1); break; }
        segs.pop();
      }
      if (curLen > 0) curLen -= 1;
      return;
    }
    if (ch === "\t") {
      const n = 8 - (curLen % 8);
      pushVisible(" ".repeat(n));
      return;
    }
    // 其余 C0/C1 控制字符（含 \x7f DEL）丢弃 —— 输出里不该有它们，留着会污染渲染。
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) return;
    pushVisible(ch);
  }

  /** 哨兵字符处理：\x1e 与可见字符先过这里，控制字符不经过。 */
  function handleSentinel(ch) {
    if (sentinelMode === S_IN) {
      if (ch === "\x1e") {
        // 收尾：解析 code:cwd。前缀 DSHX 已在 S_PENDING 阶段消费，这里缓冲的是
        // 「code:cwd」。cwd 里可能有冒号（Windows 路径），所以从第一个冒号后
        // 全部算 cwd；数字部分用 \d+ 精确匹配。
        const m = /^(\d+):([\s\S]*)$/.exec(sentinelBuf);
        if (m) lastSentinel = { code: Number(m[1]), cwd: m[2] };
        sentinelMode = S_IDLE;
        sentinelBuf = "";
        sentinelJustClosed = true;
      } else {
        sentinelBuf += ch;
      }
      return;
    }
    if (sentinelMode === S_PENDING) {
      // 已见 \x1e，期待依次匹配 "DSHX"。
      const target = "DSHX";
      const sofar = sentinelBuf.length; // 含开头的 \x1e，所以 1 起
      if (sofar < target.length + 1 && ch === target[sofar - 1]) {
        sentinelBuf += ch;
        if (sentinelBuf === "\x1eDSHX") { sentinelMode = S_IN; sentinelBuf = ""; }
      } else {
        // 失配：这是用户输出里混入的 \x1e（单测要求的干扰场景）。把被吞的
        // 字母补回显示（\x1e 本身是控制字符，按行模型规则丢弃）。
        const failed = sentinelBuf.slice(1);
        sentinelMode = S_IDLE;
        sentinelBuf = "";
        if (failed.length > 0) pushVisible(failed);
        // 失配字符本身要重新走分发：\x1e 可能开启新的哨兵（\x1eD\x1eDSHX… 里
        // 第二个 \x1e 是真正的哨兵起点），其它可见字符直接显示。
        if (ch === "\x1e") { sentinelMode = S_PENDING; sentinelBuf = "\x1e"; }
        else pushVisible(ch);
      }
      return;
    }
    if (ch === "\x1e") {
      sentinelMode = S_PENDING;
      sentinelBuf = "\x1e";
      return;
    }
    pushVisible(ch);
  }

  /** 控制字符打断未闭合哨兵：哨兵内容里不该有控制字符，见到即视为失败。 */
  function breakSentinel() {
    if (sentinelMode === S_IN) {
      // 未闭合的哨兵（进程被截断等）：整段丢弃，和闭合哨兵一样不产生空行。
      sentinelMode = S_IDLE;
      sentinelBuf = "";
      sentinelJustClosed = true;
    } else if (sentinelMode === S_PENDING) {
      const failed = sentinelBuf.slice(1);
      sentinelMode = S_IDLE;
      sentinelBuf = "";
      if (failed.length > 0) pushVisible(failed);
    }
  }

  /** 逐字符主状态机。 */
  function pushChar(ch) {
    if (escState === 1) {
      if (ch === "[") { escState = 2; escBuf = ""; }
      else if (ch === "]") { escState = 3; escBuf = ""; }
      else if (ch === "P" || ch === "X" || ch === "^" || ch === "_") { escState = 4; }
      else escState = 0; // 单字符 ESC 序列（ESC 7 / ESC c 等），整段丢弃
      return;
    }
    if (escState === 2) {
      // CSI：0x40-0x7e 是终结字节，其它参数/中间字节累积。
      if (ch >= "@" && ch <= "~") {
        if (ch === "m") applySgr(escBuf, sgr);
        // 其余 CSI（光标移动、清屏等）整段丢弃，不留残字符。
        escState = 0;
      } else if (ch === ";" || ch === ":" || ch === "?" || ch === ">" || ch === "<" ||
        ch === "=" || ch === "!" || ch === '"' || ch === "'" || ch === "$" || ch === "*" ||
        ch === "+" || ch === "," || ch === "-" || ch === "." || ch === "/" || ch === " " ||
        (ch >= "0" && ch <= "9")) {
        escBuf += ch;
      } else {
        escState = 0; // 非法字节：整个序列作废丢弃
      }
      return;
    }
    if (escState === 3) {
      // OSC：BEL 或 ESC \ 终止，内容整段丢弃（窗口标题等）。
      if (ch === "\x07") escState = 0;
      else if (ch === "\x1b") escState = 5;
      return;
    }
    if (escState === 5) {
      // OSC/DCS 的 ESC \ 结尾：\ 之后序列结束。
      escState = 0;
      return;
    }
    if (escState === 4) {
      // DCS/SOS/PM/APC 字符串：到 ST（ESC \）结束。
      if (ch === "\x1b") escState = 5;
      return;
    }
    if (ch === "\x1b") { escState = 1; return; }
    // 普通字符：控制字符打断哨兵（哨兵内容里不会有 \n/\r/\t/\b），
    // 可见字符与 \x1e 走哨兵状态机。用码元判定而不是字符串比较——
    // '\x7f' >= ' ' 在 JS 里为 true（127 > 32），会把 DEL 当可见字符放行。
    const code = ch.charCodeAt(0);
    if (ch === "\x1e" || (code >= 32 && code !== 127)) {
      handleSentinel(ch);
      return;
    }
    breakSentinel();
    handleOrdinary(ch);
  }

  return {
    /**
     * 喂一段增量文本。先做 UTF-8 断字合并（上游 collector 在任意字节位置
     * toString("utf8")，多字节字符有概率被切成两个 U+FFFD；delta 末尾是
     * U+FFFD 且本次开头也是时，把这一对合并成一个，至少不出现两个方块。
     * 这是候选上游 PR（collector 应留住不完整的尾巴）的本地缓解）。
     * @param {string} text
     */
    push(text) {
      if (prevEndsReplacement && text.startsWith("\uFFFD")) {
        text = text.slice(1);
      }
      prevEndsReplacement = text.endsWith("\uFFFD");
      for (const part of splitStderr(text)) {
        // 流切换时半行收尾：stdout/stderr 的真实交错顺序拿不到（上游只给
        // 拼好的串），80ms 轮询下「每批 stdout 在前」已经是能做到的最好近似。
        if (part.stream !== curStream) {
          if (curLen > 0) emitLine();
          curStream = part.stream;
        }
        for (const ch of part.text) pushChar(ch);
      }
    },
    /** 进程结束时冲刷：把残余半行收为完整行，未闭合的哨兵丢弃。 */
    flush() {
      crPending = false;
      sentinelMode = S_IDLE;
      sentinelBuf = "";
      if (curLen > 0 || segs.length > 0) emitLine();
      // 尾部半行没有「下一行」可重写，replaceLast 在这里没有意义；
      // 但 emitLine 会把 pendingReplace 带上去 —— 进程结束帧客户端会
      // 当作普通行处理（替换尾部，此时尾部就是它自己或为空，无害）。
    },
    /** 取走本批产出的完整行并清空。 */
    take() {
      const lines = out;
      out = [];
      return lines;
    },
    /** 最后一个完整哨兵（可能没有）。只在进程结束后调用方据此更新 cwd/退出码。 */
    getSentinel() {
      return lastSentinel;
    }
  };
}

// ---------------------------------------------------------------------------
// 环形缓冲（行上限 + 字节上限，溢出丢头部）
// ---------------------------------------------------------------------------

/** UTF-8 字节数估计（Node 全局 Buffer，本文件零 import 依然可用）。 */
function bytesOf(line) {
  let n = 0;
  for (const seg of line.segments) n += Buffer.byteLength(seg.t, "utf8");
  return n;
}

/**
 * 行环形缓冲：超出上限从头部丢，并永久标记 truncated（hello 快照要如实告知
 * 客户端历史不全）。push 返回该行的 seq（单调递增，SSE 断线重连的锚点）。
 *
 * @param {{ maxLines?: number, maxBytes?: number }} [opts]
 */
export function createRingBuffer(opts = {}) {
  const maxLines = opts.maxLines ?? RING_MAX_LINES;
  const maxBytes = opts.maxBytes ?? RING_MAX_BYTES;
  /** @type {Array<{ seq: number, line: object }>} */
  let rows = [];
  let seq = 0;        // 已分配的最大行序号（下一行是 seq+1）
  let startSeq = 1;   // 窗口内第一行的 seq；空窗口时 = seq+1
  let bytes = 0;
  let truncated = false;
  let overflowNotice = false;

  return {
    push(line) {
      seq += 1;
      rows.push({ seq, line });
      bytes += bytesOf(line);
      let overflowed = false;
      while (rows.length > maxLines || (bytes > maxBytes && rows.length > 1)) {
        const dropped = rows.shift();
        if (dropped === undefined) break; // 防御：循环条件已保证非空，tsc 推断不出
        bytes -= bytesOf(dropped.line);
        overflowed = true;
      }
      if (overflowed) {
        truncated = true;
        overflowNotice = true;
        startSeq = rows.length > 0 ? rows[0].seq : seq + 1;
      }
      return seq;
    },
    /**
     * 按 since 取增量。since 落在窗口内（since ≥ startSeq-1）返回其后行；
     * 否则返回全量并置 inWindow=false，调用方应把 truncated 置真（历史不全）。
     * @param {number} since 客户端已见的最大 seq
     */
    slice(since) {
      if (typeof since !== "number" || !Number.isFinite(since)) since = 0;
      if (rows.length === 0) return { inWindow: since >= seq, lines: [] };
      if (since < startSeq - 1) return { inWindow: false, lines: rows.map((r) => r.line) };
      const lines = [];
      for (const r of rows) if (r.seq > since) lines.push(r.line);
      return { inWindow: true, lines };
    },
    /** 全量快照（hello 用）。 */
    snapshot() {
      return { lines: rows.map((r) => r.line), startSeq, endSeq: seq, truncated };
    },
    /** 清空（Ctrl+L 通知 node 半重置环形缓冲）。seq 不重置，否则 since 锚点会乱。 */
    reset() {
      rows = [];
      bytes = 0;
      startSeq = seq + 1;
    },
    /** 取走「发生过溢出」的一次性通知（调用方借此插一条 meta 行），没有返回 false。 */
    takeOverflowNotice() {
      if (overflowNotice) { overflowNotice = false; return true; }
      return false;
    },
    get truncated() { return truncated; },
    get seq() { return seq; },
    size() { return rows.length; }
  };
}

// ---------------------------------------------------------------------------
// Tab 补全的纯逻辑（真正读目录 / 扫 PATH 在 node 半）
// ---------------------------------------------------------------------------
//
// 补全为什么能做：它跟 PTY 无关。做不了的是 **shell 原生** 补全（别名、函数、
// git 子命令那种，要靠 shell 自己的补全器），而「路径 + 可执行文件名」这两类
// 占日常用量的绝大多数，完全可以我们自己算 —— 读目录、扫 PATH，都是 node 半
// 一次 fs 调用的事，不用起 shell 进程（起一个 PowerShell 就近 300ms，那样按一
// 次 Tab 要等小半秒，没法用）。

/**
 * 找出光标处正在输入的那个 token，并判断它处在不处在「命令位」。
 *
 * 引号内的空格不算分隔符；POSIX 上反斜杠转义的空格也不算 —— Windows 上反斜杠是
 * 路径分隔符，绝不能当转义符处理（`C:\Users\x` 会被啃掉一半），这是两个平台唯一
 * 的切词差异。
 *
 * @param {string} input 输入框全文
 * @param {number} cursor 光标位置
 * @param {'pwsh' | 'bash'} shellKind
 * @returns {{ start: number, end: number, value: string, commandPosition: boolean }}
 *   start/end 是要被替换的区间（含用户已经打出的引号），value 是去掉引号与转义后
 *   的字面值。
 */
export function tokenizeForCompletion(input, cursor, shellKind) {
  const text = input.slice(0, cursor);
  const allowEscape = shellKind !== "pwsh";
  let start = 0;
  let quote = "";
  // 当前 token 之前是否已经有过一个完整 token —— 没有就说明还在命令位。
  let sawToken = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      // 单引号里没有转义（两个 shell 都是这样）。
      if (allowEscape && ch === "\\" && quote === "\"" && i + 1 < text.length) { i++; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (allowEscape && ch === "\\" && i + 1 < text.length) { i++; continue; }
    if (ch === "\"" || ch === "'") { quote = ch; continue; }
    if (ch === " " || ch === "\t") {
      if (i > start) sawToken = true;
      start = i + 1;
      continue;
    }
    // 管道 / 语句分隔之后重新回到命令位（`ls | gre<Tab>` 要补命令而不是补路径）。
    if (ch === "|" || ch === ";" || ch === "&") {
      start = i + 1;
      sawToken = false;
      continue;
    }
  }
  let value = text.slice(start);
  if (value.startsWith("\"") || value.startsWith("'")) value = value.slice(1);
  if (allowEscape) value = value.replace(/\\(.)/g, "$1");
  return { start, end: cursor, value, commandPosition: !sawToken };
}

/**
 * 把 token 拆成「目录部分 + 待匹配的基名」。两种分隔符都认：Windows 上用户可能
 * 打 `src/`，PowerShell 也照样吃。
 * @param {string} value
 * @returns {{ dir: string, base: string }}
 */
export function splitPathPrefix(value) {
  const idx = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (idx === -1) return { dir: "", base: value };
  return { dir: value.slice(0, idx + 1), base: value.slice(idx + 1) };
}

/**
 * 候选的最长公共前缀（Windows 上大小写不敏感）。大小写不敏感时以第一个候选的
 * 原始大小写为准 —— 用户打 `desk` 补出 `Desktop` 才是对的。
 * @param {readonly string[]} items
 * @param {boolean} caseInsensitive
 */
export function longestCommonPrefix(items, caseInsensitive) {
  if (items.length === 0) return "";
  let prefix = items[0];
  for (const item of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < item.length) {
      const a = caseInsensitive ? prefix[i].toLowerCase() : prefix[i];
      const b = caseInsensitive ? item[i].toLowerCase() : item[i];
      if (a !== b) break;
      i++;
    }
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix;
}

/**
 * 需要引号才安全时把整个 token 包起来（含空格的路径是主要场景）。两个 shell 的
 * 单引号里都不做变量展开，唯一要处理的是单引号自身：pwsh 靠翻倍，bash 靠退出
 * 引号再拼一个转义单引号。
 * @param {string} text
 * @param {'pwsh' | 'bash'} shellKind
 */
export function quoteToken(text, shellKind) {
  if (!/[\s'"`$()\[\]{}&;|]/.test(text)) return text;
  if (shellKind === "pwsh") return "'" + text.replace(/'/g, "''") + "'";
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

/**
 * 由候选列表拼出「按一次 Tab 该往输入框里填什么」。
 *
 * 单候选就填完整候选；多候选只填公共前缀（不加空格，让用户接着打）—— 这就是
 * bash/PowerShell 的行为，第二次按 Tab 才列出候选（列出由调用方负责）。
 *
 * @param {string} dir 目录部分（原样保留用户打的分隔符）
 * @param {Array<{ name: string, trailing?: string }>} matches
 * @param {'pwsh' | 'bash'} shellKind
 * @param {boolean} caseInsensitive
 * @returns {{ insert: string, appendSpace: boolean }}
 */
export function buildCompletion(dir, matches, shellKind, caseInsensitive) {
  if (matches.length === 0) return { insert: "", appendSpace: false };
  if (matches.length === 1) {
    const only = matches[0];
    const trailing = only.trailing ?? "";
    return {
      insert: quoteToken(dir + only.name + trailing, shellKind),
      // 目录后面不加空格（还要继续往下走），文件/命令补完了才加。
      appendSpace: trailing === ""
    };
  }
  const common = longestCommonPrefix(matches.map((m) => m.name), caseInsensitive);
  return { insert: quoteToken(dir + common, shellKind), appendSpace: false };
}
