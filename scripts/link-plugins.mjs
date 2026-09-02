// 在「钉 tag 的 git 依赖」与「指向同级工作副本的链接」之间切换插件源码。
//
//   node scripts/link-plugins.mjs        联调模式
//   node scripts/link-plugins.mjs --off  恢复：删链接 + npm install 拉回钉住的版本
//   node scripts/link-plugins.mjs --status  只看当前状态
//
// **要链的是两处**，缺一处联调就是半残的：
//
//   1) `node_modules/<插件>` → `../<仓库>`  —— 「源码从哪来」。打包时
//      pack-profile-plugins 的 `npm pack` 打的是这里，HTTP 基线测试读的也是这里。
//   2) `<DSH_HOME>/profiles/web/node_modules/<插件>` → `../<仓库>` —— 「跑的是哪份」。
//      插件迁到 profile 层之后，**真正被内核 import 的是 profile 里那份**，
//      它由 pnpm 从 tgz 装成一份独立拷贝，跟 node_modules 里那份没有任何关系。
//      只链第 1 处的话，改完代码什么都不会变 —— 这是迁移后最容易踩的一脚。
//
// 链上第 2 处之后，联调手感和迁移前一样甚至更好：改 client.js 内核的 HMR 立刻推给
// 浏览器（连注入的 <style> 都会重挂），改 index.js 重启内核即可，**没有任何拷贝
// 或重装步骤**。这也是为什么迁到 profile 层之后「拷进内核」那套机制可以整个
// 删掉：它存在的唯一理由就是把源码搬到内核能 import 到的地方，而现在插件本来就
// 住在那儿。
// 为什么不用 `npm link` 也不用 `file:` 依赖：
//   - `npm link` 要在全局 npm 前缀里注册一份，污染的是机器级状态，而且和我们
//     和 DSH_HOME 里那份 profile 叠在一起更难说清；
//   - 改成 `file:` 依赖会动 package.json 与 lockfile，而那两个文件是**发版凭据**
//     ——它们必须始终写着钉住的 tag，不能因为某次联调被改脏、更不能被误提交。
// 所以这里直接换 node_modules 里那一个目录：package.json 保持不动，pin 永远是权威。
//
// Windows 上用 junction 而不是 symlink：目录 junction 不需要管理员权限，
// symlink 默认要（除非开了开发者模式）。`npm pack` 跟着 junction 读实体内容，
// 所以两种模式打出来的 tgz 结构一致。

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vendoredPluginNames } from '../src/shared/profile-plugins.js';
import { profileDir } from '../src/shared/profile-plugins-installer.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(root, 'node_modules');
const workspace = resolve(root, '..');
// profile 里的 node_modules —— 内核真正 import 的地方。开发态 DSH_HOME 默认是
// ~/.dsh；`npm start` 不覆盖它，所以这里和应用跑起来看到的是同一个目录。
const profileNodeModules = join(profileDir(), 'node_modules');
// `profiles/<name>/` 的上一层——dsh 的 pnpm 工作区根，各 profile 共用的框架包
// （schemastery、cordis、dsh-credentials…）hoist 在这里，不在 profileNodeModules
// 里。见下面 ensurePeerAccess 的注释。
const frameworkNodeModules = join(dirname(profileDir()), 'node_modules');

/** 包名 → 同级工作副本的目录名。`@scope/x` 的仓库目录是 `x`。 */
function repoDirOf(packageName) {
  return packageName.startsWith('@') ? packageName.split('/')[1] : packageName;
}

const mode = process.argv.includes('--off') ? 'off'
  : process.argv.includes('--status') ? 'status'
    : 'on';

/**
 * 只处理「git 依赖 vendor 进来的」插件；plugins/ 下的桌面专属插件本来就是源码。
 * 名单取「清单 ∩ dependencies」而不是「dependencies 的全部」—— 后者会在将来加
 * 一个非插件生产依赖时，跑去 ../<那个包名> 找工作副本。
 */
const vendoredPlugins = () => vendoredPluginNames(root);

/**
 * @param {string} baseDir 一个 node_modules 目录
 * @returns {'linked'|'pinned'|'missing'}
 */
function stateIn(baseDir, name) {
  const dir = join(baseDir, name);
  if (!existsSync(dir)) return 'missing';
  return lstatSync(dir).isSymbolicLink() ? 'linked' : 'pinned';
}

const stateOf = (name) => stateIn(nodeModules, name);

function report() {
  const label = { linked: '联调', pinned: '钉 tag', missing: '缺失' };
  for (const name of vendoredPlugins()) {
    // 两处分别报：只链上一处是**能跑但行为不符合预期**的状态（改了没反应，或者
    // 改了有反应但打包不含），比两处都没链更难自己发现。
    console.log(`  ${name.padEnd(24)} 源码 ${label[stateOf(name)].padEnd(6)} 运行 ${label[stateIn(profileNodeModules, name)]}`);
  }
}

/**
 * `dist` 解除了联调却没恢复的标记。`dist.mjs` 的恢复走 `try/finally`，而 finally
 * **在强杀（Ctrl-C 两下 / taskkill）时不会执行** —— 那种情况下联调被静默关掉，
 * 人以为还开着，改完插件却怎么都不生效。这里替它把话说出来。
 */
/**
 * 把这些包从播种账本里删掉，逼下次启动重新装。
 *
 * 不这么做的话对账会看到「账本说装过 0.5.0、profile 里也确实是 0.5.0」（junction
 * 刚被删掉，但账本还在）而直接跳过，结果 profile 里少了这个包、内核 import 失败
 * 秒退。账本读不出来就当没有 —— 这条路是尽力而为，失败最多是多装一次。
 * @param {string[]} names
 */
function dropSeedEntries(names) {
  // userData 目录名跟 package.json 的 name 走（Electron 的默认规则）。
  const seedPath = join(process.env.APPDATA ?? join(process.env.HOME ?? '', '.config'),
    'deepseek-desktop', 'profile-plugins-seeded.json');
  if (!existsSync(seedPath)) return;
  try {
    const seeded = JSON.parse(readFileSync(seedPath, 'utf8'));
    for (const name of names) delete seeded[name];
    writeFileSync(seedPath, `${JSON.stringify(seeded, null, 2)}
`, 'utf8');
  } catch (error) {
    console.warn(`[link-plugins] 播种账本更新失败（下次启动可能不会自动装回）：${error?.message ?? error}`);
  }
}

/**
 * 让插件仓库自己能 `import` 到 schemastery / dsh-credentials 这类框架包。
 *
 * **真实事故**：改完插件市场的卡片 UI 后开另外四个插件联调，`@easytz/dsh-ui-balance`
 * 直接把内核崩了——`Cannot find package '@deepseek-ai/schemastery' imported from
 * .../dsh-ui-balance/lib/index.js`。插件仓库刻意零依赖，这些包只在 `peerDependencies`
 * 里声明，真正由内核/profile 提供；而 Node 的 ESM 解析按**文件的物理路径**网上找
 * `node_modules`——非联调时物理路径就在 `profiles/web/node_modules/@easytz/...` 下面，
 * 网上第一层就是 `frameworkNodeModules`（`profiles/node_modules`，schemastery、
 * cordis、dsh-credentials 这些框架包实际 hoist 的地方），天然够得到；联调把它换成
 * 指向同级工作副本的 junction 后，物理路径变成仓库目录本身，往上是 `workspace`、
 * `D:\`，够不到 profile 那棵树，于是任何在模块顶层 `import` 了框架包的插件
 * （目前只有用了 Config 的 dsh-ui-balance、dsh-market）联调时就会直接崩内核。
 *
 * 在仓库里补一个指向 `frameworkNodeModules` 的 `node_modules` junction 就够了：
 * 不管这条依赖链多深（schemastery、dsh-credentials 还会各自再 import cordis 等），
 * 只要它们本身也在 `frameworkNodeModules` 树里，Node 从那一步起就是在真实路径上
 * 走，会自己继续解析下去，不需要为每一层再补一个 junction。也不用在每个插件仓库
 * 各自维护一份 devDependencies 去追这条依赖链——追不完，且和 profile 里实际提供的
 * 版本对不上是双份维护。
 *
 * **绝不覆盖仓库自己真实的 node_modules**：万一某个插件仓库出于别的原因（比如跑
 * 自己的单测）真的装了本地依赖，这里应该什么都不做，而不是把它删了换成 junction。
 */
function ensurePeerAccess(repoDir) {
  const dest = join(repoDir, 'node_modules');
  if (existsSync(dest) && !lstatSync(dest).isSymbolicLink()) return; // 真实目录，不碰
  if (!existsSync(frameworkNodeModules)) return; // profile 还没起过，等下次再补
  rmSync(dest, { recursive: true, force: true });
  symlinkSync(frameworkNodeModules, dest, 'junction');
}

/** ensurePeerAccess 的另一半：联调关掉时把补的这个 junction 也收掉，别留着。 */
function clearPeerAccess(repoDir) {
  const dest = join(repoDir, 'node_modules');
  if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) {
    rmSync(dest, { recursive: true, force: true });
  }
}

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
    // 同级目录名是**仓库名**，不带 scope：包叫 `@easytz/dsh-git`，仓库目录叫
    // `dsh-git`。scope 是 npm 上的命名空间，跟磁盘布局没关系。
    const target = join(workspace, repoDirOf(name));
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
    for (const base of [nodeModules, profileNodeModules]) {
      // profile 里没装过这个插件就跳过，不要凭空造一个：profile 的
      // `dsh.profile.bundles` 里没有对应登记，链了也不会被加载，反而让
      // --status 显示成「已联调」而实际没生效。先把应用跑一次让它装进去。
      if (base === profileNodeModules && stateIn(base, name) === 'missing') {
        console.warn(`[link-plugins] ${name}：profile 里还没装过，跳过运行侧链接（先跑一次 npm start）`);
        continue;
      }
      const dest = join(base, name);
      rmSync(dest, { recursive: true, force: true });
      symlinkSync(target, dest, 'junction');
      console.log(`[link-plugins] ${dest} → ${target}`);
    }
    ensurePeerAccess(target);
  }
  // 联调恢复到位，`dist` 那次没善终的标记可以销了。
  rmSync(join(root, '.dist-unlinked'), { force: true });
  console.log('\n[link-plugins] 已进入联调模式。改 lib/client.js 立刻生效；改 lib/index.js 重启内核（npm start）生效。');
  if (failed) process.exit(1);
} else {
  let removed = 0;
  const relinkProfile = [];
  for (const name of vendoredPlugins()) {
    // ensurePeerAccess 补的那个 junction 也要收掉，不然仓库目录里凭空多一个
    // 指向 profile 框架包的 node_modules，跟"联调关掉了"这件事对不上。
    clearPeerAccess(join(workspace, repoDirOf(name)));
    // profile 侧先摘：留着它就等于「打包用钉住的版本、跑的还是工作副本」，
    // 而这条歧路恰恰是 unlink 想消除的。
    if (stateIn(profileNodeModules, name) === 'linked') {
      rmSync(join(profileNodeModules, name), { recursive: true, force: true });
      relinkProfile.push(name);
    }
    if (stateOf(name) !== 'linked') continue;
    rmSync(join(nodeModules, name), { recursive: true, force: true });
    removed += 1;
    console.log(`[link-plugins] 已解除 ${name}`);
  }
  if (relinkProfile.length > 0) {
    // 只删不补：profile 里那份由启动时的对账负责装回来（seeded 账本记的版本和
    // 随包 tgz 一致时它认为「已装」，所以这里要顺手把账本里那几条抹掉）。
    dropSeedEntries(relinkProfile);
    console.log(`[link-plugins] 已摘掉 profile 里的链接：${relinkProfile.join(', ')}（下次启动会按随包版本装回来）`);
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
