// 出厂内核自检：真的把 kernel/ 里那份内核启动一次，就绪才算过。
//
// 为什么必须有这一步：prepare-kernel 会**裁剪**内核（删源码映射、类型声明、
// @deepseek-ai/* 里的 TS 源码、非目标平台预编译）。裁剪规则一旦写歪就会删掉运行时
// 真要用的文件，而这种错误在打包阶段完全不报错 —— electron-builder 只管把目录塞
// 进安装包，装出来的客户端一启动才黑屏。这事真发生过一次（规则第一版按路径包含
// 判断，把嵌套在 dsh 底下的 debug / node-fetch 的 src/ 一起删了，那两个包的 main
// 就指向 src/index.js），当时是靠人肉复查发现的，不能指望下次还有这个运气。
//
// 「解析面审计」（逐个 package.json 查 main/bin/exports 指向的文件还在不在）曾经
// 也在本文件里，现在挪去了 prepare-kernel.mjs —— 它要拿「未裁剪的树」做对照，而
// 那棵树只在裁剪那一刻存在。理由见那边 auditPrune 上方的注释。本文件因此不再需要
// 定位打包机上的全局 dsh 安装。
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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { URL_LINE_RE, URL_LINE_TIMEOUT_MS, waitUrlLine, waitHttpReady } = require('../src/shared/kernel-boot.js');
const { reconcileProfilePlugins } = require('../src/shared/profile-plugins-installer.js');
const { kernelPaths } = require('../src/shared/kernel-paths.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kernelDir = join(root, 'kernel');
const { nodeExe, binJs } = kernelPaths(kernelDir);

/** 启动到就绪的上限。冷启动要加载整棵 plugin tree，几秒是常态。 */
const READY_TIMEOUT_MS = 90_000;

function fail(message, detail) {
  console.error(`[verify-kernel] 失败：${message}`);
  if (detail) console.error(detail.split('\n').slice(-25).join('\n'));
  process.exit(1);
}

if (!existsSync(nodeExe) || !existsSync(binJs)) {
  fail(`内核不完整（缺 node 可执行文件或 bin.js）：${kernelDir}`);
}

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
