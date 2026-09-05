'use strict';

// 上一次没善终留下的孤儿内核：识别与清理。
//
// 为什么会有孤儿：`DshService` spawn 内核时在非 win32 上带了 `detached: true`
// （见那边的注释——内核自己还会 spawn node-pty 的 shell 和 pnpm，不开独立进程组
// 就没法在退出时把整棵树杀干净）。代价是内核同时进了**独立会话**（detached 会
// setsid），于是外壳**非正常退出**时——SIGKILL、崩溃、终端挂断——它收不到任何
// 信号，直接被 systemd/init 收养，一直占着内存和一个回环端口到重启为止。
//
// 净效果是「正常退出更干净，异常退出更脏」。正常退出那一半是刚需（node-pty 的
// shell 孤儿更常见），所以不是回退 detached，而是把异常退出这一半补上。
//
// **为什么用 pid 文件，不去枚举进程的环境变量**：`dsh-service` 确实给内核注入了
// `DSH_DESKTOP_PARENT_PID`，靠它反查也能认出孤儿，但那需要遍历全系统进程读各自
// 的 environ —— Linux 上读 /proc 还算便宜，macOS 得靠 `ps -E`（对非自己的进程
// 会被拒），Windows 要走 WMI。而 pid 文件把这件事变成一次 `readFileSync`：
// **正常退出时会删掉它，所以「文件还在」本身就等于「上次没善终」**，连判断都省了。
//
// **必须防 PID 复用**：记下的 pid 可能早已退出、号被系统回收给了别的进程，
// 那时候照着杀就是误伤无辜。所以杀之前一定要核对该进程的命令行确实指向我们
// 记下的那个 bin.js —— 这个判断放在 `shouldKillOrphan` 里，是本文件唯一有
// 分支的逻辑，也是唯一值得单测的部分。

const fs = require('node:fs');

/** @typedef {{pid: number, binJs: string}} KernelPidRecord */

/**
 * 写下「当前内核是谁」。spawn 成功后立刻调用。
 *
 * 写失败只警告不抛：这是一个用于**下次启动**收拾残局的便利设施，写不下来最多是
 * 将来少清理一个孤儿，不该让本次启动失败。
 * @param {string} filePath
 * @param {KernelPidRecord} record
 * @param {{warn: Function}} [logger]
 */
function writeKernelPid(filePath, record, logger = console) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(record));
  } catch (error) {
    logger.warn('[orphan] 记录内核 pid 失败（不影响本次运行）:', error?.message ?? error);
  }
}

/**
 * 清掉记录。**内核正常退出后调用** —— 文件不在，就代表上次是善终的。
 * @param {string} filePath
 */
function clearKernelPid(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // 删不掉最多是下次启动多做一次核对（核对不过就不会杀），没有坏处。
  }
}

/**
 * 读回上次的记录；没有 / 读不动 / 格式不对都返回 null（一律当作「上次是善终的」，
 * 宁可漏杀不可错杀）。
 * @param {string} filePath
 * @param {(p: string, enc: 'utf8') => string} [readFile]
 * @returns {KernelPidRecord|null}
 */
function readKernelPid(filePath, readFile = /** @type {any} */ (fs.readFileSync)) {
  try {
    const raw = JSON.parse(String(readFile(filePath, 'utf8')));
    if (!Number.isInteger(raw?.pid) || raw.pid <= 0) return null;
    if (typeof raw?.binJs !== 'string' || raw.binJs.length === 0) return null;
    return { pid: raw.pid, binJs: raw.binJs };
  } catch {
    return null;
  }
}

/**
 * 该不该杀这个 pid。
 *
 * 判据只有一条：**该进程当前的命令行里确实含有我们记下的那个 bin.js 路径**。
 * pid 会被系统回收再分配，光看「这个 pid 还活着」远远不够 —— 那样迟早会杀掉
 * 一个碰巧拿到同一个号的无辜进程。
 *
 * `cmdline` 传 null 表示「进程已经不在」或「读不到它的命令行」，两种都返回 false：
 * 前者本来就没什么好杀的，后者属于拿不准，拿不准就不动手。
 *
 * @param {KernelPidRecord|null} record
 * @param {string|null} cmdline 该 pid 当前的命令行；进程不在或读不到时传 null
 * @returns {boolean}
 */
function shouldKillOrphan(record, cmdline) {
  if (!record || typeof cmdline !== 'string' || cmdline.length === 0) return false;
  return cmdline.includes(record.binJs);
}

module.exports = {
  writeKernelPid,
  clearKernelPid,
  readKernelPid,
  shouldKillOrphan,
};
