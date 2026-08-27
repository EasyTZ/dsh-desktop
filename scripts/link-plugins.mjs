// 在「钉 tag 的 git 依赖」与「指向同级工作副本的链接」之间切换插件源码。
//
//   node scripts/link-plugins.mjs        联调模式：node_modules/<插件> → ../<插件>
//   node scripts/link-plugins.mjs --off  恢复：删链接 + npm install 拉回钉住的版本
//   node scripts/link-plugins.mjs --status  只看当前状态
//
// 为什么不用 `npm link` 也不用 `file:` 依赖：
//   - `npm link` 要在全局 npm 前缀里注册一份，污染的是机器级状态，而且和我们
//     「全局 dsh 已经被 install-plugin 写过一遍」的现状叠在一起更难说清；
//   - 改成 `file:` 依赖会动 package.json 与 lockfile，而那两个文件是**发版凭据**
//     ——它们必须始终写着钉住的 tag，不能因为某次联调被改脏、更不能被误提交。
// 所以这里直接换 node_modules 里那一个目录：package.json 保持不动，pin 永远是权威。
//
// Windows 上用 junction 而不是 symlink：目录 junction 不需要管理员权限，
// symlink 默认要（除非开了开发者模式）。install-plugin / pack-plugins 两处
// cpSync 都带 dereference，跟着链接拷实体，两种模式的产物一致。

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vendoredPluginNames } from '../src/shared/plugin-install.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(root, 'node_modules');
const workspace = resolve(root, '..');

const mode = process.argv.includes('--off') ? 'off'
  : process.argv.includes('--status') ? 'status'
    : 'on';

/**
 * 只处理「git 依赖 vendor 进来的」插件；plugins/ 下的桌面专属插件本来就是源码。
 * 名单取「清单 ∩ dependencies」而不是「dependencies 的全部」—— 后者会在将来加
 * 一个非插件生产依赖时，跑去 ../<那个包名> 找工作副本。
 */
const vendoredPlugins = () => vendoredPluginNames(root);

/** @returns {'linked'|'pinned'|'missing'} */
function stateOf(name) {
  const dir = join(nodeModules, name);
  if (!existsSync(dir)) return 'missing';
  return lstatSync(dir).isSymbolicLink() ? 'linked' : 'pinned';
}

function report() {
  for (const name of vendoredPlugins()) {
    const state = stateOf(name);
    const label = { linked: '联调（→ ../' + name + '）', pinned: '钉 tag', missing: '缺失' }[state];
    console.log(`  ${name.padEnd(22)} ${label}`);
  }
}

/**
 * `dist` 解除了联调却没恢复的标记。`dist.mjs` 的恢复走 `try/finally`，而 finally
 * **在强杀（Ctrl-C 两下 / taskkill）时不会执行** —— 那种情况下联调被静默关掉，
 * 人以为还开着，改完插件跑 install-plugin 却怎么都不生效。这里替它把话说出来。
 */
function warnStaleUnlink() {
  const marker = join(root, '.dist-unlinked');
  if (!existsSync(marker)) return;
  console.warn('\n[link-plugins] ⚠ 上一次 npm run dist 解除了联调但没能恢复（多半是被强制中断）。');
  console.warn('[link-plugins]   跑 npm run link-plugins 恢复；恢复后这条提示会消失。');
}

if (mode === 'status') {
  console.log('[link-plugins] 当前状态：');
  report();
  warnStaleUnlink();
  process.exit(0);
}

if (mode === 'on') {
  let failed = false;
  for (const name of vendoredPlugins()) {
    const target = join(workspace, name);
    // 先确认同级真的有这个仓库、且包名对得上，再动 node_modules —— 链到一个
    // 不存在或不对的目录，表现是内核 import 失败秒退，排查成本远高于这里失败。
    const manifest = join(target, 'package.json');
    if (!existsSync(manifest)) {
      console.error(`[link-plugins] 跳过 ${name}：没找到工作副本 ${target}`);
      failed = true;
      continue;
    }
    const declared = JSON.parse(readFileSync(manifest, 'utf8')).name;
    if (declared !== name) {
      console.error(`[link-plugins] 跳过 ${name}：${target} 的包名是 ${declared}`);
      failed = true;
      continue;
    }
    const dest = join(nodeModules, name);
    rmSync(dest, { recursive: true, force: true });
    symlinkSync(target, dest, 'junction');
    console.log(`[link-plugins] ${name} → ${target}`);
  }
  // 联调恢复到位，`dist` 那次没善终的标记可以销了。
  rmSync(join(root, '.dist-unlinked'), { force: true });
  console.log('\n[link-plugins] 已进入联调模式。改完插件源码后跑 npm run install-plugin 即可生效。');
  console.log('[link-plugins] 发版前记得 npm run unlink-plugins —— 否则 npm run dist 会被拦下。');
  if (failed) process.exit(1);
} else {
  let removed = 0;
  for (const name of vendoredPlugins()) {
    if (stateOf(name) !== 'linked') continue;
    rmSync(join(nodeModules, name), { recursive: true, force: true });
    removed += 1;
    console.log(`[link-plugins] 已解除 ${name}`);
  }
  if (removed === 0) {
    console.log('[link-plugins] 没有处于联调模式的插件，无需处理。');
  } else {
    // 目录删掉之后要让 npm 按 lockfile 把钉住的那份重新拉回来。
    console.log('[link-plugins] 正在按 package.json 的 pin 恢复…');
    const isWin = process.platform === 'win32';
    const cmd = isWin ? (process.env.ComSpec || 'cmd.exe') : 'npm';
    const args = isWin ? ['/d', '/s', '/c', 'npm install'] : ['install'];
    execFileSync(cmd, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    console.log('[link-plugins] 已恢复到钉 tag 模式。');
  }
}
