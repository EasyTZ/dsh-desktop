'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 更新中心窗口专用 preload：只暴露更新相关的窄接口，不注入标题栏。
contextBridge.exposeInMainWorld('updater', {
  getState: () => ipcRenderer.invoke('updater:get-state'),
  check: () => ipcRenderer.invoke('updater:check'),
  startUpdate: () => ipcRenderer.invoke('updater:start-update'),
  restart: () => ipcRenderer.invoke('updater:restart'),
  close: () => ipcRenderer.invoke('updater:close'),
  cycleRegistry: () => ipcRenderer.invoke('updater:cycle-registry'),
  onState: (cb) => {
    const handler = (_e, state) => { try { cb(state); } catch {} };
    ipcRenderer.on('updater:state', handler);
    return () => ipcRenderer.removeListener('updater:state', handler);
  },
  // 主进程读取主窗口 dsh 页面的 color-scheme 后推过来，让更新弹窗跟着主界面的
  // 浅色/深色走，而不是永远焊死深色。
  onTheme: (cb) => {
    const handler = (_e, mode) => { try { cb(mode); } catch {} };
    ipcRenderer.on('updater:theme', handler);
    return () => ipcRenderer.removeListener('updater:theme', handler);
  },
});
