// 强制把插件 git 依赖重新拉到 package.json 当前钉住的版本。
//
// 为什么需要这个而不是直接 `npm install`：npm 会缓存 git 依赖的解析结果，改了
// `#tag` 之后 `npm install` 经常**不重新拉**，装出来还是上一版——表现是「代码
// 明明改了、装完却没变化」，很容易被误当成插件本身的 bug 排查半天。删掉目录
// 再按显式 spec 装一次，能绕开这条缓存路径。
//
// 只处理 package.json 里以 `github:` / `git+` 开头的依赖：普通 registry 依赖没有
// 这个问题，不该被这个脚本连坐重装。
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const gitDeps = Object.entries(pkg.dependencies ?? {})
  .filter(([, spec]) => /^(github:|git\+|git:)/.test(String(spec)));

if (gitDeps.length === 0) {
  console.log('[refresh-plugins] 没有 git 依赖，无需处理。');
  process.exit(0);
}

// 联调中的插件不能碰：重装会把链接换成钉住的那份，用户以为还在联调、
// 改代码却不再生效，比缓存问题更难察觉。
const linked = gitDeps
  .map(([name]) => name)
  .filter((name) => {
    const dir = join(root, 'node_modules', name);
    return existsSync(dir) && lstatSync(dir).isSymbolicLink();
  });
if (linked.length > 0) {
  console.error('[refresh-plugins] 以下插件处于联调（link）模式，已中止：');
  for (const name of linked) console.error(`  - ${name}`);
  console.error('先跑 npm run unlink-plugins，再执行本命令。');
  process.exit(1);
}

for (const [name] of gitDeps) {
  rmSync(join(root, 'node_modules', name), { recursive: true, force: true });
}

const specs = gitDeps.map(([name, spec]) => `${name}@${spec}`);
console.log('[refresh-plugins] 重新安装：\n  ' + specs.join('\n  '));

const isWin = process.platform === 'win32';
const cmd = isWin ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const args = isWin ? ['/d', '/s', '/c', `npm install ${specs.join(' ')}`] : ['install', ...specs];
execFileSync(cmd, args, { cwd: root, stdio: 'inherit', windowsHide: true });

console.log('\n[refresh-plugins] 完成，当前版本：');
for (const [name] of gitDeps) {
  const v = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  console.log(`  ${name.padEnd(22)} ${v}`);
}
