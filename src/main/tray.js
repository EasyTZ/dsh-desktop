'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const { iconPath } = require('./window');

/**
 * 「检查内核更新」这一项的标签。带上当前内核版本，让用户不用打开更新窗口就能
 * 知道自己在哪个版本 —— 更新提示有 24h 节流，不能是唯一的版本信息来源。
 * @param {string|null|undefined} kernelVersion
 */
function checkUpdateLabel(kernelVersion) {
  return kernelVersion ? `检查内核更新（当前 v${kernelVersion}）` : '检查内核更新';
}

/**
 * 构造托盘菜单。单独导出是为了内核更新完成后能重建菜单、刷新版本号。
 * @param {{onShow: () => void, onQuit: () => void, onCheckUpdate: () => void, onFeedback: () => void,
 *          kernelVersion?: string|null, appUpdate?: {version: string, url: string|null}|null,
 *          onOpenAppUpdate?: () => void}} opts
 */
function buildTrayMenu({ onShow, onQuit, onCheckUpdate, onFeedback, kernelVersion, appUpdate, onOpenAppUpdate }) {
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const items = [
    { label: '显示 / 隐藏', click: onShow },
    { type: 'separator' },
  ];
  // 外壳自身有新版本时才出现这一项——常态下不占位置，跟内核更新那一项
  // （常驻、点了才查）刻意不同：外壳的更新只能靠用户手动下载，多一步「点了才
  // 知道有没有」纯粹添麻烦，不如查到了就直接摆在菜单里。
  if (appUpdate) {
    items.push({ label: `有新版本 v${appUpdate.version}，点击查看`, click: onOpenAppUpdate });
    items.push({ type: 'separator' });
  }
  items.push(
    { label: checkUpdateLabel(kernelVersion), click: onCheckUpdate },
    { label: '反馈问题', click: onFeedback },
    { type: 'separator' },
    { label: '退出', click: onQuit },
  );
  return Menu.buildFromTemplate(items);
}

/**
 * @param {{onShow: () => void, onQuit: () => void, onCheckUpdate: () => void, onFeedback: () => void, kernelVersion?: string|null}} opts
 */
function createTray(opts) {
  const icon = iconPath();
  const img = icon ? nativeImage.createFromPath(icon) : nativeImage.createEmpty();
  const tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip('DeepSeek Harness Desktop');
  tray.setContextMenu(buildTrayMenu(opts));
  tray.on('double-click', opts.onShow);
  return tray;
}

module.exports = { createTray, buildTrayMenu, checkUpdateLabel };
