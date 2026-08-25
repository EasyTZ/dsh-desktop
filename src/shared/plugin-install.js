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

/** @typedef {{ log: (...args: any[]) => void, warn: (...args: any[]) => void }} Logger */

const fs = require('node:fs');
const path = require('node:path');

/** 读插件清单 plugins.json（单一数据源）。 */
function loadPluginManifest(pluginsDir) {
  const manifestPath = path.join(pluginsDir, 'plugins.json');
  const plugins = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(plugins)) {
    throw new Error(`plugins.json 必须是数组: ${manifestPath}`);
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

/** 在若干候选位置里找出第一个存在的 bundle patch；都不存在返回 null。 */
function findExistingPath(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/** 1) 拷贝插件源码到目标 node_modules。 */
function copyPluginSource(pluginSrcDir, nodeModulesDir, packageName) {
  const dst = path.join(nodeModulesDir, ...packageName.split('/'));
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(pluginSrcDir, dst, { recursive: true });
  return dst;
}

/**
 * 生成 `--patch` overlay 的内容：把清单里每个插件变成一条 `- insert:` 激活条目。
 *
 * 这是「装插件」与「激活插件」分家之后，激活那一半的唯一实现。overlay 作用在
 * 发行包自带的 bundle 层之上，效果与过去直接改 bundle 等价（`--dump-config`
 * 比对过，合成树逐行一致）。
 *
 * @param {string} pluginsDir
 * @param {Array<{srcDir: string, entryId: string}>} plugins
 * @returns {string}
 */
function renderActivationPatch(pluginsDir, plugins) {
  const rows = plugins.map((plugin) => {
    const { packageName } = readPluginPackage(path.join(pluginsDir, plugin.srcDir));
    return `    - id: ${plugin.entryId}\n      name: '${packageName}'\n`;
  });
  return '# 由 dsDesktop 生成，请勿手改；插件清单见 plugins/plugins.json。\n'
    + (rows.length ? `- insert:\n${rows.join('')}` : '[]\n');
}

/**
 * 把 overlay 写到 patchPath（内容确定、幂等）。启动路径与热更新自检都调它，
 * 两处共用同一份内容 —— 同一份配置两个写者迟早会不一致。
 *
 * @param {string} patchPath
 * @param {string} pluginsDir
 * @param {Array<{srcDir: string, entryId: string}>} plugins
 * @returns {string} patchPath
 */
function writeActivationPatch(patchPath, pluginsDir, plugins) {
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, renderActivationPatch(pluginsDir, plugins), 'utf8');
  return patchPath;
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
 * overlay 的事（见文件头注释）。
 *
 * @param {object} opts
 * @param {string} opts.pluginSrcDir   插件源码目录
 * @param {string} opts.nodeModulesDir 目标 node_modules（dsh 能从这里解析到插件）
 * @param {string} opts.manifestPath   dsh 的 package.json 路径
 * @param {Logger} [opts.logger]
 */
function installPlugin(opts) {
  const { pluginSrcDir, nodeModulesDir, manifestPath, logger = console } = opts;

  if (!fs.existsSync(pluginSrcDir)) {
    throw new Error(`未找到插件源码: ${pluginSrcDir}`);
  }
  const { packageName, version } = readPluginPackage(pluginSrcDir);

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
  findExistingPath,
  copyPluginSource,
  renderActivationPatch,
  writeActivationPatch,
  registerDependency,
  installPlugin,
};
