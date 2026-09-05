// 生成 macOS DMG 的安装说明背景。未做 Developer ID 签名/公证时，应用自己在
// Gatekeeper 放行前根本无法执行，所以提示必须放在用户一挂载就能看到的 Finder
// 窗口里，而不是做成应用首次启动弹窗。
import sharp from 'sharp';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, 'build');

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="660" height="480" viewBox="0 0 660 480">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f7f9ff"/>
      <stop offset="1" stop-color="#edf2ff"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="4" stdDeviation="10" flood-color="#3151a3" flood-opacity=".12"/>
    </filter>
  </defs>
  <rect width="660" height="480" fill="url(#bg)"/>
  <text x="330" y="42" text-anchor="middle" font-family="PingFang SC, Helvetica Neue, sans-serif"
        font-size="21" font-weight="650" fill="#17223b">安装 DeepSeek Harness Desktop</text>
  <text x="330" y="70" text-anchor="middle" font-family="PingFang SC, Helvetica Neue, sans-serif"
        font-size="13" fill="#64708a">把左侧应用拖入右侧 Applications 文件夹</text>

  <!-- 两个 Finder 图标会覆盖在这两个留白区域上。 -->
  <path d="M278 151 H374 M354 136 L374 151 L354 166" fill="none" stroke="#4d6bfe"
        stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>

  <rect x="30" y="260" width="600" height="190" rx="18" fill="#fff" filter="url(#shadow)"/>
  <circle cx="61" cy="294" r="15" fill="#fff1d6"/>
  <text x="61" y="300" text-anchor="middle" font-family="Helvetica Neue, sans-serif"
        font-size="18" font-weight="700" fill="#b66a00">!</text>
  <text x="88" y="291" font-family="PingFang SC, Helvetica Neue, sans-serif"
        font-size="16" font-weight="650" fill="#17223b">首次打开若被 macOS 拦截</text>
  <text x="88" y="315" font-family="PingFang SC, Helvetica Neue, sans-serif"
        font-size="12" fill="#7a8499">此版本未使用 Apple Developer ID 签名，需要手动确认一次。</text>

  <circle cx="58" cy="348" r="11" fill="#4d6bfe"/>
  <text x="58" y="353" text-anchor="middle" font-family="Helvetica Neue, sans-serif"
        font-size="12" font-weight="700" fill="#fff">1</text>
  <text x="80" y="353" font-family="PingFang SC, Helvetica Neue, sans-serif"
        font-size="13" fill="#303b54">先双击一次应用，让 macOS 显示安全警告</text>

  <circle cx="58" cy="382" r="11" fill="#4d6bfe"/>
  <text x="58" y="387" text-anchor="middle" font-family="Helvetica Neue, sans-serif"
        font-size="12" font-weight="700" fill="#fff">2</text>
  <text x="80" y="387" font-family="PingFang SC, Helvetica Neue, sans-serif"
        font-size="13" fill="#303b54">打开“系统设置” → “隐私与安全”，向下找到“安全性”</text>

  <circle cx="58" cy="416" r="11" fill="#4d6bfe"/>
  <text x="58" y="421" text-anchor="middle" font-family="Helvetica Neue, sans-serif"
        font-size="12" font-weight="700" fill="#fff">3</text>
  <text x="80" y="421" font-family="PingFang SC, Helvetica Neue, sans-serif"
        font-size="13" fill="#303b54">点“仍要打开”，验证密码后再点“打开”</text>

  <text x="330" y="470" text-anchor="middle" font-family="PingFang SC, Helvetica Neue, sans-serif"
        font-size="10.5" fill="#8993a8">仅在确认安装包来自项目官方发布页时执行上述操作</text>
</svg>`;

const outputs = [
  { name: 'dmg-background.png', width: 660 },
  { name: 'dmg-background@2x.png', width: 1320 },
];
for (const output of outputs) {
  await sharp(Buffer.from(svg)).resize({ width: output.width }).png().toFile(join(buildDir, output.name));
}

console.log('已生成 build/dmg-background.png 与 build/dmg-background@2x.png');
