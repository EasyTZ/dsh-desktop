// 把 node 可执行文件 + pnpm + 完整 dsh 依赖树装进 kernel/ 暂存目录，供 electron-builder
// 的 extraResources 打进安装包，实现自包含内核。
//
// 目录约定（runtime/ 这层子目录不能省，原因见该文件注释）统一定义在
// src/shared/kernel-paths.js。
//
// 内核树的真正来源是 kernel-src/（提交进仓库的安装规格：package.json 声明精确
// 版本、package-lock.json 锁传递依赖、.npmrc 显式关掉根 .npmrc 的
// legacy-peer-deps）。默认路径是按目标平台对它做一次干净 `npm ci`，而不是
// cpSync 打包机上「碰巧装了什么」的全局安装——原因见 docs/decisions/packaging.md。
//
// 注意：自定义插件**不搭这趟车**。它们住在用户的 profile 里，由启动时的
// reconcileProfilePlugins 从 plugins-dist/profile 的 tgz 装进去，和内核是两条独立
// 的生命线 —— 这正是迁到 profile 层的目的：换内核不动插件，换插件不动内核。
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDshInstallSync, findPnpmDirSync } from '../src/shared/dsh-locate.js';
import { NODE_BIN } from '../src/shared/kernel-paths.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'kernel');
const outDsh = join(outDir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh');
const kernelSrcDir = join(root, 'kernel-src');
// 干净安装的临时落点，不进 kernel/（那是最终产物），也不在 kernel-src/ 里装
// node_modules（那是提交进仓库的安装规格，得保持干净）。构建结束前会删掉。
const stagingDir = join(root, 'kernel-staging');

/** 打包进内核的 node 可执行文件：默认用当前正在运行的 node（一定存在且版本已知）。 */
function findNodeExe() {
  const override = process.env.DSH_NODE_EXE;
  if (override && existsSync(override)) return override;
  return process.execPath;
}

const nodeExe = findNodeExe();
console.log(`[prepare-kernel] node: ${nodeExe}`);

// 回滚开关：这是本轮唯一动了发版关键路径的改动，新旧两条路并存到三个平台都
// 真出过一次包为止。到时候这个分支、legacyPrepare()、以及 dsh-locate.js 里
// findDshInstallSync/findPnpmDirSync 的构建期用法可以一起删（dsh-service.js
// 开发态启动还在用同文件的 findDshBinJsAsync，那个不能删）。
if (process.env.DSH_KERNEL_LEGACY === '1') {
  legacyPrepare();
} else {
  cleanInstallPrepare();
}

/**
 * 旧路径：直接拷打包机上的全局安装（全局 dsh + 全局 pnpm）。**只在
 * DSH_KERNEL_LEGACY=1 时跑**——见上面「回滚开关」的注释。
 */
function legacyPrepare() {
  const installDir = findDshInstallSync();
  const pnpmDir = findPnpmDirSync();
  const kernelVersion = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version;
  console.log(`[prepare-kernel] (legacy) dsh:  ${installDir}`);
  console.log(`[prepare-kernel] (legacy) 版本: ${kernelVersion}`);
  console.log(`[prepare-kernel] (legacy) pnpm: ${pnpmDir}`);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'runtime', 'node_modules', '@deepseek-ai'), { recursive: true });
  cpSync(nodeExe, join(outDir, NODE_BIN));
  cpSync(pnpmDir, join(outDir, 'pnpm'), { recursive: true, dereference: true });
  cpSync(installDir, outDsh, { recursive: true, dereference: true });

  pruneWithAudit(outDir, process.platform, process.arch);
  console.log('[prepare-kernel] (legacy) 完成');
}

/** 校验一个值只含安全字符，能被拼进 cmd.exe 命令行而不需要转义。 */
function assertSafeToken(value, label) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) {
    throw new Error(`${label} 含不安全字符，拒绝拼进命令行：${value}`);
  }
  return value;
}

/**
 * 在 cwd 里跑一次 `npm ci`，装出目标平台的依赖树。
 *
 * Windows 上 npm 是 npm.cmd，Node 不能直接 spawn 批处理文件（CVE-2024-27980 之后
 * execFile 对 .cmd 直接报错，不再像老版本那样偷偷帮你套 shell）。这里显式走
 * cmd.exe，跟 src/shared/dsh-locate.js 的 npmRootCommand 是同一套处理方式——
 * 只是这里参数是变长的，拼进命令行前先过 assertSafeToken，不留注入面。
 * 不用 `shell: true`：那会对含特殊字符的参数发 DEP0190 警告，仓库约定里已经
 * 明确不要这么干。
 */
function runNpmCi(cwd, targetPlatform, targetArch) {
  const platform = assertSafeToken(targetPlatform, 'targetPlatform');
  const arch = assertSafeToken(targetArch, 'targetArch');
  const args = ['ci', '--omit=dev', '--legacy-peer-deps=false', `--os=${platform}`, `--cpu=${arch}`];
  console.log(`[prepare-kernel] npm ${args.join(' ')}（cwd=${cwd}）`);
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', ['npm', ...args].join(' ')],
      { cwd, stdio: 'inherit', windowsHide: true });
  } else {
    execFileSync('npm', args, { cwd, stdio: 'inherit' });
  }
}

/**
 * 新路径（默认）：按 kernel-src/ 声明的版本、按目标平台做一次干净 npm ci。
 *
 * 目标平台默认是当前进程平台（本任务只要求本机平台跑通），跨平台组装留给
 * 后面的 CI 矩阵——但结构上已经能接受 DSH_KERNEL_TARGET_PLATFORM /
 * DSH_KERNEL_TARGET_ARCH 覆盖。注意 kernel-paths.js 的 NODE_BIN 跟的是**当前
 * 进程平台**，不是这里的目标平台：node 可执行文件不是从 npm 装出来的依赖，
 * 是直接拿当前运行的 node（或 DSH_NODE_EXE 指定的那个）用，跨平台构建时它的
 * 文件名要由调用方（未来的 CI 矩阵脚本）自己决定，不归这里管。
 */
function cleanInstallPrepare() {
  const targetPlatform = process.env.DSH_KERNEL_TARGET_PLATFORM || process.platform;
  const targetArch = process.env.DSH_KERNEL_TARGET_ARCH || process.arch;
  const spec = JSON.parse(readFileSync(join(kernelSrcDir, 'package.json'), 'utf8'));
  console.log(`[prepare-kernel] dsh:  ${spec.dependencies['@deepseek-ai/dsh']}`);
  console.log(`[prepare-kernel] pnpm: ${spec.dependencies.pnpm}`);
  console.log(`[prepare-kernel] 目标: ${targetPlatform}-${targetArch}`);

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  // 只拷安装规格三件套，不拷 node_modules（kernel-src/ 里本来就不该有）。
  // 落在独立目录、独立跑 npm ci 的意义就在这里：cwd 是这里，npm 的「项目级
  // config」只会认这个目录自己的 .npmrc，不会往上找到 app/.npmrc 的
  // legacy-peer-deps=true（已实测验证过，见「陷阱二」）。
  for (const file of ['package.json', 'package-lock.json', '.npmrc']) {
    cpSync(join(kernelSrcDir, file), join(stagingDir, file));
  }

  runNpmCi(stagingDir, targetPlatform, targetArch);

  const stagedModules = join(stagingDir, 'node_modules');
  const stagedPnpm = join(stagedModules, 'pnpm');
  if (!existsSync(join(stagedPnpm, 'bin', 'pnpm.cjs'))) {
    throw new Error(`npm ci 没有装出预期的 pnpm：${stagedPnpm}`);
  }
  if (!existsSync(join(stagedModules, '@deepseek-ai', 'dsh', 'package.json'))) {
    throw new Error(`npm ci 没有装出预期的 @deepseek-ai/dsh：${stagedModules}`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(nodeExe, join(outDir, NODE_BIN));

  // pnpm 先搬出来单独落到 kernel/pnpm——`src/main/index.js` 的 PNPM_CLI_PATH 与
  // kernel-updater.js 认的就是这个落点，不能让它跟着 dsh 的依赖树一起进
  // runtime/node_modules（陷阱一）。
  const pnpmBinNames = Object.keys(
    JSON.parse(readFileSync(join(stagedPnpm, 'package.json'), 'utf8')).bin ?? {},
  );
  renameSync(stagedPnpm, join(outDir, 'pnpm'));
  dropOrphanedBinShims(join(stagedModules, '.bin'), pnpmBinNames);
  // 剩下整棵 node_modules 搬进 runtime/。**不能只搬 @deepseek-ai/dsh 这一个子
  // 目录**——npm 的常规安装会把大部分依赖 hoist 到 node_modules 顶层，不会像
  // 全局安装那样全塞进 dsh/node_modules/ 里；只搬 dsh 子目录会把 hoist 出去的
  // 依赖全部漏掉，内核启动时 require 直接炸。Node 的 require() 沿父目录逐级
  // 找 node_modules，hoist 与嵌套两种布局它都认，所以整棵搬过去无需再调整。
  mkdirSync(join(outDir, 'runtime'), { recursive: true });
  renameSync(stagedModules, join(outDir, 'runtime', 'node_modules'));

  const kernelVersion = JSON.parse(readFileSync(join(outDsh, 'package.json'), 'utf8')).version;
  console.log(`[prepare-kernel] 已安装 dsh ${kernelVersion}`);

  rmSync(stagingDir, { recursive: true, force: true });

  pruneWithAudit(outDir, targetPlatform, targetArch);
  console.log('[prepare-kernel] 完成');
}

/**
 * 裁剪 + 解析面审计。两件事必须挨着做，原因见 auditPrune 的注释。
 * @param {string} kernelDir
 * @param {string} platform 目标平台
 * @param {string} arch 目标架构
 */
function pruneWithAudit(kernelDir, platform, arch) {
  const runtimeModules = join(kernelDir, 'runtime', 'node_modules');
  const before = snapshotEntryPoints(runtimeModules);
  pruneKernel(kernelDir, platform, arch);
  auditPrune(runtimeModules, before);
}

// ---------------------------------------------------------------------------
// 解析面审计
// ---------------------------------------------------------------------------
// 遍历内核里每个 package.json，确认它 `main` / `bin` / `exports` 指向的文件在裁剪
// 之后**依然存在**。
//
// 为什么单靠 verify-kernel 那次 boot 不够：boot 只能证明**启动路径**上的模块齐全。
// 裁剪误删一个懒加载包（只有发 HTTP 时才 require 的 node-fetch、只有签 JWT 时才用
// 的 ecdsa-sig-formatter）时，内核照样正常起来，等用户踩到那条路径才
// ERR_MODULE_NOT_FOUND —— 「起得来但集成坏了」是最难查的一类故障。实测过：把
// debug/src 删掉，boot 自检一样通过。这事真发生过（裁剪规则第一版按路径包含判断，
// 把嵌套在 dsh 底下的 debug / node-fetch 的 src/ 一起删了）。
//
// **为什么审计在这里、而不在 verify-kernel**：审计要拿「未裁剪的树」做对照 ——
// 上游自己就有几个包的入口映射指向不存在的文件（`@modelcontextprotocol/sdk` 的根
// 导出、类型专用包 `@standard-schema/spec`），那不是我们的问题，不该让打包失败，
// 只有「裁剪前在、裁剪后没了」才算数。
//
// 这个对照物原先取的是**打包机上的全局 dsh 安装**，于是有两个毛病：
//   1. 它和内核树是两棵不同的树，会各自漂移；换成 npm ci 之后布局更是完全不同
//      （依赖 hoist 到顶层，不再嵌套在 dsh/node_modules 里），照旧比对会**静默
//      失效** —— 审计范围从 454 个包塌到 1 个，却依然打印「通过」。
//   2. 它让「打包机不再需要全局安装」这个目标达不成。
//
// 挪到这里之后，对照物就是**同一棵树裁剪前的快照**：问的问题（「裁剪弄坏了什么」）
// 和量的东西完全对齐，不依赖任何外部安装，两种布局（hoist / 嵌套）也都自然支持。

/** 补全省略的扩展名 / 目录形式，跟 Node 的解析顺序一致。 */
function resolvesEntry(pkgDir, target) {
  const base = join(pkgDir, target);
  const candidates = [base, `${base}.js`, `${base}.json`, `${base}.node`, `${base}.cjs`,
    `${base}.mjs`, join(base, 'index.js')];
  return candidates.some((c) => existsSync(c));
}

/** exports 可以是字符串、数组或条件对象，递归收集里面的相对路径。 */
function collectTargets(value, out) {
  if (typeof value === 'string') {
    // .d.ts 是我们有意删掉的，任何指向它的目标都不算缺失（`types` 条件键在
    // exports 里到处都是，不排掉的话全线误报）。
    if (/\.d\.[cm]?ts$/.test(value)) return;
    if (value.startsWith('./') && !value.includes('*')) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTargets(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      // 键里带通配符的整条跳过（值里通常也带 *）；types/typings 条件同理，
      // 它们指向的 .d.ts 是我们有意删的。
      if (key.includes('*') || key === 'types' || key === 'typings') continue;
      collectTargets(value[key], out);
    }
  }
}

/** 一个包 package.json 里所有「Node 运行时真会解析」的入口目标。 */
function entryTargetsOf(pkgDir) {
  const pkgJson = join(pkgDir, 'package.json');
  if (!existsSync(pkgJson)) return null;
  /** @type {any} */
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
  } catch {
    return []; // package.json 读不动是上游的事，不在本审计范围
  }
  /** @type {string[]} */
  const targets = [];
  if (typeof pkg.main === 'string' && pkg.main.length > 0) targets.push(pkg.main);
  if (typeof pkg.bin === 'string') targets.push(pkg.bin);
  else if (pkg.bin && typeof pkg.bin === 'object') collectTargets(Object.values(pkg.bin), targets);
  if (pkg.exports !== undefined) collectTargets(pkg.exports, targets);
  return [...new Set(targets)];
}

/**
 * 遍历一个 node_modules 树里的每个包。scope 目录（@xxx）本身不是包，要多走一层；
 * 嵌套的 node_modules 也要递归 —— hoist 布局与嵌套布局都得支持。
 * @param {string} nodeModulesDir
 * @param {(pkgDir: string) => void} visit
 */
function walkPackages(nodeModulesDir, visit) {
  if (!existsSync(nodeModulesDir)) return;
  for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(nodeModulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(full, { withFileTypes: true })) {
        if (!scoped.isDirectory()) continue;
        const pkgDir = join(full, scoped.name);
        visit(pkgDir);
        walkPackages(join(pkgDir, 'node_modules'), visit);
      }
      continue;
    }
    visit(full);
    walkPackages(join(full, 'node_modules'), visit);
  }
}

/**
 * 裁剪**前**的快照：记下此刻**能解析成功**的每一个入口。
 *
 * 只记能解析的那些 —— 上游本来就坏掉的入口从一开始就不进快照，于是「放行上游自己
 * 的问题」这条语义不用再单独写一遍判断。
 * @returns {{pkgDir: string, target: string}[]}
 */
function snapshotEntryPoints(nodeModulesDir) {
  /** @type {{pkgDir: string, target: string}[]} */
  const entries = [];
  let packages = 0;
  walkPackages(nodeModulesDir, (pkgDir) => {
    const targets = entryTargetsOf(pkgDir);
    if (targets === null) return;
    packages += 1;
    for (const target of targets) {
      if (resolvesEntry(pkgDir, target)) entries.push({ pkgDir, target });
    }
  });
  console.log(`[prepare-kernel] 裁剪前记下 ${packages} 个包、${entries.length} 个可解析入口`);
  return entries;
}

/** 裁剪**后**再查一遍快照里的每一条。只要有一条没了就中止 —— 构建期炸，好过用户首启炸。 */
function auditPrune(nodeModulesDir, snapshot) {
  const broken = snapshot
    .filter(({ pkgDir, target }) => !resolvesEntry(pkgDir, target))
    .map(({ pkgDir, target }) => `${relative(nodeModulesDir, pkgDir) || '.'} → ${target}`);

  if (broken.length > 0) {
    console.error(`\n[prepare-kernel] 已中止：裁剪删掉了 ${broken.length} 个仍被 package.json 指向的入口。`);
    console.error(broken.slice(0, 20).join('\n'));
    if (broken.length > 20) console.error(`…… 另有 ${broken.length - 20} 条`);
    console.error('\n改 pruneKernel 的规则时踩到了运行时真要用的文件。见该函数的注释。\n');
    process.exit(1);
  }
  console.log(`[prepare-kernel] 解析面审计通过：${snapshot.length} 个入口裁剪后依然在`);
}

/**
 * 把 pnpm 搬走之后留下的 `.bin` 残链清掉。
 *
 * `npm ci` 会给每个带 `bin` 的依赖在 `node_modules/.bin/` 下放一个入口
 * （POSIX 是符号链接，Windows 是 .cmd/.ps1 垫片）。而我们**故意**把 pnpm 从
 * `node_modules` 里搬到 `kernel/pnpm`，那几个入口就指向了不存在的位置。
 *
 * Windows / Linux 上没人读 `.bin`（内核跑 pnpm 走的是运行期另造的垫片目录），
 * 所以这个残留一直没暴露。**macOS 上会**：`codesign --deep` 遍历包内容时撞上
 * 悬空链接，直接报 `No such file or directory`，整个签名校验失败 —— 而签名失败
 * 在 Apple Silicon 上等于打出一个起不来的包。实测就是这么炸的（4 条：pn / pnpm /
 * pnx / pnpx）。
 *
 * 按 pnpm 自己声明的 bin 名字删，不写死清单：将来 pnpm 加个新命令也不会漏。
 * 三种变体（无扩展名 / .cmd / .ps1）一起删。
 *
 * @param {string} binDir `node_modules/.bin`
 * @param {string[]} names 要清掉的命令名
 */
function dropOrphanedBinShims(binDir, names) {
  if (!existsSync(binDir) || names.length === 0) return;
  let removed = 0;
  for (const name of names) {
    for (const suffix of ['', '.cmd', '.ps1']) {
      const full = join(binDir, name + suffix);
      // lstat 而不是 exists：悬空的符号链接 existsSync 返回 false（它跟着链接
      // 走），那样就一条都删不掉 —— 而悬空的恰恰是要删的那些。
      try {
        lstatSync(full);
      } catch {
        continue;
      }
      rmSync(full, { force: true });
      removed += 1;
    }
  }
  if (removed > 0) console.log(`[prepare-kernel] 清掉 ${removed} 个指向已搬走的 pnpm 的 .bin 残链`);
}

/**
 * 裁掉运行时用不到的文件。
 *
 * 为什么值得做：装进来的是**完整安装树**，其中不少运行时永远不会被读。绿色版
 * 是个 zip，解压耗时主要由**文件个数**决定（每个文件都有独立的目录项与解压
 * 开销），不是总字节数 —— 用户反馈的「解压太慢」就是这么来的。
 *
 * 判据是「Node 运行时会不会读它」：
 *   - `.map`   只有 --enable-source-maps 才会读，缺了最多是堆栈行号不好看；
 *   - `.d.ts`  纯编译期产物；
 *   - `src/`   dsh 的包声明了 `exports["./src/*"]`，但 lib/*.js 里对 `/src/` 的
 *              运行时引用是 0 处（查过），那是给 sourcemap 跳转用的；
 *   - `.pdb`   Windows 调试符号；
 *   - 非目标平台的 node-pty 预编译（win32-arm64 一个就 11.2 MB）。
 *
 * **`.md` 不在删除名单里**：`config/agent-presets/<preset>/skills/<name>/SKILL.md`
 * 是运行时内容（agent 技能），一刀切删 .md 会把它们一起带走。5 MB 不值这个风险。
 *
 * `--omit=dev` 之后树本身已经比旧的全局安装干净不少，这些规则可能有一部分不再
 * 必要——但这轮先原样保留，实测确认后再删，不提前删。
 *
 * 只动 kernelDir 这份拷贝，其它目录一个字节都不碰。
 *
 * @param {string} kernelDir
 * @param {string} platform 目标平台（不是 process.platform——跨平台构建时两者会不同）
 * @param {string} arch 目标架构（不是 process.arch）
 */
function pruneKernel(kernelDir, platform, arch) {
  const runtimeDir = join(kernelDir, 'runtime');
  // 目标平台之外的 node-pty 预编译。prebuilds/ 下按 `<platform>-<arch>` 分目录。
  const keepPrebuild = `${platform}-${arch}`;
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
          // 非目标平台的原生预编译
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
    + `${(removedBytes / 1024 / 1024).toFixed(1)} MB（源码映射 / 类型声明 / TS 源码 / 调试符号 / 非目标平台预编译）`);
}
