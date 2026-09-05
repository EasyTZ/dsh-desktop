// 打包后整理最终产物：把安装包与 zip 绿色版复制到 release/，与中间产物分开。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const releaseDir = join(root, 'release');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

if (!existsSync(distDir)) {
  console.error('[collect-release] 未找到 dist 目录，请先执行 electron-builder');
  process.exit(1);
}

const files = readdirSync(distDir);
// 按当前版本精确匹配，避免 dist 里残留的旧版本产物被误选。
// 每个平台每次只会产出自己那一套（CI 上 Windows job 和 Linux job 各自独立跑
// electron-builder，不会同时出现），所以每种都是「有就收，没有就跳过」，不像
// setup 曾经那样是唯一的硬性必需项。
const setup = files.find((f) => /^DeepSeek-Harness-Desktop-Setup-.*\.exe$/.test(f) && f.endsWith(`-${version}.exe`));
const zip = files.find((f) => f.endsWith(`-${version}-win.zip`));
const appImage = files.find((f) => f.endsWith(`-${version}.AppImage`));

if (!setup && !appImage) {
  console.error('[collect-release] 未找到任何已知产物（Windows 安装包 / AppImage）');
  process.exit(1);
}

rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

if (setup) cpSync(join(distDir, setup), join(releaseDir, `DeepSeek-Harness-Desktop-Setup-${version}.exe`));
if (zip) cpSync(join(distDir, zip), join(releaseDir, `DeepSeek-Harness-Desktop-Portable-${version}.zip`));
if (appImage) cpSync(join(distDir, appImage), join(releaseDir, `DeepSeek-Harness-Desktop-${version}.AppImage`));

console.log('[collect-release] 完成，产物：');
for (const f of readdirSync(releaseDir)) {
  console.log(`  - ${f}`);
}

// 把这次打进包的内核版本再报一次。产物文件名上只有应用版本号，而内核是独立
// 升级的另一条线 —— 发布说明里要写「内置内核 x.y.z」，这里是最后一次能顺手拿到
// 这个号的地方，不必事后去扒 asar。
const kernelPkg = join(root, 'kernel', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
if (existsSync(kernelPkg)) {
  console.log(`\n[collect-release] 本次内置内核：dsh ${JSON.parse(readFileSync(kernelPkg, 'utf8')).version}`);
}
