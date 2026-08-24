// 把自定义插件安装到「开发态 dsh」（默认 D:\nodejs）的依赖树，并追加 bundle 激活。
// 这样开发态（dsh web / npm start）能加载插件；prepare-kernel 打包时把整个 dsh 目录
// 拷进内核，插件与激活条目随之自动进入 release —— 开发态先有、打包后有，顺序正确。
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function findDshInstall() {
  if (process.env.DSH_INSTALL_DIR && existsSync(process.env.DSH_INSTALL_DIR)) {
    return process.env.DSH_INSTALL_DIR;
  }
  const candidates = [];
  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true, shell: true }).trim();
    if (npmRoot) candidates.push(join(npmRoot, '@deepseek-ai', 'dsh'));
  } catch {}
  candidates.push(
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    'D:\\nodejs\\node_modules\\@deepseek-ai\\dsh',
    'C:\\Program Files\\nodejs\\node_modules\\@deepseek-ai\\dsh',
  );
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error('找不到 dsh 安装目录，请设置 DSH_INSTALL_DIR 指向 @deepseek-ai/dsh 包目录');
}

const installDir = findDshInstall();
const pluginSrc = join(root, 'plugins', 'dsh-ui-balance');
const pluginDst = join(installDir, 'node_modules', '@deepseek-ai', 'dsh-ui-balance');

if (!existsSync(pluginSrc)) {
  console.error(`[install-plugin] 未找到插件源码 ${pluginSrc}`);
  process.exit(1);
}

// 1. 拷贝插件到 dsh 依赖树。
rmSync(pluginDst, { recursive: true, force: true });
cpSync(pluginSrc, pluginDst, { recursive: true });
console.log(`[install-plugin] 插件已装入: ${pluginDst}`);

// 2. 在 dsh-web-app 的 bundle patch 末尾追加 balance 激活条目。
const webAppPatch = join(installDir, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'cordis.patch.yml');
if (existsSync(webAppPatch)) {
  let text = readFileSync(webAppPatch, 'utf8');
  if (!text.includes('id: balance')) {
    text += "\n- insert:\n    - id: balance\n      name: '@deepseek-ai/dsh-ui-balance'\n";
    writeFileSync(webAppPatch, text, 'utf8');
    console.log('[install-plugin] 已在 dsh-web-app patch 追加 balance 激活条目');
  } else {
    console.log('[install-plugin] balance 激活条目已存在，跳过');
  }
}

// 3. 把插件登记进 dsh 的 package.json dependencies。
// 运行时 dsh 会执行 healProfilesModuleFallback：遍历安装包 dependencies 闭包，
// 在 $DSH_HOME/profiles/node_modules 为每个包建解析 symlink，web profile 的
// balance 条目才能从 profile 目录解析到该插件。若只拷 node_modules 而不登记，
// 依赖闭包不包含它，dsh web 启动 import 该模块即 ERR_MODULE_NOT_FOUND、进程
// 立即退出——桌面端表现为闪屏黑屏卡死、无任何提示。
const dshManifestPath = join(installDir, 'package.json');
const dshManifest = JSON.parse(readFileSync(dshManifestPath, 'utf8'));
const pluginVersion = JSON.parse(readFileSync(join(pluginSrc, 'package.json'), 'utf8')).version;
dshManifest.dependencies ??= {};
if (dshManifest.dependencies['@deepseek-ai/dsh-ui-balance'] === void 0) {
  dshManifest.dependencies['@deepseek-ai/dsh-ui-balance'] = pluginVersion;
  writeFileSync(dshManifestPath, JSON.stringify(dshManifest, null, 2) + '\n');
  console.log(`[install-plugin] 已在 dsh package.json 登记依赖 @deepseek-ai/dsh-ui-balance@${pluginVersion}`);
} else {
  console.log('[install-plugin] dsh package.json 已登记 dsh-ui-balance 依赖，跳过');
}

console.log('[install-plugin] 完成');
