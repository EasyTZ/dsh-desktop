import { Service } from "@deepseek-ai/cordis";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCompletion,
  createLineModel,
  createRingBuffer,
  splitPathPrefix,
  tokenizeForCompletion
} from "./pure.js";

// 终端面板（host 半）。
//
// 会话状态全部活在这里：标签页 = 一个 TerminalSession，面板关掉不杀进程（用户跑着
// `npm run dev` 去看会话，回来还得在）。浏览器半通过 webServer 路由与之通信，
// 输出流走 SSE（WebRoute.handler 拥有完整响应生命周期，可以 hold 住响应）。
//
// 命令执行一律走 ctx.shell 官方 seam，不自己 spawn：
//   - Windows 自动是 pwsh、macOS/Linux 自动是 bash（跨平台兼容性的答案）；
//   - 进程组 kill、输出溢写落盘、凭据环境变量擦洗、组合体销毁时自动收尸都是白拿的。
// 每条命令都是**一个独立进程**，所以 cd 不会自然保留 —— cwd/退出码靠「哨兵」从
// 输出里解析（见 SENTINEL 一节），解析逻辑在 lib/pure.js（可单测）。
//
// 安全边界：浏览器半只传 workspaceId，路径在这里用 ctx.workspaceRegistry 解析；
// token 是主要防线（每条路由都校验 id+token），POST 强制 application/json 让
// 跨源请求死在 preflight，Origin 存在且非本服务自身就 403 —— 防的是浏览器里的
// 恶意页面打本机回环端口；本机上已经能跑代码的进程不在防御范围内。
//
// 信任假设要讲明白：token **不是权限隔离**。GET /api/terminal/sessions 把每个
// 会话的 token 明文返回且不要凭据，同源脚本本来就能自己 POST /session 造一个新
// 会话执行任意命令 —— 藏 token 的安全收益是零。真实的信任边界是「同源 = 完全
// 信任」（dsh 的客户端插件都跑在同源同进程里），token 防的只是跨源页面：它们
// 读不到响应体（我们从不发 Access-Control-Allow-Origin），也发不出合法请求
// （Origin 校验 + Content-Type 检查把它们挡在 preflight/403）。

/** 输出轮询间隔（ms）。stdout/stderr 的真实交错顺序拿不到，轮询越短越接近真实。 */
const POLL_MS = 80;
/** 标签页上限。 */
const MAX_SESSIONS = 8;
/** 单条命令长度上限。 */
const COMMAND_MAX_BYTES = 32 * 1024;
/** SSE 心跳间隔：防中间层掐连接。 */
const HEARTBEAT_MS = 15_000;

// ---------------------------------------------------------------------------
// 哨兵（sentinel）
// ---------------------------------------------------------------------------
// 每条命令是独立进程，退出码与 cwd 必须由追加在用户命令**末尾**的哨兵语句带回来
// （绝不能包裹用户命令，那会改变解析）。进程退出码因此不再是用户命令的退出码，
// 所以哨兵必须自己带退出码。
//
// bash（\036 = RS, U+001E）：printf 的 \036 在 JS 字符串里要写成 \\036 才是字面
// 反斜杠序列（JS 里 \0 是八进制转义）。$? 必须在用户命令后第一行立刻捕获。
const BASH_SENTINEL = `__dsh_code=$?
printf '\\036DSHX%s:%s\\036\\n' "$__dsh_code" "$PWD"`;

// pwsh：必须兼容 Windows PowerShell 5.1，所以用 [char]30 而不是 `u{1e}。
// $? 与 $LASTEXITCODE 必须在命令后第一行立刻捕获，晚一行就被后面的语句改写了。
// 每条命令都是新 pwsh 进程，$LASTEXITCODE 只有在本次真的跑过原生程序时才非 null。
const PWSH_SENTINEL = `$__dshOk = $?; $__dshLast = $LASTEXITCODE
$__dshCode = if ($__dshLast -ne $null) { $__dshLast } elseif ($__dshOk) { 0 } else { 1 }
Write-Output ([char]30 + "DSHX" + $__dshCode + ":" + (Get-Location).Path + [char]30)`;

// ---------------------------------------------------------------------------
// mac PATH 塌陷补偿
// ---------------------------------------------------------------------------
// GUI 启动的 Electron 只继承到 /usr/bin:/bin:/usr/sbin:/sbin，内核进程继承的也是
// 它，于是 brew / nvm 装的 node、git 全都「找不到命令」。缓解（仅 darwin、
// best-effort、结果缓存一次）：用 SHELL 的登录 shell 探测真实 PATH，成功就作为
// env: { PATH } 传进每次 resolve() —— dsh-shell 的 ENV_OVERRIDES 合并顺序是
// 「调用方 env 条目赢」。失败就算了、不报错、不重试。
//
// 更彻底的修法是在 L4 主进程里给整个内核修 PATH（连模型的 bash 工具一起受益），
// 那是 Mac 上线时的事，不属于本插件。
let macPath = null;
if (process.platform === "darwin") {
  execFile(process.env.SHELL || "/bin/zsh", ["-lc", "printf %s \"$PATH\""], {
    timeout: 2000,
    windowsHide: true
  }, (error, stdout) => {
    if (!error && typeof stdout === "string" && stdout.length > 0) macPath = stdout.trim();
  });
}

// ---------------------------------------------------------------------------
// 会话表
// ---------------------------------------------------------------------------
// 模块级（跟随 dsh-git 的 repoLocks 惯例）；插件卸载时由 teardown effect 清理。
/** @type {Map<string, object>} */
const sessions = new Map();

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** 校验 POST 的 Content-Type：不是 application/json 就 415（防无 preflight 的简单请求）。 */
function requireJson(req) {
  const ct = String(req.headers["content-type"] ?? "").toLowerCase();
  return ct.startsWith("application/json");
}

/**
 * Origin 校验：存在且不等于本服务自身 origin（同端口的 http://127.0.0.1 /
 * http://localhost）就拒绝。本服务从不发 Access-Control-Allow-Origin，所以跨源
 * 页面拿不到响应体 —— 但「拿不到响应」不等于「发不出请求」，恶意页面还是可以用
 * text/plain 发简单请求打本机回环端口，这条防线配合 Content-Type 检查一起关掉它。
 */
function originAllowed(req, port) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  return url.host === `127.0.0.1:${port}` || url.host === `localhost:${port}`;
}

/** 按 id+token 取会话；不存在或 token 不符返回 null（token 是主要防线）。 */
function resolveSession(id, token) {
  if (typeof id !== "string" || id.length === 0 || typeof token !== "string" || token.length === 0) {
    return null;
  }
  const session = sessions.get(id);
  if (!session || session.token !== token) return null;
  return session;
}

/** 构造一条 meta 行（我们自己插的提示，不经 ANSI/哨兵解析）。 */
function metaLine(text) {
  return { stream: "meta", segments: [{ t: text, cls: [] }] };
}

/** 发一个 SSE 帧。res 已销毁时静默跳过（写已关闭的流会抛错）。 */
function sendEvent(res, event, data) {
  if (res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 把一批行推进环形缓冲并广播给所有订阅者。 */
function appendLines(session, lines) {
  if (lines.length === 0) return;
  let seq = session.lines.seq;
  const appended = [];
  for (const line of lines) {
    seq = session.lines.push(line);
    appended.push(line);
  }
  // 环形缓冲溢出时插一条 meta 行（取一次性通知，避免刷屏）。
  if (session.lines.takeOverflowNotice()) {
    const notice = metaLine("输出行数超出上限，较早的内容已丢弃");
    seq = session.lines.push(notice);
    appended.push(notice);
  }
  let replaceLast = null;
  for (let i = appended.length - 1; i >= 0; i--) {
    if (appended[i].replaceLast) { replaceLast = appended[i]; break; }
  }
  broadcast(session, "lines", { seq, append: appended, replaceLast });
}

function broadcast(session, event, data) {
  for (const res of session.subscribers) sendEvent(res, event, data);
}

function broadcastStatus(session) {
  broadcast(session, "status", {
    seq: session.lines.seq,
    state: session.state,
    exitCode: session.lastExit ? session.lastExit.code : null,
    cwd: session.cwd,
    durationMs: session.lastExit ? session.lastExit.durationMs : null,
    currentCommand: session.currentCommand
  });
}

// ---------------------------------------------------------------------------
// 命令执行
// ---------------------------------------------------------------------------

function startPolling(session) {
  session.timer = setInterval(() => pollOnce(session), POLL_MS);
}

function stopPolling(session) {
  if (session.timer) {
    clearInterval(session.timer);
    session.timer = null;
  }
}

function pollOnce(session) {
  const proc = session.proc;
  if (!proc) {
    stopPolling(session);
    return;
  }
  const read = proc.readOutput();
  if (read.delta.length > 0) {
    session.model.push(read.delta);
    appendLines(session, session.model.take());
  }
  if (read.lossy) {
    // 上游 collector 的尾窗口是 64KB，轮询够快就不会丢；真丢了不能假装无事发生。
    appendLines(session, [metaLine("输出过快，部分内容被丢弃")]);
  }
  if (proc.status !== "running") {
    // status 只在 done 结算时变化，所以走到这里说明进程已结束、缓冲已可完整读取。
    stopPolling(session);
    finishSession(session);
  }
}

function finishSession(session) {
  if (session.finishDone) return;
  session.finishDone = true;
  const proc = session.proc;

  // 进程结束后缓冲仍可读（readOutput 是尾窗口），再读一次拿残余输出。
  if (proc) {
    const read = proc.readOutput();
    if (read.delta.length > 0) {
      session.model.push(read.delta);
      appendLines(session, session.model.take());
    }
  }
  // 冲刷尾部半行（只把完整行进模型，最后一行在进程结束时收尾）。
  session.model.flush();
  appendLines(session, session.model.take());

  // 只认最后一个完整哨兵，且只在 done 之后据此更新 cwd。哨兵没出现（用户命令里
  // 有 exit、进程被 kill、shell 自己崩了）：保持旧 cwd，退出码退回 proc.exitCode，
  // 不报错。
  const sentinel = session.model.getSentinel();
  let exitCode = proc ? proc.exitCode : null;
  if (sentinel) {
    session.cwd = sentinel.cwd;
    exitCode = sentinel.code;
  }

  const durationMs = Date.now() - session.startedAt;
  if (exitCode !== null && exitCode !== 0) {
    appendLines(session, [metaLine(`✗ 退出码 ${exitCode} · ${(durationMs / 1000).toFixed(1)}s`)]);
  } else if (exitCode === 0 && durationMs >= 2000) {
    // 退出码 0 且耗时 ≥ 2s 才插「完成」行；太快的不插，避免噪音。
    appendLines(session, [metaLine(`✓ 完成 · ${(durationMs / 1000).toFixed(1)}s`)]);
  }

  session.state = "idle";
  session.proc = null;
  session.currentCommand = null;
  session.lastExit = { code: exitCode, durationMs, at: Date.now() };
  broadcastStatus(session);
}

// ---------------------------------------------------------------------------
// 路由 handlers
// ---------------------------------------------------------------------------

async function handleSessions(ctx, req, res) {
  if (req.method !== "GET") return sendJson(res, 405, fail("method-not-allowed", "GET only"));
  const list = [...sessions.values()].map((s) => ({
    id: s.id,
    token: s.token,
    // 浏览器半用它给命令历史分桶（按工作区存，不能按会话 id 存）。
    workspaceId: s.workspaceId,
    cwd: s.cwd,
    shellKind: s.shellKind,
    state: s.state,
    currentCommand: s.currentCommand,
    // 比说明书多带 lastExit：侧边栏徽标要感知「面板关闭期间有后台命令结束且
    // 非零退出」，客户端靠轮询比对 lastExit.at 检测新事件。
    lastExit: s.lastExit
  }));
  return sendJson(res, 200, { ok: true, data: { sessions: list } });
}

async function handleSession(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  if (!requireJson(req)) return sendJson(res, 415, fail("unsupported-media-type", "Content-Type 必须是 application/json"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  if (sessions.size >= MAX_SESSIONS) {
    return sendJson(res, 200, fail("limit", "最多只能同时开 8 个终端标签"));
  }
  const workspaceId = body.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return sendJson(res, 200, fail("missing-workspace", "缺少 workspaceId"));
  }
  const workspace = ctx.workspaceRegistry.get(workspaceId);
  if (!workspace) {
    return sendJson(res, 200, fail("workspace-not-found", "工作区不存在"));
  }
  const session = {
    id: randomUUID(),
    token: randomUUID(),
    workspaceId,
    cwd: workspace.path,
    // shellKind 按平台判定 —— bundle 就是按这个开关切 executor 的，这是忠实代理。
    shellKind: process.platform === "win32" ? "pwsh" : "bash",
    state: "idle",
    proc: null,
    currentCommand: null,
    startedAt: null,
    lines: createRingBuffer(),
    model: createLineModel(),
    subscribers: new Set(),
    finishDone: false,
    lastExit: null,
    timer: null
  };
  sessions.set(session.id, session);
  return sendJson(res, 200, { ok: true, data: { id: session.id, token: session.token, workspaceId: session.workspaceId, cwd: session.cwd, shellKind: session.shellKind } });
}

async function handleExec(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  if (!requireJson(req)) return sendJson(res, 415, fail("unsupported-media-type", "Content-Type 必须是 application/json"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const session = resolveSession(body.id, body.token);
  if (!session) return sendJson(res, 403, fail("forbidden", "会话不存在或 token 无效"));
  const command = typeof body.command === "string" ? body.command : "";
  if (command.trim().length === 0) return sendJson(res, 200, fail("bad-request", "命令不能为空"));
  if (command.length > COMMAND_MAX_BYTES) return sendJson(res, 200, fail("command-too-long", "命令过长"));
  if (session.state === "running") {
    // 每会话串行：running 时拒绝，不排队。
    return sendJson(res, 200, fail("busy", "命令正在运行中"));
  }

  // 用户命令原样交给 ctx.shell（它本来就是 shell，不存在「命令注入」这回事），
  // 但我们自己拼的哨兵只能追加在末尾。
  const full = session.shellKind === "pwsh"
    ? `${command}\n${PWSH_SENTINEL}`
    : `${command}\n${BASH_SENTINEL}`;
  const spec = ctx.shell.resolve({
    command: full,
    workdir: session.cwd,
    // mac PATH 探测结果（可能为 null，resolve 会忽略 undefined env）。
    env: macPath ? { PATH: macPath } : undefined,
    // 显式 danger-full-access：沙箱存在的目的是约束**模型**，而这里每一条命令
    // 都是用户自己敲下 Enter 的，用户就是信任根；一个 npm i -g 都跑不了、写不了
    // 工作区外文件的「终端」是坏的，而且会被当成 bug。dsh-pwsh-sandbox /
    // dsh-bash-sandbox 的 resolve 尊重调用方传的 sandboxPolicy（不传才回退
    // 部署策略），danger-full-access 在 run/start 里完全绕过 confine。
    sandboxPolicy: { mode: "danger-full-access", workspaceRoot: session.cwd }
  });

  let proc;
  try {
    proc = ctx.shell.start(spec);
  } catch (error) {
    return sendJson(res, 200, fail("spawn-failed", error?.message ?? "无法启动 shell 进程"));
  }

  session.state = "running";
  session.proc = proc;
  session.currentCommand = command;
  session.startedAt = Date.now();
  session.finishDone = false;
  // 命令回显（meta 行）先于 status 广播，客户端先看到回显再看到运行态。
  appendLines(session, [metaLine(`❯ ${command}`)]);
  broadcastStatus(session);
  startPolling(session);
  return sendJson(res, 200, { ok: true });
}

async function handleSignal(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  if (!requireJson(req)) return sendJson(res, 415, fail("unsupported-media-type", "Content-Type 必须是 application/json"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const session = resolveSession(body.id, body.token);
  if (!session) return sendJson(res, 403, fail("forbidden", "会话不存在或 token 无效"));
  if (session.state === "running" && session.proc) {
    appendLines(session, [metaLine("^C")]);
    // proc.kill() 是进程组级别的（两个平台都处理过了），返回 false 表示已结束，幂等。
    session.proc.kill();
  }
  return sendJson(res, 200, { ok: true });
}

async function handleClose(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  if (!requireJson(req)) return sendJson(res, 415, fail("unsupported-media-type", "Content-Type 必须是 application/json"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const session = resolveSession(body.id, body.token);
  if (!session) return sendJson(res, 403, fail("forbidden", "会话不存在或 token 无效"));
  stopPolling(session);
  session.proc?.kill();
  // 主动结束所有 SSE 订阅（客户端 EventSource 会触发 error 并自行清理）。
  for (const sub of session.subscribers) {
    if (!sub.destroyed) sub.end();
  }
  session.subscribers.clear();
  sessions.delete(session.id);
  return sendJson(res, 200, { ok: true });
}

async function handleClear(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  if (!requireJson(req)) return sendJson(res, 415, fail("unsupported-media-type", "Content-Type 必须是 application/json"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const session = resolveSession(body.id, body.token);
  if (!session) return sendJson(res, 403, fail("forbidden", "会话不存在或 token 无效"));
  // 重置环形缓冲（seq 不重置，否则客户端 since 锚点会乱）；行模型也换新的，
  // 清掉未闭合的哨兵/半行 —— 正在跑的命令输出从下一段 delta 继续，可接受。
  session.lines.reset();
  session.model = createLineModel();
  return sendJson(res, 200, { ok: true });
}

/** SSE 流：hello（全量/增量快照）→ lines / status 实时帧 + 15s 心跳。 */
async function handleStream(ctx, req, res) {
  if (req.method !== "GET") return sendJson(res, 405, fail("method-not-allowed", "GET only"));
  const url = new URL(req.url, "http://localhost");
  const session = resolveSession(url.searchParams.get("id"), url.searchParams.get("token"));
  if (!session) return sendJson(res, 403, fail("forbidden", "会话不存在或 token 无效"));
  const sinceParam = Number(url.searchParams.get("since"));
  const since = Number.isFinite(sinceParam) && sinceParam >= 0 ? sinceParam : 0;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    // 防中间层（nginx 等）缓冲 SSE。
    "x-accel-buffering": "no"
  });
  res.flushHeaders();

  // 顺序很关键：先同步取快照，再加入订阅者，最后写 hello —— 加入订阅者之后到达
  // 的任何新行都会走广播，而 hello 一定先于广播写出（Node 单线程，这三步之间
  // 不会有其它事件插入），所以快照与实时流之间不会丢行。
  const sliced = session.lines.slice(since);
  session.subscribers.add(res);
  sendEvent(res, "hello", {
    seq: session.lines.seq,
    lines: sliced.lines,
    // since 落在窗口外（历史被环形缓冲丢过）必须如实告知，客户端整段替换。
    truncated: !sliced.inWindow || session.lines.truncated,
    state: session.state,
    cwd: session.cwd,
    currentCommand: session.currentCommand
  });

  const heartbeat = setInterval(() => {
    if (res.destroyed) return;
    // 注释帧：`: heartbeat\n\n` 不是事件，客户端自动忽略。
    res.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  res.on("close", () => {
    session.subscribers.delete(res);
    clearInterval(heartbeat);
  });
}

// ---------------------------------------------------------------------------
// Tab 补全
// ---------------------------------------------------------------------------
// 全部在 node 里算（读目录 / 扫 PATH），不起 shell 进程 —— 起一个 PowerShell 就近
// 300ms，按一次 Tab 等小半秒没人能用。代价是补不出 shell 原生的东西（别名、函数、
// git 子命令那类要 shell 自己的补全器），而「路径 + 可执行文件名」覆盖了日常绝大
// 多数场景。这跟有没有 PTY 无关。

/** 补全候选上限：再多列出来也没法看，超了截断并告知。 */
const MAX_COMPLETION_ITEMS = 200;
/** PATH 扫描缓存：一次要遍历几十个目录（Windows 上尤其慢），10s 内复用。 */
let pathCommandsCache = { at: 0, names: /** @type {string[]} */ ([]) };

function readDirEntries(dirAbs) {
  try {
    return fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    // 目录不存在 / 没权限：补不出来就算了，不该报错打断用户输入。
    return [];
  }
}

/** Windows 大小写不敏感：用户打 desk 要能补出 Desktop。 */
function startsWithCase(name, prefix, caseInsensitive) {
  if (prefix.length === 0) return true;
  return caseInsensitive
    ? name.toLowerCase().startsWith(prefix.toLowerCase())
    : name.startsWith(prefix);
}

/** PATH 上的可执行文件名（Windows 按 PATHEXT 去掉扩展名，`git.exe` → `git`）。 */
function listPathCommands() {
  const now = Date.now();
  if (now - pathCommandsCache.at < 10000) return pathCommandsCache.names;
  const isWin = process.platform === "win32";
  const exts = isWin
    ? String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";").filter((e) => e.length > 0)
    : null;
  // 本地拦截的那几条不在 PATH 上，但用户会指望补出来。
  const names = new Set(["cd", "clear", "cls", "exit"]);
  // mac 上优先用登录 shell 探到的 PATH（GUI 启动的 Electron 那份是残的，见文件头）。
  const rawPath = macPath ?? process.env.PATH ?? "";
  for (const dir of rawPath.split(isWin ? ";" : ":")) {
    if (dir.length === 0) continue;
    for (const entry of readDirEntries(dir)) {
      if (entry.isDirectory()) continue;
      if (!exts) { names.add(entry.name); continue; }
      const lower = entry.name.toLowerCase();
      const ext = exts.find((e) => lower.endsWith(e));
      if (ext !== undefined) names.add(entry.name.slice(0, entry.name.length - ext.length));
    }
  }
  pathCommandsCache = { at: now, names: [...names].sort() };
  return pathCommandsCache.names;
}

/**
 * 路径候选。相对路径一律相对**会话自己的 cwd** 解析 —— 浏览器半只传输入框原文，
 * 真实路径永远只在这边算（跟 git 插件同一条安全边界）。
 */
function completePath(session, value) {
  const isWin = process.platform === "win32";
  const { dir, base } = splitPathPrefix(value);
  let dirPart = dir;
  // ~ 展开只在 POSIX 做：Windows 上 ~ 不是家目录的写法。
  if (!isWin && dirPart.startsWith("~")) dirPart = os.homedir() + dirPart.slice(1);
  const abs = path.resolve(session.cwd, dirPart.length > 0 ? dirPart : ".");
  // 补出来的分隔符跟着用户已经打的走：打了 src/ 就继续用 /，否则用平台默认。
  const sepChar = dir.includes("/") && !dir.includes("\\") ? "/" : path.sep;
  const matches = [];
  for (const entry of readDirEntries(abs)) {
    // 隐藏文件只在用户明确打了「.」开头时才出现（POSIX 惯例）。
    if (entry.name.startsWith(".") && !base.startsWith(".")) continue;
    if (!startsWithCase(entry.name, base, isWin)) continue;
    matches.push({ name: entry.name, trailing: entry.isDirectory() ? sepChar : "" });
  }
  matches.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, matches };
}

async function handleComplete(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  if (!requireJson(req)) return sendJson(res, 415, fail("unsupported-media-type", "Content-Type 必须是 application/json"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const session = resolveSession(body.id, body.token);
  if (!session) return sendJson(res, 403, fail("forbidden", "会话不存在或 token 无效"));
  const input = typeof body.input === "string" ? body.input.slice(0, COMMAND_MAX_BYTES) : "";
  const rawCursor = Number(body.cursor);
  const cursor = Number.isFinite(rawCursor)
    ? Math.max(0, Math.min(input.length, Math.trunc(rawCursor)))
    : input.length;

  const isWin = process.platform === "win32";
  const token = tokenizeForCompletion(input, cursor, session.shellKind);
  // 命令位、且没打出路径的样子（含分隔符 / . / ~ 开头）才补命令名；`./build.ps1`
  // 这种虽然在命令位，但显然是要补路径。
  const looksLikePath = /[\\/~]/.test(token.value) || token.value.startsWith(".");
  let dir = "";
  let matches;
  if (token.commandPosition && !looksLikePath) {
    matches = listPathCommands()
      .filter((name) => startsWithCase(name, token.value, isWin))
      .map((name) => ({ name, trailing: "" }));
  } else {
    const found = completePath(session, token.value);
    dir = found.dir;
    matches = found.matches;
  }
  const truncated = matches.length > MAX_COMPLETION_ITEMS;
  if (truncated) matches = matches.slice(0, MAX_COMPLETION_ITEMS);
  const built = buildCompletion(dir, matches, session.shellKind, isWin);
  return sendJson(res, 200, {
    ok: true,
    data: {
      start: token.start,
      end: token.end,
      insert: built.insert,
      appendSpace: built.appendSpace,
      items: matches.map((m) => m.name + (m.trailing ?? "")),
      truncated
    }
  });
}

// ---------------------------------------------------------------------------
// 在系统终端中打开
// ---------------------------------------------------------------------------
// 面板里跑不了交互式程序（vim、sudo 密码、npm init 的问答），这是命令控制台的
// 硬边界。与其让用户卡在那儿，不如给个台阶：一键用**会话当前的 cwd**（不是工作区
// 根目录 —— 用户可能已经 cd 到很深的地方了）拉起系统自带的终端。
//
// 用 spawn + detached + unref：拉起来的终端不能是内核进程的子进程，否则内核退出
// 会把它一起带走，而且 stdio 挂着会让父进程等它。

/** 拉起系统终端，返回是否成功起来了（起不来才算失败，退出码不作数）。 */
function openSystemTerminal(cwd) {
  const platform = process.platform;
  /** @type {Array<{ cmd: string, args: string[] }>} */
  let candidates;
  if (platform === "win32") {
    candidates = [
      // Windows Terminal（Win11 自带；-d 指定起始目录）
      { cmd: "wt.exe", args: ["-d", cwd] },
      // 回退：直接起 PowerShell。detached 在 Windows 上会给子进程分配新控制台窗口。
      { cmd: "powershell.exe", args: ["-NoLogo", "-NoExit"] }
    ];
  } else if (platform === "darwin") {
    candidates = [{ cmd: "open", args: ["-a", "Terminal", cwd] }];
  } else {
    candidates = [
      { cmd: "x-terminal-emulator", args: [] },
      { cmd: "gnome-terminal", args: [] },
      { cmd: "xterm", args: [] }
    ];
  }

  return new Promise((resolve, reject) => {
    const tryNext = (index) => {
      if (index >= candidates.length) {
        reject(new Error("未找到可用的系统终端"));
        return;
      }
      const { cmd, args } = candidates[index];
      let settled = false;
      let child;
      try {
        child = spawn(cmd, args, { cwd, detached: true, stdio: "ignore", windowsHide: false });
      } catch {
        tryNext(index + 1);
        return;
      }
      child.on("error", (error) => {
        // ENOENT = 这个终端在这台机器上不存在，换下一个候选。其它错误同样换，
        // 反正候选列表末尾还有兜底。
        if (settled) return;
        settled = true;
        void error;
        tryNext(index + 1);
      });
      // 起进程是异步的，error 事件要到下一轮 tick 才可能来；给一小段时间，
      // 没报错就认为起来了（终端窗口的生命周期跟我们无关，不能等它退出）。
      setTimeout(() => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve();
      }, 300);
    };
    tryNext(0);
  });
}

async function handleOpenExternal(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  if (!requireJson(req)) return sendJson(res, 415, fail("unsupported-media-type", "Content-Type 必须是 application/json"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const session = resolveSession(body.id, body.token);
  if (!session) return sendJson(res, 403, fail("forbidden", "会话不存在或 token 无效"));
  // cwd 可能已经被删掉（用户在别处 rm 了这个目录），起终端前先确认。
  if (!fs.existsSync(session.cwd)) {
    return sendJson(res, 200, fail("path-not-found", "当前目录不存在，可能已被移动或删除"));
  }
  try {
    await openSystemTerminal(session.cwd);
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 200, fail("open-failed", error?.message ?? "无法打开系统终端"));
  }
}

const ROUTES = [
  ["/api/terminal/sessions", handleSessions],
  ["/api/terminal/session", handleSession],
  ["/api/terminal/exec", handleExec],
  ["/api/terminal/signal", handleSignal],
  ["/api/terminal/close", handleClose],
  ["/api/terminal/complete", handleComplete],
  ["/api/terminal/open-external", handleOpenExternal],
  // clear 不在任务书的路由表里，但 UI 明确要求 Ctrl+L「通知 node 半重置环形缓冲」。
  ["/api/terminal/clear", handleClear],
  ["/api/terminal/stream", handleStream]
];

class TerminalPanelService extends Service {
  static inject = ["webServer", "workspaceRegistry", "shell"];

  constructor(ctx) {
    super(ctx, "terminalPanel");
    for (const [path, handler] of ROUTES) {
      this.ctx.effect(() => this.ctx.webServer.register({
        kind: "exact",
        path,
        handler: (req, res) => {
          // port 在请求时动态取：webServer 是 [Service.init] 时才绑定端口，
          // 构造期缓存会拿到 undefined。listen 未完成时宽放（同源页面此刻
          // 也还在启动阶段，发不出请求）。
          const port = this.ctx.webServer.port;
          if (port != null && !originAllowed(req, port)) {
            return sendJson(res, 403, fail("forbidden", "Origin 不被允许"));
          }
          return handler(this.ctx, req, res);
        }
      }), `terminal-panel: ${path}`);
    }
    // 插件卸载：杀掉所有还在跑的进程并清空会话表 —— 面板关闭不杀进程，但插件
    // 卸载（热重载/禁用）必须收尸，否则留下孤儿 shell 进程。
    this.ctx.effect(() => () => {
      for (const session of sessions.values()) {
        stopPolling(session);
        session.proc?.kill();
      }
      sessions.clear();
    }, "terminal-panel: teardown");
  }
}

export default TerminalPanelService;
