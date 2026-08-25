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
 * @param {{onShow: () => void, onQuit: () => void, onCheckUpdate: () => void, kernelVersion?: string|null}} opts
 */
function buildTrayMenu({ onShow, onQuit, onCheckUpdate, kernelVersion }) {
  return Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: onShow },
    { type: 'separator' },
    { label: checkUpdateLabel(kernelVersion), click: onCheckUpdate },
    { type: 'separator' },
    { label: '退出', click: onQuit },
  ]);
}

/**
 * @param {{onShow: () => void, onQuit: () => void, onCheckUpdate: () => void, kernelVersion?: string|null}} opts
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
