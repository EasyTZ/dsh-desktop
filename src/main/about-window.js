'use strict';

const { BrowserWindow } = require('electron');
const path = require('node:path');
const { iconPath } = require('./window');
const { detectTheme } = require('./updater-window');

/** @type {import('electron').BrowserWindow|null} */
let win = null;

/**
 * 「关于」窗口：单例、无边框、居中，加载 about.html。
 *
 * 外观刻意跟更新中心（updater.html）同一套：同尺寸、同 header、同 token 色板、
 * 同样按主窗口 dsh 页面的 color-scheme 走浅色/深色。用户从托盘点开的两个弹窗
 * 如果长得不一样，会像是两个程序。
 *
 * 跟更新中心不同的是这里**关闭即销毁**：没有要跨次保留的状态（信息每次打开
 * 重新拉一遍），留个隐藏窗口没有意义。
 * @param {{ mainWindow?: import('electron').BrowserWindow|null }} [args]
 */
async function showAboutWindow({ mainWindow } = {}) {
  if (win && !win.isDestroyed()) {
    const existing = win;
    const mode = await detectTheme(mainWindow);
    if (existing.isDestroyed()) return existing;
    existing.webContents.send('about:theme', mode);
    existing.show();
    existing.focus();
    return existing;
  }

  // 同更新中心：主题先拿到再建窗口，通过 query string 让首帧就画对颜色。
  const initialTheme = await detectTheme(mainWindow);

  const created = new BrowserWindow({
    width: 400,
    // 高度跟着信息表的行数走：5 行（应用/内核/作者/GitHub/Gitee）在 400 高里会
    // 顶到 footer，wrap 是 overflow:hidden，超出的部分直接被切掉而不是出滚动条。
    height: 440,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    backgroundColor: initialTheme === 'light' ? '#ffffff' : '#151517',
    title: '关于 DeepSeek Harness Desktop',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'about.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win = created;

  created.center();
  created.loadFile(path.join(__dirname, 'about.html'), { query: { theme: initialTheme } });
  created.once('ready-to-show', () => created.show());
  created.on('closed', () => {
    if (win === created) win = null;
  });
  return created;
}

function closeAboutWindow() {
  if (win && !win.isDestroyed()) win.close();
  win = null;
}

module.exports = { showAboutWindow, closeAboutWindow };
