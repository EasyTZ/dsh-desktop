// 把 kernel/ 整棵树打成单个 kernel.tar.gz，交给 electron-builder 的 extraResources。
//
// 为什么要打包：绿色版是个 zip，而**用资源管理器解压 zip 的耗时由文件个数决定，
// 不是字节数**。同一份内核树（15444 个文件 / 123 MB）实测：
//   资源管理器「全部解压缩」 181 秒
//   .NET ZipFile             21.7 秒
//   系统 tar 解 tar.gz       12.3 秒
// 每个文件约 11.7ms 的固定开销 —— 数据本身两秒就能写完，时间全耗在文件个数上。
// 打成一个文件后，zip 里只剩几十个条目，用户那一步几乎瞬间完成；剩下的十几秒挪到
// 首次启动，由我们自己解（有进度提示，见 src/shared/kernel-unpack.js）。
//
// 归档**不预压缩**：压缩交给外层容器。实测纯 tar 再 deflate 是 74.4MB、预先 gzip 是
// 73.1MB（zip 那边没差别），但预先 gzip 会让安装包的 LZMA 无从发挥 —— 同一次构建
// 安装包从 152.7MB 涨到 171.5MB。
//
// `--format=ustar` 是刻意指定的：运行时的兜底解包器只实现 ustar（GNU/PAX 扩展头会
// 让解析复杂一大截）。本仓库最长相对路径 196 字符，ustar 的 100+155 放得下；万一
// 将来某个依赖的路径超限，tar 会在这里直接失败 —— **构建期炸，好过用户首启炸**。
//
// **这套「打 tar」只对 Windows 成立**：上面整段理由都是「资源管理器解 zip 慢」，
// 而 Linux 的 AppImage 是 squashfs 镜像，从来没有「逐文件解压」这一步，前提不存在。
// 所以非 Windows 目标直接跳过，electron-builder.yml 的 linux 段把 extraResources
// 指向 kernel/ 目录本身。目标平台由 dist.mjs 传下来的 --win/--linux 决定，不传时
// 按当前系统猜（本地单独跑本脚本调试时的兜底）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Windows 上不能直接用 PATH 里的 tar（Git 自带的 GNU tar 会把 C:… 当成远程主机），
// 与运行时解包共用同一套解析逻辑。
const { resolveTarCommand } = createRequire(import.meta.url)('../src/shared/kernel-unpack.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kernelDir = join(root, 'kernel');
const outDir = join(root, 'kernel-dist');
const archivePath = join(outDir, 'kernel.tar');

const targetArg = process.argv.find((a) => a === '--win' || a === '--linux' || a === '--mac');
const target = targetArg ? targetArg.slice(2) : (process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux');

if (!existsSync(kernelDir)) {
  console.error(`[pack-kernel] 找不到内核目录：${kernelDir}（先跑 prepare-kernel）`);
  process.exit(1);
}

if (target !== 'win') {
  // 不打 tar：清掉可能残留的旧 kernel-dist，避免 electron-builder 的 win 段
  // extraResources 万一被误用时打进一份过期归档（正常流程不会走到那条配置，
  // 这里只是防呆）。electron-builder.yml 的 linux/mac 段直接吃 kernel/ 本身。
  rmSync(outDir, { recursive: true, force: true });
  console.log(`[pack-kernel] 目标平台 ${target}：AppImage/.app 没有「逐文件解压」这一步，跳过打 tar，extraResources 直接用 kernel/。`);
  process.exit(0);
}

/**
 * 统计文件数，写进 manifest 供解包后核对（少解出来一半也能立刻发现）；
 * 顺便守住两条 ustar 的前提。
 */
function countFiles(dir, rel = '') {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    // 前提一：全 ASCII 路径。Windows 的 bsdtar 在 ustar 格式下把非 ASCII 文件名
    // 按**系统 ANSI 代码页**写进头里（实测：中文名会变成 GBK 字节），而运行时的
    // 内置解包器按 UTF-8 解 —— 名字就会变成乱码。今天内核树里一个非 ASCII 路径
    // 都没有，所以这里直接断言死；将来真有了，要么给 tar 加
    // `--options hdrcharset=UTF-8`（bsdtar 支持，实测有效），要么让解包器改按
    // 字节保留。总之要有人**看见**这件事，而不是让用户拿到乱码文件名。
    if (/[^\x20-\x7e]/.test(relPath)) {
      console.error(`[pack-kernel] 路径含非 ASCII 字符，ustar 下会乱码：${relPath}`);
      process.exit(1);
    }
    // 前提二：ustar 的路径上限（name 100 + prefix 155）。tar 自己也会报错，
    // 但这里报得更早、也更能说清是怎么回事。
    if (relPath.length > 255) {
      console.error(`[pack-kernel] 路径超过 ustar 上限（255）：${relPath.length} 字符 ${relPath}`);
      process.exit(1);
    }
    if (entry.isDirectory()) {
      const sub = countFiles(full, relPath);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(full).size;
    }
  }
  return { files, bytes };
}

/** @returns {Promise<void>} */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))));
  });
}

const source = countFiles(kernelDir);
console.log(`[pack-kernel] 源：${source.files} 个文件、${(source.bytes / 1024 / 1024).toFixed(1)} MB`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const started = Date.now();
// -C kernel . ：归档里存相对路径（runtime/…、node.exe），解包时直接铺进目标目录。
await run(resolveTarCommand(), ['-cf', archivePath, '--format=ustar', '-C', kernelDir, '.']);

const size = statSync(archivePath).size;
writeFileSync(join(outDir, 'kernel.manifest.json'), JSON.stringify({
  files: source.files,
  bytes: source.bytes,
  archiveBytes: size,
}, null, 2) + '\n');

console.log(`[pack-kernel] 完成：kernel.tar ${(size / 1024 / 1024).toFixed(1)} MB`
  + `（${((Date.now() - started) / 1000).toFixed(0)}s）`);
