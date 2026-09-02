// 把 profile 层插件打成 tarball，连同索引摊到 plugins-dist/profile/，
// 由 electron-builder 的 extraResources 一起进包（resources/plugins/profile/）。
//
// 为什么是 tarball 而不是像 A2 那样铺源码目录：这些插件是要用**包管理器**装进用户
// profile 的（`dsh plugin add <tgz>`，它转发给 pnpm 并顺手 reconcile
// `dsh.profile.bundles`）。给 pnpm 一个目录它会建链接、给它一个 tarball 它才会
// 真正安装成一份独立的包 —— 而我们要的正是后者：用户的 profile 不该链回应用的
// 安装目录，否则卸载应用就把插件也带走了。
//
// 为什么不让它去 npm 拉：**首次启动必须离线可用**。发行包里躺着 tgz，装的时候不需要
// 网络，也不会因为 registry 抽风或包被 unpublish 而拿不到。
//
// 版本号取自被打包插件自己的 package.json，不在清单里手写第二遍 —— 手写那份迟早和
// 真实产物对不上，而启动时的对账正是拿它当「期望」的。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfilePluginManifest, resolvePluginSrcDir } from '../src/shared/profile-plugins.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginsDir = join(root, 'plugins');
const nodeModulesDir = join(root, 'node_modules');
const outDir = join(root, 'plugins-dist', 'profile');

const plugins = loadProfilePluginManifest(pluginsDir);
if (plugins.length === 0) {
  console.log('[pack-profile-plugins] 清单为空，跳过');
  process.exit(0);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const index = [];
for (const { packageName, required } of plugins) {
  const srcDir = resolvePluginSrcDir({ nodeModulesDir, packageName });
  const pkg = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`[pack-profile-plugins] ${packageName} 的 package.json 没有 version`);
  }

  // `npm pack` 而不是自己 tar：打包范围由插件自己的 `files` 字段说了算，和别人
  // `npm install` 装到的内容完全一致。自己打包意味着又多一处「该收哪些文件」的判断，
  // 而它和插件仓库里的那处迟早会分叉。
  const before = new Set(readdirSync(outDir));
  execFileSync('npm', ['pack', '--pack-destination', outDir], {
    cwd: srcDir,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });
  const produced = readdirSync(outDir).filter((name) => !before.has(name) && name.endsWith('.tgz'));
  if (produced.length !== 1) {
    throw new Error(`[pack-profile-plugins] ${packageName} 期望产出 1 个 tgz，实际 ${produced.length} 个`);
  }
  const tarball = produced[0];
  const bytes = statSync(join(outDir, tarball)).size;
  // required 原样带进索引：它是清单里的声明，运行期对账要用（见 planProfileReconcile）。
  index.push({ packageName, version, tarball, required: required === true });
  console.log(`[pack-profile-plugins] ${packageName}@${version} → ${tarball}（${(bytes / 1024).toFixed(1)} KB）`);
}

writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`[pack-profile-plugins] 完成，${index.length} 个插件`);
