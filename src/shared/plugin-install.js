'use strict';

// 自定义插件安装的唯一实现。构建期（scripts/install-plugin.mjs，装进本机全局
// dsh）与运行期（src/main/kernel-updater.js，装进热更新出的新内核）共用这里，
// 两条路径只负责解析各自的目录，逻辑不再各写一份。
//
// 装一个插件要做两件事，缺一不可：
//   1) 拷贝插件源码到 dsh 能解析到的 node_modules；
//   2) 把插件登记进 dsh 的 package.json dependencies。
//
// 第 2 步是硬约束，不是可选优化：dsh 运行时靠 healProfilesModuleFallback 遍历
// 依赖闭包，在 $DSH_HOME/profiles/node_modules 为每个包建解析 symlink。只拷贝
// 而不登记，内核 import 该插件时会 ERR_MODULE_NOT_FOUND、进程秒退，桌面端表现
// 为黑屏 —— v1.1.1 就是为这个发的补丁版本。
//
// 「激活」曾经是第 3 件事：往 dsh 发行包自带的 dsh-web-app/cordis.patch.yml 末尾
// 追加 `- insert:` 条目。那是在改别人已经装好的软件的配置文件，代价是每出一个新
// 内核都要重改一遍、还得猜这文件在 hoisted 顶层还是嵌套位置。现在改走 dsh 官方的
// `--patch` overlay（patch 层栈的第 4 层，本来就是留给调用方的）：激活条目由
// renderActivationPatch 生成到我们自己的文件里，发行包保持原样。
//
// 插件源码的位置（拆仓后有两处）：
//   - plugins/<packageName>       随本仓库走的桌面专属插件（如 dsh-plugin-manager）
//   - node_modules/<packageName>  根 package.json 的 git 依赖 vendor 进来的通用插件
// 由 resolvePluginSrcDir 统一解析，两条安装路径与打包脚本共用。

/** @typedef {{ log: (...args: any[]) => void, warn: (...args: any[]) => void }} Logger */

const fs = require('node:fs');
const path = require('node:path');
const { isPluginEnabled, safeModePlugins } = require('./plugin-state');

/**
 * 合法的 npm 包名形状（可选 scope）。
 *
 * 这条正则是**路径护栏**，不是洁癖：packageName 会被 `packageName.split('/')`
 * 摊进 path.join，然后交给 `fs.rmSync(..., { recursive: true, force: true })`
 * —— 一个 `../..` 形状的值就能删到目标目录之外。清单目前是我们自己的可信文件，
 * 但它同时也是「错一个字段就让内核秒退」的高危输入，护栏成本只有一行。
 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * 读插件清单 plugins.json（单一数据源）。packageName / entryId 在这里强校验：
 * 清单字段错了会让激活条目指向不存在的模块，内核 boot 时秒退——与其让用户看
 * 黑屏，不如在装的时候就大声失败。
 * @returns {Array<{packageName: string, entryId: string, enabled?: boolean, safeMode?: boolean}>}
 */
function loadPluginManifest(pluginsDir) {
  const manifestPath = path.join(pluginsDir, 'plugins.json');
  const plugins = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(plugins)) {
    throw new Error(`plugins.json 必须是数组: ${manifestPath}`);
  }
  const seenEntryIds = new Set();
  const seenPackageNames = new Set();
  for (const plugin of plugins) {
    if (typeof plugin?.packageName !== 'string' || plugin.packageName.length === 0) {
      throw new Error(`plugins.json 条目缺少 packageName: ${JSON.stringify(plugin)}`);
    }
    if (typeof plugin?.entryId !== 'string' || plugin.entryId.length === 0) {
      throw new Error(`plugins.json 条目缺少 entryId: ${JSON.stringify(plugin)}`);
    }
    if (!PACKAGE_NAME_RE.test(plugin.packageName)) {
      throw new Error(`plugins.json 的 packageName 不是合法包名: ${JSON.stringify(plugin.packageName)}`);
    }
    // 重复 entryId 与「和上游 bundle 条目撞名」是同一种事故：`- insert:` 不去重，
    // cordis loader 见到重复 id 直接抛 duplicate loader entry id，内核秒退、桌面端
    // 黑屏。前缀规则挡的是「和别人撞」，这里挡的是「自己人内部撞」。
    if (seenEntryIds.has(plugin.entryId)) {
      throw new Error(`plugins.json 有重复的 entryId: ${plugin.entryId}（会让内核以 duplicate loader entry id 秒退）`);
    }
    // 重复 packageName 不会秒退，但会让同一个包被装两遍、激活两条，
    // 且用户开关状态按 entryId 存 —— 两条条目指向同一份源码，开关行为无法自洽。
    if (seenPackageNames.has(plugin.packageName)) {
      throw new Error(`plugins.json 有重复的 packageName: ${plugin.packageName}`);
    }
    seenEntryIds.add(plugin.entryId);
    seenPackageNames.add(plugin.packageName);
  }
  return plugins;
}

/**
 * 「以 git 依赖 vendor 进来的插件」的包名列表 —— 联调 / 发版闸门 / 打包这几个
 * 脚本共用的那份名单。
 *
 * 判据是**清单与 dependencies 的交集**，不是「dependencies 的全部」。后者是个
 * 隐式约定：现在根 `dependencies` 里恰好只有四条插件，脚本才凑巧对；哪天加一个
 * 真正的生产依赖，`link-plugins` 就会跑去 `../<那个包名>` 找工作副本，
 * `verify-plugin-pins` 会要求它是 git 依赖 —— 都是莫名其妙的失败。
 *
 * `plugins/` 下的桌面专属插件（如 dsh-plugin-manager）本来就是源码，不在
 * dependencies 里，自然被交集排除。
 *
 * @param {string} rootDir 本仓库根目录
 * @returns {string[]}
 */
function vendoredPluginNames(rootDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const deps = pkg.dependencies ?? {};
  // 两份清单都要算进来：A2（plugins.json，拷进内核）与 A1（profile-plugins.json，
  // 打成 tarball 装进用户 profile）。发版闸门查的是「源码是不是来自钉住的 tag」，
  // 这个风险对两条路径完全一样——A1 那条甚至更隐蔽，因为 npm pack 打的就是工作副本。
  const { loadProfilePluginManifest } = require('./profile-plugins');
  const names = [
    ...loadPluginManifest(path.join(rootDir, 'plugins')).map((plugin) => plugin.packageName),
    ...loadProfilePluginManifest(path.join(rootDir, 'plugins')).map((plugin) => plugin.packageName),
  ];
  return [...new Set(names)].filter((name) => name in deps);
}

/** 读插件自己的 package.json，取包名与版本。 */
function readPluginPackage(pluginSrcDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginSrcDir, 'package.json'), 'utf8'));
  const packageName = pkg.name;
  if (typeof packageName !== 'string' || packageName.length === 0) {
    throw new Error(`${pluginSrcDir}/package.json 缺少 name 字段`);
  }
  return {
    packageName,
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
  };
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
 * 拷贝插件源码时要跳过的顶层目录。
 *
 * 插件拆仓之后，插件仓库里开始有自己的测试与 CI 配置（`test/`、`.github/`），
 * 而这两条安装路径都是**整目录拷贝**——不挡一下，测试文件会跟着进内核和安装包。
 * 它们不参与运行，只增加文件数，而绿色版的解压耗时主要由文件个数决定。
 *
 * 只按顶层目录名匹配，不做深度匹配：插件源码就是 `lib/` 加几个元文件，规则越简单
 * 越不会误伤（比如某天真有个 `lib/testing.js`）。
 */
const PLUGIN_COPY_EXCLUDE = new Set(['test', 'tests', '__tests__', '.github', '.git', 'node_modules']);

/**
 * 拷贝插件源码到 `dstDir`，跳过 PLUGIN_COPY_EXCLUDE 里的顶层目录。
 *
 * dereference：本地联调把 node_modules 指到插件仓库的工作副本，源码目录会是
 * 符号链接；cpSync 默认把链接原样复制过去，内核拿到一个断链。跟随链接拷实体，
 * 两种开发方式都不踩坑。
 *
 * @param {string} srcDir
 * @param {string} dstDir
 */
function copyPluginTree(srcDir, dstDir) {
  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dstDir), { recursive: true });
  fs.cpSync(srcDir, dstDir, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = path.relative(srcDir, src);
      if (rel === '') return true;
      const top = rel.split(path.sep)[0];
      return !PLUGIN_COPY_EXCLUDE.has(top);
    },
  });
}

/** 1) 拷贝插件源码到目标 node_modules。 */
function copyPluginSource(pluginSrcDir, nodeModulesDir, packageName) {
  const dst = path.join(nodeModulesDir, ...packageName.split('/'));
  copyPluginTree(pluginSrcDir, dst);
  return dst;
}

/**
 * 生成 `--patch` overlay 的内容：把清单里每个**激活的**插件变成一条 `- insert:`
 * 条目。被用户关掉的插件不出现在 overlay 里（源码照样装，只是不激活——见
 * plugin-state.js 的说明）。
 *
 * 这是「装插件」与「激活插件」分家之后，激活那一半的唯一实现。overlay 作用在
 * 发行包自带的 bundle 层之上，效果与过去直接改 bundle 等价（`--dump-config`
 * 比对过，合成树逐行一致）。
 *
 * 包名直接取清单的 packageName，不读插件源码：拆仓后源码在开发态的
 * node_modules、打包态的 resources/plugins，路径两套，靠读源码取包名会把
 * 「路径解析」泄漏进这条本可以纯函数的逻辑。名字一致性由 installPlugin 的
 * expectedName 校验兜住。
 *
 * @param {Array<{packageName: string, entryId: string, enabled?: boolean, safeMode?: boolean}>} plugins
 * @param {Record<string, boolean>} [userState] 用户开关状态（userData/plugin-state.json）
 * @returns {string}
 */
function renderActivationPatch(plugins, userState = {}, disableEntryIds = []) {
  return renderPatchFor(plugins.filter((plugin) => isPluginEnabled(plugin, userState)), disableEntryIds);
}

/**
 * 把**已经选定**的插件渲染成 overlay 文本。选谁是调用方的事，这里不再过滤——
 * 正常启动按用户开关选，安全模式按 `safeMode` 标记选，两条路选完都到这儿。
 *
 * 第二个参数是**要停用的 profile 层 entry id**。A2 插件的「关掉」等于不生成它的
 * `- insert:`（我们自己是插入方，不插就是关）；profile 层（A1）插件是自己插自己的
 * 第 2 层条目，我们插不了也删不掉，只能从第 4 层压一条 `disabled: true` 上去。
 * 同一个「停用」在两层是两种写法，这是分层带来的，不是设计冗余。
 *
 * **调用方必须保证这些 id 真实存在**：dsh 自己给遥测生成 disable 补丁时也先查了
 * `hasRow`，说明 patch 一个不存在的 id 不是安全操作。
 *
 * @param {Array<{packageName: string, entryId: string}>} selected
 * @param {string[]} [disableEntryIds] profile 层要停用的 entry id
 * @returns {string}
 */
function renderPatchFor(selected, disableEntryIds = []) {
  const rows = selected
    .map((plugin) => `    - id: ${plugin.entryId}\n      name: '${plugin.packageName}'\n`);
  const insert = rows.length ? `- insert:\n${rows.join('')}` : '';
  const disables = disableEntryIds.map((id) => `- id: ${id}\n  disabled: true\n`).join('');
  const body = `${insert}${disables}`;
  // 两段都空时输出合法的空 YAML 列表 `[]`，不能是空文件——否则 dsh 解析 patch
  // 时直接报错。迁移之后这是**常态**：A2 清单已空，没人被停用时 body 就是空的。
  return '# 由 dsDesktop 生成，请勿手改；插件清单见 plugins/plugins.json。\n'
    + (body.length ? body : '[]\n');
}

/**
 * 把 overlay 写到 patchPath（内容确定、幂等）。启动路径与热更新自检都调它，
 * 两处共用同一份内容 —— 同一份配置两个写者迟早会不一致。
 *
 * @param {string} patchPath
 * @param {Array<{packageName: string, entryId: string, enabled?: boolean, safeMode?: boolean}>} plugins
 * @param {Record<string, boolean>} [userState]
 * @param {string[]} [disableEntryIds] profile 层要停用的 entry id（见 renderPatchFor）
 * @returns {string} patchPath
 */
function writeActivationPatch(patchPath, plugins, userState, disableEntryIds = []) {
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, renderActivationPatch(plugins, userState, disableEntryIds), 'utf8');
  return patchPath;
}

/**
 * 写安全模式的激活 overlay：只留清单里标了 `safeMode` 的插件。
 *
 * **完全绕开开关判定**（用户状态与清单 `enabled` 都不看）：安全模式的插件集
 * 在 `safeModePlugins` 那一步就已经选定，再过一遍开关只可能把恢复入口也滤掉
 * —— 而这个功能恰恰是在「开关状态可能有问题」时用的：状态文件被手改坏、
 * 或恢复入口自己被关掉，逃生舱就进不去了。
 *
 * **profile 层（A1）的插件要主动 disable**，这是第二件事，不能只靠「不生成 insert」：
 * 那些插件是自己 insert 自己的第 2 层条目的，我们不生成它、也就关不掉它。不 disable
 * 的话，用户从市场装的插件把内核搞崩时安全模式救不了他——它在安全模式下照样加载。
 * 要 disable 哪些由调用方算好传进来（见 profile-plugins.js 的 profileBundleEntryIds），
 * 这里只负责渲染：这个模块不该去认识 profile 目录长什么样。
 *
 * @param {string} patchPath
 * @param {Array<{packageName: string, entryId: string, enabled?: boolean, safeMode?: boolean}>} plugins
 * @param {string[]} [disableEntryIds] 要额外 disable 的 loader entry id（profile 层插件）
 * @returns {string} patchPath
 */
function writeSafeModePatch(patchPath, plugins, disableEntryIds = []) {
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, renderSafeModePatch(safeModePlugins(plugins), disableEntryIds), 'utf8');
  return patchPath;
}

/**
 * 渲染安全模式的 patch：安全插件的 `- insert:` + profile 层插件的 disable 条目。
 *
 * 两段都可能为空。**全空时必须输出 `[]`**，不能是空文件——dsh 解析 patch 会直接报错，
 * 而那正好发生在用户最需要安全模式的时候。
 */
function renderSafeModePatch(selected, disableEntryIds) {
  const insertRows = selected
    .map((plugin) => `    - id: ${plugin.entryId}\n      name: '${plugin.packageName}'\n`);
  const insert = insertRows.length ? `- insert:\n${insertRows.join('')}` : '';
  const disables = (disableEntryIds ?? [])
    .map((id) => `- id: ${id}\n  disabled: true\n`)
    .join('');
  const body = `${insert}${disables}`;
  return '# 由 dsDesktop 生成（安全模式），请勿手改。\n' + (body.length ? body : '[]\n');
}

/**
 * 我们**曾经**用过、现在已经不用的插件包名。
 *
 * 拆仓之前四个通用插件挂在上游的 `@deepseek-ai` scope 下（那本来就是不该占的
 * 命名空间）。改名之后旧包并不会自己消失：`installPlugin` 只做「拷贝 + 登记」，
 * 而全局 dsh 是个长期存在、被反复写入的安装目录，旧包名就一直留在它的
 * node_modules 与 dependencies 里，再被 `prepare-kernel` 的整目录 cpSync 一路
 * 搭车带进出厂内核。不会出错（overlay 里写的是新名字，它们永远不被激活），但会
 * 白白进安装包，还让 healProfilesModuleFallback 多建一批无用软链。
 */
const LEGACY_PLUGIN_NAMES = [
  '@deepseek-ai/dsh-git',
  '@deepseek-ai/dsh-ui-balance',
  '@deepseek-ai/dsh-terminal-panel',
  '@deepseek-ai/dsh-reveal-explorer',
];

/**
 * 我们在目标 dsh 的 package.json 里留的「装过哪些插件」账本。
 *
 * 为什么需要它：清理遗留插件要回答「这个包是不是我们装的」，而这个判断的输出会
 * 被拿去 `rmSync`。原先靠启发式猜——裸包名 + `dsh-` 前缀，理由是上游的包全在
 * `@deepseek-ai` scope 下。这个理由对上游成立，对**用户**不成立：dsh 插件生态起
 * 来之后，用户完全可能自己 `dsh plugin add` 一个叫 `dsh-foo` 的第三方插件到同一
 * 个全局 dsh 里，然后被我们当「遗留」删掉。我们自己就在发四个 `dsh-` 开头的插件，
 * 等于亲手把这个命名空间做热了。
 *
 * 记账取代猜测：装过什么就写下什么，清理只动账本上的名字。
 */
const PLUGIN_LEDGER_KEY = 'dsDesktopPlugins';

/**
 * 读账本；返回 null 表示这个 dsh 还没有账本（本次改动之前装的），调用方需要走
 * 一次性的迁移路径。
 * @param {any} manifest
 * @returns {string[]|null}
 */
function readPluginLedger(manifest) {
  const value = manifest?.[PLUGIN_LEDGER_KEY];
  if (!Array.isArray(value)) return null;
  return value.filter((name) => typeof name === 'string' && name.length > 0);
}

/**
 * 仅用于**迁移**：账本还不存在时，用旧的启发式认领一次历史遗留，认完就把账本写
 * 上，之后再不会走到这里。保守判据同旧实现：明确列举的旧名，或裸包名 + `dsh-`
 * 前缀（上游的包全在 `@deepseek-ai` scope 下，对上游不会误伤）。
 * @param {string} name
 */
function isOwnPluginName(name) {
  if (LEGACY_PLUGIN_NAMES.includes(name)) return true;
  return !name.startsWith('@') && name.startsWith('dsh-');
}

/**
 * 清掉「我们装过、但已经不在清单里」的插件：从目标 node_modules 删目录，并从
 * dsh 的 package.json dependencies 里摘掉登记。
 *
 * 只在构建期（scripts/install-plugin.mjs，写的是长期存在的全局 dsh）需要。
 * 热更新那条路不用：`kernel-updater` 每次都是 pnpm 装一个全新的 staging 目录，
 * 里面不可能有上一轮的残留。
 *
 * @param {object} opts
 * @param {string} opts.nodeModulesDir
 * @param {string} opts.manifestPath   dsh 的 package.json
 * @param {Array<{packageName: string}>} opts.plugins 当前清单
 * @param {Logger} [opts.logger]
 * @returns {string[]} 被清掉的包名
 */
function cleanupLegacyPlugins({ nodeModulesDir, manifestPath, plugins, logger = console }) {
  const keep = new Set(plugins.map((p) => p.packageName));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const deps = manifest.dependencies ?? {};

  const ledger = readPluginLedger(manifest);
  /** @type {Set<string>} */
  const candidates = new Set();

  // 改名前的旧包（`@deepseek-ai/*`）在账本诞生之前就存在，两条路径都要认领：
  // 它们是明确列举的、只增不猜的名字，认了不会误伤。
  for (const name of LEGACY_PLUGIN_NAMES) {
    if (fs.existsSync(path.join(nodeModulesDir, ...name.split('/'))) || name in deps) {
      candidates.add(name);
    }
  }

  if (ledger) {
    // 常规路径：除了上面的旧名，只认账本。上游的包、用户自己装的第三方 dsh 插件
    // 都不在账本上，因此**结构上**不可能被我们删掉 —— 这正是从启发式换成记账
    // 要买的东西。
    for (const name of ledger) candidates.add(name);
  } else {
    // 一次性迁移：这个 dsh 是本次改动之前装的，没有账本。用旧的启发式认领一次
    // 历史遗留，末尾把账本写上，之后就走上面那条路了。
    //
    // 候选取**两处**，缺一不可：只看 dependencies 会漏掉「登记已摘、目录还在」
    // 的孤儿（清理中途被打断就会留下），而那正是要清的东西；只看目录则拿不到登记。
    for (const name of Object.keys(deps)) {
      if (isOwnPluginName(name)) candidates.add(name);
    }
    if (fs.existsSync(nodeModulesDir)) {
      // 顶层只可能是裸包名（scoped 的在 @scope/ 子目录里）。
      for (const entry of fs.readdirSync(nodeModulesDir)) {
        if (isOwnPluginName(entry)) candidates.add(entry);
      }
    }
  }

  const stale = [...candidates].filter((name) => !keep.has(name));

  let changed = false;
  for (const name of stale) {
    if (name in deps) {
      delete deps[name];
      changed = true;
    }
    fs.rmSync(path.join(nodeModulesDir, ...name.split('/')), { recursive: true, force: true });
    logger.log(`[plugin] 已清理遗留插件: ${name}`);
  }

  // 账本永远写成「当前清单」，与本次实际装进去的一致。即使没清理出东西也要写：
  // 迁移那一趟必须留下账本，否则下次又走启发式。
  const nextLedger = [...keep].sort();
  const prevLedger = ledger ? [...ledger].sort() : null;
  if (prevLedger === null || prevLedger.join('\0') !== nextLedger.join('\0')) {
    manifest[PLUGIN_LEDGER_KEY] = nextLedger;
    changed = true;
  }
  if (changed) {
    manifest.dependencies = deps;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  return stale;
}

/**
 * 2) 登记进 dsh 的 package.json dependencies（幂等）。返回是否真的写入。
 *
 * 版本号不同要**改写**而不是跳过：copyPluginSource 每次都会覆盖成最新源码，
 * 登记若停在旧号，全局 dsh 的 package.json 就会长期写着 v0.1.1、实际躺着
 * v0.2.2。运行时不读这个号（healProfilesModuleFallback 只看 key），所以不会
 * 出错——但它是排查问题时第一个会去看的地方，一个会骗人的状态比没有更糟。
 */
function registerDependency(manifestPath, packageName, version) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.dependencies ??= {};
  if (manifest.dependencies[packageName] === version) return false;
  manifest.dependencies[packageName] = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return true;
}

/**
 * 安装一个插件：拷贝源码 + 登记依赖。激活不在这里 —— 那是启动时 `--patch`
 * overlay 的事（见文件头注释）。被用户关掉的插件也照样装：登记依赖是
 * healProfilesModuleFallback 的输入，随意摘除会引入新的解析失败面，而且重新
 * 打开时不需要再装一次。
 *
 * @param {object} opts
 * @param {string} opts.pluginSrcDir   插件源码目录
 * @param {string} opts.nodeModulesDir 目标 node_modules（dsh 能从这里解析到插件）
 * @param {string} opts.manifestPath   dsh 的 package.json 路径
 * @param {string} [opts.expectedName] 清单里声明的包名；与插件 package.json 的
 *   name 不一致时报错——激活条目的 name 来自清单，两边不一致等于激活了一个
 *   不存在的模块，内核 boot 时秒退，必须在装的时候就拦下。
 * @param {Logger} [opts.logger]
 */
function installPlugin(opts) {
  const { pluginSrcDir, nodeModulesDir, manifestPath, expectedName, logger = console } = opts;

  if (!fs.existsSync(pluginSrcDir)) {
    throw new Error(`未找到插件源码: ${pluginSrcDir}`);
  }
  const { packageName, version } = readPluginPackage(pluginSrcDir);
  if (expectedName !== undefined && packageName !== expectedName) {
    throw new Error(
      `清单 packageName（${expectedName}）与插件 package.json 的 name（${packageName}）不一致: ${pluginSrcDir}`
    );
  }

  const dst = copyPluginSource(pluginSrcDir, nodeModulesDir, packageName);
  logger.log(`[plugin] 已拷贝: ${dst}`);

  const wrote = registerDependency(manifestPath, packageName, version);
  logger.log(wrote
    ? `[plugin] 已登记依赖 ${packageName}@${version}`
    : `[plugin] 依赖 ${packageName}@${version} 已是最新登记，跳过`);

  return { packageName, version };
}

module.exports = {
  PLUGIN_LEDGER_KEY,
  loadPluginManifest,
  vendoredPluginNames,
  readPluginPackage,
  resolvePluginSrcDir,
  copyPluginSource,
  copyPluginTree,
  PLUGIN_COPY_EXCLUDE,
  renderActivationPatch,
  writeActivationPatch,
  writeSafeModePatch,
  cleanupLegacyPlugins,
  registerDependency,
  installPlugin,
};
