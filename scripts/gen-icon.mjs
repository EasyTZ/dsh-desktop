// 用 DeepSeek 官方鲸鱼 logo（build/logo.svg）生成应用图标：
// - build/icon.png：256x256 透明背景（系统托盘 / 窗口图标）
// - build/icon.ico：多尺寸 PNG 内嵌（安装包 / 开始菜单 / 任务栏图标）
//
// 关键点：先裁掉 logo 自带的透明留白，让鲸鱼尽量填满图标画布，
// 这样缩到 16px 托盘、24px 开始菜单时，鲸鱼仍然足够大、足够清晰。
import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const logoPath = join(root, 'build', 'logo.svg');

// 1) 高分辨率渲染 SVG，再裁掉四周透明边，得到鲸鱼的紧凑包围盒。
const tight = await sharp(readFileSync(logoPath), { density: 600 })
  .png()
  .trim()
  .toBuffer();

// 2) 按目标尺寸生成「鲸鱼填满」的 PNG，只按比例留极小边避免贴边。
async function render(size) {
  const pad = Math.round(size * 0.03);
  const inner = size - pad * 2;
  return sharp(tight)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// 3) 生成 ICO（内嵌多尺寸 PNG，Vista+ 支持 PNG 压缩 ICO）。
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4); // count
  let offset = 6 + 16 * images.length;
  const entries = [];
  const datas = [];
  for (const { size, buf } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // width（256 记作 0）
    entry[1] = size >= 256 ? 0 : size; // height
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(buf.length, 8); // size
    entry.writeUInt32LE(offset, 12); // offset
    entries.push(entry);
    datas.push(buf);
    offset += buf.length;
  }
  return Buffer.concat([header, ...entries, ...datas]);
}

// 覆盖托盘(16/20/24/32)、开始菜单(24/32/48)、桌面(48/64)、大图标(128/256)。
// ICO 目录项的宽高用单字节表示（`encodeIco` 里 `size >= 256 ? 0 : size`，0 记作
// 256），超过 256 的尺寸也只能写 0，多个不同尺寸的图挤在同一个 0/0 上会互相
// 覆盖——ICO 格式本身就不支持大于 256 的尺寸，所以 ICO 只到 256 封顶。
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
// build/icon.png 单独渲染一张更大尺寸：Linux AppImage 建议 ≥512（electron-builder
// 拿它自动生成 Linux 图标集），macOS icns 要求 ≥512 否则直接报错（任务 7 铺路）。
// PNG 没有 ICO 那个单字节尺寸限制，选 1024 留出余量。
const PNG_SIZE = 1024;

const icoImages = [];
for (const size of ICO_SIZES) {
  icoImages.push({ size, buf: await render(size) });
}
const pngBuf = await render(PNG_SIZE);

mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'icon.png'), pngBuf);
writeFileSync(join(root, 'build', 'icon.ico'), encodeIco(icoImages));
console.log('已生成 build/icon.png（1024）与 build/icon.ico（16~256 多尺寸，鲸鱼填满）');
