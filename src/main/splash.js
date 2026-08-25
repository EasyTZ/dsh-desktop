'use strict';

const { BrowserWindow } = require('electron');
const path = require('node:path');

/**
 * 启动闪屏窗口：在 dsh 内核就绪前立即弹出，给用户即时反馈。
 * 小而居中、无边框、置顶、不占任务栏，主窗口就绪后由调用方关闭。
 */
function createSplashWindow() {
  const win = new BrowserWindow({
    width: 380,
    height: 240,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#151517',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.center();
  win.loadFile(path.join(__dirname, 'splash.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}

module.exports = { createSplashWindow };
