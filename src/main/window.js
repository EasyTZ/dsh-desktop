'use strict';

const { BrowserWindow, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

function iconPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
    path.join(process.resourcesPath, 'icon.png'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

/**
 * mac 菜单栏托盘专用的单色 template 图路径（见 scripts/gen-icon.mjs）。只在
 * `src/main/tray.js` 里 `process.platform === 'darwin'` 时使用——`@2x` 变体
 * 跟它同目录，Electron 会按屏幕缩放自动挑。
 */
function trayTemplateIconPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', 'iconTemplate.png'),
    path.join(process.resourcesPath, 'iconTemplate.png'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

function isLoopback(u) {
  try {
    const h = new URL(u).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @param {{onCloseRequest?: (event: any, win: any) => void, onFocusChanged?: (focused: boolean) => void}} [opts]
 */
function createMainWindow(url, { onCloseRequest, onFocusChanged } = {}) {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    title: 'DeepSeek Harness Desktop',
    backgroundColor: '#151517',
    icon: iconPath(),
    show: false,
    autoHideMenuBar: true,
    // mac 要保留原生红绿灯（用户对「关闭」按钮位置的预期是系统级的，自己画一套
    // 摆在右上角会很违和），`frame: false` 会把红绿灯也一起藏掉，所以 mac 走
    // `titleBarStyle: 'hiddenInset'`（隐藏标题文字/工具栏，但红绿灯还在）+
    // `trafficLightPosition` 把红绿灯垂直居中到我们那条 28px 高的自绘标题栏里
    // （见 preload/index.js 的 TITLEBAR_HEIGHT）。Windows/Linux 没有这个概念，
    // 维持整条 `frame:false` 全自绘。
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 8 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadURL(url);
  win.once('ready-to-show', () => win.show());

  // 自愈：渲染进程被 GPU/显卡驱动拖垮而异常退出时（典型场景是开机瞬间独显/核显
  // 切换还没稳定，见 2026-09-07 排查记录），Chromium 不会自己重新发起渲染，
  // 表现为窗口打开但一片黑、没有任何报错。这里不用重弹崩溃框或重启内核（内核
  // 本身没事），reload 一次通常就够——这时驱动栈大概率已经稳定，等价于用户
  // 手动退出重开那一步。
  win.webContents.on('render-process-gone', (_event, details) => {
    if (win.isDestroyed()) return;
    console.warn('[window] 渲染进程异常退出，自动重新加载:', details.reason);
    win.webContents.reload();
  });

  // 推送最大化状态给渲染进程，用于切换「最大化 / 还原」按钮图标。
  const sendMaxState = () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximized-changed', win.isMaximized());
  };
  win.on('maximize', sendMaxState);
  win.on('unmaximize', sendMaxState);

  // 新开窗口：回环地址放行（SPA 内部跳转），外部链接交给系统浏览器。
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isLoopback(target)) return { action: 'allow' };
    shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (!isLoopback(target)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  win.on('close', (event) => {
    if (typeof onCloseRequest === 'function') onCloseRequest(event, win);
  });

  // 窗口聚焦状态（用于系统通知：后台时才提醒）。
  if (typeof onFocusChanged === 'function') {
    win.on('focus', () => onFocusChanged(true));
    win.on('blur', () => onFocusChanged(false));
  }

  return win;
}

module.exports = { createMainWindow, iconPath, trayTemplateIconPath };
