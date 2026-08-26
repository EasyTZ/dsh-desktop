import { Service } from "@deepseek-ai/cordis";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * 在系统文件管理器里打开当前会话所在工作区的目录（host 半）。
 * 只有一条路由，浏览器半 fetch 它。走 webServer 路由而非 Typert Remote，
 * 理由同其它插件：避免依赖编译生成的 remote descriptor（本项目无编译步骤）。
 *
 * 安全边界：浏览器半只传 workspaceId，这里用 ctx.workspaceRegistry 把它解析
 * 成真实路径——绝不能让浏览器半直接传路径，否则等于开放任意目录的打开能力。
 */

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

function resolveWorkspacePath(ctx, workspaceId) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return { error: { code: "missing-workspace", message: "缺少 workspaceId" } };
  }
  const workspace = ctx.workspaceRegistry.get(workspaceId);
  if (!workspace) {
    return { error: { code: "workspace-not-found", message: "工作区不存在" } };
  }
  return { path: workspace.path };
}

/**
 * 用系统文件管理器打开一个目录。本项目目前只出 Windows 包，但插件代码本身
 * 没理由锁死平台——真跑在别的系统上，至少不会因为「完全没考虑过」而崩。
 * @param {string} dirPath
 */
function openInFileManager(dirPath) {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    const cmd = platform === "win32" ? "explorer.exe" : platform === "darwin" ? "open" : "xdg-open";
    execFile(cmd, [dirPath], (error) => {
      // explorer.exe 有个众所周知的怪癖：窗口确实打开了，仍可能返回非零退出码
      // （具体跟路径形式有关）。不能把「非零退出码」当成「打开失败」——只有
      // 连进程都起不来（ENOENT，比如系统里没有这个命令）才是真的失败。
      if (error && error.code === "ENOENT") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function handleReveal(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const resolved = resolveWorkspacePath(ctx, body.workspaceId);
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  // explorer.exe 打开一个不存在的目录时也返回跟"打开成功"完全相同的非零退出码
  // （实测确认过），没法靠它自己的返回值区分——只能在调用前自己先查一遍目录
  // 是否还在。工作区注册之后目录被移动/删除是会真实发生的（尤其是长期没用的
  // 工作区），不检查就会对着一个空错误对话框汇报"已打开"。
  if (!existsSync(resolved.path)) {
    return sendJson(res, 200, fail("path-not-found", "该目录不存在，可能已被移动或删除"));
  }
  try {
    await openInFileManager(resolved.path);
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    const code = error?.code === "ENOENT" ? "opener-not-found" : "open-failed";
    const message = error?.code === "ENOENT" ? "未找到系统文件管理器命令" : (error?.message ?? "打开失败");
    return sendJson(res, 200, { ok: false, error: { code, message } });
  }
}

class RevealExplorerService extends Service {
  static inject = ["webServer", "workspaceRegistry"];

  constructor(ctx) {
    super(ctx, "reveal-explorer");
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: "exact",
      path: "/api/reveal-explorer",
      handler: (req, res) => handleReveal(this.ctx, req, res)
    }), "reveal-explorer: web route");
  }
}

export default RevealExplorerService;
