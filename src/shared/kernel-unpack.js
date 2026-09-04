'use strict';

// 出厂内核的首启解包。
//
// 打包时内核被压成单个 kernel.tar.gz（见 scripts/pack-kernel.mjs 的理由：资源管理器
// 解 zip 的耗时由**文件个数**决定，15444 个文件要 181 秒，而同一份内容打成一个文件
// 后用户那一步几乎瞬间完成）。代价是首次启动要把它铺开，这里就是那一步。
//
// 两条解包路径：
//   1. 系统 tar（Windows 10 1803+ 自带 bsdtar，macOS 自带）——实测 12.3 秒，首选；
//   2. 自带的 ustar 解包器——tar 不存在或失败时兜底。慢一些，但不依赖任何外部程序，
//      也就不会出现「某台机器上没有 tar 就永远装不上」这种死局。
//
// 解包目标优先「就地」（resources/kernel），保住 README 承诺的「拷到别的电脑也照样
// 跑」；那里不可写（比如被放进 Program Files）就退到用户内核目录——那本来就是
// resolvePackagedKernel 会优先选的位置，不需要新机制。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { isKernelComplete } = require('./kernel-paths');

/** 打包产物的固定文件名，pack-kernel 与这里共用。 */
const ARCHIVE_NAME = 'kernel.tar';
const MANIFEST_NAME = 'kernel.manifest.json';

/** @param {string} kernelDir */
function archivePathOf(kernelDir) {
  return path.join(kernelDir, ARCHIVE_NAME);
}

/**
 * 解析要用哪个 tar。
 *
 * Windows 上**不能直接用 PATH 里的 `tar`**：装了 Git for Windows 的机器上，PATH
 * 里往往是 MSYS 的 GNU tar，而它会把 `C:\...` 当成 `host:path` 形式的远程地址，
 * 报 `Cannot connect to C: resolve failed`（本机实测踩到）。系统自带的 bsdtar
 * （Windows 10 1803+）在固定位置，直接指名道姓地用它，绕开 PATH 顺序的不确定性。
 * 找不到才退回 PATH 里的 `tar`（macOS / Linux 走的就是这条）。
 */
function resolveTarCommand() {
  if (process.platform === 'win32') {
    const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(systemTar)) return systemTar;
  }
  return 'tar';
}

/**
 * 需不需要解包：有归档、且当前目录还不是一个完整内核。
 * 解包成功后归档会被删掉，所以这个判断天然只在首启为真。
 * @param {string} kernelDir
 */
function needsUnpack(kernelDir) {
  return fs.existsSync(archivePathOf(kernelDir)) && !isKernelComplete(kernelDir);
}

/** 目录能不能写：直接试着建目录 + 写一个探针文件，比查权限位可靠。 */
function isWritable(dir) {
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 解开出厂内核。
 *
 * @param {object} opts
 * @param {string} opts.kernelDir      归档所在目录（打包态的 resources/kernel）
 * @param {string} [opts.fallbackDir]  就地不可写时的落点（用户内核目录）
 * @param {{log: Function, warn: Function}} [opts.logger]
 * @param {(text: string) => void} [opts.onStatus] 进度文案回调（闪屏用）
 * @returns {Promise<{dir: string, method: 'tar'|'builtin', usedFallback: boolean, seconds: number}>}
 */
async function unpackKernel(opts) {
  const { kernelDir, fallbackDir, logger = console, onStatus } = opts;
  const archive = archivePathOf(kernelDir);
  if (!fs.existsSync(archive)) throw new Error(`找不到内核归档：${archive}`);

  const inPlace = isWritable(kernelDir);
  const target = inPlace ? kernelDir : fallbackDir;
  if (!target) throw new Error(`内核目录不可写，且没有可用的备用目录：${kernelDir}`);
  if (!inPlace) {
    logger.warn(`[kernel] ${kernelDir} 不可写，改解到 ${target}`);
    if (!isWritable(target)) throw new Error(`备用目录也不可写：${target}`);
  }

  const started = Date.now();
  onStatus?.('正在准备内核（仅首次，约需十几秒）…');

  let method = /** @type {'tar'|'builtin'} */ ('tar');
  try {
    await extractWithSystemTar(archive, target);
  } catch (error) {
    // tar 不存在（老版本 Windows）或解压失败：换自带解包器再来一次。不直接失败，
    // 否则用户拿到的就是一个永远装不上的包。
    logger.warn(`[kernel] 系统 tar 解包失败（${error?.message ?? error}），改用内置解包器`);
    method = 'builtin';
    await extractUstar(archive, target);
  }

  if (!isKernelComplete(target)) {
    throw new Error(`解包后内核仍不完整：${target}`);
  }
  verifyFileCount(kernelDir, target, logger);

  // 解包成功后归档就没用了，删掉省一份磁盘（就地解包才删——落到备用目录时，
  // 归档还在只读的安装目录里，删不掉也不该删）。
  if (inPlace) {
    try {
      fs.rmSync(archive, { force: true });
      fs.rmSync(path.join(kernelDir, MANIFEST_NAME), { force: true });
    } catch (error) {
      logger.warn(`[kernel] 删除归档失败（不影响使用）：${error?.message ?? error}`);
    }
  }

  const seconds = (Date.now() - started) / 1000;
  logger.log(`[kernel] 解包完成：${target}（${method === 'tar' ? '系统 tar' : '内置解包器'}，${seconds.toFixed(1)}s）`);
  return { dir: target, method, usedFallback: !inPlace, seconds };
}

/** 核对解出来的文件数与打包时记录的是否一致，对不上只警告不拦——内核完整性已经查过。 */
function verifyFileCount(kernelDir, target, logger) {
  try {
    const manifestPath = path.join(kernelDir, MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) return;
    const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))?.files;
    if (typeof expected !== 'number') return;
    let actual = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name));
        else if (entry.isFile()) actual += 1;
      }
    };
    walk(target);
    if (actual < expected) {
      logger.warn(`[kernel] 解包文件数偏少：期望 ${expected}，实际 ${actual}`);
    }
  } catch {
    // 核对本身失败不该影响启动。
  }
}

/** @returns {Promise<void>} */
function extractWithSystemTar(archive, target) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveTarCommand(), ['-xf', archive, '-C', target], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar 退出码 ${code}${stderr ? `：${stderr.trim().split('\n')[0]}` : ''}`));
    });
  });
}

// ---------------------------------------------------------------------------
// 内置 ustar 解包器（兜底）
// ---------------------------------------------------------------------------
// 只实现 ustar：归档由我们自己用 `--format=ustar` 生成，不会出现 GNU 长名或 PAX
// 扩展头。归档本身不压缩（压缩交给外层的 zip / NSIS —— 预先 gzip 会让安装包的
// LZMA 无从发挥，实测大 19MB）。流式处理而不是整个读进内存：255MB 全读进来会让
// 主进程卡住十几秒，闪屏连重绘都做不到，看着就像卡死。

const BLOCK = 512;

/** 从 512 字节头里取一段以 NUL 结尾的字符串。 */
function readString(block, offset, length) {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

/** ustar 的数值字段是补零的八进制字符串。 */
function readOctal(block, offset, length) {
  const text = readString(block, offset, length).trim();
  if (!text) return 0;
  const value = parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 解开我们自己生成的 ustar + gzip 归档。
 * @param {string} archive
 * @param {string} target
 */
async function extractUstar(archive, target) {
  const stream = fs.createReadStream(archive);
  let carry = Buffer.alloc(0);
  /** @type {{handle: fsp.FileHandle, remaining: number, padding: number, path: string, mode: number}|null} */
  let open = null;

  const finishOpen = async () => {
    if (open && open.remaining === 0 && open.padding === 0) {
      await open.handle.close();
      // ustar 头里的 mode 才是权威来源——`fsp.open(dest, 'w')` 用的是 umask 默认
      // 权限（通常 0644）。Windows 上没有执行位这回事，NTFS 上任何权限都能跑，
      // 这个 bug 一直没暴露；换到 POSIX，只要走了这条兜底路径，解出来的 node /
      // rg 就是不可执行的，内核直接起不来。
      //
      // 两个前提检查：
      //   - **win32 直接跳过**。那边 chmod 唯一的效果是切换只读属性，帮不上忙，
      //     反倒会把归档里 0444 的条目变成只读文件；而内核树有 15000+ 个文件，
      //     省下的是同样数量的无用系统调用。
      //   - **mode 为 0 时跳过**。readOctal 解析不出来时返回 0，chmod(path, 0)
      //     会让文件**谁都读不了**，内核换一种方式坏掉，而且报错指不到这里。
      //     我们自己 `tar --format=ustar` 打的归档一定有 mode，所以这纯粹是给
      //     「兜底解包器遇到意外归档」兜底 —— 那正是它存在的理由。
      if (process.platform !== 'win32' && open.mode) {
        await fsp.chmod(open.path, open.mode & 0o7777);
      }
      open = null;
    }
  };

  for await (const chunk of stream) {
    carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    // 一轮里可能既要写文件数据、又要读下一个头，所以循环到吃不动为止。
    for (;;) {
      if (open) {
        if (open.remaining > 0) {
          const take = Math.min(open.remaining, carry.length);
          if (take === 0) break;
          await open.handle.write(carry.subarray(0, take));
          carry = carry.subarray(take);
          open.remaining -= take;
          continue;
        }
        // 文件数据写完了，还要吃掉补齐到 512 的那几个字节。
        const skip = Math.min(open.padding, carry.length);
        carry = carry.subarray(skip);
        open.padding -= skip;
        await finishOpen();
        if (open) break; // padding 还没吃完，等下一个 chunk
        continue;
      }

      if (carry.length < BLOCK) break;
      const header = carry.subarray(0, BLOCK);
      carry = carry.subarray(BLOCK);
      // 全 0 的块表示归档结束。
      if (header.every((b) => b === 0)) continue;

      const name = readString(header, 0, 100);
      const mode = readOctal(header, 100, 8);
      const size = readOctal(header, 124, 12);
      const typeflag = String.fromCharCode(header[156] || 0x30);
      const prefix = readString(header, 345, 155);
      const rel = prefix ? `${prefix}/${name}` : name;
      // 归档里的路径全是相对的（打包时 -C kernel .），但解包器不能假设这一点：
      // 带 .. 或绝对路径的条目会写到目标目录外面去（tar 穿越漏洞）。
      const dest = path.resolve(target, rel);
      if (dest !== path.resolve(target) && !dest.startsWith(path.resolve(target) + path.sep)) {
        throw new Error(`归档里有越界路径：${rel}`);
      }

      if (typeflag === '5') {
        await fsp.mkdir(dest, { recursive: true });
        continue;
      }
      if (typeflag !== '0' && typeflag !== '\0') {
        // 符号链接等类型我们的归档里不会有，跳过它的数据块。
        const padding = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK);
        open = { handle: /** @type {any} */ (null), remaining: size, padding, path: dest, mode };
        // 没有句柄就不能走上面的写分支，这里直接把数据丢掉。
        const drop = Math.min(size + padding, carry.length);
        carry = carry.subarray(drop);
        open = null;
        continue;
      }

      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const handle = await fsp.open(dest, 'w');
      const padding = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK);
      open = { handle, remaining: size, padding, path: dest, mode };
      await finishOpen();
    }
  }

  if (open) {
    await open.handle.close();
    throw new Error('归档在文件中间意外结束');
  }
}

module.exports = {
  ARCHIVE_NAME,
  MANIFEST_NAME,
  archivePathOf,
  needsUnpack,
  resolveTarCommand,
  unpackKernel,
  extractUstar,
};
