import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextUserState } from "./pure.js";

/**
 * 插件管理面板（host 半）：两条 /api/dsdesktop/plugin-manager/* 路由，浏览器半
 * fetch 它们。走 webServer 路由而非 Typert Remote，理由同其它插件：避免依赖编译
 * 生成的 remote descriptor（本项目无编译步骤）。
 *
 * 用**函数形式**的插件而不是 `Service` 子类：本插件不向任何人提供能力，占一个
 * cordis 服务名只有坏处 —— `ctx.provide` 撞名是直接抛异常的，等于在 boot 阶段
 * 杀掉内核、桌面端黑屏，和 loader 的 `duplicate loader entry id` 同一类事故。
 * 这条对本插件尤其要紧：它是安全模式下**唯一**被加载的插件，也就是「插件把内核
 * 搞崩」时的唯一逃生舱 —— 逃生舱自己不能是崩溃源。
 *
 * 路由统一挂 `/api/dsdesktop/` 前缀，同理由：webServer 的 `register` 对重复
 * (kind, path) 也是直接抛。
 *
 * 边界要说清楚——这个插件管理的是「桌面发行版随包分发的插件」的开关，而开关
 * 的最终裁决（清单默认值被用户状态覆盖 → 生成激活 overlay）在 dsDesktop 的
 * src/shared/plugin-install.js / plugin-state.js 里，那里是唯一实现。本插件
 * **不复制**那套合并逻辑，只做三件原始的事：
 *
 *   1) 读插件清单：DSH_DESKTOP_PLUGINS_DIR 环境变量（主进程注入，绝不硬编码
 *      %APPDATA% 之类的机器路径）；
 *   2) 读写原始状态文件：DSH_DESKTOP_PLUGIN_STATE（同上）。只写
 *      `{ "<entryId>": <bool> }` 的原始覆盖值，不在这边算「有效状态」；
 *   3) 把「当前实际激活集合」从激活 overlay（DSH_DESKTOP_ACTIVATION_PATCH）
 *      里读出来——overlay 本身就是共享合并逻辑的输出，读它等于读合并结果，
 *      面板不需要（也不允许）自己再算一遍。
 *
 * 插件的描述与版本从兄弟包的 package.json 读：安装时所有插件与本体平铺在
 * 同一个 node_modules 里（开发态全局 dsh 的嵌套布局、热更新内核的 hoisted
 * 布局都成立），且被关掉的插件也照样安装——所以这里总能读到。
 */

// 激活 overlay 里 insert 条目的行格式（renderActivationPatch 生成）：
// `    - id: <entryId>`。name 行不会命中这个模式，逐行匹配足够。
const INSERT_ID_RE = /^\s*-\s+id:\s*(\S+)\s*$/;

/** 本包自己的根目录。 */
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 本包的包名（判定「管理面板自身」用，不硬编码 entryId）。
 *
 * **读失败必须退化，不能抛**。这是模块顶层的同步 IO：抛出去就是 import 阶段
 * 失败 → 内核秒退 → 桌面端黑屏（v1.1.1 同一类），而且崩掉的恰好是唯一能关掉
 * 出问题插件的恢复入口，用户没有任何自救手段——删 %APPDATA% 没用（插件在安装
 * 目录、overlay 从清单重新生成），重装也没用（同一份包），只能等新版本。
 * package.json 读不到的现实原因：安装残缺、杀软隔离、拷贝中断。
 *
 * 退回常量在语义上是安全的：这是**本包自己的**名字，编码时就已确定，与
 * package.json 里的 name 字段是同一个事实的两处书写。
 */
const OWN_NAME = readOwnName();

function readOwnName() {
  try {
    const name = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).name;
    if (typeof name === "string" && name.length > 0) return name;
  } catch {}
  return "dsh-plugin-manager";
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
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
 *
 * 本插件的写操作是「关掉某个插件」。拿不到响应也无所谓——攻击者不需要读回结果，
 * 把 Git 面板或终端面板关掉就已经是有效破坏，用户下次重启才会发现。
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

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readJsonBody(req, limitBytes = 64 * 1024) {
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

/** 读兄弟插件的 package.json（描述/版本仅用于展示，读不到就退化为空）。 */
function readSiblingMeta(packageName) {
  const pkg = readJsonSafe(join(PKG_ROOT, "..", packageName, "package.json"));
  if (!pkg || typeof pkg !== "object") return {};
  return {
    description: typeof pkg.description === "string" ? pkg.description : null,
    version: typeof pkg.version === "string" ? pkg.version : null,
  };
}

/** 从激活 overlay 里读出当前实际激活的 entryId 集合；文件缺失/不可读按空集。 */
function readActiveEntryIds(patchPath) {
  if (!patchPath || !existsSync(patchPath)) return new Set();
  try {
    const active = new Set();
    for (const line of readFileSync(patchPath, "utf8").split(/\r?\n/)) {
      const m = INSERT_ID_RE.exec(line);
      if (m) active.add(m[1]);
    }
    return active;
  } catch {
    return new Set();
  }
}

/** 读用户状态文件（原始覆盖值）。读不到按「没有任何覆盖」处理。 */
function readUserState(statePath) {
  if (!statePath) return {};
  const parsed = readJsonSafe(statePath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const state = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "boolean") state[key] = value;
  }
  return state;
}

/**
 * 把一项覆盖值写回状态文件（读-改-写）。合并语义在 pure.js：等于清单默认值的
 * 项**删键**而不是写入，状态文件只记录偏离默认的项。
 * @param {string} statePath
 * @param {{ entryId: string, enabled?: boolean }} plugin 清单条目（要用它的默认值）
 * @param {boolean} enabled
 */
function writeUserState(statePath, plugin, enabled) {
  const state = nextUserState(readUserState(statePath), plugin, enabled);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function handleList(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, fail("method-not-allowed", "GET only"));
  }
  const env = process.env;
  const pluginsDir = env.DSH_DESKTOP_PLUGINS_DIR;
  if (!pluginsDir) {
    // 只在桌面发行版里跑得起来（环境变量由外壳注入）；单独装进裸 dsh 时给出
    // 明确原因，而不是让面板对着一个读不到的路径转圈。
    return sendJson(res, 200, fail("missing-env", "插件管理仅桌面版可用（缺少外壳注入的环境变量）"));
  }
  const manifest = readJsonSafe(join(pluginsDir, "plugins.json"));
  if (!Array.isArray(manifest)) {
    return sendJson(res, 200, fail("manifest-unreadable", "插件清单读不出来"));
  }
  const active = readActiveEntryIds(env.DSH_DESKTOP_ACTIVATION_PATCH);
  const plugins = [];
  for (const plugin of manifest) {
    if (typeof plugin?.packageName !== "string" || typeof plugin?.entryId !== "string") continue;
    const meta = readSiblingMeta(plugin.packageName);
    plugins.push({
      entryId: plugin.entryId,
      packageName: plugin.packageName,
      description: meta.description ?? null,
      version: meta.version ?? null,
      // 「当前激活」以 overlay 为准：它是共享合并逻辑（清单默认值 × 用户状态）
      // 的输出快照，读它比在这里重新实现一遍合并可靠。
      active: active.has(plugin.entryId),
      self: plugin.packageName === OWN_NAME,
    });
  }
  // 安全模式由外壳经环境变量告知：这一次启动刻意跳过了非恢复类插件，面板要说
  // 明白「插件不是丢了」，否则用户看到列表里全是「未激活」只会更慌。
  const safeMode = env.DSH_DESKTOP_SAFE_MODE === "1";
  return sendJson(res, 200, { ok: true, data: { plugins, safeMode } });
}

async function handleToggle(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  const env = process.env;
  const pluginsDir = env.DSH_DESKTOP_PLUGINS_DIR;
  const statePath = env.DSH_DESKTOP_PLUGIN_STATE;
  if (!pluginsDir || !statePath) {
    return sendJson(res, 200, fail("missing-env", "插件管理仅桌面版可用（缺少外壳注入的环境变量）"));
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const entryId = typeof body.entryId === "string" ? body.entryId : "";
  const manifest = readJsonSafe(join(pluginsDir, "plugins.json"));
  const plugin = Array.isArray(manifest)
    ? manifest.find((p) => p && p.entryId === entryId && typeof p.packageName === "string")
    : undefined;
  if (!plugin) return sendJson(res, 200, fail("unknown-plugin", "清单里没有这个插件"));
  // 管理面板自身不可关：关掉它，重启后面板一起消失，用户就没有再打开的入口了
  // （只能手删状态文件），这是必须挡住的自我反锁。
  if (plugin.packageName === OWN_NAME) {
    return sendJson(res, 200, fail("self-locked", "插件管理面板自身不能关闭"));
  }
  if (typeof body.enabled !== "boolean") {
    return sendJson(res, 200, fail("bad-request", "enabled 必须是布尔值"));
  }
  try {
    writeUserState(statePath, plugin, body.enabled);
  } catch (error) {
    return sendJson(res, 200, fail("state-write-failed", `状态写入失败：${error?.message ?? error}`));
  }
  return sendJson(res, 200, { ok: true });
}

/** 所有桌面端插件的路由都挤在这个我们自己说了算的前缀下，见文件头注释。 */
const ROUTE_PREFIX = "/api/dsdesktop/plugin-manager";

const ROUTES = [
  ["/plugins", handleList],
  ["/plugins/toggle", handleToggle],
];

/**
 * 所有路由的统一入口防线。放在这里而不是各个 handler 里：这套检查的价值来自
 * 「一条都不漏」，撒进各个 handler 就会有下一个忘记加。
 */
function guard(ctx, req, res, handler) {
  // port 在请求时动态取：webServer 是 [Service.init] 时才绑定端口，
  // apply 执行时读到的还是 null。
  const port = ctx.webServer.port;
  if (port != null && !originAllowed(req, port)) {
    return sendJson(res, 403, fail("forbidden-origin", "跨源请求被拒绝"));
  }
  if (req.method === "POST" && !requireJson(req)) {
    return sendJson(res, 415, fail("unsupported-media-type", "Content-Type 必须是 application/json"));
  }
  return handler(req, res);
}

export const name = "dsh-plugin-manager";

export const inject = ["webServer"];

export function apply(ctx) {
  for (const [suffix, handler] of ROUTES) {
    const path = `${ROUTE_PREFIX}${suffix}`;
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path,
      handler: (req, res) => guard(ctx, req, res, handler)
    }), `plugin-manager: ${path}`);
  }
}
