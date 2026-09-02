'use strict';

// 内核目录 layout 的唯一定义处。内置内核、用户内核（热更新产物）、staging
// 三处共用同一套约定，任何一处改了都必须从这里改。
//
//   <kernelDir>/node.exe
//   <kernelDir>/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js
//
// 注意 runtime/ 这一层不能省：electron-builder 硬排除 extraResources `from`
// 根部的 node_modules，套一层子目录才能把依赖树打进安装包。

const fs = require('node:fs');
const path = require('node:path');
const { isNewer } = require('./version');

/** 由内核目录推导 node.exe 与 bin.js 路径。 */
function kernelPaths(kernelDir) {
  return {
    nodeExe: path.join(kernelDir, 'node.exe'),
    binJs: path.join(kernelDir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  };
}

/** 内核目录里 dsh 的 package.json 路径。 */
function dshManifestPath(kernelDir) {
  return path.join(kernelDir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
}

/**
 * 内核目录是否看起来完整（node.exe 与 bin.js 都在）。
 * @param {string} kernelDir
 * @param {(p: string) => boolean} [exists]
 */
function isKernelComplete(kernelDir, exists = fs.existsSync) {
  const p = kernelPaths(kernelDir);
  return exists(p.nodeExe) && exists(p.binJs);
}

/** @typedef {(path: string, encoding: 'utf8') => string} ReadTextFile */

/**
 * 读某个内核目录里 dsh 的版本号；读不到返回 null。readFile 可注入，便于测试。
 * @param {string} kernelDir
 * @param {ReadTextFile} [readFile]
 * @returns {string|null}
 */
function readKernelVersion(kernelDir, readFile = /** @type {ReadTextFile} */ (fs.readFileSync)) {
  try {
    const manifest = JSON.parse(String(readFile(dshManifestPath(kernelDir), 'utf8')));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * 打包态解析内核：用户内核（热更新产物）优先，**但出厂内核更新时反超**。
 *
 * 「更新时反超」这条不是优化，是修一个真实的版本倒挂：安装包不会碰
 * `%APPDATA%`，所以用户装了带更新出厂内核的新版客户端后，旧的用户内核仍然
 * 完整、仍然被优先选中 —— 新客户端的 preload 与插件是照着新内核验证的，却
 * 跑在旧内核上，而且这个错配只能等 24h 节流过期后的自动检查、并且用户点了
 * 更新才会消解。这里直接比版本，让它压根不发生。
 *
 * 保守起见只在「能确证出厂内核更新」时反超：任一侧版本读不出来就维持原有
 * 行为（用户内核优先），不为一个读取失败引入新的启动分支。
 *
 * 不删除被反超的用户内核：它没坏，只是旧了；留着，将来热更新出更新的版本时
 * 会自然重新胜出。删除是不可逆的，而这里没有任何非删不可的理由。
 *
 * exists / readVersion 可注入，便于测试。
 * @returns {{nodeExe: string, binJs: string, source: 'user'|'builtin',
 *            version: string|null, supersededUserVersion: string|null}}
 */
/**
 * @param {string|null|undefined} userKernelDir
 * @param {string} builtinKernelDir
 * @param {(p: string) => boolean} [exists]
 * @param {(dir: string) => string|null} [readVersion]
 */
function resolvePackagedKernel(
  userKernelDir, builtinKernelDir, exists = fs.existsSync, readVersion = readKernelVersion,
) {
  const builtin = () => ({
    ...kernelPaths(builtinKernelDir),
    source: /** @type {'builtin'} */ ('builtin'),
    version: readVersion(builtinKernelDir),
    supersededUserVersion: null,
  });

  if (!userKernelDir || !isKernelComplete(userKernelDir, exists)) return builtin();

  const userVersion = readVersion(userKernelDir);
  const builtinVersion = readVersion(builtinKernelDir);
  if (userVersion && builtinVersion && isNewer(builtinVersion, userVersion)) {
    return { ...builtin(), supersededUserVersion: userVersion };
  }

  return {
    ...kernelPaths(userKernelDir),
    source: /** @type {'user'} */ ('user'),
    version: userVersion,
    supersededUserVersion: null,
  };
}

module.exports = {
  kernelPaths,
  dshManifestPath,
  isKernelComplete,
  readKernelVersion,
  resolvePackagedKernel,
};
