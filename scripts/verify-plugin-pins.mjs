// 发版闸门：插件源码必须来自钉住的 git tag，不能是联调用的本地链接。
//
// 为什么必须有这一步：install-plugin 与 pack-plugins 都带 dereference 拷贝，
// 处于联调模式时它们会把**工作副本当前的内容**摊进内核和安装包 —— 包括你还没
// 提交、没推送的改动。而 package.json / plugins.json / 内核依赖登记里的版本号
// 仍然写着 tag 的号。产物自称 v0.1.1，内容却和 GitHub 上的 v0.1.1 不是一回事，
// 事后既复现不了也追溯不了。
//
// 检查一个符号链接就够了：没链接就说明 node_modules 里那份是 npm 按 lockfile
// 从钉住的 commit 拉下来的，本身就可复现。
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vendoredPluginNames } from '../src/shared/plugin-install.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const plugins = vendoredPluginNames(root);

const linked = plugins.filter((name) => {
  const dir = join(root, 'node_modules', name);
  return existsSync(dir) && lstatSync(dir).isSymbolicLink();
});

if (linked.length > 0) {
  console.error('[verify-plugin-pins] 插件仍处于联调（link）模式：');
  for (const name of linked) console.error(`  - ${name}`);
  console.error('\n这样打出来的包会含入未提交的本地改动，版本号却是钉住的 tag，无法复现。');
  console.error('请先把插件改动提交 + 打 tag + push，再执行：');
  console.error('  npm run unlink-plugins   # 解除链接并按 pin 恢复');
  console.error('（若插件有新版本，记得先把 package.json 里的 #tag 升上去）');
  process.exit(1);
}

// 「不是链接」只证明那份来自 npm，不证明它来自一个**钉死的 tag**。这个脚本的名
// 字承诺的是后者：把依赖改成 `#main` 或干脆不带 ref，照样能过上面那关，而按分支
// 拉取意味着同一个 commit 在不同时间打出不同的包 —— 正是这个闸门要挡的事。
const BAD_REFS = new Set(['main', 'master', 'HEAD', 'latest']);
const badSpecs = [];
for (const name of plugins) {
  const spec = String(pkg.dependencies?.[name] ?? '');
  const hash = spec.indexOf('#');
  const ref = hash < 0 ? '' : spec.slice(hash + 1);
  if (ref.length === 0) {
    badSpecs.push(`${name}: 依赖没有钉任何 ref（${spec || '空'}）`);
  } else if (BAD_REFS.has(ref) || ref.startsWith('semver:')) {
    badSpecs.push(`${name}: 钉的是分支或范围而非固定 tag（#${ref}）`);
  }
}
if (badSpecs.length > 0) {
  console.error('[verify-plugin-pins] 插件依赖没有钉在固定 tag 上：');
  for (const line of badSpecs) console.error(`  - ${line}`);
  console.error('\n按分支拉取意味着同一个 commit 在不同时间打出不同的包。');
  console.error('请把 package.json 里对应依赖改成 `#v<版本号>` 形式的 tag。');
  process.exit(1);
}

console.log(`[verify-plugin-pins] ${plugins.length} 个插件均来自钉住的 tag，可以打包。`);
