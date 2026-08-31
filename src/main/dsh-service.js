'use strict';

const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');
const { resolvePackagedKernel } = require('../shared/kernel-paths');
const { findFreePort } = require('../shared/net');
const { findDshBinJsAsync } = require('../shared/dsh-locate');
const { loadPluginManifest, writeActivationPatch, writeSafeModePatch } = require('../shared/plugin-install');
const { loadPluginState } = require('../shared/plugin-state');
const { isPortBindFailure, firstBindErrorLine } = require('../shared/error-detail');
const { profileBundleEntryIds } = require('../shared/profile-plugins');
const { withPnpmOnPath, profileDir } = require('./profile-plugins-installer');

const URL_LINE_RE = /dsh web:\s+(https?:\/\/\S+)/;

/**
 * 安全模式下**不**关掉的 profile 层插件。
 *
 * 目前只有插件市场：dsh-plugin-manager 的 UI 并进它之后，它是唯一能关插件的界面。
 * 安全模式的意义是「把出问题的插件关掉」，把那个能关插件的东西也关了就等于没有安全模式。
 */
const RECOVERY_PACKAGES = ['@easytz/dsh-market'];

/**
 * 用户在插件市场里「停用」的 profile 层插件 → 要写进 overlay 的 disable 条目。
 *
 * 「停用」和「卸载」是两件事，用户两个都要：停用保留安装、随时能开回来（适合暂时
 * 排查问题），卸载是真的删掉。profile 层插件自己插自己的第 2 层条目，我们插不了也
 * 删不掉，只能从第 4 层压一条 `disabled: true`。
 *
 * 状态存在 `plugin-state.json`（entryId → boolean，`false` = 停用），和 A2 插件的
 * 开关**共用同一个文件与同一种形状**：那本来就是同一个概念——用户对某个 loader 条目
 * 的开关意愿，只是两层的实现手段不同。
 *
 * **只对 profile 里真实存在的 entry id 生成 disable**：dsh 自己给遥测生成 disable
 * 补丁时也先查了 `hasRow`，说明 patch 一个不存在的 id 不是安全操作。用户卸载了一个
 * 曾经停用过的插件后，状态文件里那条 `false` 就是「不存在的 id」——不过滤会在下次
 * 启动时炸在所有人脸上。
 */
function disabledProfileEntryIds(userState) {
  const wanted = new Set(
    Object.entries(userState ?? {}).filter(([, on]) => on === false).map(([id]) => id),
  );
  if (wanted.size === 0) return [];
  return profileBundleEntryIds(profileDir()).filter((id) => wanted.has(id));
}

// 端口绑定失败的换端口重试上限。三次都撞上说明不是运气问题（多半是安全软件拦截
// 或系统保留了很大一段端口），继续试没有意义，交给上层报错。
const MAX_BIND_RETRIES = 3;

// 等内核打印 URL 行的上限。--port 0 时端口只能从那行拿到，等不到就退回老做法。
// 取 20s：冷启动要加载整棵 plugin tree，慢机器上十几秒是常态。
const URL_LINE_TIMEOUT_MS = 20_000;

// 端口应答后再观察这么久，确认内核没有在 plugin tree 加载阶段随后崩溃。
// dsh 是「先绑端口、后加载插件树」，两者之间存在一个「HTTP 已通但内核仍会
// 崩溃」的窗口期；不等这一会儿就会把正在崩溃的内核当成就绪。
const READY_SETTLE_MS = 700;



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
    this.pluginsDir = opts.pluginsDir ?? null;
    this.activationPatchPath = opts.activationPatchPath ?? null;
    this.pluginStatePath = opts.pluginStatePath ?? null;
    // 安全模式：只加载清单里标了 safeMode 的插件（逃生舱，见 #prepareActivationPatch）。
    // 会话级，不落盘 —— 重启应用即回到正常模式，不会让用户卡在安全模式里出不来。
    this.safeMode = opts.safeMode === true;
    // pnpm 垫片目录。由启动时的 profile 插件对账造出来后写进来（见 index.js），
    // 拿不到就是 null —— 那种情况下内核里的 `dsh plugin add` 退回碰运气用系统 pnpm。
    this.pnpmShimDir = opts.pnpmShimDir ?? null;
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
   * 只可能在上游改掉那行输出格式时发生。宁可退回有交接窗口的老路，也不能让用户
   * 对着一个「进程活着但永远不就绪」的闪屏干等 —— 那是最难自查的一种卡死。
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
      child.kill();
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
    this.url = port ? `http://127.0.0.1:${port}` : null;
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
   * 备好激活 overlay，返回它的路径；缺少插件目录或清单读不出来时返回 null
   * （外壳照常启动，只是插件不生效 —— 好过整个应用起不来）。
   *
   * 用户在插件管理面板里关掉的插件不生成 `- insert:` 条目：状态文件在每次
   * 启动时读一次，所以「切换后重启内核生效」的重启路径走的就是这里。
   *
   * 安全模式（`this.safeMode`）下只写清单里标了 `safeMode: true` 的插件，且
   * **不读用户状态** —— 那是插件把内核搞崩之后的逃生舱，见 plugin-state.js 的
   * `safeModePlugins`。
   * @returns {string|null}
   */
  #prepareActivationPatch() {
    if (!this.pluginsDir || !this.activationPatchPath) return null;
    try {
      const plugins = loadPluginManifest(this.pluginsDir);
      if (this.safeMode) {
        // profile 层（A1）插件也要一并关掉，否则安全模式只挡得住随包分发的那批，
        // 而用户从市场装的插件——恰恰是最可能出问题、也最需要被关掉的那些——照样
        // 加载。**唯独放过插件市场自己**：它是并入 UI 之后唯一的恢复入口，把它关了
        // 安全模式就变成一个没有任何按钮可点的界面。
        const disable = profileBundleEntryIds(profileDir(), { exclude: RECOVERY_PACKAGES });
        if (disable.length > 0) {
          this.logger.log(`[dsh] 安全模式：额外关闭 profile 层插件 ${disable.join(', ')}`);
        }
        return writeSafeModePatch(this.activationPatchPath, plugins, disable);
      }
      const userState = loadPluginState(this.pluginStatePath);
      return writeActivationPatch(
        this.activationPatchPath, plugins, userState, disabledProfileEntryIds(userState),
      );
    } catch (error) {
      this.logger.warn('[dsh] 生成插件激活 overlay 失败，插件将不生效:', error?.message ?? error);
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
   * 轮询内核 HTTP 端口直到就绪。注意 dsh 是「先绑端口、后加载 plugin tree」，
   * 所以端口能应答并不等于内核启动完成：插件加载阶段崩溃时 HTTP 早已经通了。
   * 因此这里要求响应码 < 500，并在宣告就绪前再观察 READY_SETTLE_MS 确认进程
   * 仍然存活 —— 否则一个正在崩溃的内核会被当成就绪，后续崩溃被 ready 吞掉，
   * 表现为「窗口打开了但是一片黑、也没有任何报错」。
   */
  #pollReady() {
    const deadline = Date.now() + 30000;
    // URL 行一直不来的兜底期限（见 #launch：--port 0 时端口只能从这行拿到）。
    const urlDeadline = Date.now() + URL_LINE_TIMEOUT_MS;
    const attempt = () => {
      if (this.stopped || this.ready) return;
      // 子进程已经退出：不可能再就绪，交给 exit 处理器报错，别空等到超时。
      if (!this.child) return;
      // --port 0 时端口由内核自己选，要等它把 URL 行打出来才知道打哪儿。
      const url = this.url;
      if (!url) {
        if (Date.now() > urlDeadline) {
          this.#fallbackToExplicitPort();
          return;
        }
        this.#schedule(deadline, attempt);
        return;
      }
      const req = http.get(url + '/', (res) => {
        res.resume();
        // 5xx 说明内核还没准备好（或已经坏了），继续等。
        if (!res.statusCode || res.statusCode >= 500) {
          this.#schedule(deadline, attempt);
          return;
        }
        this.#confirmReady(/** @type {string} */ (url));
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
      this.emit('error', new Error(`dsh web 未在 30 秒内就绪（${this.url}）`));
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
      if (!child || child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {
          if (child.exitCode === null) {
            try { child.kill(); } catch {}
          }
        });
      } else {
        child.kill('SIGTERM');
      }
      const t = setTimeout(() => {
        try { if (child.exitCode === null) child.kill('SIGKILL'); } catch {}
        resolve();
      }, 3000);
      if (t.unref) t.unref();
    });
  }
}

module.exports = { DshService };
