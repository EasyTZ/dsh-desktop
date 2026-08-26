import { Service } from "@deepseek-ai/cordis";
import { execFile } from "node:child_process";

/**
 * Git 可视化面板（host 半）。
 * 注册 5 条 /api/git/* 路由，浏览器半 fetch 它们。走 webServer 路由而非 Typert
 * Remote，理由同余额插件：避免依赖编译生成的 remote descriptor（本项目无编译步骤）。
 *
 * 安全边界：浏览器半只传 workspaceId，这里用 ctx.workspaceRegistry 把它解析成
 * 真实路径——绝不能让浏览器半直接传路径，否则等于开放任意目录执行 git 的能力。
 */

const MAX_LOG_LIMIT = 200;
const DEFAULT_LOG_LIMIT = 50;
// git log 的自定义 --pretty=format 用单元/记录分隔符（\x1f / \x1e），而不是逗号
// 或竖线之类的可见字符——commit subject 里出现这些字符完全合法，用不可见的
// ASCII 分隔符才不会跟真实内容混淆。
const LOG_FIELD_SEP = "\x1f";
const LOG_RECORD_SEP = "\x1e";

/** 同一个仓库路径的 git 调用排成一条队列，避免我们自己并发调用互相踩 index.lock。 */
const repoLocks = new Map();

function runGit(repoPath, args) {
  const prev = repoLocks.get(repoPath) ?? Promise.resolve();
  const next = prev.then(() => execGit(repoPath, args), () => execGit(repoPath, args));
  // 不管这次成功还是失败都要把链条延续下去，否则一次失败会让后续调用永远排不上队。
  repoLocks.set(repoPath, next.catch(() => {}));
  return next;
}

function execGit(repoPath, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd: repoPath,
      // GIT_TERMINAL_PROMPT=0：git 在非 tty 环境下遇到需要凭据的操作会阻塞等待
      // 输入，把内核进程整个挂死。这条必须每次都带上。
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        // 分类逻辑不能只看 stderr——实测 `git commit` 在「没有暂存内容」时把
        // 那段人话提示写去 stdout（退出码依然非零），只查 stderr 会永远读到
        // 空字符串。stdout 也一并挂到 error 上，classifyGitError 两个都查。
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * git 的失败提示不一定在 stderr——实测 `git commit` 在「没有暂存内容」时
 * 把那段人话提示写去 stdout（退出码依然非零）。所有需要检查 git 输出内容
 * 的地方（分类失败原因、判断要不要自动重试）都用这个，别只查 stderr。
 * @param {{ stdout?: string, stderr?: string }} error
 */
function gitErrorText(error) {
  return String(error?.stdout ?? "") + "\n" + String(error?.stderr ?? "");
}

function classifyGitError(error) {
  if (error?.code === "ENOENT") {
    return { code: "git-not-found", message: "未检测到 git，请确认已安装并加入 PATH" };
  }
  if (error?.untrackedOnly) {
    return { code: "untracked-only", message: "只有未跟踪的新文件，没有已跟踪文件的改动——请先点文件旁的「+」暂存后再提交" };
  }
  if (error?.firstCommit) {
    // 这个要放在通用文本分类之前：git 对「HEAD~1 不存在」的实际提示是
    // "ambiguous argument 'HEAD~1': unknown revision..."，其中 "unknown
    // revision" 会命中下面 no-commits 那条正则，说成「仓库还没有任何提交」——
    // 但这里仓库明明有提交，只是没有更早的了，两码事，必须用专门的标记优先分流。
    return { code: "first-commit", message: "这是仓库的第一个提交，没有更早的状态可以退回" };
  }
  const text = gitErrorText(error);
  if (/not a git repository/i.test(text)) {
    return { code: "not-a-repo", message: "当前工作区不是 Git 仓库" };
  }
  if (/index\.lock/i.test(text)) {
    return { code: "index-locked", message: "Git 索引被占用（可能有其他 Git 操作正在进行），请稍后重试" };
  }
  if (/nothing to commit, working tree clean/i.test(text)) {
    // git 在「有改动但没暂存」时说的是 "no changes added to commit" /
    // "nothing added to commit but untracked files present"，都不含
    // "nothing to commit" 这个词组——那两种走的是 handleCommit 里的自动
    // 暂存重试，根本不会走到这条分类。真正落到这里的，是工作区彻底干净。
    return { code: "nothing-to-commit", message: "没有可提交的更改" };
  }
  if (/Please tell me who you are|user\.email|user\.name/i.test(text)) {
    return { code: "no-identity", message: "未配置 Git 用户名/邮箱（git config user.name / user.email）" };
  }
  if (/does not have any commits yet|unknown revision|ambiguous argument 'HEAD'|Failed to resolve 'HEAD'/i.test(text)) {
    return { code: "no-commits", message: "仓库还没有任何提交" };
  }
  if (/would be overwritten by (checkout|merge)/i.test(text)) {
    // "checkout" 是切分支时的措辞，"merge" 是 revert/合并类操作时的措辞——
    // 都是「工作区有未提交的改动，会被冲掉」这同一件事，用同一个 code。
    // 这条错误的价值在文件列表，只截第一行会把最有用的部分丢掉。
    return { code: "local-changes-blocked", message: text.trim() };
  }
  if (/No configured push destination/i.test(text)) {
    return { code: "no-remote", message: "未配置远程仓库（需要先 git remote add origin <url>）" };
  }
  if (/\[rejected\]|failed to push some refs/i.test(text)) {
    // pull 这次没做，拒绝之后没有别的路可退——只能明确告诉用户去终端处理，
    // 不能假装能在面板里一键解决。
    return { code: "push-rejected", message: "远端有本地没有的提交，需要先在终端执行 git pull 再推送" };
  }
  const firstLine = text.trim().split("\n")[0];
  return { code: "git-error", message: firstLine || error?.message || "Git 命令执行失败" };
}

/**
 * 解析 `git status --porcelain=v2 --untracked-files=all -z -b` 的输出。
 * -z 让所有记录以 NUL 结尾（而不是 LF），先按 NUL 切分成 token 再逐个识别类型：
 *   '#' 分支信息；'1' 普通变更；'2' 重命名/复制（额外占用下一个 token 作为原路径）；
 *   'u' 冲突；'?' 未跟踪。
 * 每种记录类型的字段数固定，用 anchored 正则整体匹配、把最后一段直接当路径——
 * 不能按空格 split，文件名本身可能含空格。
 * @param {string} raw
 */
function parseStatusZ(raw) {
  const tokens = raw.length === 0 ? [] : raw.split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();

  let branch = null;
  let detached = false;
  let unborn = false;
  let hasUpstream = false;
  let ahead = 0;
  let behind = 0;
  const staged = [];
  const unstaged = [];
  const untracked = [];

  const RE_ORDINARY = /^1 (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/s;
  const RE_RENAME = /^2 (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/s;
  const RE_UNMERGED = /^u (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/s;

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const marker = token.charAt(0);

    if (marker === "#") {
      const rest = token.slice(2);
      if (rest.startsWith("branch.head ")) {
        branch = rest.slice("branch.head ".length);
        detached = branch === "(detached)";
      } else if (rest.startsWith("branch.oid ")) {
        unborn = rest.slice("branch.oid ".length) === "(initial)";
      } else if (rest.startsWith("branch.ab ")) {
        // git 只在配置了上游分支时才会输出这一行——没有它就说明没有 upstream，
        // 不需要单独解析 branch.upstream 那一行来判断有没有跟踪关系。
        hasUpstream = true;
        const m = /^\+(\d+) -(\d+)$/.exec(rest.slice("branch.ab ".length));
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      }
      i += 1;
      continue;
    }

    if (marker === "1" || marker === "2" || marker === "u") {
      const re = marker === "1" ? RE_ORDINARY : marker === "2" ? RE_RENAME : RE_UNMERGED;
      const m = re.exec(token);
      if (!m) {
        i += 1;
        continue;
      }
      const xy = m[1];
      const path = m[2];
      const x = xy.charAt(0);
      const y = xy.charAt(1);
      const entry = { path, x, y };
      if (marker === "2") {
        i += 1;
        entry.origPath = tokens[i];
      }
      if (x !== "." ) staged.push(entry);
      if (y !== "." && y !== "?") unstaged.push({ ...entry });
      i += 1;
      continue;
    }

    if (marker === "?") {
      untracked.push({ path: token.slice(2) });
      i += 1;
      continue;
    }

    // '!'（ignored，我们没请求）或未知前缀，跳过。
    i += 1;
  }

  return { branch, detached, unborn, hasUpstream, ahead, behind, staged, unstaged, untracked };
}

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

function resolveRepoPath(ctx, workspaceId) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return { error: { code: "missing-workspace", message: "缺少 workspaceId" } };
  }
  const workspace = ctx.workspaceRegistry.get(workspaceId);
  if (!workspace) {
    return { error: { code: "workspace-not-found", message: "工作区不存在" } };
  }
  return { path: workspace.path };
}

async function handleStatus(ctx, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, fail("method-not-allowed", "GET only"));
  const url = new URL(req.url, "http://localhost");
  const resolved = resolveRepoPath(ctx, url.searchParams.get("workspaceId"));
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  try {
    const raw = await runGit(resolved.path, ["status", "--porcelain=v2", "--untracked-files=all", "-z", "-b"]);
    return sendJson(res, 200, { ok: true, data: parseStatusZ(raw) });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

async function handleLog(ctx, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, fail("method-not-allowed", "GET only"));
  const url = new URL(req.url, "http://localhost");
  const resolved = resolveRepoPath(ctx, url.searchParams.get("workspaceId"));
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), MAX_LOG_LIMIT) : DEFAULT_LOG_LIMIT;
  try {
    const raw = await runGit(resolved.path, [
      "log",
      `--max-count=${limit}`,
      `--pretty=format:%H${LOG_FIELD_SEP}%h${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%ad${LOG_FIELD_SEP}%s${LOG_RECORD_SEP}`,
      "--date=iso-strict"
    ]);
    const commits = raw.length === 0 ? [] : raw.split(LOG_RECORD_SEP)
      .map((r) => r.trim())
      .filter((r) => r.length > 0)
      .map((record) => {
        const [hash, shortHash, author, date, subject] = record.split(LOG_FIELD_SEP);
        return { hash, shortHash, author, date, subject };
      });
    return sendJson(res, 200, { ok: true, data: { commits } });
  } catch (error) {
    const classified = classifyGitError(error);
    // 空仓库（还没有第一个提交）不是错误，是正常状态，交给面板显示「尚无提交」。
    if (classified.code === "no-commits") return sendJson(res, 200, { ok: true, data: { commits: [] } });
    return sendJson(res, 200, { ok: false, error: classified });
  }
}

function extractPaths(body) {
  return Array.isArray(body?.paths) ? body.paths.filter((p) => typeof p === "string" && p.length > 0) : [];
}

async function handleStage(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const resolved = resolveRepoPath(ctx, body.workspaceId);
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  const paths = extractPaths(body);
  if (paths.length === 0) return sendJson(res, 200, fail("bad-request", "paths 不能为空"));
  try {
    await runGit(resolved.path, ["add", "--", ...paths]);
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

async function handleUnstage(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const resolved = resolveRepoPath(ctx, body.workspaceId);
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  const paths = extractPaths(body);
  if (paths.length === 0) return sendJson(res, 200, fail("bad-request", "paths 不能为空"));
  try {
    try {
      await runGit(resolved.path, ["reset", "--", ...paths]);
    } catch (error) {
      // 仓库还没有第一个提交时没有 HEAD 可解引用，`git reset` 会失败；
      // 退化成 `git rm --cached`，效果等价于把文件移出暂存区。
      if (/ambiguous argument 'HEAD'|unknown revision|Failed to resolve 'HEAD'/i.test(gitErrorText(error))) {
        await runGit(resolved.path, ["rm", "--cached", "--", ...paths]);
      } else {
        throw error;
      }
    }
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

async function handleCommit(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const resolved = resolveRepoPath(ctx, body.workspaceId);
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length === 0) return sendJson(res, 200, fail("bad-request", "提交信息不能为空"));
  try {
    try {
      await runGit(resolved.path, ["commit", "-m", message]);
    } catch (error) {
      // 前端不强制用户先手动暂存已跟踪文件的改动——按钮点下去就该是「暂存
      // 全部已跟踪改动 + 提交」。但**未跟踪的新文件绝不自动暂存**：那是用户
      // 还没决定要不要纳入版本控制的东西，必须手动点「+」明确选择，不能靠
      // 提交按钮顺手带走——否则「+ 暂存又 − 取消暂存」这个操作会被下一次
      // 提交悄悄撤销，表现成「− 好像没生效」（这是真实踩过的一个体验问题，
      // 根源不在 −，在这里自动暂存的范围太宽）。
      //
      // 所以只在「有已跟踪文件的改动、只是没暂存」这一种 git 措辞时才自动
      // 暂存重试，且用 `add -u`（只更新已跟踪文件）不用 `add -A`（无差别
      // 全部暂存）。已经手动暂存过部分文件时第一次 commit 直接成功，不会
      // 走到这里；只有未跟踪文件、没有任何已跟踪改动时不重试，直接报错让
      // 用户自己去点 +；工作区真的干净时走 classifyGitError 的
      // nothing-to-commit 分支。这几句提示 git 写在 stdout，必须用
      // gitErrorText 而不是只查 error.stderr——之前只查 stderr 时这个
      // 分支永远进不去，端到端测试里直接暴露了这个坑。
      const text = gitErrorText(error);
      if (/no changes added to commit/i.test(text)) {
        await runGit(resolved.path, ["add", "-u"]);
        await runGit(resolved.path, ["commit", "-m", message]);
      } else if (/nothing added to commit but untracked files present/i.test(text)) {
        throw Object.assign(new Error("untracked-only"), { stderr: "", stdout: "", untrackedOnly: true });
      } else {
        throw error;
      }
    }
    let shortHash = null;
    try {
      shortHash = (await runGit(resolved.path, ["rev-parse", "--short", "HEAD"])).trim();
    } catch {
      // 提交本身已经成功，取哈希失败不影响提交结果，静默忽略。
    }
    return sendJson(res, 200, { ok: true, data: { shortHash } });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

async function handleBranches(ctx, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, fail("method-not-allowed", "GET only"));
  const url = new URL(req.url, "http://localhost");
  const resolved = resolveRepoPath(ctx, url.searchParams.get("workspaceId"));
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  try {
    // refname:short + HEAD 用 tab 分隔——分支名不允许含空白字符，不需要 -z/NUL
    // 那一套（跟文件路径不一样，这里按行/按 tab split 是安全的）。
    const raw = await runGit(resolved.path, ["for-each-ref", "--format=%(refname:short)%09%(HEAD)", "refs/heads/"]);
    const branches = raw.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, head] = line.split("\t");
        return { name, current: head === "*" };
      });
    return sendJson(res, 200, { ok: true, data: { branches } });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

async function handleCheckout(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const resolved = resolveRepoPath(ctx, body.workspaceId);
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  const branch = typeof body.branch === "string" ? body.branch.trim() : "";
  if (branch.length === 0) return sendJson(res, 200, fail("bad-request", "branch 不能为空"));
  try {
    await runGit(resolved.path, ["checkout", branch]);
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

async function handlePush(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const resolved = resolveRepoPath(ctx, body.workspaceId);
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  try {
    try {
      await runGit(resolved.path, ["push"]);
    } catch (error) {
      // 没配置上游分支（第一次推这个分支）：取当前分支名，推到 origin 并建立
      // 跟踪关系，跟 GitHub Desktop / VS Code 的默认行为一致。远程本身不存在
      // 时会走另一条 "No configured push destination" 分支，那种没法自动
      // 修复，原样抛出去交给 classifyGitError。
      if (/has no upstream branch/i.test(gitErrorText(error))) {
        const branch = (await runGit(resolved.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        await runGit(resolved.path, ["push", "--set-upstream", "origin", branch]);
      } else {
        throw error;
      }
    }
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

async function handleUndoCommit(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const resolved = resolveRepoPath(ctx, body.workspaceId);
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  try {
    // 自己重新查一遍有没有推送过，不信任浏览器半传来的状态——面板打开的这段
    // 时间里仓库状态可能已经变了（比如用户在终端里手动 push 过），撤销的方式
    // 选错了后果不轻（该 revert 的走了 reset，或者反过来）。
    const raw = await runGit(resolved.path, ["status", "--porcelain=v2", "-z", "-b"]);
    const { hasUpstream, ahead } = parseStatusZ(raw);
    const pushed = hasUpstream && ahead === 0;
    if (pushed) {
      // 已经推送过：只能 revert——生成一条新提交去抵消，不改写共享历史、
      // 不需要强推，不会让已经拉取过这次提交的协作者出问题。
      await runGit(resolved.path, ["revert", "--no-edit", "HEAD"]);
      return sendJson(res, 200, { ok: true, data: { mode: "revert" } });
    }
    // 还没推送：直接把这次提交从历史上摘掉，用 --mixed 保留改动到工作区
    // （不是 --hard 直接丢弃）——「撤销」不等于「删除我的代码」。
    try {
      await runGit(resolved.path, ["reset", "--mixed", "HEAD~1"]);
    } catch (error) {
      if (/unknown revision|ambiguous argument/i.test(gitErrorText(error))) {
        throw Object.assign(new Error("first-commit"), { firstCommit: true });
      }
      throw error;
    }
    return sendJson(res, 200, { ok: true, data: { mode: "reset" } });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

const ROUTES = [
  ["/api/git/status", handleStatus],
  ["/api/git/log", handleLog],
  ["/api/git/branches", handleBranches],
  ["/api/git/checkout", handleCheckout],
  ["/api/git/stage", handleStage],
  ["/api/git/unstage", handleUnstage],
  ["/api/git/commit", handleCommit],
  ["/api/git/push", handlePush],
  ["/api/git/undo-commit", handleUndoCommit]
];

class GitService extends Service {
  static inject = ["webServer", "workspaceRegistry"];

  constructor(ctx) {
    super(ctx, "git");
    for (const [path, handler] of ROUTES) {
      this.ctx.effect(() => this.ctx.webServer.register({
        kind: "exact",
        path,
        handler: (req, res) => handler(this.ctx, req, res)
      }), `git: ${path}`);
    }
  }
}

export default GitService;
