'use strict';

// **profile 层插件**（A1）的清单与对账逻辑。
//
// 和 plugins.json 那套（A2）是两回事，别混：
//
// | | A2：plugins.json | A1：profile-plugins.json |
// |---|---|---|
// | 装到哪 | 内核的 node_modules | `$DSH_HOME/profiles/<name>/` |
// | 谁激活 | 我们生成的 `--patch` overlay（第 4 层） | 插件自带的 `dsh.bundle.patch`（第 2 层） |
// | 内核热更新后 | 必须重装（跟着内核走） | 原样还在（不受内核更换影响） |
// | 用户能不能卸 | 不能，只能开关 | 能，市场面板里就有卸载 |
//
// 判据是**生命周期归属**：随包分发、该跟着内核一起前进和回退的东西放 A2；用户自己
// 装的、不该因为内核换了一版就消失的东西放 A1。插件市场自己属于后者——它管理的正是
// profile 层，自己住在那儿才自洽，而且它同时也是个可以发布给任何 dsh 用户的通用插件。
//
// 但「用户装的」不等于「桌面不管」：市场是发行版承诺提供的功能，所以桌面要保证它
// **首次启动就在、坏了会自愈、版本跟着应用版本走**。这就是这里的对账（reconcile）：
// 拿随包分发的期望状态去比 profile 的实际状态，缺了或漂了就用随包 tarball 装回来。
//
// 为什么用 tarball 而不是让它去 npm 拉：首次启动必须离线可用。发行包里躺着 tgz，
// 装的时候不需要网络，也不会因为 registry 抽风或包被 unpublish 而拿不到。

/** @typedef {{ packageName: string, version: string, tarball: string, required?: boolean }} DesiredProfilePlugin */

const fs = require('node:fs');
const path = require('node:path');
const { isNewer } = require('./version');

/**
 * 合法的 npm 包名形状（可选 scope）。与 plugin-install.js 里那条同源同理由：
 * packageName 会被摊进 path.join 去拼路径，`../..` 形状能穿越出去。
 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * 读 profile 插件清单。字段错了要**大声失败**：清单是构建期输入，错在这里比错到
 * 用户机器上便宜得多。
 * @param {string} pluginsDir
 * @returns {Array<{ packageName: string, required?: boolean }>}
 */
function loadProfilePluginManifest(pluginsDir) {
  const manifestPath = path.join(pluginsDir, 'profile-plugins.json');
  // 这个清单是**可选的**：没有 profile 层插件的构建（或旧版本升上来的目录）不该因此报错。
  if (!fs.existsSync(manifestPath)) return [];
  const plugins = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(plugins)) {
    throw new Error(`profile-plugins.json 必须是数组: ${manifestPath}`);
  }
  const seen = new Set();
  for (const plugin of plugins) {
    if (typeof plugin?.packageName !== 'string' || plugin.packageName.length === 0) {
      throw new Error(`profile-plugins.json 条目缺少 packageName: ${JSON.stringify(plugin)}`);
    }
    if (!PACKAGE_NAME_RE.test(plugin.packageName)) {
      throw new Error(`profile-plugins.json 的 packageName 不是合法包名: ${JSON.stringify(plugin.packageName)}`);
    }
    if (seen.has(plugin.packageName)) {
      throw new Error(`profile-plugins.json 有重复的 packageName: ${plugin.packageName}`);
    }
    seen.add(plugin.packageName);
  }
  return plugins;
}

/**
 * 读随包分发的 tarball 索引（构建期由 pack-profile-plugins.mjs 生成）。
 *
 * 版本号来自被打包插件自己的 package.json，不在清单里手写第二遍——手写的那份
 * 迟早和真实产物对不上，而对账正是拿它当「期望」的。
 * @param {string} dir 索引所在目录（发行包里是 resources/plugins/profile/）
 * @returns {DesiredProfilePlugin[]}
 */
function loadProfilePluginIndex(dir) {
  const indexPath = path.join(dir, 'index.json');
  if (!fs.existsSync(indexPath)) return [];
  const entries = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!Array.isArray(entries)) throw new Error(`profile 插件索引必须是数组: ${indexPath}`);
  const out = [];
  for (const entry of entries) {
    if (typeof entry?.packageName !== 'string' || !PACKAGE_NAME_RE.test(entry.packageName)) continue;
    if (typeof entry?.version !== 'string' || entry.version.length === 0) continue;
    if (typeof entry?.tarball !== 'string' || entry.tarball.length === 0) continue;
    out.push({
      packageName: entry.packageName,
      version: entry.version,
      tarball: entry.tarball,
      // required 决定对账语义（见 planProfileReconcile）：缺省 false = 用户自主管理。
      required: entry.required === true,
    });
  }
  return out;
}

/**
 * 对账：期望状态 vs profile 实际状态 + 播种账本，得出「要装哪几个」。
 *
 * 这里的语义是整套机制里最容易想歪的一处，写清楚：
 *
 * 随包分发的插件分两类，判据完全不同 ——
 *
 * **`required: true`（目前只有插件市场）**：必须在，且版本必须是随包的那一版。用户
 * 卸不掉它（市场自己的保护名单挡着），装坏了下次启动自愈，应用回退时也跟着回退。
 * 判据是「不等就装」。
 *
 * **其余（随应用分发但用户自主管理的插件）**：**只播种一次**。第一次启动时装上，
 * 之后用户卸载了就**永远不再装回来** —— 否则「卸载」这个按钮是假的：点完下次启动
 * 它又回来了，比没有这个按钮更让人恼火。要区分「从没装过」和「装过但被卸了」，光看
 * profile 是看不出来的（两种情况下 `installedVersionOf` 都返回 null），所以必须有
 * 一本**播种账本**记「我们给这个 profile 播过哪些种」。
 *
 * 已播种且仍装着的，只在**随包版本更新**时升级（`isNewer` 判断），不降级：用户可能
 * 自己从市场装了更新的版本，应用不该把它按回旧版。
 *
 * 比的是**实际装到的版本号**（读 profile 的 node_modules/<name>/package.json），
 * 不是 profile package.json 里的依赖 spec —— 从 tarball 装进去的 spec 长
 * `file:...tgz` 这样，跟版本号对不上，拿它比会每次都判定为「漂了」然后反复重装。
 *
 * @param {DesiredProfilePlugin[]} desired 随包分发的期望状态
 * @param {(packageName: string) => string|null} installedVersionOf 读实际装到的版本，没装返回 null
 * @param {Record<string, string>} [seeded] 播种账本：包名 → 播种时的版本
 * @returns {DesiredProfilePlugin[]} 需要安装的条目（顺序保持清单顺序）
 */
function planProfileReconcile(desired, installedVersionOf, seeded = {}) {
  const plan = [];
  for (const entry of desired) {
    const actual = installedVersionOf(entry.packageName);
    if (entry.required) {
      // 恢复入口：不等就装（含降级——应用回退时插件也要跟着回到配套版本）。
      if (actual !== entry.version) plan.push(entry);
      continue;
    }
    const everSeeded = Object.prototype.hasOwnProperty.call(seeded, entry.packageName);
    if (!everSeeded) {
      plan.push(entry);          // 第一次见到这个 profile，播种
      continue;
    }
    if (actual === null) continue; // 播过种但现在没装 = 用户卸了，尊重它
    if (isNewer(entry.version, actual)) plan.push(entry); // 随包版本更新了，升上去
  }
  return plan;
}

/**
 * 读播种账本。读不到按「什么都没播过」——最坏结果是重播一次种，
 * 比「误判成播过、于是永远不装」要好：后者表现为「插件凭空少了」。
 * @param {string} file
 * @returns {Record<string, string>}
 */
function loadSeedState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [name, version] of Object.entries(parsed)) {
      if (typeof version === 'string') out[name] = version;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 记一笔播种。**装成功之后才记** —— 装失败也记的话，那个插件就永远不会再被尝试，
 * 用户看到的是一个「本该随应用分发、却始终不存在」的插件。
 * @param {string} file
 * @param {Record<string, string>} state
 */
function saveSeedState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * 读某个包在 profile 里实际装到的版本；没装或读不出来返回 null。
 * @param {string} profileDir
 * @param {string} packageName
 */
function installedVersionIn(profileDir, packageName) {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json'),
      'utf8',
    ));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * bundle patch 文件里 `- id: X` 那一行。
 *
 * 用逐行正则而不是拉一个 YAML 解析器进来：这些 patch 文件都是插件作者手写的几行
 * `- insert:` 条目，而外壳进程刻意保持零运行时依赖（package.json 的 dependencies
 * 里一个都没有，只有 electron 是 devDependency）。为一件「取几个 id」的事引入 js-yaml
 * 会把这条性质破坏掉。代价是遇到花哨写法（流式 YAML、锚点）会漏读——那种 patch
 * 在现实里不存在，真出现了后果也只是「安全模式没关掉某个插件」，不是崩溃。
 */
const PATCH_ENTRY_ID_RE = /^\s*-?\s*id:\s*(\S+)\s*$/;

/**
 * 列出 profile 层插件声明的全部 loader entry id。
 *
 * 用途只有一个：**安全模式**。安全模式生成的 overlay 原本只管「不激活 A2 插件」，
 * 而 profile 层（A1）的插件是自己 insert 自己的第 2 层条目 —— 我们不生成它、也就
 * 关不掉它。结果是：用户从市场装的插件把内核搞崩时，安全模式救不了他，因为那个
 * 插件在安全模式下照样加载。补法是从第 4 层主动 disable 它们（实测有效：第 4 层的
 * 一条 `- id: X` 配 `disabled: true`，能关掉第 2 层的同名条目）。
 *
 * 只看「既是直接依赖、又在 bundles 里」的包：`dsh.profile.bundles` 里还有
 * `@deepseek-ai/dsh-base` 与 `dsh-web-app` 这两个**应用本体**，它们不是 dependencies，
 * 也绝不能被 disable —— 关掉它们不是「安全模式」，是「没有界面」。
 *
 * @param {string} profileDir
 * @param {{ exclude?: string[] }} [options] 不参与 disable 的包名（恢复入口自己）
 * @returns {string[]} 要被 disable 的 entry id
 */
function profileBundleEntryIds(profileDir, options = {}) {
  const exclude = new Set(options.exclude ?? []);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const deps = manifest?.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const ids = [];
  for (const name of bundles) {
    if (typeof name !== 'string') continue;
    if (!Object.prototype.hasOwnProperty.call(deps, name)) continue; // 应用本体，不碰
    if (exclude.has(name)) continue;
    ids.push(...entryIdsForPackage(profileDir, name));
  }
  return [...new Set(ids)];
}

/**
 * 某个已装的包声明了哪些 loader entry id（读它自己的 `dsh.bundle.patch`）。
 * 读不到任何一环都返回空数组——「读不出来」和「没有声明」在调用方看来是同一件事。
 * @param {string} profileDir
 * @param {string} packageName
 * @returns {string[]}
 */
function entryIdsForPackage(profileDir, packageName) {
  if (typeof packageName !== 'string' || !PACKAGE_NAME_RE.test(packageName)) return [];
  const pkgDir = path.join(profileDir, 'node_modules', ...packageName.split('/'));
  let patchRel;
  try {
    patchRel = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))?.dsh?.bundle?.patch;
  } catch {
    return [];
  }
  if (typeof patchRel !== 'string' || patchRel.length === 0) return [];
  let text;
  try {
    text = fs.readFileSync(path.join(pkgDir, ...patchRel.replace(/^\.\//, '').split('/')), 'utf8');
  } catch {
    return [];
  }
  const ids = [];
  for (const line of text.split(/\r?\n/)) {
    const m = PATCH_ENTRY_ID_RE.exec(line);
    if (m) ids.push(m[1].replace(/^['"]|['"]$/g, ''));
  }
  return [...new Set(ids)];
}

/**
 * 找出「我们播过种、但现在的随包清单里已经没有、而且会和现清单撞 entry id」的包。
 *
 * 这是给**改名 / 换包**兜底的。`- insert:` 不去重：新旧两个包声明同一个 entry id
 * 时，cordis loader 抛 `duplicate loader entry id`，内核秒退、用户看到的是黑屏加一句
 * 内核启动失败。而改名恰恰会造出这种局面——新名字被播种进去，旧名字还在。
 *
 * **判据必须是「撞 id」而不是「不在清单里」**：后者会把「我们曾经分发、后来不再分发，
 * 但用户还在用」的插件也删掉，那是替用户做决定。撞 id 不一样——它是确定会让内核起不来
 * 的状态，两个包不可能共存，清掉我们自己留下的那个是唯一出路。
 *
 * 只看播种账本里的包：用户自己装的东西不归我们管，哪怕它撞了 id 也轮不到我们删。
 *
 * @param {DesiredProfilePlugin[]} desired 当前随包清单
 * @param {Record<string, string>} seeded 播种账本
 * @param {(packageName: string) => string[]} entryIdsOf 读某个包声明的 entry id
 * @returns {string[]} 应当移除的包名
 */
function planProfileCleanup(desired, seeded, entryIdsOf) {
  const desiredNames = new Set(desired.map((entry) => entry.packageName));
  const desiredIds = new Set();
  for (const entry of desired) {
    for (const id of entryIdsOf(entry.packageName)) desiredIds.add(id);
  }
  const remove = [];
  for (const name of Object.keys(seeded)) {
    if (desiredNames.has(name)) continue;
    const ids = entryIdsOf(name);
    if (ids.length === 0) continue;                 // 没装 / 没声明条目，撞不了
    if (ids.some((id) => desiredIds.has(id))) remove.push(name);
  }
  return remove;
}

/**
 * 解析插件源码目录：先查 plugins/<packageName>（随仓库走的），再查
 * node_modules/<packageName>（git 依赖 vendor 的）。打包态只有 resources/plugins
 * 一处（extraResources 已把全部源码摊进去），nodeModulesDir 传 null 即可。
 *
 * 判存在用「目录里有 package.json」而不是「目录存在」：node_modules 里同名
 * 空目录（安装中途失败留下的）不该被当成可用源码。
 * @param {{ pluginsDir?: string|null, nodeModulesDir?: string|null, packageName: string }} opts
 * @returns {string}
 */
/**
 * 挑出 profile 清单里「声明了但装不出来」的 bundle 条目。
 *
 * 为什么需要它：内核 boot 时按 `dsh.profile.bundles` 逐个解析包目录，解不出来就
 * **直接抛异常退出**（`cannot resolve profile bundle "X"`）。这不是插件坏了那种
 * 局部故障 —— 它发生在 profile 组装阶段，早于第 4 层 patch 生效，所以安全模式也
 * 救不回来：安全模式靠给 entry id 压 `disabled: true` 来关插件，而包都不在了，
 * 我们连它的 entry id 都读不到。用户看到的是一个反复弹错、连逃生舱都进不去的应用。
 *
 * 真实发生过：用户在市场里卸载一个插件，`dsh plugin remove` 中途失败，node_modules
 * 里的包没了、清单里的两条声明还在，下次启动就再也起不来。
 *
 * **只处理 profile 自己拥有的包**：判据是它同时出现在 `dependencies` 里。基础
 * bundle（`@deepseek-ai/dsh-base` 等）是从 dsh 安装目录解析的，不在 profile 的
 * dependencies 里，这里一律不碰 —— 误删那些等于把内核拆了。
 *
 * @param {any} manifest profile 的 package.json 内容
 * @param {(packageName: string) => boolean} isInstalled 包目录在不在
 * @returns {string[]} 该从清单里摘掉的包名
 */
function planBundlePrune(manifest, isInstalled) {
  const bundles = manifest?.dsh?.profile?.bundles;
  const deps = manifest?.dependencies;
  if (!Array.isArray(bundles) || !deps || typeof deps !== 'object') return [];
  const owned = new Set(Object.keys(deps));
  return bundles.filter((name) => typeof name === 'string' && owned.has(name) && !isInstalled(name));
}

/**
 * 把 planBundlePrune 选中的条目从清单里摘掉（`bundles` 与 `dependencies` 各一处）。
 *
 * 两处都摘：只摘 bundles 的话，profile 里留着一条指向不存在的包的依赖，下一次
 * pnpm 操作（用户装/卸任何一个插件）解析到它就会失败 —— 故障从「起不来」变成
 * 「插件再也装不上」，同样难查。
 *
 * @returns {{ manifest: any, pruned: string[] }} 新清单与被摘掉的名字
 */
function pruneBundles(manifest, names) {
  if (names.length === 0) return { manifest, pruned: [] };
  const drop = new Set(names);
  const next = { ...manifest, dependencies: { ...manifest.dependencies } };
  for (const name of drop) delete next.dependencies[name];
  next.dsh = { ...manifest.dsh, profile: { ...manifest.dsh.profile } };
  next.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n) => !drop.has(n));
  return { manifest: next, pruned: [...drop] };
}

/**
 * 挑出清单里已经指不到东西的 `file:` 依赖，并改指到能找到的替代品。
 *
 * 为什么这事非管不可：pnpm 解析的是**全部**依赖，不是只解析这次要动的那个。清单
 * 里只要留着一条指向已消失文件的 `file:`，用户装/卸任何一个插件都会失败，连
 * 「下次启动自动装回来」那条自愈路径也一起被堵死（它自己也要跑 pnpm）。
 *
 * 只按**文件名**找替代：`file:` 记的是绝对路径，路径变了但文件名（带版本号）没变，
 * 就是同一个包的同一版。找不到的原样留着 —— 在这儿擅自删掉一条依赖，等于卸掉一个
 * 可能还在正常工作的插件。
 *
 * @param {any} manifest profile 的 package.json 内容
 * @param {(target: string) => boolean} exists 目标文件在不在
 * @param {(basename: string) => string|null} findReplacement 按文件名找替代路径
 * @returns {{ manifest: any, repaired: string[] }}
 */
function planFileSpecRepair(manifest, exists, findReplacement) {
  const deps = manifest?.dependencies;
  if (!deps || typeof deps !== 'object') return { manifest, repaired: [] };
  const next = { ...deps };
  const repaired = [];
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
    const target = spec.slice('file:'.length);
    if (exists(target)) continue;
    const basename = target.split(/[\\/]/).pop() ?? '';
    const replacement = findReplacement(basename);
    if (replacement === null) continue;
    next[name] = `file:${replacement}`;
    repaired.push(name);
  }
  if (repaired.length === 0) return { manifest, repaired: [] };
  return { manifest: { ...manifest, dependencies: next }, repaired };
}

function resolvePluginSrcDir({ pluginsDir, nodeModulesDir, packageName }) {
  const candidates = [];
  if (pluginsDir) candidates.push(path.join(pluginsDir, packageName));
  if (nodeModulesDir) candidates.push(path.join(nodeModulesDir, packageName));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  throw new Error(`未找到插件源码: ${packageName}（找过 ${candidates.join(' ; ') || '（无候选位置）'}）`);
}

/**
 * 「以 git 依赖 vendor 进来的插件」的包名列表 —— 联调 / 发版闸门 / 打包共用的那份名单。
 *
 * 判据是**清单与 dependencies 的交集**，不是「dependencies 的全部」。后者是个隐式
 * 约定：现在根 dependencies 里恰好只有插件，脚本才凑巧对；哪天加一个真正的生产依赖，
 * link-plugins 就会跑去 `../<那个包名>` 找工作副本、verify-plugin-pins 会要求它是
 * git 依赖——都是莫名其妙的失败。
 *
 * @param {string} rootDir 本仓库根目录
 * @returns {string[]}
 */
function vendoredPluginNames(rootDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const deps = pkg.dependencies ?? {};
  return loadProfilePluginManifest(path.join(rootDir, 'plugins'))
    .map((plugin) => plugin.packageName)
    .filter((name) => name in deps);
}

module.exports = {
  resolvePluginSrcDir,
  vendoredPluginNames,
  profileBundleEntryIds,
  entryIdsForPackage,
  planProfileCleanup,
  loadSeedState,
  saveSeedState,
  loadProfilePluginManifest,
  loadProfilePluginIndex,
  planProfileReconcile,
  installedVersionIn,
  planBundlePrune,
  pruneBundles,
  planFileSpecRepair,
};
