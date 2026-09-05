// 从 CHANGELOG.md 里抽出某个版本那一节，作为 GitHub Release 的正文。
//
//   node scripts/release-notes.mjs 1.7.4
//
// 为什么不让发布说明只写一句「详见 CHANGELOG」：那等于把读者又踢回仓库再翻一遍，
// 而 Release 页面本来就是大多数人唯一会看的地方。CHANGELOG 里已经按版本分好节、
// 措辞也是面向用户的，直接搬过来即可，不需要维护第二份文案。
//
// 抽哪一节由**版本号**决定，不是「取第一节」：手动触发、补发旧版本时不能想当然
// 认为要发的就是最新那节。对不上就报错中止 —— 发布说明写错版本比没有说明更糟。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error('用法：node scripts/release-notes.mjs <version>  例如 1.7.4');
  process.exit(1);
}

const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);

// 每节的标题形如 `**最新版 v1.7.4** —— …` 或 `**v1.7.3** —— …`。
// 「最新版」这个前缀只是给 CHANGELOG 自己看的，两种都要认。
const headingOf = (line) => /^\*\*(?:最新版\s*)?v(\d+\.\d+\.\d+[^*]*)\*\*/.exec(line)?.[1]?.trim();

const start = lines.findIndex((l) => headingOf(l) === version);
if (start < 0) {
  console.error(`[release-notes] CHANGELOG.md 里没有 v${version} 那一节。`);
  console.error('发版前要先在 CHANGELOG.md 顶部加一节，格式参照现有的条目。');
  process.exit(1);
}

// 到下一个版本标题为止（没有下一个就到文件末尾）。
let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (headingOf(lines[i])) { end = i; break; }
}

// 标题那行本身不进正文：Release 页面上方已经显示了 tag 名，再重复一遍版本号是噪音。
// 但标题里 `—— ` 之后的那句概述要留 —— 它是这一版最重要的一句话。
const heading = lines[start];
const summary = heading.split('——').slice(1).join('——').trim().replace(/[:：]\s*$/, '');

const body = lines.slice(start + 1, end).join('\n').trim();

const out = [
  summary ? `**${summary}**\n` : '',
  body,
  '',
  '---',
  '',
  '各平台安装说明与首次启动提示见 [README](https://github.com/EasyTZ/dsh-desktop#-下载与安装)；',
  '完整历史见 [CHANGELOG.md](https://github.com/EasyTZ/dsh-desktop/blob/main/CHANGELOG.md)。',
].filter((s) => s !== null).join('\n');

process.stdout.write(out + '\n');
