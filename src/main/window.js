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
    frame: false,
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

module.exports = { createMainWindow, iconPath };
