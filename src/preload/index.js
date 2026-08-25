'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const TITLEBAR_HEIGHT = 40;

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
 * 这里刻意只放窗口控制按钮：不画分隔线、不加阴影、不写应用名，背景直接取 dsh 的
 * 主题变量。目的是让这条区域看起来是页面本身的一部分，而不是额外贴上去的一层外壳
 * —— 早期版本有 border-bottom + 阴影 + logo + 标题文字，视觉上把窗口切成了两截。
 */
function injectTitlebar() {
  const bar = document.createElement('div');
  bar.id = 'dsh-titlebar';
  bar.innerHTML =
    '<div class="tb-aside"></div>' +
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

  trackSidebarWidth(/** @type {HTMLElement} */ (bar.querySelector('.tb-aside')));
}

// 放弃探测侧边栏的时限。取 15s 是因为冷启动时 dsh 的前端要等内核加载完 plugin
// tree 才渲染，几秒是常态；再长就不是「还没渲染」而是「选择器已经失效」了。
const SIDEBAR_PROBE_TIMEOUT_MS = 15000;

/**
 * 标题栏左段跟随 dsh 侧边栏的宽度：侧边栏可折叠（280px ↔ 56px），写死宽度会在
 * 折叠瞬间露出色差。dsh 的侧边栏没有 data-testid，只能靠 CSS Modules 类名里
 * 保留的原始片段（"sidebarCol"）做弱耦合匹配，随内核升级需要留意此处是否还能命中。
 *
 * 匹配不中不会抛错，但**必须有时限**：`mo.disconnect()` 原先只在命中时执行，
 * 上游一旦改掉这个类名，这个 `subtree: true` 的 observer 就永久挂在聊天界面上，
 * 而聊天界面正是 DOM 变动最频繁的地方。超时后除了断开，还要经主进程留一条日志
 * —— preload 的 console 只到渲染进程 devtools，用户不会去开，等于没报。
 * @param {HTMLElement | null} aside
 */
function trackSidebarWidth(aside) {
  if (!aside) return;
  let sidebar = /** @type {HTMLElement | null} */ (null);
  let observer = /** @type {ResizeObserver | null} */ (null);

  const sync = () => {
    if (sidebar) aside.style.width = sidebar.getBoundingClientRect().width + 'px';
  };

  const giveUp = setTimeout(() => {
    mo.disconnect();
    ipcRenderer.send('titlebar:sidebar-probe-failed', SIDEBAR_PROBE_TIMEOUT_MS);
  }, SIDEBAR_PROBE_TIMEOUT_MS);

  const attach = () => {
    const found = /** @type {HTMLElement | null} */ (document.querySelector('[class*="sidebarCol"]'));
    if (!found || found === sidebar) return;
    sidebar = found;
    observer = new ResizeObserver(sync);
    observer.observe(sidebar);
    sync();
    clearTimeout(giveUp);
    mo.disconnect();
  };

  // 侧边栏是应用启动后异步渲染出来的，首次可能还没挂载；用 MutationObserver 补一次探测，
  // 找到后立即断开——聊天界面 DOM 变动频繁，长期挂着会白白消耗性能。
  const mo = new MutationObserver(attach);
  mo.observe(document.body, { childList: true, subtree: true });
  attach();
}

function injectStyles() {
  const style = document.createElement('style');
  style.textContent =
    // 背景与前景全部走 dsh 的设计 token，浅色 / 深色 / 跟随系统都能自动对上。
    // 兜底值用深色主题的真实取值（bg-base = rgb(21,21,23)、label-primary = rgb(249,250,251)），
    // 而不是以前那个偏蓝的 #0d1117 —— 万一变量取不到，也不会露出色差。
    // z-index 刻意不用「盖过一切」的超大值：dsh 自己的弹窗遮罩（对话框 mask，24% 黑
    // + 2px 模糊）z-index 是 1000，如果标题栏比它还高，弹窗打开时背景变暗变糊而标题栏
    // 纹丝不动，浅色主题下这个反差极其扎眼。900 卡在「盖住普通页面内容（观测到的最高
    // 是 20）」和「盖不过弹窗遮罩」之间，让标题栏跟着弹窗一起变暗——弹窗开着时窗口按钮
    // 点不到是可接受的代价，换来的是视觉上不再露馅。
    '#dsh-titlebar{' +
    'position:fixed;top:0;left:0;right:0;height:' + TITLEBAR_HEIGHT + 'px;' +
    'z-index:900;display:flex;align-items:center;justify-content:flex-end;' +
    '-webkit-app-region:drag;user-select:none;box-sizing:border-box;' +
    'background:var(--dsw-alias-bg-base,#151517);' +
    'color:var(--dsw-alias-label-primary,#f9fafb);}' +
    // 左段贴着侧边栏顶部，颜色跟侧边栏的实际色板 token 走（而不是对话区的 bg-base）——
    // web 应用里侧边栏和对话区本来就是两种底色，标题栏顶在上面得跟着分成两段。
    // 宽度由 trackSidebarWidth() 用 ResizeObserver 实时同步，折叠/展开都不会错位。
    '#dsh-titlebar .tb-aside{' +
    'position:absolute;top:0;left:0;height:100%;width:0;' +
    'background:var(--dsw-specific-sidebar-fill,#1b1b1c);' +
    'pointer-events:none;}' +
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
    '#dsh-titlebar .tb-close:hover{background:#e5484d;color:#fff;}' +
    '#root{padding-top:' + TITLEBAR_HEIGHT + 'px;box-sizing:border-box;}';
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
