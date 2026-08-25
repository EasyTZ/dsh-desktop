'use strict';

// 定位本机全局安装的 dsh 与 pnpm。构建脚本（同步）与主进程开发态（异步）共用。
//
// 这里刻意不写死任何机器专属路径：候选位置全部由 `npm root -g`、APPDATA 与当前
// node 可执行文件的位置推导。写死 D:\nodejs 之类只在作者机器上成立，对别人是噪音。
// 需要指到别处时用环境变量覆盖：DSH_INSTALL_DIR / DSH_BIN_JS / DSH_NODE_EXE / DSH_PNPM_DIR。

const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 不依赖 npm 的全局 node_modules 候选位置。 */
function staticNodeModulesRoots() {
  const roots = [];
  if (process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  }
  // nvm-windows / 便携版 node：node.exe 与 node_modules 同级。
  roots.push(path.join(path.dirname(process.execPath), 'node_modules'));
  return roots;
}

/**
 * 构造「问 npm 要全局 node_modules 路径」的命令。
 *
 * Windows 上 npm 是 npm.cmd，而 Node 自 CVE-2024-27980 起禁止直接 spawn 批处理
 * 文件（异步 execFile 会 EINVAL）。这里显式走 cmd.exe：参数全是常量、没有注入
 * 面，也就不必用 shell: true —— 后者会触发 DEP0190（参数不转义）警告。
 */
function npmRootCommand() {
  if (process.platform === 'win32') {
    return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm root -g'] };
  }
  return { cmd: 'npm', args: ['root', '-g'] };
}

/** 同步问 npm 要全局 node_modules 路径；失败返回 null。 */
function npmRootSync() {
  const { cmd, args } = npmRootCommand();
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 异步版本，避免在应用启动路径上同步阻塞几百毫秒。 */
function npmRootAsync() {
  const { cmd, args } = npmRootCommand();
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const out = String(stdout).trim();
      resolve(out || null);
    });
  });
}

function dshCandidates(roots) {
  return roots.filter(Boolean).map((r) => path.join(r, '@deepseek-ai', 'dsh'));
}

function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

const NOT_FOUND = '找不到 dsh 安装目录。请先全局安装 DeepSeek Harness'
  + '（npm install -g @deepseek-ai/dsh），或设置环境变量 DSH_INSTALL_DIR 指向包目录。';

/** 同步定位全局 dsh 包目录（构建脚本用）。 */
function findDshInstallSync() {
  if (process.env.DSH_INSTALL_DIR && fs.existsSync(process.env.DSH_INSTALL_DIR)) {
    return process.env.DSH_INSTALL_DIR;
  }
  const hit = firstExisting(dshCandidates([npmRootSync(), ...staticNodeModulesRoots()]));
  if (!hit) throw new Error(NOT_FOUND);
  return hit;
}

/** 异步定位全局 dsh 包目录（主进程开发态用）。 */
async function findDshInstallAsync() {
  if (process.env.DSH_INSTALL_DIR && fs.existsSync(process.env.DSH_INSTALL_DIR)) {
    return process.env.DSH_INSTALL_DIR;
  }
  const hit = firstExisting(dshCandidates([await npmRootAsync(), ...staticNodeModulesRoots()]));
  if (!hit) throw new Error(NOT_FOUND);
  return hit;
}

/** 开发态的 dsh 入口脚本路径。 */
async function findDshBinJsAsync() {
  if (process.env.DSH_BIN_JS && fs.existsSync(process.env.DSH_BIN_JS)) {
    return process.env.DSH_BIN_JS;
  }
  return path.join(await findDshInstallAsync(), 'lib', 'bin.js');
}

/**
 * 定位 pnpm 包目录（自包含：pnpm 把实现打包进 dist，内嵌全部依赖）。
 * 打进内核后，用户机器上无需预装 Node/pnpm 也能热更新。
 */
function findPnpmDirSync() {
  if (process.env.DSH_PNPM_DIR && fs.existsSync(process.env.DSH_PNPM_DIR)) {
    return process.env.DSH_PNPM_DIR;
  }
  const roots = [npmRootSync(), ...staticNodeModulesRoots()].filter(Boolean);
  for (const r of roots) {
    const dir = path.join(r, 'pnpm');
    if (fs.existsSync(path.join(dir, 'bin', 'pnpm.cjs'))) return dir;
  }
  throw new Error('找不到 pnpm 安装目录（node_modules/pnpm）。请 npm install -g pnpm，'
    + '或设置环境变量 DSH_PNPM_DIR 指向 pnpm 包目录。');
}

module.exports = {
  staticNodeModulesRoots,
  npmRootSync,
  npmRootAsync,
  findDshInstallSync,
  findDshInstallAsync,
  findDshBinJsAsync,
  findPnpmDirSync,
};
