// 把自定义插件安装到「开发态 dsh」（默认 D:\nodejs）的依赖树，并追加 bundle 激活。
// 这样开发态（dsh web / npm start）能加载插件；prepare-kernel 打包时把整个 dsh 目录
// 拷进内核，插件与激活条目随之自动进入 release —— 开发态先有、打包后有，顺序正确。
//
// 每个插件必须做满三件事，缺一不可（否则内核启动即失败，桌面端表现为黑屏卡死）：
//   1) 拷贝插件源码到 dsh 的 node_modules；
//   2) 在目标 bundle patch 末尾追加激活条目（id + name）；
//   3) 把插件登记进 dsh 的 package.json dependencies —— 这是关键：dsh 运行时靠
//      healProfilesModuleFallback 遍历依赖闭包、在 $DSH_HOME/profiles/node_modules
//      为每个包建解析 symlink；不登记则依赖闭包不含它，模块从 profile 目录解析不到。
//
// 新增插件：只需在下方 PLUGINS 清单加一项，以上三件事全自动完成，不会漏登记依赖。
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 自定义插件清单（相对仓库根）。
//   srcDir    插件源码目录；
//   patchFile 要追加激活条目的 bundle patch（相对 dsh 安装目录）；
//   entryId   激活条目的 id（同一 patch 内须唯一）。
const PLUGINS = [
  {
    srcDir: 'plugins/dsh-ui-balance',
    patchFile: 'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml',
    entryId: 'balance',
  },
];

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

/** 安装单个插件，返回是否成功；做满「拷贝 / 激活 / 登记依赖」三件事。 */
function installPlugin(installDir, plugin) {
  const pluginSrc = join(root, plugin.srcDir);
  if (!existsSync(pluginSrc)) {
    console.error(`[install-plugin] 未找到插件源码 ${pluginSrc}`);
    return false;
  }
  const pkg = JSON.parse(readFileSync(join(pluginSrc, 'package.json'), 'utf8'));
  const packageName = pkg.name;
  if (typeof packageName !== 'string' || packageName.length === 0) {
    console.error(`[install-plugin] ${plugin.srcDir}/package.json 缺少 name 字段`);
    return false;
  }
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';

  // 1) 拷贝插件源码到 dsh 依赖树。
  const pluginDst = join(installDir, 'node_modules', ...packageName.split('/'));
  rmSync(pluginDst, { recursive: true, force: true });
  cpSync(pluginSrc, pluginDst, { recursive: true });
  console.log(`[install-plugin] 插件已装入: ${pluginDst}`);

  // 2) 追加 bundle 激活条目（按 entry id 幂等判断）。
  const patchPath = join(installDir, plugin.patchFile);
  if (!existsSync(patchPath)) {
    console.error(`[install-plugin] 未找到目标 bundle patch: ${patchPath}`);
    return false;
  }
  let text = readFileSync(patchPath, 'utf8');
  if (!text.includes(`id: ${plugin.entryId}`)) {
    text += `\n- insert:\n    - id: ${plugin.entryId}\n      name: '${packageName}'\n`;
    writeFileSync(patchPath, text, 'utf8');
    console.log(`[install-plugin] 已在 ${plugin.patchFile} 追加 ${plugin.entryId} 激活条目`);
  } else {
    console.log(`[install-plugin] ${plugin.entryId} 激活条目已存在，跳过`);
  }

  // 3) 登记进 dsh 的 package.json dependencies（幂等）。
  const dshManifestPath = join(installDir, 'package.json');
  const dshManifest = JSON.parse(readFileSync(dshManifestPath, 'utf8'));
  dshManifest.dependencies ??= {};
  if (dshManifest.dependencies[packageName] === void 0) {
    dshManifest.dependencies[packageName] = version;
    writeFileSync(dshManifestPath, JSON.stringify(dshManifest, null, 2) + '\n');
    console.log(`[install-plugin] 已在 dsh package.json 登记依赖 ${packageName}@${version}`);
  } else {
    console.log(`[install-plugin] dsh package.json 已登记 ${packageName} 依赖，跳过`);
  }
  return true;
}

const installDir = findDshInstall();
let failed = false;
for (const plugin of PLUGINS) {
  if (!installPlugin(installDir, plugin)) failed = true;
}
console.log(failed ? '[install-plugin] 完成（存在失败项）' : '[install-plugin] 完成');
if (failed) process.exit(1);
