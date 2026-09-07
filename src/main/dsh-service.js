'use strict';

const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');
const { URL_LINE_RE, URL_LINE_TIMEOUT_MS, probeUrl } = require('../shared/kernel-boot');
const { resolvePackagedKernel } = require('../shared/kernel-paths');
const { findFreePort } = require('../shared/net');
const { findDshBinJsAsync } = require('../shared/dsh-locate');
const { prepareActivationPatch } = require('../shared/activation-patch');
const { isPortBindFailure, firstBindErrorLine } = require('../shared/error-detail');
const { writeKernelPid, clearKernelPid } = require('../shared/orphan-kernel');
const { withPnpmOnPath, profileDir } = require('../shared/profile-plugins-installer');

/**
 * 安全模式下**不**关掉的 profile 层插件。
 *
 * 目前只有插件市场：它是唯一能关插件的界面。
 * 安全模式的意义是「把出问题的插件关掉」，把那个能关插件的东西也关了就等于没有安全模式。
 *
 * **只在安全模式下才排除**——市场的「卸载」按钮现在走的是假卸载（见
 * dsh-market/lib/index.js 的 SELF_PACKAGE_NAME 分支）：点了不是真的从磁盘删掉，
 * 是把自己的 entry id 写进跟别的插件共用的那份停用状态，靠这份排除名单只在
 * 正常模式下**不**生效，市场才能被这条「假卸载」真正关掉。安全模式恢复排除，
 * 保证不管用户有没有假卸载过市场，逃生舱里永远能看到它、用它把出问题的插件
 * 关掉或卸载——这也是用户重新启用市场自己的唯一入口，见该文件里的注释。
 */
const RECOVERY_PACKAGES = ['@easytz/dsh-market'];

// 端口绑定失败的换端口重试上限。三次都撞上说明不是运气问题（多半是安全软件拦截
// 或系统保留了很大一段端口），继续试没有意义，交给上层报错。
const MAX_BIND_RETRIES = 3;

// 端口应答后再观察这么久，确认内核没有在 plugin tree 加载阶段随后崩溃。
// dsh 是「先绑端口、后加载插件树」，两者之间存在一个「HTTP 已通但内核仍会
// 崩溃」的窗口期；不等这一会儿就会把正在崩溃的内核当成就绪。
const READY_SETTLE_MS = 700;

// HTTP 探活的预算，**从拿到地址行那一刻开始算**（不是从进程启动算）。
// 两段分开计时的理由见 #pollReady：冷启动光等地址行就可能花掉几十秒，共用一个
// 预算等于「等得越久、留给探活的时间越少」，正好在最需要耐心的时候最没耐心。
const READY_TIMEOUT_MS = 60000;

/**
 * 给内核**整棵进程树**发信号（仅非 win32）。
 *
 * 内核自己还会 spawn node-pty 的 shell、pnpm 等子进程。POSIX 上信号默认只送到直接
 * 子进程，那些孙进程会变成孤儿、占着端口不放。spawn 时带了 `detached`，于是
 * `child.pid` 就是进程组组长，对 **-pid（负数）** 发信号才能打到整棵树。
 *
 * 拿不到 pid、或进程组已经不在（ESRCH）时退回只杀直接子进程 —— 聊胜于无，而且这
 * 条路径上抛异常没有任何好处：调用方都是「正在收摊」的场景。
 *
 * Windows 不走这里：那边要用 `taskkill /T` 才是按进程树杀，见 stop()。
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function signalTree(child, signal) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

/**
 * Owns the `dsh web` child process: resolves the node binary + dsh bin.js for
 * dev or packaged layouts, starts the server on a free port, waits for the
 * HTTP surface to answer, and tears the process down on quit.
 */
class DshService extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.logger = opts.logger ?? console;
    this.userKernelDir = opts.userKernelDir ?? null;
    this.activationPatchPath = opts.activationPatchPath ?? null;
    this.pluginStatePath = opts.pluginStatePath ?? null;
    // 安全模式：只加载清单里标了 safeMode 的插件（逃生舱，见 #prepareActivationPatch）。
    // 会话级，不落盘 —— 重启应用即回到正常模式，不会让用户卡在安全模式里出不来。
    this.safeMode = opts.safeMode === true;
    // pnpm 垫片目录。由启动时的 profile 插件对账造出来后写进来（见 index.js），
    // 拿不到就是 null —— 那种情况下内核里的 `dsh plugin add` 退回碰运气用系统 pnpm。
    this.pnpmShimDir = opts.pnpmShimDir ?? null;
    // 记「当前内核是谁」的文件。正常退出会删掉它，所以下次启动看到它还在，
    // 就说明上次没善终、多半留了个孤儿内核（见 shared/orphan-kernel.js）。
    this.kernelPidPath = opts.kernelPidPath ?? null;
    this.child = null;
    this.url = null;
    this.stopped = false;
    this.ready = false;
    this.usingUserKernel = false;
  }

  /**
   * 解析要启动的内核。打包态走内置/用户内核（同步即可，全是路径判断）；
   * 开发态要问 npm 全局安装位置，走异步以免阻塞应用启动路径。
   */
  /** @returns {Promise<{nodeExe: string, binJs: string, source?: 'user'|'builtin',
   *                     version?: string|null, supersededUserVersion?: string|null}>} */
  async resolveKernel() {
    if (app.isPackaged) {
      const builtin = path.join(process.resourcesPath, 'kernel');
      return resolvePackagedKernel(this.userKernelDir, builtin);
    }
    return {
      nodeExe: process.env.DSH_NODE_EXE || 'node',
      binJs: await findDshBinJsAsync(),
    };
  }

  async start() {
    const { nodeExe, binJs, source, version, supersededUserVersion } = await this.resolveKernel();
    this.usingUserKernel = source === 'user';
    if (source) {
      this.logger.log(`[dsh] 内核: ${source} ${version ?? '版本未知'}`);
    }
    // 出厂内核反超了旧的用户内核。留一行日志：这条路径只在「装了新版客户端、
    // 但用户内核还停在更早版本」时才走到，出问题时它是最关键的一条线索。
    if (supersededUserVersion) {
      this.logger.log(`[dsh] 出厂内核较新，已跳过用户内核 ${supersededUserVersion}`);
    }
    this.#nodeExe = nodeExe;
    this.#binJs = binJs;
    await this.#launch();
    return this;
  }

  /** @type {string|null} */ #nodeExe = null;
  /** @type {string|null} */ #binJs = null;
  /** 端口绑定失败后换端口重试的次数。 */
  #bindRetries = 0;
  /** 退回「自己探端口再交给内核」的老做法（只有拿不到 URL 行时才置位）。 */
  #explicitPortFallback = false;

  /**
   * 等不到内核打印 URL 行：杀掉它，换回「自己探一个端口」的老做法重来一次。
   *
   * 只可能在上游改掉那行输出格式、或内核卡死在打印之前时发生。宁可退回有交接窗口
   * 的老路，也不能让用户对着一个「进程活着但永远不就绪」的闪屏干等。
   *
   * **注意这条路救不了「格式变了」那种情况**：端口是我们自己定的没错，但登录 token
   * 仍然只能从那行里读，读不到就进不去。所以重来一轮之后地址依旧等地址行（见
   * #launch 里 `this.url = null` 那段），再等不到就由 #pollReady 报错收场——那比
   * 「拿一个进不去的裸地址把窗口打开」诚实得多。
   */
  #fallbackToExplicitPort() {
    if (this.#explicitPortFallback) return; // 老路也没起来，交给就绪超时报错
    this.#explicitPortFallback = true;
    this.logger.warn(`[dsh] ${URL_LINE_TIMEOUT_MS / 1000}s 内没等到内核的 URL 行，`
      + '退回自选端口方式重试（上游可能改了输出格式）');
    const child = this.child;
    this.child = null;
    this.#stderrTail = '';
    this.#stdoutBuffer = '';
    if (child) {
      child.removeAllListeners('exit');
      // 这里也要按进程树杀：走到这一步时内核已经 boot 了一会儿，很可能已经拉起了
      // node-pty 的 shell。只杀直接子进程会留下孤儿**占着端口**——而端口正是这条
      // fallback 要解决的问题，留个孤儿等于自己给自己下绊子。
      if (process.platform === 'win32') child.kill();
      else signalTree(child, 'SIGTERM');
    }
    void this.#launch();
  }

  /**
   * 起一次内核进程（定端口 → spawn → 挂事件 → 轮询就绪）。
   *
   * PATH 里会插一个 pnpm 垫片（`pnpmShimDir`，由启动时的 profile 插件对账造出来）：
   * 插件市场的「一键安装」跑的是内核进程里的 `dsh plugin add`，而它内部 spawn 的是
   * 裸 `pnpm`——用户机器上不一定装过。桌面版承诺「无需额外环境」，这条就得由我们补上。
   *
   * **端口交给内核自己申请（`--port 0`）。** 老做法是父进程探一个空闲端口、把号码
   * 交给子进程去 bind，这中间有固有的时间差：探测成功不代表几秒后内核 bind 时还能
   * 绑上。用户实测报过 `listen EACCES 127.0.0.1:53389` —— Windows 上 loopback bind
   * 报 EACCES 的典型原因是端口落进了系统保留区间，而 Hyper-V / WSL2 / Docker 会
   * **动态**预留大段端口（一台真实机器上实测有 60 段、约占动态端口范围的 37%，
   * 而且是按需分配、随时新增的）。换成 --port 0 之后，端口由内核进程在 bind 那一刻
   * 向系统申请，系统天然跳过保留段，这个交接窗口整个消失。
   *
   * 绑定失败仍然保留「换端口重试」这条兜底（EADDRINUSE 理论上还可能发生），而且
   * **绝不能把它当成「内核坏了」**：那会触发上层的用户内核弃用逻辑，把一个好端端的
   * 热更新内核删掉，然后回退的内置内核撞上同一个端口问题继续失败。
   */
  async #launch() {
    const nodeExe = /** @type {string} */ (this.#nodeExe);
    const binJs = /** @type {string} */ (this.#binJs);
    // 默认让**内核自己**申请端口（--port 0）：端口由内核进程在 bind 那一刻向系统
    // 要，系统天然会跳过保留区间，交接窗口不复存在。实际端口从内核打印的
    // `dsh web: http://127.0.0.1:<port>` 那行读回来（#scanStdout 一直在解析它）。
    //
    // #explicitPortFallback 是退路：万一哪天上游改了那行的格式，我们就拿不到端口，
    // 只能退回「自己探一个端口交给内核」的老做法（#fallbackToExplicitPort 触发）。
    const port = this.#explicitPortFallback ? await findFreePort() : 0;
    // **端口是谁定的都一样，地址一律等内核打印的地址行。** 那行里带着登录 token，
    // 而不带 token 的裸地址在内核那边永远是 401（换不到会话 cookie）——退回自选
    // 端口时这里原本会先填一个裸地址好让探活立刻开始，结果就是主窗口也拿着这个
    // 进不去的地址加载，窗口打开却一直停在登录前，没有任何报错。
    this.url = null;
    const args = [binJs, 'web'];

    // 插件激活：走 dsh 官方的 `--patch` overlay，不再改发行包自带的 bundle patch。
    //
    // 位置很讲究 —— `--patch` 必须排在 `--host` 之前。bin.js 的 launcher 只解析它
    // 自己的 flag，「第一个不认识的 token 开始就是内层参数」，而 --host/--port 是
    // web app 的 flag：排在它们后面的 --patch 会被原样透传下去，然后 web app 报
    // `unknown option '--patch'` 直接退出。
    const patchPath = this.#prepareActivationPatch();
    if (patchPath) args.push('--patch', patchPath);

    // --no-open：dsh web 默认会自己拉起系统默认浏览器打开这个地址，这是给纯
    // 命令行用户的便利功能。桌面壳已经用 Electron 窗口加载了同一个 URL，不禁掉
    // 就是内容被打开两次——一份在我们的窗口里，一份在用户的系统浏览器里。
    args.push('--host', '127.0.0.1', '--port', String(port), '--no-open');

    this.logger.log(`[dsh] 启动: ${nodeExe} ${args.join(' ')}`);
    this.child = spawn(nodeExe, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // 非 win32 上开独立进程组：内核自己还会 spawn node-pty 的 shell、pnpm 等
      // 子进程，SIGTERM 默认只送到直接子进程，那些孙进程会变成孤儿、占着端口
      // 不放。detached 让 child.pid 成为组长，stop() 里对 -pid 发信号能打到
      // 整棵树。Windows 走 taskkill /T 已经是按进程树杀的，不需要这个。
      detached: process.platform !== 'win32',
      // 打上唯一标记：桌面版内核进程可据此与网页版/其他实例精确区分，
      // 避免后续清理进程时误杀正在开发它的 agent 自己。
      // DSH_DESKTOP_SAFE_MODE 让插件管理面板知道自己正跑在安全模式下，好在 UI 上
      // 说明「插件不是丢了，是被这次启动刻意跳过了」。
      env: withPnpmOnPath({
        ...process.env,
        DSH_DESKTOP: '1',
        DSH_DESKTOP_PARENT_PID: String(process.pid),
        ...(this.safeMode ? { DSH_DESKTOP_SAFE_MODE: '1' } : {}),
      }, this.pnpmShimDir),
    });

    // 落一份 pid 记录，给下次启动收拾残局用。带上 binJs：pid 会被系统回收再
    // 分配，下次核对时必须确认那个 pid 的命令行确实指向同一个内核，才敢动手。
    if (this.kernelPidPath && this.child.pid) {
      writeKernelPid(this.kernelPidPath, { pid: this.child.pid, binJs }, this.logger);
    }

    this.child.stdout.on('data', (d) => this.#scanStdout(d));
    this.child.stderr.on('data', (d) => {
      const text = d.toString('utf8');
      // 保留 stderr 尾部，内核在就绪前崩溃时用于给出可读的错误提示。
      this.#stderrTail = (this.#stderrTail + text).slice(-4000);
      this.logger.log(`[dsh:err] ${text.trimEnd()}`);
    });
    this.child.on('error', (err) => {
      this.logger.error('[dsh] 进程错误:', err.message);
      this.emit('error', err);
    });
    this.child.on('exit', (code, signal) => {
      this.logger.log(`[dsh] 退出 code=${code} signal=${signal}`);
      const detail = this.#stderrTail.trim();
      // 只要不是我们主动 stop 的，就是崩溃 —— 无论有没有 ready 过。
      const crashed = !this.stopped;
      // 就绪「前」退出（例如插件模块解析失败导致 ERR_MODULE_NOT_FOUND）走 error：
      // 触发用户内核回退与「启动失败」弹框。就绪「后」崩溃则通过 exit 的 crashed
      // 标记交给外层处理 —— 早期版本在这里什么都不做，用户只会看到一个黑屏。
      if (crashed && !this.ready) {
        // 端口绑不上：换个端口重来，别把它当成内核损坏（见 #launch 的注释）。
        if (isPortBindFailure(detail) && this.#bindRetries < MAX_BIND_RETRIES) {
          this.#bindRetries += 1;
          this.logger.warn(
            `[dsh] 端口绑定失败（第 ${this.#bindRetries} 次），换端口重试：${firstBindErrorLine(detail)}`
          );
          this.child = null;
          this.#stderrTail = '';
          this.#stdoutBuffer = '';
          void this.#launch();
          return;
        }
        const err = new Error(
          `dsh 内核启动失败（code=${code}${signal ? ` signal=${signal}` : ''}）` +
          (detail ? `\n${detail}` : '')
        );
        // 打上标记：上层据此区分「内核坏了」（该弃用用户内核）与「端口绑不上」
        // （换台机器上的环境问题，删内核只会白白让用户重下一次）。
        if (isPortBindFailure(detail)) /** @type {any} */ (err).code = 'port-bind-failed';
        this.emit('error', err);
      }
      this.emit('exit', { code, signal, crashed, detail });
      this.child = null;
    });

    this.#pollReady();
  }

  #stdoutBuffer = '';
  #stderrTail = '';

  /**
   * 备好 overlay，返回路径；写不出来时返回 null（外壳照常启动，只是停用不生效——
   * 好过整个应用起不来）。
   *
   * overlay 现在只做一件事：**按用户意愿停用条目**。插件全在 profile 层，是自己
   * insert 自己的第 2 层条目，我们插不了也删不掉，只能从第 4 层压 `disabled: true`。
   *
   * 状态每次启动读一次，所以「改完开关重启生效」走的就是这条路。
   *
   * **只对 profile 里真实存在的 entry id 生成 disable**：dsh 自己给遥测生成 disable
   * 补丁时也先查了 `hasRow`，说明 patch 一个不存在的 id 不是安全操作。用户卸载一个
   * 曾经停用过的插件之后，状态文件里那条 `false` 就是「不存在的 id」——不过滤会在
   * 下次启动时炸在所有人脸上。
   *
   * 安全模式**不读用户状态**：那正是「用户状态可能有问题」时用的逃生舱，再过一遍
   * 开关只可能把恢复入口也滤掉。它关掉市场以外的全部 profile 插件。
   *
   * `exclude` 只在安全模式下才传：正常模式不排除市场，让它能被自己的「假卸载」
   * 真正停用（见 RECOVERY_PACKAGES 顶部注释）；安全模式下换回排除名单，不管
   * 市场当前是不是被假卸载了，都强制算作「不停用」，保证逃生舱里市场永远在。
   * @returns {string|null}
   */
  #prepareActivationPatch() {
    if (!this.activationPatchPath) return null;
    try {
      const patch = prepareActivationPatch({
        patchPath: this.activationPatchPath, statePath: this.pluginStatePath,
        profileDir: profileDir(), safeMode: this.safeMode,
        exclude: this.safeMode ? RECOVERY_PACKAGES : [],
      });
      if (this.safeMode) this.logger.log('[dsh] 安全模式：已停用市场以外的全部 profile 插件');
      return patch;
    } catch (error) {
      this.logger.warn('[dsh] 生成 overlay 失败，插件停用状态本次不生效:', error?.message ?? error);
      return null;
    }
  }

  #scanStdout(d) {
    this.#stdoutBuffer += d.toString('utf8');
    const lines = this.#stdoutBuffer.split(/\r?\n/);
    this.#stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      this.logger.log(`[dsh:out] ${line}`);
      const m = URL_LINE_RE.exec(line);
      if (m) {
        this.url = m[1];
        this.logger.log(`[dsh] URL 行: ${this.url}`);
      }
    }
  }

  /**
   * 等内核真正可用。分两段，**各自计时**：
   *
   * 1. 等地址行。地址由内核打印（`--port 0` 时端口也只能从这行读回来），而且那行
   *    里带着登录 token —— 没有 token 就算端口通了也进不去（内核一律 401）。
   * 2. 等 HTTP 应答。dsh 是「先绑端口、后加载 plugin tree」，端口能应答不等于启动
   *    完成，插件加载阶段崩溃时 HTTP 早已经通了；所以还要再观察 READY_SETTLE_MS
   *    确认进程没随后崩掉，否则正在崩溃的内核会被当成就绪、后续崩溃被 ready 吞掉。
   *
   * 两段分开计时，是因为共用一个预算会「等地址行等得越久，留给探活的时间越少」——
   * 冷启动正是地址行最慢的时候，也正是最不该失去耐心的时候（实测这行要 20s+，
   * 而原先两段共用 30s，剩下不到 10s 给探活，直接把能起来的内核判成失败）。
   */
  #pollReady() {
    const urlDeadline = Date.now() + URL_LINE_TIMEOUT_MS;
    /** 探活预算，拿到地址行才开始算。 @type {number|null} */
    let readyDeadline = null;
    const attempt = () => {
      if (this.stopped || this.ready) return;
      // 子进程已经退出：不可能再就绪，交给 exit 处理器报错，别空等到超时。
      if (!this.child) return;
      const url = this.url;
      if (!url) {
        if (Date.now() <= urlDeadline) {
          setTimeout(attempt, 250);
          return;
        }
        // 还没退回过自选端口：退一次（那边会重起一轮，含新的 #pollReady）。
        if (!this.#explicitPortFallback) {
          this.#fallbackToExplicitPort();
          return;
        }
        // 退回过还是等不到地址行 = 拿不到 token = 这个内核进不去。直接报错，
        // 别让用户对着闪屏无限等 —— 这条路径上原先是**静默停止轮询**。
        this.emit('error', new Error(
          `dsh 内核在 ${(URL_LINE_TIMEOUT_MS / 1000).toFixed(0)}s 内没有打印地址行，取不到登录 token`
        ));
        return;
      }
      if (readyDeadline === null) readyDeadline = Date.now() + READY_TIMEOUT_MS;
      const deadline = readyDeadline;
      const req = http.get(probeUrl(url), (res) => {
        res.resume();
        // 5xx = 内核还没准备好（或已经坏了）。401 = 地址里的 token 没被认下来，
        // 同样**不算就绪**：内核的登录态是「带 token 的地址换一次签名 cookie」，
        // 把 401 当成就绪，主窗口就会拿着一个换不到 cookie 的地址加载，窗口打开
        // 却永远停在登录前、且没有任何报错。整段排查见
        // docs/decisions/kernel-lifecycle.md。
        if (!res.statusCode || res.statusCode >= 500 || res.statusCode === 401) {
          this.#schedule(deadline, attempt);
          return;
        }
        this.#confirmReady(url);
      });
      req.on('error', () => this.#schedule(deadline, attempt));
      req.setTimeout(2000, () => {
        req.destroy();
        this.#schedule(deadline, attempt);
      });
    };
    attempt();
  }

  /** 端口应答后再观察一小段时间，进程仍然活着才真正宣告就绪。 */
  #confirmReady(url) {
    const timer = setTimeout(() => {
      if (this.stopped || this.ready) return;
      // settle 期间退出了：ready 仍为 false，exit 处理器会 emit error。
      if (!this.child) return;
      this.ready = true;
      this.emit('ready', url);
    }, READY_SETTLE_MS);
    if (timer.unref) timer.unref();
  }

  #schedule(deadline, attempt) {
    if (this.stopped) return;
    if (Date.now() > deadline) {
      // 秒数从常量算，别写死在文案里——改了预算却忘了改这句话，日志就会骗人。
      this.emit('error', new Error(
        `dsh web 未在 ${(READY_TIMEOUT_MS / 1000).toFixed(0)} 秒内就绪（${this.url}）`
      ));
      return;
    }
    setTimeout(attempt, 250);
  }

  /**
   * Force-stop the dsh process tree; always resolves.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      this.stopped = true;
      const child = this.child;
      // 主动停内核 = 这次是善终，把 pid 记录清掉。**放在最前面**，不等真的杀完：
      // 后面那条 3 秒兜底路径可能走到 SIGKILL，也可能整个进程在中途被系统带走，
      // 谁都不保证 resolve 一定跑到。而这个标记的语义是「我们**打算**善终」——
      // 记录留着的唯一后果是下次启动多做一次核对（核对不过就不会杀），
      // 而漏删的后果是下次启动可能去动一个已经不归我们管的 pid。宁可早删。
      if (this.kernelPidPath) clearKernelPid(this.kernelPidPath);
      if (!child || child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {
          if (child.exitCode === null) {
            try { child.kill(); } catch {}
          }
        });
      } else {
        signalTree(child, 'SIGTERM');
      }
      const t = setTimeout(() => {
        if (child.exitCode === null) {
          if (process.platform === 'win32') {
            try { child.kill('SIGKILL'); } catch {}
          } else {
            signalTree(child, 'SIGKILL');
          }
        }
        resolve();
      }, 3000);
      if (t.unref) t.unref();
    });
  }
}

module.exports = { DshService };
