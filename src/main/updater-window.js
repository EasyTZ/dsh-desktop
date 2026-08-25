'use strict';

const { BrowserWindow, nativeTheme } = require('electron');
const path = require('node:path');
const { iconPath } = require('./window');

/** @type {import('electron').BrowserWindow|null} */
let win = null;
let allowClose = false;

/**
 * 更新弹窗跟主窗口不是同一个 webContents，读不到 dsh 页面自己的 CSS 变量；
 * 但 dsh 会把当前主题写进 `<html style="color-scheme: ...">`，这是最省事也最
 * 准的信号——比去解析某个具体 token 的颜色值可靠得多。主窗口还没加载出 dsh
 * 页面（比如内核没起来）或已销毁时，退回操作系统的深色模式判断。
 * @param {import('electron').BrowserWindow|null|undefined} mainWindow
 * @returns {Promise<'light'|'dark'>}
 */
async function detectTheme(mainWindow) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const scheme = await mainWindow.webContents.executeJavaScript(
        'document.documentElement.style.colorScheme',
        true
      );
      if (scheme === 'light' || scheme === 'dark') return scheme;
    } catch {
      // 主窗口页面还没就绪，忽略，走下面的系统主题兜底。
    }
  }
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/**
 * 把最新主题推给已经打开的更新窗口（用于单例复用时刷新，而非首次加载）。
 * @param {import('electron').BrowserWindow|null} target
 * @param {import('electron').BrowserWindow|null|undefined} mainWindow
 */
async function applyTheme(target, mainWindow) {
  if (!target || target.isDestroyed()) return;
  const mode = await detectTheme(mainWindow);
  if (target.isDestroyed()) return;
  target.webContents.send('updater:theme', mode);
}

/**
 * 更新中心窗口：单例、无边框、居中，加载 updater.html。
 * 承载「检查更新 / 更新提示 / 更新动画 / 源切换」一整套内核更新交互。
 * @param {{ updater: InstanceType<typeof import('./kernel-updater').KernelUpdater>, mainWindow?: import('electron').BrowserWindow|null }} args
 */
async function createUpdaterWindow({ updater, mainWindow }) {
  if (win && !win.isDestroyed()) {
    applyTheme(win, mainWindow).catch(() => {});
    return win;
  }

  // 创建前先拿到主题，通过 query string 首帧就画对颜色——不然先弹出焊死的深色，
  // 等 IPC 推送到了再切换，用户会看见一下闪色。
  const initialTheme = await detectTheme(mainWindow);

  win = new BrowserWindow({
    width: 400,
    height: 400,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    backgroundColor: initialTheme === 'light' ? '#ffffff' : '#151517',
    title: 'DeepSeek 内核更新',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'updater.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.center();
  win.loadFile(path.join(__dirname, 'updater.html'), { query: { theme: initialTheme } });
  const created = win;
  created.once('ready-to-show', () => created.show());

  const onState = (state) => {
    if (win && !win.isDestroyed()) win.webContents.send('updater:state', state);
  };
  updater.on('state', onState);

  // 关闭即隐藏（单例复用）；真正销毁时移除监听。应用退出时由
  // destroyUpdaterWindow 置 allowClose 放行。
  win.on('close', (event) => {
    if (!allowClose && win && !win.isDestroyed()) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    updater.off('state', onState);
    win = null;
  });

  return win;
}

/** @param {{ updater: InstanceType<typeof import('./kernel-updater').KernelUpdater>, mainWindow?: import('electron').BrowserWindow|null }} args */
async function showUpdaterWindow({ updater, mainWindow }) {
  const w = await createUpdaterWindow({ updater, mainWindow });
  w.show();
  w.focus();
  return w;
}

function hideUpdaterWindow() {
  if (win && !win.isDestroyed()) win.hide();
}

/** 应用退出前调用：放行 close，确保窗口不会阻止退出。 */
function destroyUpdaterWindow() {
  allowClose = true;
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

module.exports = { createUpdaterWindow, showUpdaterWindow, hideUpdaterWindow, destroyUpdaterWindow };
