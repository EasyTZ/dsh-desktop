'use strict';

const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { isNewer } = require('../shared/version');
const {
  dshManifestPath, kernelNodeModulesDir, readKernelVersion, resolvePackagedKernel,
} = require('../shared/kernel-paths');
const { loadPluginManifest, installPlugin, resolvePluginSrcDir, writeActivationPatch } = require('../shared/plugin-install');
const { loadPluginState } = require('../shared/plugin-state');

const REGISTRY_PRESETS = [
  'https://registry.npmmirror.com',
  'https://registry.npmjs.org',
];

// 自动检查间隔：距上次「成功」检查不足这个时长就不再打扰用户。
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// 新内核 HTTP 通了之后再观察这么久，确认它没有在插件加载阶段随后崩溃。
const VERIFY_SETTLE_MS = 1500;

// 内核启动后打印的地址行，`--port 0` 时端口只能从这里读回来。与 DshService 用的
// 是同一条正则（两边都在解析同一个上游输出，格式一变要一起改）。
const URL_LINE_RE = /dsh web:\s+(https?:\/\/\S+)/;
// 等这行出现的上限。超时说明内核连端口都没绑上，多半是启动阶段就崩了。
const URL_LINE_TIMEOUT_MS = 20000;

/**
 * 等内核把地址行打出来。进程中途退出就立刻失败，不空等到超时 —— 那正是「新内核
 * 起不来」最常见的样子。
 * @param {{ value: string|null }} urlState
 * @param {{ value: unknown }} exitState
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function waitUrlLine(urlState, exitState, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (urlState.value) return resolve(urlState.value);
      if (exitState.value !== null) return reject(new Error('进程在打印地址行之前退出'));
      if (Date.now() > deadline) return reject(new Error('等不到内核打印地址行'));
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

/**
 * 轮询 HTTP 直到就绪（<500），超时抛错。isDead 可选：进程已经退出时立刻失败，
 * 不必空等到超时。
 * @returns {Promise<void>}
 */
function waitHttpReady(url, timeoutMs, isDead) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        schedule();
      });
      req.on('error', schedule);
      req.setTimeout(2000, () => { req.destroy(); schedule(); });
    };
    const schedule = () => {
      if (typeof isDead === 'function' && isDead()) {
        return reject(new Error('进程在就绪前退出'));
      }
      if (Date.now() > deadline) return reject(new Error(`超时（${url}）`));
      setTimeout(attempt, 250);
    };
    attempt();
  });
}

/**
 * 内核独立热更新器：检查 npm registry、下载新版 @deepseek-ai/dsh 到用户可写
 * 目录，重装自定义插件，校验可启动后原子切换。全程只读内置内核作为兜底。
 *
 * 目录约定（与内置内核 layout 一致）：
 *   <kernelDir>/node.exe
 *   <kernelDir>/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js
 */
class KernelUpdater extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.logger = opts.logger ?? console;
    this.userKernelDir = opts.userKernelDir;
    this.builtinKernelDir = opts.builtinKernelDir;
    this.pluginsDir = opts.pluginsDir;
    this.configPath = opts.configPath;
    this.pnpmCliPath = opts.pnpmCliPath;
    this.builtinNodeExe = opts.builtinNodeExe;
    this.pnpmStoreDir = opts.pnpmStoreDir ?? null;
    this.activationPatchPath = opts.activationPatchPath ?? null;
    this.pluginStatePath = opts.pluginStatePath ?? null;
    // 开发态传仓库根的 node_modules（git 依赖插件在那里）；打包态全部插件源码
    // 都在 extraResources 的 plugins/ 下，传 null 只查那一处。
    this.nodeModulesDir = opts.nodeModulesDir ?? null;
    this.onRestart = opts.onRestart ?? null;

    /** @type {{ phase: string, currentVersion: string|null, latestVersion: string|null,
     *           progress: { percent: number, message: string }|null,
     *           error: string|null, registry: string }} */
    this.state = {
      phase: 'idle', // idle|checking|up-to-date|available|downloading|installing|done|error
      currentVersion: null,
      latestVersion: null,
      progress: null,
      error: null,
      registry: REGISTRY_PRESETS[0],
    };
    this._child = null;
    this._busy = false;
    this._config = this._loadConfig();
    this.state.registry = this._config.registry || REGISTRY_PRESETS[0];
    this.state.currentVersion = this.getCurrentVersion();
  }

  // ── 配置 ──────────────────────────────────────────────────────────────────
  _loadConfig() {
    try {
      if (this.configPath && fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      }
    } catch (error) {
      this.logger.warn('[updater] 读取配置失败:', error?.message ?? error);
    }
    return {};
  }

  _saveConfig() {
    try {
      if (!this.configPath) return;
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this._config, null, 2) + '\n');
    } catch (error) {
      this.logger.warn('[updater] 写入配置失败:', error?.message ?? error);
    }
  }

  cycleRegistry() {
    const idx = REGISTRY_PRESETS.indexOf(this.state.registry);
    this.state.registry = REGISTRY_PRESETS[(idx + 1) % REGISTRY_PRESETS.length];
    this._config.registry = this.state.registry;
    this._saveConfig();
    this._emitState();
    return this.state;
  }

  /** 上次成功检查的时间戳（没有则为 0）。 */
  getLastCheck() {
    return Number(this._config.lastCheck) || 0;
  }

  /**
   * 距上次成功检查是否已经超过间隔。配置由 updater 自己持有，调用方不要再去
   * 读 updater.json —— 同一份配置两个读者迟早会不一致。
   */
  shouldAutoCheck(intervalMs = AUTO_CHECK_INTERVAL_MS) {
    return Date.now() - this.getLastCheck() >= intervalMs;
  }

  // ── 状态 ──────────────────────────────────────────────────────────────────
  getState() {
    return { ...this.state };
  }

  _setState(patch) {
    Object.assign(this.state, patch);
    this._emitState();
  }

  _emitState() {
    this.emit('state', this.getState());
  }

  // ── 版本 ──────────────────────────────────────────────────────────────────
  /**
   * 当前**实际会被启动**的那个内核的 dsh 版本。
   *
   * 必须与 DshService 走同一个 resolvePackagedKernel，否则更新中心显示的版本
   * 会和真正跑着的内核对不上 —— 出厂内核反超旧用户内核时尤其如此，那正是这里
   * 最容易骗人的场景。
   */
  getCurrentVersion() {
    if (!this.builtinKernelDir) {
      return this.userKernelDir ? readKernelVersion(this.userKernelDir) : null;
    }
    return resolvePackagedKernel(this.userKernelDir, this.builtinKernelDir).version;
  }

  /** registry 编码 scope 包的 URL：把 `/` 转成 `%2F`。 */
  _packageUrl(name = '@deepseek-ai/dsh') {
    const base = this.state.registry.replace(/\/+$/, '');
    return `${base}/${name.replace('/', '%2F')}`;
  }

  /** 查询最新版本号；失败抛错。 */
  async _fetchLatest() {
    const res = await fetch(this._packageUrl(), {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`registry 返回 ${res.status}`);
    const data = await res.json();
    const latest = data && data['dist-tags'] && data['dist-tags'].latest;
    if (typeof latest !== 'string' || latest.length === 0) {
      throw new Error('registry 未返回 dist-tags.latest');
    }
    return latest;
  }

  /** 检查更新：idle -> checking -> available | up-to-date | error。 */
  async check() {
    if (this._busy) return this.getState();
    this._busy = true;
    this._setState({ phase: 'checking', error: null, progress: null });
    try {
      const current = this.getCurrentVersion();
      const latest = await this._fetchLatest();
      this._config.lastCheck = Date.now();
      this._saveConfig();
      if (!current) {
        // 读不到当前内核版本说明内核目录不完整/损坏。以前这里落进 else 被报成
        // 「已是最新」—— 明明装坏了却告诉用户一切正常，是最坏的一种谎报。
        this._setState({
          phase: 'error',
          currentVersion: null,
          latestVersion: latest,
          error: '读不到当前内核版本，内核目录可能已损坏。可尝试更新以重新安装内核。',
        });
      } else if (isNewer(latest, current)) {
        this._setState({ phase: 'available', currentVersion: current, latestVersion: latest });
      } else {
        this._setState({ phase: 'up-to-date', currentVersion: current, latestVersion: latest });
      }
    } catch (error) {
      this._setState({ phase: 'error', error: `检查更新失败：${error?.message ?? error}` });
    } finally {
      this._busy = false;
    }
    return this.getState();
  }

  /** 开始下载安装。 */
  async startUpdate() {
    if (this._busy) return this.getState();
    if (!this.state.latestVersion) {
      await this.check();
      if (this.state.phase !== 'available') return this.getState();
    }
    this._busy = true;
    try {
      await this._install(this.state.latestVersion);
    } catch (error) {
      this._setState({ phase: 'error', error: `更新失败：${error?.message ?? error}` });
    } finally {
      this._busy = false;
    }
    return this.getState();
  }

  /**
   * 安装目标版本到 staging 目录，验证通过后原子切换为正式用户内核。
   */
  async _install(version) {
    const staging = `${this.userKernelDir}-staging`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(path.join(staging, 'runtime'), { recursive: true });

    // node.exe 与内置内核保持一致（内核 node 版本通常随应用发布，无需单独更新）。
    fs.copyFileSync(this.builtinNodeExe, path.join(staging, 'node.exe'));

    await this._pnpmInstall(staging, version);
    this._installPlugins(staging);
    await this._verify(staging, version);

    // 原子切换：先挪走旧内核，再把 staging 转正。
    const backup = `${this.userKernelDir}-old`;
    fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(this.userKernelDir)) {
      fs.renameSync(this.userKernelDir, backup);
    }
    try {
      fs.renameSync(staging, this.userKernelDir);
    } catch (error) {
      // 切换失败则回滚旧内核。
      if (fs.existsSync(backup)) fs.renameSync(backup, this.userKernelDir);
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });

    this._setState({
      phase: 'done',
      currentVersion: version,
      latestVersion: version,
      progress: null,
    });
  }

  _pnpmInstall(staging, version) {
    // dsh 的原生依赖（node-pty/koffi/sharp 等）二进制都通过 optionalDependencies 与
    // 包内 prebuilds 分发，Windows 上无需编译；pnpm 默认不运行依赖 build scripts
    // （安全策略，返回 ignored-builds 非零退出），安装实际已成功，放行即可。
    const runtimeDir = path.join(staging, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });

    const args = [
      this.pnpmCliPath,
      'add',
      '--dir', runtimeDir,
      `@deepseek-ai/dsh@${version}`,
      '--registry', this.state.registry,
      '--node-linker=hoisted',
      '--reporter=append-only',
    ];
    if (this.pnpmStoreDir) args.push('--store-dir', this.pnpmStoreDir);

    return this._spawnProgress(this.builtinNodeExe, args, (line) => {
      const m = /resolved\s+(\d+).*?added\s+(\d+)/.exec(line);
      if (m) {
        const resolved = parseInt(m[1], 10);
        const added = parseInt(m[2], 10);
        const percent = resolved > 0 ? Math.min(99, Math.round((added / resolved) * 100)) : -1;
        this._setState({
          phase: 'installing',
          progress: { percent, message: `正在更新内核（${added}/${resolved} 个包）…` },
        });
      }
    }).catch((error) => {
      // pnpm 对「依赖声明了 build scripts 但被忽略」返回非零退出码（默认安全策略）。
      // 这些 scripts 在 Windows 上要么是 no-op（chmod 可执行位）、要么二进制已随包
      // 分发，忽略不影响功能 —— 安装实际已成功，据此放行。
      if (error && error.ignoredBuilds) return;
      throw error;
    });
  }

  /**
   * spawn 一个子进程，逐行回调 stdout，非零退出抛错。错误对象携带 stderr 尾部
   * 与 ignoredBuilds 标记（供 pnpm 安全策略放行用）。
   * @returns {Promise<void>}
   */
  _spawnProgress(cmd, args, onLine) {
    return new Promise((resolve, reject) => {
      this.logger.log('[updater] 执行:', cmd, args.join(' '));
      const child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env },
      });
      this._child = child;
      let buf = '';
      let combinedTail = '';
      let sawIgnoredBuilds = false;
      const feed = (chunk, stream) => {
        const text = chunk.toString('utf8');
        // pnpm 的 reporter 与部分错误走 stdout、警告走 stderr，统一收尾部用于报错。
        combinedTail = (combinedTail + text).slice(-4000);
        if (/Ignored build scripts|ERR_PNPM_IGNORED_BUILDS/.test(text)) sawIgnoredBuilds = true;
        if (stream === 'stderr') this.logger.log(`[updater:err] ${text.trimEnd()}`);
        buf += text;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          if (stream === 'stdout') this.logger.log(`[updater:out] ${t}`);
          try { onLine(t); } catch {}
        }
      };
      child.stdout.on('data', (d) => feed(d, 'stdout'));
      child.stderr.on('data', (d) => feed(d, 'stderr'));
      child.on('error', (err) => reject(err));
      child.on('exit', (code) => {
        this._child = null;
        if (code === 0) return resolve();
        const err = /** @type {Error & { ignoredBuilds?: boolean }} */ (new Error(`pnpm 退出码 ${code}${combinedTail.trim() ? `：${combinedTail.trim()}` : ''}`));
        err.ignoredBuilds = sawIgnoredBuilds;
        reject(err);
      });
    });
  }

  /**
   * 把清单里的插件全部装进新内核。**任何一个装失败，整次更新就失败。**
   *
   * 曾经这里是「失败就 warn 一声接着装下一个」，那会漏出一个很隐蔽的洞：
   * 假设装失败的正好是**被用户关掉**的插件 —— 它不在 `_activationPatch` 生成的
   * overlay 里，于是 `_verify` 起的那次自检根本不加载它，自检照样通过，新内核被
   * 扶正。等用户哪天在插件面板里把它重新打开、重启，内核 import 一个不存在的
   * 模块 → 秒退 → 黑屏。事故发生在装完的好几天之后，且和「更新内核」这个动作
   * 完全对不上，基本没法排查。
   *
   * 「被关掉的插件也要照样装」是 installPlugin 的既定意图（见 plugin-install.js），
   * 装不上就说明这个新内核不完整，不该扶正。失败的代价只是这次更新不生效、
   * 继续用当前能跑的内核，比留一颗定时炸弹便宜得多。
   */
  _installPlugins(kernelDir) {
    if (!this.pluginsDir || !fs.existsSync(this.pluginsDir)) {
      this.logger.warn('[updater] 未找到插件目录，跳过插件重装:', this.pluginsDir);
      return;
    }
    const plugins = loadPluginManifest(this.pluginsDir);
    for (const plugin of plugins) {
      try {
        installPlugin({
          pluginSrcDir: resolvePluginSrcDir({
            pluginsDir: this.pluginsDir,
            nodeModulesDir: this.nodeModulesDir,
            packageName: plugin.packageName,
          }),
          nodeModulesDir: kernelNodeModulesDir(kernelDir),
          manifestPath: dshManifestPath(kernelDir),
          expectedName: plugin.packageName,
          logger: this.logger,
        });
      } catch (error) {
        throw new Error(
          `插件 ${plugin.packageName} 安装失败，新内核不完整：${error?.message ?? error}`,
          { cause: error },
        );
      }
    }
  }

  /**
   * 备好自检用的激活 overlay，返回路径；不可用时返回 null。与 DshService 写同一
   * 个文件、同一份内容（含用户开关状态——关掉的插件同样不该出现在自检里），
   * 所以先后顺序无所谓。
   * @returns {string|null}
   */
  _activationPatch() {
    if (!this.pluginsDir || !this.activationPatchPath) return null;
    // 这里**不吞异常**，理由和 _installPlugins 同源：吞掉就等于「自检验的内核」
    // 和「将来真正启动的内核」不是同一个配置 —— 自检跑的是没有插件的干净内核，
    // 通过之后扶正，用户下次启动才带着 overlay 加载插件，崩在那时候。
    // 只有「压根没配插件」（上面那个 return null）才是合法的无 overlay。
    return writeActivationPatch(
      this.activationPatchPath, loadPluginManifest(this.pluginsDir), loadPluginState(this.pluginStatePath),
    );
  }

  /**
   * 校验新内核可启动：真正 boot 一次 web，等待内核打印 URL 并 HTTP 就绪后立即
   * 结束。这样能覆盖「依赖树完整 + 插件激活」的完整加载路径，而不只是读版本号。
   */
  async _verify(kernelDir, version) {
    const nodeExe = path.join(kernelDir, 'node.exe');
    const binJs = path.join(kernelDir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    // 用隔离的 DSH_HOME 自检，避免与正在运行的主内核并发读写用户 profile。
    const verifyHome = path.join(path.dirname(kernelDir), '.verify-home');
    fs.rmSync(verifyHome, { recursive: true, force: true });
    // 自检必须带上激活 overlay：不带就等于验了一个「没有插件的内核」，而真正
    // 启动时是带着 overlay 跑的 —— 插件加载阶段的崩溃就会溜过自检。
    // `--patch` 排在 `--host` 之前，理由见 DshService 里的同名注释。
    const args = [binJs, 'web'];
    const patchPath = this._activationPatch();
    if (patchPath) args.push('--patch', patchPath);
    // 端口交给内核自己申请（`--port 0`），与 DshService 的正式启动路径保持一致。
    // 这里曾经是「父进程探一个空闲端口再交给内核」，那条老路有固有的时间差：探测
    // 成功不代表几秒后内核 bind 时还绑得上。Windows 上 Hyper-V / WSL2 / Docker 会
    // **动态**预留大段端口（实测一台机器 60 段、约占动态端口范围的 37%），撞上就是
    // `listen EACCES` —— v1.3.1 那个补丁版本修的正是这个。留在这条路上的后果是：
    // 恰恰在那批机器上，内核热更新会反复自检失败、永远更新不了，而错误信息看起来
    // 像「新内核坏了」。实际端口从内核打印的 `dsh web: http://127.0.0.1:<port>`
    // 那行读回来。
    args.push('--host', '127.0.0.1', '--port', '0', '--no-open');

    const child = spawn(nodeExe, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, DSH_HOME: verifyHome, DSH_DESKTOP_VERIFY: '1' },
    });

    let stderrTail = '';
    /** @type {{ value: {code: number|null, signal: NodeJS.Signals|null}|null }} */
    const exitState = { value: null };
    /** @type {{ value: string|null }} */
    const urlState = { value: null };
    let stdoutTail = '';
    child.stdout.on('data', (d) => {
      if (urlState.value) return;
      stdoutTail = (stdoutTail + d.toString('utf8')).slice(-4000);
      const m = URL_LINE_RE.exec(stdoutTail);
      if (m) urlState.value = m[1].replace(/\/+$/, '');
    });
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString('utf8')).slice(-4000); });
    child.on('error', () => {});
    // 记录退出：自检的关键不是「端口通没通」，而是「通了之后进程还活着吗」。
    child.on('exit', (code, signal) => { exitState.value = { code, signal }; });

    const stopChild = () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
        } else {
          child.kill();
        }
      } catch {}
    };

    try {
      const url = await waitUrlLine(urlState, exitState, URL_LINE_TIMEOUT_MS);
      await waitHttpReady(url, 30000, () => exitState.value !== null);
      // 端口通了不代表 plugin tree 加载完成：dsh 先绑端口、后加载插件树，插件加载
      // 阶段崩溃时 HTTP 早已能应答。这里再观察一段时间确认进程没有随后崩溃 —— 否则
      // 一个坏内核会通过自检被原子切换扶正，把一次性故障变成每次启动都复现的故障。
      await new Promise((r) => setTimeout(r, VERIFY_SETTLE_MS));
      if (exitState.value) {
        const { code, signal } = exitState.value;
        throw new Error(`进程在自检期间退出（code=${code}${signal ? ` signal=${signal}` : ''}）`);
      }
      stopChild();
      this.logger.log('[updater] 新内核 web 自检通过');
    } catch (error) {
      stopChild();
      throw new Error(`新内核 web 自检失败：${error?.message ?? error}${stderrTail.trim() ? `\n${stderrTail.trim()}` : ''}`);
    } finally {
      fs.rmSync(verifyHome, { recursive: true, force: true });
    }

    const installed = readKernelVersion(kernelDir);
    if (installed && installed !== version) {
      this.logger.log(`[updater] 实际安装版本 ${installed}（请求 ${version}）`);
    }
  }

  /** 取消正在进行的安装（尽力而为）。 */
  cancel() {
    if (this._child) {
      try { this._child.kill(); } catch {}
      this._child = null;
    }
  }

  /** 重启应用以应用更新。 */
  restart() {
    if (typeof this.onRestart === 'function') this.onRestart();
  }
}

module.exports = { KernelUpdater, REGISTRY_PRESETS, AUTO_CHECK_INTERVAL_MS };
