// 把 node.exe + pnpm + 完整 dsh 依赖树拷到 kernel/ 暂存目录，供 electron-builder
// 的 extraResources 打进安装包，实现自包含内核。
//
// 目录约定（runtime/ 这层子目录不能省，原因见该文件注释）统一定义在
// src/shared/kernel-paths.js。
//
// 注意：自定义插件由 scripts/install-plugin.mjs 装进开发态 dsh 的依赖树（含激活
// 条目与依赖登记），下面整目录拷贝 dsh 时会一并带进内核，因此这里无需再处理插件。
// 前提是 install-plugin 先跑过 —— npm run dist 的顺序已经保证了这一点。
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDshInstallSync, findPnpmDirSync } from '../src/shared/dsh-locate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'kernel');
const outDsh = join(outDir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh');

/** 打包进内核的 node.exe：默认用当前正在运行的 node（一定存在且版本已知）。 */
function findNodeExe() {
  const override = process.env.DSH_NODE_EXE;
  if (override && existsSync(override)) return override;
  return process.execPath;
}

const installDir = findDshInstallSync();
const nodeExe = findNodeExe();
const pnpmDir = findPnpmDirSync();

console.log(`[prepare-kernel] dsh:  ${installDir}`);
console.log(`[prepare-kernel] node: ${nodeExe}`);
console.log(`[prepare-kernel] pnpm: ${pnpmDir}`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'runtime', 'node_modules', '@deepseek-ai'), { recursive: true });
cpSync(nodeExe, join(outDir, 'node.exe'));
cpSync(pnpmDir, join(outDir, 'pnpm'), { recursive: true, dereference: true });
cpSync(installDir, outDsh, { recursive: true, dereference: true });

console.log('[prepare-kernel] 完成');
