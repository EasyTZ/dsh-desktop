// 打包总入口：自动收尾联调模式，打完再恢复。
//
//   node scripts/dist.mjs        完整打包（出安装包 + 收进 release/）
//   node scripts/dist.mjs --dir  只出 win-unpacked
//
// 为什么要包一层，而不是让人自己记着 unlink：联调模式可以常开，唯独打包这一步
// 必须用钉住的版本（`pack-profile-plugins` 的 `npm pack` 打的是 node_modules 里
// 当前那份，联调下就是工作副本的现状）。让脚本来记，人只管 `npm run dist`。
//
// **但自动解除联调有个反向陷阱**：如果插件工作副本里有没提交/没打 tag 的改动，
// 解除之后拉回来的是钉住的旧版本，打出来的包**不含你的改动**，而你以为含。这和
// 「打出不可复现的包」是同一枚硬币的两面 —— 产物都不是你以为的那个。所以解除
// 之前先比对：工作副本干净、且 HEAD 正好是 package.json 钉住的那个 tag，才放行。
//
// 恢复用 try/finally：打包失败也要把联调恢复回去，否则人会在不知情的状态下继续
// 开发，改半天没生效。
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vendoredPluginNames } from '../src/shared/profile-plugins.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(root, '..');
// 「dist 解除了联调但还没恢复」的标记，见落盘处的注释。
const UNLINK_MARKER = join(root, '.dist-unlinked');
const dirOnly = process.argv.includes('--dir');
const isWin = process.platform === 'win32';

const run = (file, args = []) =>
  execFileSync(process.execPath, [join(root, 'scripts', file), ...args], { cwd: root, stdio: 'inherit' });

const runCmd = (line) => {
  const cmd = isWin ? (process.env.ComSpec || 'cmd.exe') : 'sh';
  const args = isWin ? ['/d', '/s', '/c', line] : ['-c', line];
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', windowsHide: true });
};

/**
 * 打完包清掉 dist 里**其它版本**的产物，只留当前版本这一套。
 *
 * 一版就是 350 MB 上下（安装包 + zip），攒了五个版本 dist 就到 2 GB 了。
 * collect-release 是按版本号精确挑产物的，所以旧文件不会让打包出错——纯粹占地方，
 * 而且真正的发布归档在 GitHub Releases 上，本地留一份历史没有意义。
 *
 * 三条自保规则，宁可少删不可错删：
 *   1) 只删**文件**，目录一律不碰（win-unpacked 是下次增量打包要用的）；
 *   2) 文件名里认不出 `-x.y.z` 版本号的一律留着（builder-debug.yml、latest.yml、
 *      builder-effective-config.yaml 都属于这类）；
 *   3) 版本号用 `(?=[-.])` 前瞻断言截断，不吞后面的标识。少了这条，
 *      `DeepSeek Harness Desktop-1.7.1-win.zip` 会被解析成版本 `1.7.1-win`，
 *      跟当前版本对不上，于是把**这次刚打出来的 zip** 给删了。
 *
 * 放在 collect-release **之后**：先确认新产物已经生成并归到 release/，再删旧的。
 * 反过来的话，打包中途失败就会既没有新的、又没有旧的。
 */
function pruneOtherVersions() {
  const distDir = join(root, 'dist');
  if (!existsSync(distDir)) return;
  const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const removed = [];
  for (const name of readdirSync(distDir)) {
    const full = join(distDir, name);
    if (!statSync(full).isFile()) continue;
    const found = /-(\d+\.\d+\.\d+)(?=[-.])/.exec(name)?.[1];
    // 预发布版（1.7.1-beta.1）的产物文件名里带的是 1.7.1，也算当前版本。
    if (!found || found === current || current.startsWith(`${found}-`)) continue;
    rmSync(full, { force: true });
    removed.push(name);
  }
  if (removed.length === 0) {
    console.log(`[dist] dist 里没有其它版本的产物需要清理（当前 ${current}）。`);
    return;
  }
  console.log(`[dist] 已清掉 ${removed.length} 个其它版本的产物，只留 ${current}：`);
  for (const name of removed) console.log(`  - ${name}`);
}

const git = (repo, args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();

/** 当前处于联调（junction）状态的插件包名。 */
function linkedPlugins() {
  return vendoredPluginNames(root).filter((name) => {
    const dir = join(root, 'node_modules', name);
    return existsSync(dir) && lstatSync(dir).isSymbolicLink();
  });
}

/** package.json 里钉住的 tag，如 `github:EasyTZ/dsh-git#v0.2.1` → `v0.2.1`。 */
function pinnedTag(name) {
  const spec = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies[name] ?? '');
  const hash = spec.indexOf('#');
  return hash < 0 ? null : spec.slice(hash + 1);
}

/**
 * 检查联调中的工作副本能不能安全地换回钉住的版本：
 * 工作区干净、且 HEAD 正好落在钉住的 tag 上 —— 此时两者内容一致，换过去打包
 * 与用工作副本打包结果相同。任何一条不满足，都说明「有改动不会进这个包」。
 * @returns {string[]} 问题描述；空数组表示可以放行
 */
function inspect(name) {
  // 同级目录名是仓库名，不带 scope（`@easytz/dsh-git` 的仓库目录是 `dsh-git`）。
  const repo = join(workspace, name.startsWith('@') ? name.split('/')[1] : name);
  const problems = [];
  if (!existsSync(join(repo, '.git'))) return [`${name}: ${repo} 不是 git 仓库，无法核对`];

  const tag = pinnedTag(name);
  if (!tag) return [`${name}: package.json 里的依赖没有钉 tag`];

  if (git(repo, ['status', '--porcelain'])) {
    problems.push(`${name}: 工作区有未提交的改动`);
  }
  /** @type {string|null} */
  let tagCommit = null;
  try {
    tagCommit = git(repo, ['rev-list', '-n', '1', tag]);
  } catch {
    problems.push(`${name}: 本地没有 tag ${tag}（没打，或没 fetch 下来）`);
  }
  if (tagCommit) {
    const head = git(repo, ['rev-parse', 'HEAD']);
    if (head !== tagCommit) {
      problems.push(`${name}: HEAD 不在 ${tag} 上（本地有 ${tag} 之后的提交，或还没打新 tag）`);
    }
  }
  return problems;
}

const linked = linkedPlugins();
let restore = false;

// 非联调态也要核对一遍，只是**降级成警告**。
//
// 这道检查原先整段包在 `if (linked.length > 0)` 里，等于把保险挂在「检测到联调」上，
// 而不是挂在「打包」这个动作上。可「插件改了、tag 还没打，于是产物里是旧版本」这件事
// 跟联调开没开毫无关系 —— 联调关着的时候照样会发生，而且**一声不吭**，比开着更危险。
//
// 为什么这里只警告不中止：非联调态下「插件仓库有 WIP、但这次就是要用钉住的版本打包」
// 是完全正当的用法（在做插件的下一版，同时要发一个只改了外壳的应用版本）。中止会把
// 这条正当路径堵死。而联调态下同样的偏差要中止 —— 那时你一直在用工作副本调试，产物
// 却是另一份，落差最大、最容易自欺。
//
// 只核对同级目录里**存在**的工作副本：别人 clone 下来只有 app 一个仓库时不该报噪音。
const unlinkedProblems = linked.length > 0
  ? []
  : vendoredPluginNames(root).flatMap((name) => (
    existsSync(join(workspace, name.startsWith('@') ? name.split('/')[1] : name)) ? inspect(name) : []
  ));
if (unlinkedProblems.length > 0) {
  console.warn('');
  console.warn('[dist] 注意：下列插件的工作副本跟钉住的 tag 对不上，这些改动**不会**进这个包：');
  console.warn('');
  for (const p of unlinkedProblems) console.warn(`  ! ${p}`);
  console.warn('');
  console.warn('这个包用的是 package.json 里钉住的版本。要把改动打进去：插件仓库 commit + push + 打新 tag，');
  console.warn('回本仓库升 package.json 的 #tag，再重新执行本命令。确认无所谓就不用管 —— 打包照常进行。');
  console.warn('');
}

if (linked.length > 0) {
  console.log(`[dist] 检测到 ${linked.length} 个插件处于联调模式，核对能否安全换回钉住的版本…`);
  const problems = linked.flatMap(inspect);
  if (problems.length > 0) {
    console.error('\n[dist] 已中止：联调中的插件与钉住的版本不一致。\n');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('\n如果直接打包，安装包里会是**钉住的旧版本**，不含你上面这些改动——');
    console.error('产物和你以为的不是一回事，事后很难发现。请先把插件改动收尾：\n');
    console.error('  1) 在插件仓库 commit + push + 打新 tag');
    console.error('  2) 回本仓库把 package.json 里对应的 #tag 升上去');
    console.error('  3) 重新执行本命令\n');
    console.error('（确实只想用钉住的版本打包，就先手动 npm run unlink-plugins。）');
    process.exit(1);
  }
  console.log('[dist] 核对通过：工作副本与钉住的 tag 内容一致，临时解除联调。');
  // 先落标记再解除。`finally` 只在进程正常走完时执行，**强杀（Ctrl-C 两下 /
  // taskkill）不会执行** —— v1.4.1 那次打包被强杀，联调就这么被静默关掉了，人
  // 以为还开着，改半天不生效。标记文件不依赖进程善终：只要它还在，就说明恢复
  // 那一步没跑完，plugins-status 会大声提醒。
  writeFileSync(UNLINK_MARKER, `${new Date().toISOString()}\n${linked.join('\n')}\n`, 'utf8');
  run('link-plugins.mjs', ['--off']);
  restore = true;
}

try {
  // 打包前先强制把插件重新拉到 package.json 当前钉住的版本——这一步以前要人
  // 记得手动跑 `npm run refresh-plugins`，忘了的后果是：pack-profile-plugins
  // 打的是 node_modules 里那份**旧**内容，版本号却对得上新 tag，verify-plugin-pins
  // 也测不出来（它只查有没有钉 tag，不查 node_modules 是不是那个 tag 的内容）。
  // 自动跑掉这步，「忘了刷新」这类人为失误就不存在了。
  run('refresh-plugins.mjs');
  run('verify-plugin-pins.mjs');
  run('prepare-kernel.mjs');
  // pack-profile-plugins 必须排在 verify-kernel **之前**：自检要拿它产出的 tgz 把
  // 插件播种进隔离 home，否则验的是一个没有插件的内核（见 verify-kernel.mjs 顶部）。
  run('pack-profile-plugins.mjs');
  run('verify-kernel.mjs');
  run('pack-kernel.mjs');
  runCmd(dirOnly ? 'npx electron-builder --win --dir' : 'npx electron-builder --win');
  if (!dirOnly) {
    run('collect-release.mjs');
    // --dir 模式不出安装包，这时候清理会把上一版的安装包删掉却没有新的顶上，
    // 所以只在完整打包成功之后清。
    pruneOtherVersions();
  }
} finally {
  // 无论打包成功还是失败都要恢复，否则人会在「以为还在联调」的状态下继续改，
  // 改半天不生效。
  if (restore) {
    console.log('\n[dist] 恢复联调模式…');
    try {
      run('link-plugins.mjs');
      rmSync(UNLINK_MARKER, { force: true });
    } catch (error) {
      console.error('[dist] 恢复联调失败，请手动执行 npm run link-plugins：', error?.message ?? error);
    }
  }
}
