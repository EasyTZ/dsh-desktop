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
  for (const plugin of plugins) {
    if (typeof plugin?.packageName !== 'string' || plugin.packageName.length === 0) {
      throw new Error(`plugins.json 条目缺少 packageName: ${JSON.stringify(plugin)}`);
    }
    if (typeof plugin?.entryId !== 'string' || plugin.entryId.length === 0) {
      throw new Error(`plugins.json 条目缺少 entryId: ${JSON.stringify(plugin)}`);
    }
  }
  return plugins;
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

/** 1) 拷贝插件源码到目标 node_modules。 */
function copyPluginSource(pluginSrcDir, nodeModulesDir, packageName) {
  const dst = path.join(nodeModulesDir, ...packageName.split('/'));
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  // dereference：本地联调常用 npm link / file: 协议把 node_modules 指到插件仓库的
  // 工作副本，源码目录会是符号链接；cpSync 默认把链接原样复制过去，内核拿到一个
  // 断链。跟随链接拷实体，两种开发方式都不踩坑。
  fs.cpSync(pluginSrcDir, dst, { recursive: true, dereference: true });
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
function renderActivationPatch(plugins, userState = {}) {
  return renderPatchFor(plugins.filter((plugin) => isPluginEnabled(plugin, userState)));
}

/**
 * 把**已经选定**的插件渲染成 overlay 文本。选谁是调用方的事，这里不再过滤——
 * 正常启动按用户开关选，安全模式按 `safeMode` 标记选，两条路选完都到这儿。
 * @param {Array<{packageName: string, entryId: string}>} selected
 * @returns {string}
 */
function renderPatchFor(selected) {
  const rows = selected
    .map((plugin) => `    - id: ${plugin.entryId}\n      name: '${plugin.packageName}'\n`);
  // 空清单（或全部被关掉）时输出合法的空 YAML 列表 `[]`，不能是空文件——
  // 否则 dsh 解析 patch 时直接报错。
  return '# 由 dsDesktop 生成，请勿手改；插件清单见 plugins/plugins.json。\n'
    + (rows.length ? `- insert:\n${rows.join('')}` : '[]\n');
}

/**
 * 把 overlay 写到 patchPath（内容确定、幂等）。启动路径与热更新自检都调它，
 * 两处共用同一份内容 —— 同一份配置两个写者迟早会不一致。
 *
 * @param {string} patchPath
 * @param {Array<{packageName: string, entryId: string, enabled?: boolean, safeMode?: boolean}>} plugins
 * @param {Record<string, boolean>} [userState]
 * @returns {string} patchPath
 */
function writeActivationPatch(patchPath, plugins, userState) {
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, renderActivationPatch(plugins, userState), 'utf8');
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
 * @param {string} patchPath
 * @param {Array<{packageName: string, entryId: string, enabled?: boolean, safeMode?: boolean}>} plugins
 * @returns {string} patchPath
 */
function writeSafeModePatch(patchPath, plugins) {
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, renderPatchFor(safeModePlugins(plugins)), 'utf8');
  return patchPath;
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
 * 判断一个依赖名是不是「我们装的插件」。两条判据都刻意保守 —— 这个函数的输出
 * 会被拿去删目录，误判一次就是把上游的包删掉、内核起不来：
 *
 *   1) 在 LEGACY_PLUGIN_NAMES 里（明确列举，只增不猜）；
 *   2) 裸包名且以 `dsh-` 开头 —— 上游的包**全部**在 `@deepseek-ai` scope 下，
 *      它的非 scoped 依赖只有 commander / js-yaml / node-addon-require-builtin，
 *      没有任何 `dsh-` 开头的，所以这条不会误伤。
 *
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

  // 候选来自**两处**，缺一不可：
  //   - dependencies 的登记项
  //   - node_modules 里实际存在的目录
  // 只看登记会漏掉「登记已摘、目录还在」的孤儿（清理中途失败，或先摘登记再删
  // 目录时被打断都会留下），而那正是我们要清的东西；只看目录则拿不到登记。
  const candidates = new Set(Object.keys(deps).filter(isOwnPluginName));
  for (const name of LEGACY_PLUGIN_NAMES) {
    if (fs.existsSync(path.join(nodeModulesDir, ...name.split('/')))) candidates.add(name);
  }
  if (fs.existsSync(nodeModulesDir)) {
    // 顶层只可能是裸包名（scoped 的在 @scope/ 子目录里），isOwnPluginName 的
    // `dsh-` 前缀判据在这里同样安全：上游的包全在 @deepseek-ai scope 下。
    for (const entry of fs.readdirSync(nodeModulesDir)) {
      if (isOwnPluginName(entry)) candidates.add(entry);
    }
  }

  const stale = [...candidates].filter((name) => !keep.has(name));
  if (stale.length === 0) return [];

  let depsChanged = false;
  for (const name of stale) {
    if (name in deps) {
      delete deps[name];
      depsChanged = true;
    }
    fs.rmSync(path.join(nodeModulesDir, ...name.split('/')), { recursive: true, force: true });
    logger.log(`[plugin] 已清理遗留插件: ${name}`);
  }
  if (depsChanged) {
    manifest.dependencies = deps;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  return stale;
}

/** 2) 登记进 dsh 的 package.json dependencies（幂等）。返回是否真的写入。 */
function registerDependency(manifestPath, packageName, version) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.dependencies ??= {};
  if (manifest.dependencies[packageName] !== undefined) return false;
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
    : `[plugin] 依赖 ${packageName} 已登记，跳过`);

  return { packageName, version };
}

module.exports = {
  loadPluginManifest,
  readPluginPackage,
  resolvePluginSrcDir,
  copyPluginSource,
  renderActivationPatch,
  writeActivationPatch,
  writeSafeModePatch,
  cleanupLegacyPlugins,
  registerDependency,
  installPlugin,
};
