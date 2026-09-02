// 出厂内核自检：真的把 kernel/ 里那份内核启动一次，就绪才算过。
//
// 为什么必须有这一步：prepare-kernel 会**裁剪**内核（删源码映射、类型声明、
// @deepseek-ai/* 里的 TS 源码、非本平台预编译）。裁剪规则一旦写歪就会删掉运行时
// 真要用的文件，而这种错误在打包阶段完全不报错 —— electron-builder 只管把目录塞
// 进安装包，装出来的客户端一启动才黑屏。这事真发生过一次（规则第一版按路径包含
// 判断，把嵌套在 dsh 底下的 debug / node-fetch 的 src/ 一起删了，那两个包的 main
// 就指向 src/index.js），当时是靠人肉复查发现的，不能指望下次还有这个运气。
//
// 检查方式跟热更新的 kernel-updater._verify 同源：用隔离的 DSH_HOME 真 boot 一次
// web，轮询到 HTTP 应答（状态码 < 500）就算通过。**必须先把 profile 层插件播种进
// 那个隔离 home**，否则验的是一个「没有插件的内核」，插件加载阶段的崩溃会整个溜
// 过去 —— 而用户跑的从来是「内核 + 插件」这个组合。
//
// 插件迁到 profile 层之后播种方式变了：不再是往 overlay 里写 `- insert:`，
// 而是拿 plugins-dist/profile 里的 tgz 走和正式启动完全相同的那套对账装进去。
// 因此 dist.mjs 里 pack-profile-plugins 必须排在本脚本**之前**。
//
// 端口交给内核自己申请（--port 0），与 DshService / kernel-updater 一致；显式探
// 端口的老做法会撞 Windows 保留端口段。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { URL_LINE_RE, URL_LINE_TIMEOUT_MS, waitUrlLine, waitHttpReady } = require('../src/shared/kernel-boot.js');
const { findDshInstallSync } = require('../src/shared/dsh-locate.js');
const { reconcileProfilePlugins } = require('../src/shared/profile-plugins-installer.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kernelDir = join(root, 'kernel');
const nodeExe = join(kernelDir, 'node.exe');
const binJs = join(kernelDir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

/** 启动到就绪的上限。冷启动要加载整棵 plugin tree，几秒是常态。 */
const READY_TIMEOUT_MS = 90_000;

function fail(message, detail) {
  console.error(`[verify-kernel] 失败：${message}`);
  if (detail) console.error(detail.split('\n').slice(-25).join('\n'));
  process.exit(1);
}

if (!existsSync(nodeExe) || !existsSync(binJs)) {
  fail(`内核不完整（缺 node.exe 或 bin.js）：${kernelDir}`);
}

auditEntryPoints(join(kernelDir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh'), findDshInstallSync());

const home = mkdtempSync(join(tmpdir(), 'dsh-verify-'));

// 把随包分发的插件装进这个隔离 home。用的是运行期那份 reconcileProfilePlugins，
// 不是另写一遍 —— 「怎么装插件」只能有一处实现，两处迟早分叉，而分叉的那天自检
// 验的就不是用户真正会跑的东西了。
//
// 构建期不带用户开关状态（默认全开）：这里要验的是「插件加载路径」本身。也因此
// 不需要 --patch overlay —— 迁到 profile 层之后 overlay 只用来**停用**条目，构建
// 期没有任何要停用的。
const profileDistDir = join(root, 'plugins-dist', 'profile');
if (!existsSync(profileDistDir)) {
  fail(`没有 ${relative(root, profileDistDir)}，先跑 npm run pack-profile-plugins（dist.mjs 已排好顺序）`);
}
const seeded = await reconcileProfilePlugins({
  profileDistDir,
  nodeExe,
  binJs,
  pnpmCliPath: join(kernelDir, 'pnpm', 'bin', 'pnpm.cjs'),
  shimDir: join(home, 'pnpm-shim'),
  seedStatePath: join(home, 'seeded.json'),
  logger: console,
  env: { ...process.env, DSH_HOME: home },
});
// 这里**必须硬失败**，不能像运行期那样「装不上就少几个插件」：构建期装不上意味着
// 打出来的包里这些插件也装不上，而自检若照旧放行，验的就又是一个没有插件的内核。
if (seeded.failed.length > 0) fail(`profile 插件没装进自检 home：${seeded.failed.join(', ')}`);
console.log(`[verify-kernel] profile 插件已播种（${seeded.installed.length} 个），开始 boot 自检…`);

const child = spawn(nodeExe, [binJs, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: root,
  env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED' },
  windowsHide: true,
});

let stderr = '';
/** @type {{ value: {code: number|null, signal: NodeJS.Signals|null}|null }} */
const exitState = { value: null };
/** @type {{ value: string|null }} */
const urlState = { value: null };
let stdoutTail = '';
child.stdout.on('data', (d) => {
  if (urlState.value) return;
  stdoutTail = (stdoutTail + String(d)).slice(-4000);
  const m = URL_LINE_RE.exec(stdoutTail);
  if (m) urlState.value = m[1].replace(/\/+$/, '');
});
child.stderr.on('data', (chunk) => { stderr += String(chunk); });
child.on('error', () => {});
// 只记录退出，不在这里 fail：判「起来了没有」是下面那段等待的事，两处都判会互相打架。
child.on('exit', (code, signal) => { exitState.value = { code, signal }; });

const started = Date.now();
try {
  const url = await waitUrlLine(urlState, exitState, URL_LINE_TIMEOUT_MS);
  await waitHttpReady(url, READY_TIMEOUT_MS, () => exitState.value !== null);
  // 端口通了不代表 plugin tree 加载完成：dsh 先绑端口、后加载插件树，插件加载阶段
  // 崩溃时 HTTP 早就能应答了。观察一会儿，确认进程没有随后崩溃。
  await new Promise((r) => setTimeout(r, 1500));
  if (exitState.value) {
    const { code, signal } = exitState.value;
    // 抛出而不是直接 fail：清理（kill + 删临时 home）只写在 catch 一处。
    throw new Error(`内核在就绪后随即退出（code=${code} signal=${signal}）`);
  }
} catch (error) {
  child.kill();
  rmSync(home, { recursive: true, force: true });
  fail(error?.message ?? String(error), stderr);
}

child.kill();
rmSync(home, { recursive: true, force: true });

console.log(`[verify-kernel] 通过：出厂内核能正常启动（${((Date.now() - started) / 1000).toFixed(1)}s）`);

/**
 * 解析面审计：遍历内核里每个 package.json，确认它 `main` / `bin` / `exports` 指向
 * 的文件真的还在。
 *
 * 为什么单靠上面那次 boot 不够：boot 只能证明**启动路径**上的模块齐全。裁剪误删
 * 一个懒加载包（比如只有发 HTTP 时才 require 的 node-fetch、只有签 JWT 时才用的
 * ecdsa-sig-formatter）时，内核照样正常起来，等用户踩到那条路径才 ERR_MODULE_
 * NOT_FOUND —— 这正是「起得来但集成坏了」那类最难查的故障。实测过：把 debug/src
 * 删掉，boot 自检一样通过。
 *
 * 只查 Node 运行时真正会解析的字段。**不查 `types`/`typings`** —— 我们是故意删掉
 * .d.ts 的，查它必然全线误报。带通配符的 exports（如 `"./src/*"`）跳过：模式匹配
 * 不到具体文件，而 @deepseek-ai/* 的 src/ 正是我们有意删的。
 *
 * 还要**跟原始安装树比对**：上游自己就有几个包的入口映射指向不存在的文件
 * （`@modelcontextprotocol/sdk` 的根导出、类型专用包 `@standard-schema/spec`），
 * 那不是我们的问题，也不该让打包失败。只有「原始树里有、裁剪后没了」才算数。
 *
 * @param {string} kernelDshDir 裁剪后的 dsh 目录
 * @param {string} sourceDshDir 原始（未裁剪）的全局 dsh 安装目录
 */
function auditEntryPoints(kernelDshDir, sourceDshDir) {
  /** @type {string[]} */
  const missing = [];
  let checked = 0;

  /** 补全省略的扩展名 / 目录形式，跟 Node 的解析顺序一致。 */
  const resolves = (pkgDir, target) => {
    const base = join(pkgDir, target);
    const candidates = [base, `${base}.js`, `${base}.json`, `${base}.node`, `${base}.cjs`, `${base}.mjs`, join(base, 'index.js')];
    return candidates.some((c) => existsSync(c));
  };

  /** exports 可以是字符串、数组或条件对象，递归收集里面的相对路径。 */
  const collectTargets = (value, out) => {
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
  };

  /** 查一个包目录的入口是否都还在。 */
  const auditPackage = (pkgDir) => {
    const pkgJson = join(pkgDir, 'package.json');
    if (!existsSync(pkgJson)) return;
    checked += 1;
    /** @type {any} */
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
    } catch {
      return; // package.json 读不动是上游的事，不在本审计范围
    }
    /** @type {string[]} */
    const targets = [];
    if (typeof pkg.main === 'string' && pkg.main.length > 0) targets.push(pkg.main);
    if (typeof pkg.bin === 'string') targets.push(pkg.bin);
    else if (pkg.bin && typeof pkg.bin === 'object') collectTargets(Object.values(pkg.bin), targets);
    if (pkg.exports !== undefined) collectTargets(pkg.exports, targets);
    for (const target of new Set(targets)) {
      if (resolves(pkgDir, target)) continue;
      // 原始树里也没有 → 上游自己的入口映射就是坏的，与裁剪无关，放行。
      const source = join(sourceDshDir, relative(kernelDshDir, pkgDir));
      if (!resolves(source, target)) continue;
      missing.push(`${relative(kernelDshDir, pkgDir) || '.'} → ${target}`);
    }
  };

  /** @param {string} nodeModulesDir 一个 node_modules 目录 */
  const walkPackages = (nodeModulesDir) => {
    if (!existsSync(nodeModulesDir)) return;
    for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(nodeModulesDir, entry.name);
      // scope 目录（@xxx）本身不是包，往里再走一层。
      if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(full, { withFileTypes: true })) {
          if (!scoped.isDirectory()) continue;
          const pkgDir = join(full, scoped.name);
          auditPackage(pkgDir);
          walkPackages(join(pkgDir, 'node_modules'));
        }
        continue;
      }
      auditPackage(full);
      walkPackages(join(full, 'node_modules'));
    }
  };

  // dsh 包自己也要查（它就是内核的入口）。
  auditPackage(kernelDshDir);
  walkPackages(join(kernelDshDir, 'node_modules'));
  if (missing.length > 0) {
    fail(`裁剪删掉了 ${missing.length} 个仍被 package.json 指向的入口（下面最多列 20 条）`,
      missing.slice(0, 20).join('\n'));
  }
  console.log(`[verify-kernel] 解析面审计通过：${checked} 个包的入口文件都在`);
}
