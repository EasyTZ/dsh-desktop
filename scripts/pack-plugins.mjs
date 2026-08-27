// 把全部自定义插件源码 + 清单摊到 plugins-dist/，交给 electron-builder 的
// extraResources 打进安装包（resources/plugins/）。
//
// 为什么需要这一步（拆仓后）：插件源码不再全在 plugins/ 下——四个通用插件在
// 仓库 node_modules 里（git 依赖 vendor），桌面专属插件在 plugins/ 里。运行期
// 热更新重装插件依赖的就是这份打进包的源码，所以必须把它摊平到与「运行期
// 期望」一致的布局：resources/plugins/<packageName>/ + plugins.json。
//
// 与 pack-kernel 的关系：kernel 走 tar.gz 单文件（文件数决定解压耗时），插件
// 一共几十个文件，直接铺目录即可，没有打包成归档的必要。
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyPluginTree, loadPluginManifest, resolvePluginSrcDir } from '../src/shared/plugin-install.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginsDir = join(root, 'plugins');
const nodeModulesDir = join(root, 'node_modules');
const outDir = join(root, 'plugins-dist');

const plugins = loadPluginManifest(pluginsDir);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(pluginsDir, 'plugins.json'), join(outDir, 'plugins.json'));

let files = 0;
let bytes = 0;
/** @param {string} dir */
function measure(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) measure(full);
    else if (entry.isFile()) {
      files += 1;
      bytes += statSync(full).size;
    }
  }
}

for (const plugin of plugins) {
  const src = resolvePluginSrcDir({ pluginsDir, nodeModulesDir, packageName: plugin.packageName });
  // 与装进内核那条路用同一个拷贝实现：跟随符号链接拷实体（联调时 node_modules
  // 里是链接，摊进安装包的必须是实体文件），并跳过 test/ .github/ 这类不参与运行
  // 的目录 —— 拆仓后插件仓库有了自己的测试与 CI，不挡就会跟着进安装包。
  copyPluginTree(src, join(outDir, plugin.packageName));
  measure(join(outDir, plugin.packageName));
  console.log(`[pack-plugins] ${plugin.packageName} <- ${src}`);
}

console.log(`[pack-plugins] 完成：${plugins.length} 个插件、${files} 个文件、${(bytes / 1024).toFixed(1)} KB`);
