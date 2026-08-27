// 把自定义插件安装到「开发态 dsh」的依赖树：拷贝源码 + 登记依赖。
//
// 实现在 src/shared/plugin-install.js，与运行期热更新（src/main/kernel-updater.js）
// 共用同一份代码 —— 两条路径曾经各写一份，结果漏了「登记依赖」这步，导致 v1.1.1
// 的黑屏事故。
//
// 激活不在这里做：插件的 `- insert:` 条目由启动时的 `--patch` overlay 提供，发行包
// 自带的 cordis.patch.yml 保持原样。
//
// 源码位置（拆仓后）：plugins/<packageName> 是随仓库走的桌面专属插件，
// node_modules/<packageName> 是 git 依赖 vendor 进来的通用插件，resolvePluginSrcDir
// 统一解析 —— 所以本脚本前置除了全局 dsh，还需要先 npm install 拉下插件依赖。
//
// 顺序提醒：本脚本必须先于 prepare-kernel 执行。prepare-kernel 是整目录拷贝全局
// dsh 安装目录，插件源码与依赖登记是搭这趟车进入内核的。
//
// 另外：本脚本改的是本机全局 dsh 安装目录，每次 `npm install -g @deepseek-ai/dsh`
// 升级后都要重跑一次，否则改动会被新版本覆盖丢失。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDshInstallSync } from '../src/shared/dsh-locate.js';
import { loadPluginManifest, installPlugin, resolvePluginSrcDir } from '../src/shared/plugin-install.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginsDir = join(root, 'plugins');
const nodeModulesDir = join(root, 'node_modules');
const installDir = findDshInstallSync();

console.log(`[install-plugin] dsh: ${installDir}`);

const plugins = loadPluginManifest(pluginsDir);

let failed = false;
for (const plugin of plugins) {
  try {
    installPlugin({
      pluginSrcDir: resolvePluginSrcDir({ pluginsDir, nodeModulesDir, packageName: plugin.packageName }),
      nodeModulesDir: join(installDir, 'node_modules'),
      manifestPath: join(installDir, 'package.json'),
      expectedName: plugin.packageName,
    });
  } catch (error) {
    console.error(`[install-plugin] ${plugin.packageName} 安装失败:`, error?.message ?? error);
    failed = true;
  }
}

console.log(failed ? '[install-plugin] 完成（存在失败项）' : '[install-plugin] 完成');
if (failed) process.exit(1);
