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
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  run('verify-plugin-pins.mjs');
  run('prepare-kernel.mjs');
  // pack-profile-plugins 必须排在 verify-kernel **之前**：自检要拿它产出的 tgz 把
  // 插件播种进隔离 home，否则验的是一个没有插件的内核（见 verify-kernel.mjs 顶部）。
  run('pack-profile-plugins.mjs');
  run('verify-kernel.mjs');
  run('pack-kernel.mjs');
  runCmd(dirOnly ? 'npx electron-builder --win --dir' : 'npx electron-builder --win');
  if (!dirOnly) run('collect-release.mjs');
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
