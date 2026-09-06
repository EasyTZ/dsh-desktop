'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 「关于」窗口专用 preload：只暴露几个窄接口，不注入标题栏。
//
// 外链不让渲染进程传 URL：页面只说「打开哪一类链接」（repo / author / issues），
// 真正的地址由主进程查表决定。about.html 是我们自己的静态页，风险本来不大，
// 但「渲染进程能让主进程打开任意 URL」这种口子一开就收不回来，不如一开始就不开。
contextBridge.exposeInMainWorld('about', {
  getInfo: () => ipcRenderer.invoke('about:get-info'),
  open: (target) => ipcRenderer.send('about:open', String(target)),
  close: () => ipcRenderer.send('about:close'),
  // 跟更新中心同一套主题联动：主进程读主窗口 dsh 页面的 color-scheme 推过来。
  onTheme: (cb) => {
    const handler = (_e, mode) => { try { cb(mode); } catch {} };
    ipcRenderer.on('about:theme', handler);
    return () => ipcRenderer.removeListener('about:theme', handler);
  },
});
