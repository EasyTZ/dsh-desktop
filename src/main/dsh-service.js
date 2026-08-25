'use strict';

const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');
const { resolvePackagedKernel } = require('../shared/kernel-paths');
const { findFreePort } = require('../shared/net');
const { findDshBinJsAsync } = require('../shared/dsh-locate');
const { loadPluginManifest, writeActivationPatch } = require('../shared/plugin-install');

const URL_LINE_RE = /dsh web:\s+(https?:\/\/\S+)/;

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
    const port = await findFreePort();
    this.url = `http://127.0.0.1:${port}`;
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
      env: { ...process.env, DSH_DESKTOP: '1', DSH_DESKTOP_PARENT_PID: String(process.pid) },
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
        this.emit('error', new Error(
          `dsh 内核启动失败（code=${code}${signal ? ` signal=${signal}` : ''}）` +
          (detail ? `\n${detail}` : '')
        ));
      }
      this.emit('exit', { code, signal, crashed, detail });
      this.child = null;
    });

    this.#pollReady();
    return this;
  }

  #stdoutBuffer = '';
  #stderrTail = '';

  /**
   * 备好激活 overlay，返回它的路径；缺少插件目录或清单读不出来时返回 null
   * （外壳照常启动，只是插件不生效 —— 好过整个应用起不来）。
   * @returns {string|null}
   */
  #prepareActivationPatch() {
    if (!this.pluginsDir || !this.activationPatchPath) return null;
    try {
      const plugins = loadPluginManifest(this.pluginsDir);
      return writeActivationPatch(this.activationPatchPath, this.pluginsDir, plugins);
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
    const url = this.url;
    const attempt = () => {
      if (this.stopped || this.ready) return;
      // 子进程已经退出：不可能再就绪，交给 exit 处理器报错，别空等到超时。
      if (!this.child) return;
      const req = http.get(url + '/', (res) => {
        res.resume();
        // 5xx 说明内核还没准备好（或已经坏了），继续等。
        if (!res.statusCode || res.statusCode >= 500) {
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
