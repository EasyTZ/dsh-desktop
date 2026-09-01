'use strict';

// 启动时把 **profile 层（A1）插件**对账回随包分发的那一版。
//
// 背景见 src/shared/profile-plugins.js 的头部注释：插件市场装在用户的 profile 里
// （不跟内核走，内核热更新/回退都不影响它），但它同时又是发行版承诺提供的功能，
// 所以桌面要保证「首次启动就在、被误删了会自愈、版本跟着应用版本走」。
//
// 三条硬约束：
//
//   1. **不能阻塞启动**。对账失败只记日志，应用照常起来——最坏情况是市场面板这一次
//      不可用，而不是应用打不开。
//   2. **不能联网**。装的是发行包里躺着的 tgz，首次启动断网也能装上。
//   3. **常态零开销**。版本一致时只读两个 package.json 就返回，不 spawn 任何进程。
//      冷启动多几秒是用户能感觉到的，而「一致」是绝大多数次启动的情况。
//
// 为什么走 `dsh plugin add` 而不是直接调 pnpm：`dsh plugin` 除了转发 pnpm，还会
// reconcile `dsh.profile.bundles`（按安装后的实际状态判断哪些依赖声明了 dsh.bundle，
// 据此维护 patch 层列表）。那段逻辑是上游的，我们自己实现一遍就等着分叉——装完却
// 没激活、或者卸载后层列表里留个幽灵条目。

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadProfilePluginIndex, planProfileReconcile, planProfileCleanup, entryIdsForPackage,
  installedVersionIn, loadSeedState, saveSeedState,
} = require('../shared/profile-plugins');

/** 单个插件的安装超时。本地 tgz 不需要下载，但 pnpm 建链接、写 lockfile 也要点时间。 */
const INSTALL_TIMEOUT_MS = 120000;

/** 桌面版启动的 profile 名。与 dsh-service 里 `args = [binJs, 'web']` 是同一个事实。 */
const PROFILE_NAME = 'web';

/**
 * 解析 dsh home。语义与上游 `@deepseek-ai/dsh-home-paths` 一致：`DSH_HOME` 覆盖，
 * 否则 `~/.dsh`。**必须跟上游一致**，否则我们往一个目录装、内核从另一个目录读，
 * 表现是「装了但面板不出现」，而且没有任何报错。
 */
function resolveDshHome(env = process.env) {
  const override = env.DSH_HOME;
  return typeof override === 'string' && override.length > 0
    ? path.resolve(override)
    : path.join(os.homedir(), '.dsh');
}

function profileDir(env = process.env) {
  return path.join(resolveDshHome(env), 'profiles', PROFILE_NAME);
}

/**
 * 造一个 `pnpm` 的 PATH 垫片，指向随包分发的那份 pnpm。
 *
 * 为什么需要：`dsh plugin` 内部是 `spawnSync("pnpm", …)`，靠 PATH 找。而用户机器上
 * **不一定装了 pnpm**——桌面版本来就承诺「无需额外环境」。发行包里带的是
 * `kernel/pnpm/bin/pnpm.cjs`（一个 .cjs 文件，不是可执行程序），PATH 里放它没用，
 * 得有个同名的可执行入口。
 *
 * 这个垫片同时也让**市场面板里的一键安装**能用：它走的也是 `dsh plugin add`，在没有
 * 系统 pnpm 的机器上原本会直接失败。所以垫片目录要一并塞进内核进程的 PATH。
 *
 * @returns {string|null} 垫片目录；造不出来返回 null（调用方据此退回「碰运气用系统 pnpm」）
 */
function ensurePnpmShim({ shimDir, nodeExe, pnpmCliPath }) {
  if (!nodeExe || !pnpmCliPath || !fs.existsSync(pnpmCliPath)) return null;
  try {
    fs.mkdirSync(shimDir, { recursive: true });
    if (process.platform === 'win32') {
      // `%*` 透传全部参数；`@echo off` 避免 pnpm 的输出里混进命令回显。
      fs.writeFileSync(
        path.join(shimDir, 'pnpm.cmd'),
        `@echo off\r\n"${nodeExe}" "${pnpmCliPath}" %*\r\n`,
        'utf8',
      );
    } else {
      const shim = path.join(shimDir, 'pnpm');
      fs.writeFileSync(shim, `#!/bin/sh\nexec "${nodeExe}" "${pnpmCliPath}" "$@"\n`, 'utf8');
      fs.chmodSync(shim, 0o755);
    }
    return shimDir;
  } catch {
    return null;
  }
}

/** 把垫片目录放到 PATH 最前面。找不到垫片就原样返回。 */
function withPnpmOnPath(env, shimDir) {
  if (!shimDir) return env;
  // Windows 的环境变量名大小写不敏感，但 Node 的 env 对象是敏感的——直接写 'PATH'
  // 可能造出第二个键，而子进程读到的是原来那个。找出实际的键名再改。
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...env, [key]: `${shimDir}${path.delimiter}${env[key] ?? ''}` };
}

/**
 * 一次装若干个 tarball。
 *
 * **批量而不是逐个**：首次启动要播 5 个种，逐个跑就是 5 次 pnpm 冷启动，而这段路
 * 挂在应用启动上、用户正对着闪屏等。`dsh plugin add` 把参数原样转给 pnpm，pnpm 本来
 * 就接受多个 spec，一次装完只有一次进程与 lockfile 开销。
 *
 * 代价是**失败是整体的**：一个包坏了这一批都不算成功。可以接受——这些 tarball 是我们
 * 自己打进发行包的，一个装不上通常意味着包本身有问题（磁盘损坏、杀软隔离），那时逐个
 * 重试也好不到哪去，而错误输出里会写明是哪个包。
 */
/** 取输出末尾若干行，用于报错展示。 */
function tailOf(output, lines = 10) {
  return String(output ?? '').split('\n').slice(-lines).join('\n');
}

/** 从 profile 里移除若干个包（改名残留清理用，见 planProfileCleanup）。 */
function runDshPluginRemove({ nodeExe, binJs, cwd, env, names }) {
  return new Promise((resolve) => {
    execFile(nodeExe, [binJs, 'plugin', '--profile', PROFILE_NAME, 'remove', ...names], {
      cwd,
      env: { ...env, CI: '1' },
      maxBuffer: 16 * 1024 * 1024,
      timeout: INSTALL_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });
}

function runDshPluginAdd({ nodeExe, binJs, cwd, env, specs }) {
  return new Promise((resolve) => {
    execFile(nodeExe, [binJs, 'plugin', '--profile', PROFILE_NAME, 'add', ...specs], {
      cwd,
      // CI=1：pnpm 在非交互环境下不要停下来等确认，否则这个 spawn 永远不返回、
      // 而它挂在应用启动路径上。
      env: { ...env, CI: '1' },
      maxBuffer: 16 * 1024 * 1024,
      timeout: INSTALL_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout ?? ''}${stderr ?? ''}`.trim(), error });
    });
  });
}

/**
 * 对账并安装。
 *
 * @param {object} options
 * @param {string} options.profileDistDir profile 插件的产物目录（index.json + tgz 所在处）
 * @param {string} options.nodeExe 内核自带的 node
 * @param {string} options.binJs 内核的 dsh 入口
 * @param {string} options.pnpmCliPath 随包分发的 pnpm.cjs
 * @param {string} options.shimDir 垫片目录（可写，通常在 userData 下）
 * @param {string} options.seedStatePath 播种账本路径（可写，userData 下）
 * @param {{ log(msg: string): void, warn(msg: string): void }} options.logger
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<{ installed: string[], failed: string[], shimDir: string|null }>}
 */
async function reconcileProfilePlugins(options) {
  const {
    profileDistDir, nodeExe, binJs, pnpmCliPath, shimDir, seedStatePath, logger, env = process.env,
  } = options;
  /** @type {{ installed: string[], failed: string[], shimDir: string|null }} */
  const result = { installed: [], failed: [], shimDir: null };

  let desired = [];
  try {
    desired = loadProfilePluginIndex(profileDistDir);
  } catch (error) {
    logger.warn(`[profile-plugins] 索引读不出来，跳过对账：${error?.message ?? error}`);
    return result;
  }

  // 垫片无论要不要装都要造：市场面板里的一键安装也靠它（见 ensurePnpmShim 注释）。
  result.shimDir = ensurePnpmShim({ shimDir, nodeExe, pnpmCliPath });
  if (desired.length === 0) return result;

  const dir = profileDir(env);
  let seeded = loadSeedState(seedStatePath);

  // 先清残留，再装新的。顺序不能反：改名的场景下新旧两个包声明同一个 entry id，
  // 先装会让 profile 短暂处于「两个都在」的状态——这中间要是被打断（断电、杀进程），
  // 下次启动就是 duplicate loader entry id + 黑屏。
  const spawnEnv0 = withPnpmOnPath(env, result.shimDir);
  const stale = planProfileCleanup(desired, seeded, (name) => entryIdsForPackage(dir, name));
  if (stale.length > 0) {
    logger.log(`[profile-plugins] 清理会撞 entry id 的历史残留：${stale.join(', ')}`);
    const removed = await runDshPluginRemove({
      nodeExe, binJs, cwd: path.dirname(binJs), env: spawnEnv0, names: stale,
    });
    if (removed.ok) {
      seeded = { ...seeded };
      for (const name of stale) delete seeded[name];
      try {
        saveSeedState(seedStatePath, seeded);
      } catch { /* 账本写不下不影响这次清理的效果 */ }
    } else {
      // 清不掉就别再装新的：装了就是两个撞 id 的包共存，内核起不来。宁可这一次
      // 少几个插件，也不要一个打不开的应用。
      logger.warn(`[profile-plugins] 残留清理失败，本次跳过安装以免撞 entry id：\n${tailOf(removed.output)}`);
      return result;
    }
  }

  const plan = planProfileReconcile(desired, (name) => installedVersionIn(dir, name), seeded);
  if (plan.length === 0) {
    logger.log(`[profile-plugins] 无需处理（随包 ${desired.length} 个，已播种 ${Object.keys(seeded).length} 个）`);
    return result;
  }

  const specs = [];
  for (const entry of plan) {
    const tarball = path.join(profileDistDir, entry.tarball);
    if (!fs.existsSync(tarball)) {
      logger.warn(`[profile-plugins] ${entry.packageName} 的 tarball 不在包里：${tarball}`);
      result.failed.push(entry.packageName);
      continue;
    }
    const actual = installedVersionIn(dir, entry.packageName);
    logger.log(`[profile-plugins] 待装 ${entry.packageName}@${entry.version}（当前：${actual ?? '未安装'}）`);
    specs.push({ entry, tarball });
  }
  if (specs.length === 0) return result;

  const run = await runDshPluginAdd({
    nodeExe, binJs, cwd: path.dirname(binJs), env: spawnEnv0, specs: specs.map((s) => s.tarball),
  });
  if (run.ok) {
    // **装成功之后才记账**。失败也记的话，那个插件就再也不会被尝试，用户看到的是
    // 一个「本该随应用分发、却始终不存在」的插件——而且没有任何提示。
    const next = { ...seeded };
    for (const { entry } of specs) {
      result.installed.push(entry.packageName);
      next[entry.packageName] = entry.version;
    }
    try {
      saveSeedState(seedStatePath, next);
    } catch (error) {
      // 账本写不下只影响「下次还会不会重播种」，装是已经装好了，不该因此报失败。
      logger.warn(`[profile-plugins] 播种账本写入失败（下次启动可能重播）：${error?.message ?? error}`);
    }
    logger.log(`[profile-plugins] 装好了：${result.installed.join(', ')}`);
  } else {
    for (const { entry } of specs) result.failed.push(entry.packageName);
    // 失败只记录不抛：这条路挂在应用启动上，插件缺席远好过应用起不来。
    const tail = run.output.split('\n').slice(-10).join('\n');
    logger.warn(`[profile-plugins] 安装失败，本次启动这些插件不可用：${result.failed.join(', ')}\n${tail}`);
  }
  return result;
}

module.exports = {
  reconcileProfilePlugins,
  ensurePnpmShim,
  withPnpmOnPath,
  resolveDshHome,
  profileDir,
  PROFILE_NAME,
};
