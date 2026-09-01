// 把 node.exe + pnpm + 完整 dsh 依赖树拷到 kernel/ 暂存目录，供 electron-builder
// 的 extraResources 打进安装包，实现自包含内核。
//
// 目录约定（runtime/ 这层子目录不能省，原因见该文件注释）统一定义在
// src/shared/kernel-paths.js。
//
// 注意：自定义插件**不搭这趟车**。它们住在用户的 profile 里（A1），由启动时的
// reconcileProfilePlugins 从 plugins-dist/profile 的 tgz 装进去，和内核是两条独立
// 的生命线 —— 这正是迁到 profile 层的目的：换内核不动插件，换插件不动内核。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDshInstallSync, findPnpmDirSync } from '../src/shared/dsh-locate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'kernel');
const outDsh = join(outDir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh');

/** 打包进内核的 node.exe：默认用当前正在运行的 node（一定存在且版本已知）。 */
function findNodeExe() {
  const override = process.env.DSH_NODE_EXE;
  if (override && existsSync(override)) return override;
  return process.execPath;
}

const installDir = findDshInstallSync();
const nodeExe = findNodeExe();
const pnpmDir = findPnpmDirSync();

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const kernelVersion = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version;

console.log(`[prepare-kernel] dsh:  ${installDir}`);
console.log(`[prepare-kernel] 版本: ${kernelVersion}`);
console.log(`[prepare-kernel] node: ${nodeExe}`);
console.log(`[prepare-kernel] pnpm: ${pnpmDir}`);

/**
 * 内核版本闸门。
 *
 * 插件是可复现的（package.json 钉 tag、lockfile 锁 commit），内核**不是**：它整
 * 个来自打包机上的全局 dsh，随手一次 `npm i -g @deepseek-ai/dsh` 就换了。同一个
 * app commit 在不同时间打包，装进去的内核可能是两个版本，而外面贴的还是同一个
 * 应用版本号 —— 用户报「1.4.0 有 bug」时，我们连自己发的是哪个内核都对不上账。
 *
 * 所以把「这一版要发哪个内核」写进 package.json 的 dshKernel.expected，让它跟着
 * 代码一起进版本库。对不上就**中止**而不是静默打包：升级全局 dsh 是个有意的动作，
 * 那就让「换内核」也变成一个有意的动作（改一行、跟着这次提交走）。
 *
 * 临时想拿别的内核试打包，用 DSH_KERNEL_ANY=1 跳过 —— 但那样打出来的包别拿去发布。
 */
const expectedKernel = pkg.dshKernel?.expected;
if (expectedKernel && expectedKernel !== kernelVersion && process.env.DSH_KERNEL_ANY !== '1') {
  console.error(`\n[prepare-kernel] 已中止：内核版本与本仓库声明的不一致。`);
  console.error(`  package.json dshKernel.expected: ${expectedKernel}`);
  console.error(`  本机全局 dsh 实际版本:            ${kernelVersion}\n`);
  console.error('二选一：');
  console.error(`  · 这一版就要发 ${kernelVersion} → 把 package.json 的 dshKernel.expected 改成它，一起提交；`);
  console.error(`  · 不想换内核 → npm i -g @deepseek-ai/dsh@${expectedKernel}\n`);
  console.error('（只是想试打包，不发布：DSH_KERNEL_ANY=1 npm run dist）');
  process.exit(1);
}
if (!expectedKernel) {
  console.warn('[prepare-kernel] 警告：package.json 未声明 dshKernel.expected，本次打包的内核版本不受约束。');
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'runtime', 'node_modules', '@deepseek-ai'), { recursive: true });
cpSync(nodeExe, join(outDir, 'node.exe'));
cpSync(pnpmDir, join(outDir, 'pnpm'), { recursive: true, dereference: true });
cpSync(installDir, outDsh, { recursive: true, dereference: true });

pruneKernel(outDir);

console.log('[prepare-kernel] 完成');

/**
 * 裁掉运行时用不到的文件。
 *
 * 为什么值得做：整目录 cpSync 进来的是**开发态的完整安装树**，实测 29529 个文件 /
 * 202.8 MB，其中一半以上运行时永远不会被读。绿色版是个 zip，解压耗时主要由**文件
 * 个数**决定（每个文件都有独立的目录项与解压开销），不是总字节数 —— 用户反馈的
 * 「解压太慢」就是这么来的。
 *
 * 判据是「Node 运行时会不会读它」：
 *   - `.map`   只有 --enable-source-maps 才会读，缺了最多是堆栈行号不好看；
 *   - `.d.ts`  纯编译期产物；
 *   - `src/`   dsh 的包声明了 `exports["./src/*"]`，但 lib/*.js 里对 `/src/` 的
 *              运行时引用是 0 处（查过），那是给 sourcemap 跳转用的；
 *   - `.pdb`   Windows 调试符号；
 *   - 非本平台的 node-pty 预编译（win32-arm64 一个就 11.2 MB）。
 *
 * **`.md` 不在删除名单里**：`config/agent-presets/<preset>/skills/<name>/SKILL.md`
 * 是运行时内容（agent 技能），一刀切删 .md 会把它们一起带走。5 MB 不值这个风险。
 *
 * 只动 kernel/ 这份拷贝，全局安装目录一个字节都不碰。
 *
 * @param {string} kernelDir
 */
function pruneKernel(kernelDir) {
  const runtimeDir = join(kernelDir, 'runtime');
  // 本平台之外的 node-pty 预编译。prebuilds/ 下按 `<platform>-<arch>` 分目录。
  const keepPrebuild = `${process.platform}-${process.arch}`;
  let removedFiles = 0;
  let removedBytes = 0;

  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const parent = basename(dir);
        const dropDir =
          // 只删 @deepseek-ai/* 自己那些包里的 TypeScript 源码目录。
          //
          // 判据必须是「这个包直属 @deepseek-ai 这个 scope 目录」，**不能**写成
          // 「路径里含 @deepseek-ai/dsh」—— 第三方依赖全都嵌套在 dsh 包底下，
          // 而其中 debug / node-fetch / ecdsa-sig-formatter 的 `main` 就直接指向
          // `src/index.js`。按路径包含判断会把它们的运行时代码删掉，内核当场起不来
          // （真发生过：这条规则第一版就是这么写的，打出来的包内核是死的）。
          (entry.name === 'src' && basename(dirname(dir)) === '@deepseek-ai')
          // 非本平台的原生预编译
          || (parent === 'prebuilds' && entry.name !== keepPrebuild);
        if (dropDir) {
          const stats = measureDir(full);
          rmSync(full, { recursive: true, force: true });
          removedFiles += stats.files;
          removedBytes += stats.bytes;
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const name = entry.name.toLowerCase();
      if (name.endsWith('.map') || name.endsWith('.d.ts') || name.endsWith('.pdb')) {
        removedBytes += statSync(full).size;
        removedFiles += 1;
        rmSync(full, { force: true });
      }
    }
  };

  /** @param {string} dir */
  function measureDir(dir) {
    let files = 0;
    let bytes = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = measureDir(full);
        files += sub.files;
        bytes += sub.bytes;
      } else if (entry.isFile()) {
        files += 1;
        bytes += statSync(full).size;
      }
    }
    return { files, bytes };
  }

  walk(runtimeDir);
  console.log(`[prepare-kernel] 裁剪：删除 ${removedFiles} 个文件、`
    + `${(removedBytes / 1024 / 1024).toFixed(1)} MB（源码映射 / 类型声明 / TS 源码 / 调试符号 / 非本平台预编译）`);
}
