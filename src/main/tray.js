'use strict';

const { app, Tray, Menu, nativeImage } = require('electron');
const { iconPath, trayTemplateIconPath } = require('./window');

/**
 * 「检查内核更新」这一项的标签。带上当前内核版本，让用户不用打开更新窗口就能
 * 知道自己在哪个版本 —— 更新提示有 24h 节流，不能是唯一的版本信息来源。
 * @param {string|null|undefined} kernelVersion
 */
function checkUpdateLabel(kernelVersion) {
  return kernelVersion ? `检查内核更新（当前 v${kernelVersion}）` : '检查内核更新';
}

/**
 * 安全模式那一项的标签：同一个位置、按当前状态切换文案。
 *
 * 退出那一侧要把「重启应用」写在脸上：安全模式只存在于内存里（见 index.js 的
 * `safeMode`），退出的实现就是 relaunch，用户点之前应该知道窗口会消失一下再回来。
 * @param {boolean|undefined} safeMode
 */
function safeModeLabel(safeMode) {
  return safeMode ? '退出安全模式（重启应用）' : '进入安全模式';
}

/**
 * @typedef {object} MenuOpts
 * @property {() => void} onShow
 * @property {() => void} onQuit
 * @property {() => void} onCheckUpdate
 * @property {() => void} onFeedback
 * @property {() => void} [onAbout]
 * @property {() => void} [onToggleSafeMode]
 * @property {boolean} [safeMode]
 * @property {string|null} [kernelVersion]
 * @property {{version: string, url: string|null}|null} [appUpdate]
 * @property {() => void} [onOpenAppUpdate]
 */

/**
 * 构造托盘菜单。单独导出是为了内核更新完成后能重建菜单、刷新版本号；进出安全模式
 * 时也要重建，让那一项的文案跟着状态变。
 * @param {MenuOpts} opts
 */
function buildTrayMenu({ onShow, onQuit, onCheckUpdate, onFeedback, onAbout, onToggleSafeMode, safeMode,
  kernelVersion, appUpdate, onOpenAppUpdate }) {
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
  items.push({ label: checkUpdateLabel(kernelVersion), click: onCheckUpdate });
  // 安全模式常驻一项：以前只能从崩溃对话框进，但「插件装完界面卡死 / 白屏但内核
  // 没退」这类故障不会触发崩溃对话框，用户没有任何入口能把插件关掉。
  if (onToggleSafeMode) {
    items.push({ label: safeModeLabel(safeMode), click: onToggleSafeMode });
  }
  items.push({ type: 'separator' });
  if (onAbout) items.push({ label: '关于', click: onAbout });
  items.push(
    { label: '反馈问题', click: onFeedback },
    { type: 'separator' },
    { label: '退出', click: onQuit },
  );
  return Menu.buildFromTemplate(items);
}

/**
 * 给 macOS 再放两条不依赖状态栏图标的入口。
 *
 * 菜单栏项目过多（尤其带刘海的屏幕）时，macOS 会把一部分状态项挤掉；那不是
 * Tray 创建失败，但用户同样点不到唯一的更新入口。顶部应用菜单与 Dock 右键菜单
 * 都是系统原生、不会依赖状态项是否可见，且复用同一组回调，不再造第二套行为。
 * @param {MenuOpts} opts
 */
function installMacApplicationMenu(opts) {
  if (process.platform !== 'darwin') return;
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const appUpdateItems = opts.appUpdate ? [
    { label: `有新版本 v${opts.appUpdate.version}，点击查看`, click: opts.onOpenAppUpdate },
    { type: 'separator' },
  ] : [];
  /** @type {import('electron').MenuItemConstructorOptions} */
  const updateItem = { label: checkUpdateLabel(opts.kernelVersion), click: opts.onCheckUpdate };
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const safeModeItems = opts.onToggleSafeMode
    ? [{ label: safeModeLabel(opts.safeMode), click: opts.onToggleSafeMode }]
    : [];
  // 「关于」用我们自己的窗口而不是系统 `role: 'about'`：系统那个只会显示版本号和
  // 版权，内核版本、仓库地址都放不进去，而且长得跟更新中心完全不是一套。
  /** @type {import('electron').MenuItemConstructorOptions} */
  const aboutItem = opts.onAbout
    ? { label: `关于 ${app.name}`, click: opts.onAbout }
    : { role: 'about' };

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        aboutItem,
        { type: 'separator' },
        ...appUpdateItems,
        updateItem,
        ...safeModeItems,
        { label: '反馈问题', click: opts.onFeedback },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: '退出', accelerator: 'Command+Q', click: opts.onQuit },
      ],
    },
    { role: 'editMenu' },
    {
      label: '窗口',
      submenu: [
        { label: '显示 / 隐藏', click: opts.onShow },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]));

  if (app.dock) {
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: opts.onShow },
      { type: 'separator' },
      updateItem,
      ...safeModeItems,
      ...appUpdateItems,
      ...(opts.onAbout ? [{ label: '关于', click: opts.onAbout }] : []),
      { label: '反馈问题', click: opts.onFeedback },
    ]));
  }
}

/**
 * @param {MenuOpts} opts
 * @returns {import('electron').Tray|null} 失败（多半是 Linux 缺 libappindicator）时返回 null
 */
function createTray(opts) {
  const isMac = process.platform === 'darwin';
  // mac 菜单栏要单色 template 图（见 window.js/gen-icon.mjs 的注释），彩色图标
  // resize 到 16px 在深色菜单栏里是一坨糊的方块。Windows/Linux 继续用彩色图标
  // 手动 resize 到 16px。
  const icon = isMac ? trayTemplateIconPath() : iconPath();
  let img = icon ? nativeImage.createFromPath(icon) : nativeImage.createEmpty();
  if (isMac) {
    // 双保险：文件名 `Template` 后缀本身已经会被 Electron 自动识别为模板图，
    // 这里显式设一遍，不依赖命名巧合。
    img.setTemplateImage(true);
  } else {
    img = img.resize({ width: 16, height: 16 });
  }
  try {
    const tray = new Tray(img);
    tray.setToolTip('DeepSeek Harness Desktop');
    tray.setContextMenu(buildTrayMenu(opts));
    tray.on('double-click', opts.onShow);
    return tray;
  } catch (error) {
    // Linux 的系统托盘依赖 libappindicator，部分发行版 / 桌面环境没装，
    // `new Tray()` 会直接抛。托盘只是「最小化到后台」的一个入口，不是核心功能，
    // 不该因为它拿不到就让整个应用起不来——降级为无托盘图标运行，调用方
    // （src/main/index.js）已经处处判了 `if (tray)`，null 能安全流过去。
    console.error('[tray] 创建托盘失败，以无托盘模式继续运行:', error?.message ?? error);
    return null;
  }
}

module.exports = { createTray, buildTrayMenu, checkUpdateLabel, safeModeLabel, installMacApplicationMenu };
