'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const TITLEBAR_HEIGHT = 32;

// 窗口控制按钮图标（SVG，stroke 跟随 currentColor）。
const ICONS = {
  minimize: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M1 5 H9"/></svg>',
  maximize: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="1" y="1" width="8" height="8"/></svg>',
  restore: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M3 3 V1 H9 V7 H7"/><rect x="1" y="3" width="6" height="6"/></svg>',
  close: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5"/></svg>',
};

/**
 * 注入自定义标题栏。
 *
 * 只放窗口控制按钮，背景透明——**不再用 `#root` padding-top 把整个页面推低**，
 * 而是让标题栏悬浮叠在 dsh 自己页面顶部（dsh 那部分本来就有留白，实测目前
 * 观察到的几个页面顶部都没有实际内容）。好处是不再需要额外一段代码去猜侧边栏
 * 颜色/宽度来伪装成"页面的一部分"——透明背景下，dsh 真实的背景色本来就会
 * 透出来，天然对得上。
 *
 * 代价：叠加区域是 `-webkit-app-region:drag`，如果 dsh 某个页面在这 32px
 * 高度内有真实可点击内容（比如会话头部的操作按钮延伸到了最顶部），会被这层
 * 拖拽区域挡住点不到。这一版只根据一张欢迎页截图判断顶部是空的，**没有实机
 * 跑过 dsh 的其他页面**（活跃会话、设置页等）——如果发现某个页面按钮点不到，
 * 多半是这个原因，需要针对那块加 `-webkit-app-region:no-drag` 例外，或者
 * 退回「reserve 空间」的旧方案（`git log` 里能翻到）。
 */
function injectTitlebar() {
  const bar = document.createElement('div');
  bar.id = 'dsh-titlebar';
  bar.innerHTML =
    '<div class="tb-controls">' +
    '<button class="tb-btn" data-action="minimize" aria-label="最小化">' + ICONS.minimize + '</button>' +
    '<button class="tb-btn" data-action="maximize" aria-label="最大化">' + ICONS.maximize + '</button>' +
    '<button class="tb-btn tb-close" data-action="close" aria-label="关闭">' + ICONS.close + '</button>' +
    '</div>';
  document.body.appendChild(bar);

  bar.querySelectorAll('.tb-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      ipcRenderer.send('window:' + /** @type {HTMLElement} */ (btn).dataset.action);
    });
  });

  // 最大化 / 还原按钮图标随窗口状态切换。
  const maxBtn = bar.querySelector('[data-action="maximize"]');
  ipcRenderer.on('window:maximized-changed', (_e, isMax) => {
    if (!maxBtn) return;
    maxBtn.innerHTML = isMax ? ICONS.restore : ICONS.maximize;
    maxBtn.setAttribute('aria-label', isMax ? '还原' : '最大化');
  });

  // 双击标题栏切换最大化（避开按钮区域）。
  bar.addEventListener('dblclick', (e) => {
    const target = /** @type {HTMLElement|null} */ (e.target);
    if (target && target.closest('.tb-controls')) return;
    ipcRenderer.send('window:maximize');
  });
}

function injectStyles() {
  const style = document.createElement('style');
  style.textContent =
    // 透明悬浮层，不再占用/推挤页面布局。z-index 刻意不用「盖过一切」的超大值：
    // dsh 自己的弹窗遮罩（对话框 mask，24% 黑 + 2px 模糊）z-index 是 1000，如果
    // 标题栏比它还高，弹窗打开时背景变暗变糊而标题栏纹丝不动，浅色主题下这个
    // 反差极其扎眼。900 卡在「盖住普通页面内容（观测到的最高是 20）」和「盖不过
    // 弹窗遮罩」之间，让标题栏跟着弹窗一起变暗——弹窗开着时窗口按钮点不到是可
    // 接受的代价，换来的是视觉上不再露馅。
    '#dsh-titlebar{' +
    'position:fixed;top:0;left:0;right:0;height:' + TITLEBAR_HEIGHT + 'px;' +
    'z-index:900;display:flex;align-items:center;justify-content:flex-end;' +
    '-webkit-app-region:drag;user-select:none;box-sizing:border-box;' +
    'background:transparent;' +
    'color:var(--dsw-alias-label-primary,#f9fafb);}' +
    '#dsh-titlebar .tb-controls{' +
    'display:flex;align-items:center;height:100%;gap:2px;padding-right:6px;' +
    '-webkit-app-region:no-drag;}' +
    '#dsh-titlebar .tb-btn{' +
    'width:40px;height:28px;border:none;background:transparent;color:inherit;' +
    'line-height:1;cursor:pointer;border-radius:7px;' +
    'display:inline-flex;align-items:center;justify-content:center;' +
    'transition:background .15s ease,color .15s ease;}' +
    '#dsh-titlebar .tb-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));}' +
    '#dsh-titlebar .tb-btn svg{width:11px;height:11px;display:block;}' +
    '#dsh-titlebar .tb-close:hover{background:#e5484d;color:#fff;}';
  document.head.appendChild(style);
}

function mount() {
  injectTitlebar();
  injectStyles();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
});
