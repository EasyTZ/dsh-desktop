'use strict';

// 打包完成后裁掉用不到的 Electron 语言包。
//
// locales/ 下有 55 个 .pak、46.6 MB，而这些只影响 Chromium 自带 UI 的文案（右键
// 菜单、错误页），我们自己的界面与 dsh 的 web 应用都自带 i18n。Chromium 找不到
// 请求的语言时回退 en-US，所以留 en-US + zh-CN 就够，省下的 ~45 MB 直接体现在
// 安装包与绿色版体积上。
//
// 为什么是 afterPack 而不是 beforeBuild：语言包来自 electron 官方 dist，只有等
// electron-builder 把它拷进 appOutDir 之后才存在。
//
// macOS 的语言包在 .app 内部的 Electron Framework 里，路径完全不同 —— 这里探测
// 不到就直接跳过，等真上 Mac 时再单独处理，不要在这里猜路径。

const fs = require('node:fs');
const path = require('node:path');

/** 保留的语言包。界面是中文，英文是 Chromium 的兜底语言。 */
const KEEP = new Set(['en-US.pak', 'zh-CN.pak']);

module.exports = async (context) => {
  const localesDir = path.join(context.appOutDir, 'locales');
  if (!fs.existsSync(localesDir)) return;

  let removed = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(localesDir)) {
    if (!name.endsWith('.pak') || KEEP.has(name)) continue;
    const full = path.join(localesDir, name);
    bytes += fs.statSync(full).size;
    fs.rmSync(full);
    removed += 1;
  }
  console.log(`  • 裁掉未用语言包  count=${removed} saved=${(bytes / 1024 / 1024).toFixed(1)}MB`);
};
