'use strict';

const { app, globalShortcut, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { DshService } = require('./dsh-service');
const { createMainWindow } = require('./window');
const { createTray, buildTrayMenu } = require('./tray');
const { createSplashWindow } = require('./splash');
const { TaskNotifications } = require('./notifications');
const { KernelUpdater } = require('./kernel-updater');
const { summarizeStderr } = require('../shared/error-detail');
const { showUpdaterWindow, hideUpdaterWindow, destroyUpdaterWindow } = require('./updater-window');

const APP_ID = 'com.deepseek.desktop';
const ISSUES_URL = 'https://github.com/EasyTZ/Deepseek-Harness-Desktop/issues/new/choose';
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);

  /** @type {import('electron').BrowserWindow|null} */
  let win = null;
  /** @type {import('electron').BrowserWindow|null} */
  let splash = null;
  /** @type {import('electron').Tray|null} */
  let tray = null;
  /** @type {InstanceType<typeof DshService>|null} */
  let dsh = null;
  /** @type {InstanceType<typeof KernelUpdater>|null} */
  let updater = null;
  let isQuitting = false;
  let kernelFallbackAttempted = false;

  // 内核与插件路径：打包态走 resourcesPath，开发态走仓库根。
  const BUILTIN_KERNEL_DIR = app.isPackaged
    ? path.join(process.resourcesPath, 'kernel')
    : path.join(__dirname, '..', '..', 'kernel');
  const PLUGINS_DIR = app.isPackaged
    ? path.join(process.resourcesPath, 'plugins')
    : path.join(__dirname, '..', '..', 'plugins');
  const USER_KERNEL_DIR = path.join(app.getPath('userData'), 'kernel');
  const UPDATER_CONFIG_PATH = path.join(app.getPath('userData'), 'updater.json');
  // 插件激活 overlay：由 plugins.json 生成，启动时经 `--patch` 交给内核。
  // 放 userData 而不是 resources：打包态 resources 只读，且内容随清单变化。
  const ACTIVATION_PATCH_PATH = path.join(app.getPath('userData'), 'desktop.patch.yml');
  const PNPM_CLI_PATH = path.join(BUILTIN_KERNEL_DIR, 'pnpm', 'bin', 'pnpm.cjs');
  const PNPM_STORE_DIR = path.join(app.getPath('userData'), 'pnpm-store');
  const BUILTIN_NODE_EXE = path.join(BUILTIN_KERNEL_DIR, 'node.exe');

  /**
   * 弃用损坏的用户内核：**改名，不是删除**。
   *
   * 内核目录是 3 万多个文件、300+ MB，`fs.rmSync` 实测要 13 秒，而这段代码跑在
   * 启动路径的主进程上 —— 同步删就等于应用假死 13 秒，然后才轮到回退重启。
   * 同卷 `rename` 只要 30ms，拿到干净状态后立刻就能重启，真正的删除挪到后台。
   * 带时间戳后缀是为了避免与上一次遗留的 `-broken` 目录撞名（撞了就得先删，
   * 又回到同步删的老路）。
   */
  const discardUserKernel = () => {
    const trash = `${USER_KERNEL_DIR}-broken-${Date.now()}`;
    try {
      fs.renameSync(USER_KERNEL_DIR, trash);
    } catch (e) {
      // 改名失败（文件被占用等）：退回同步删除。慢，但总比留着坏内核每次启动
      // 都崩一遍强。
      console.warn('[app] 用户内核改名失败，退回同步删除:', e?.message ?? e);
      try { fs.rmSync(USER_KERNEL_DIR, { recursive: true, force: true }); } catch (e2) {
        console.warn('[app] 删除用户内核失败:', e2?.message ?? e2);
      }
      return;
    }
    sweepDiscardedKernels();
  };

  /**
   * 后台清掉所有 `-broken-*` 残骸。异步 rm 走 libuv 线程池，不占主线程；
   * 中途退出应用也没关系，下次启动这里会再扫一遍。
   */
  const sweepDiscardedKernels = () => {
    const parent = path.dirname(USER_KERNEL_DIR);
    const prefix = `${path.basename(USER_KERNEL_DIR)}-broken-`;
    fs.promises.readdir(parent)
      .then((names) => Promise.all(names
        .filter((n) => n.startsWith(prefix))
        .map((n) => fs.promises.rm(path.join(parent, n), { recursive: true, force: true })
          .then(() => console.log('[app] 已清理损坏内核残骸:', n))
          .catch((e) => console.warn('[app] 清理残骸失败:', n, e?.message ?? e)))))
      .catch(() => {});
  };

  const showWindow = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.flashFrame(false);
  };

  const closeSplash = () => {
    if (splash && !splash.isDestroyed()) {
      splash.destroy();
    }
    splash = null;
  };

  /**
   * Windows 通知（toast）要求应用有一个指向它的开始菜单快捷方式，且快捷方式的
   * AppUserModelID 与 app.setAppUserModelId 一致。安装版由安装器创建；绿色版 /
   * win-unpacked 没有，这里首次启动时补建一个，否则后台通知会静默丢失。
   */
  const ensureStartMenuShortcut = () => {
    if (process.platform !== 'win32') return;
    try {
      const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DeepSeek Harness Desktop.lnk');
      // 已存在则跳过：每次启动重写 .lnk 会做一次磁盘 + shell 写，属启动路径上的冗余开销。
      if (fs.existsSync(lnk)) return;
      shell.writeShortcutLink(lnk, 'replace', {
        target: process.execPath,
        appUserModelId: APP_ID,
        description: 'DeepSeek Harness Desktop',
      });
    } catch (error) {
      console.warn('[app] 创建开始菜单快捷方式失败:', error?.message ?? error);
    }
  };

  const notifications = new TaskNotifications({
    logger: console,
    onActivate: showWindow,
    onAttention: () => { if (win && !win.isDestroyed()) win.flashFrame(true); },
  });

  const toggleWindow = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isVisible() && !win.isMinimized()) win.hide();
    else showWindow();
  };

  const quitApp = () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    closeSplash();
    destroyUpdaterWindow();
    if (tray) {
      tray.destroy();
      tray = null;
    }
    app.quit();
  };

  // 崩溃弹框同一时刻只允许一个，避免内核反复崩溃时弹框风暴。
  let crashDialogOpen = false;

  /**
   * 把内核崩溃摆到用户面前，并给出「重启内核 / 退出」两个出口。
   * 静默失败是这个应用历史上最严重的体验问题（窗口打开、内容全黑、毫无提示），
   * 所以这条路径上宁可打扰用户，也绝不吞掉错误。
   */
  /** @param {{code?: number|null, signal?: string|null, detail?: string, title?: string, message?: string, retryLabel?: string}} info */
  const reportKernelCrash = ({ code, signal, detail, title, message, retryLabel }) => {
    if (isQuitting || crashDialogOpen) return;
    crashDialogOpen = true;
    closeSplash();
    const where = typeof code === 'number'
      ? `（code=${code}${signal ? ` signal=${signal}` : ''}）`
      : '';
    let choice = 1;
    try {
      choice = dialog.showMessageBoxSync({
        type: 'error',
        title: title ?? 'DeepSeek 内核已停止',
        message: message ?? `dsh 内核已退出${where}`,
        detail: summarizeStderr(detail),
        buttons: [retryLabel ?? '重启内核', '退出'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
    } finally {
      crashDialogOpen = false;
    }
    if (choice === 0) restartKernel();
    else quitApp();
  };

  /** 丢弃当前内核实例并重新拉起一个（崩溃后恢复用）。 */
  const restartKernel = () => {
    if (isQuitting) return;
    const old = dsh;
    dsh = null;
    if (!old) return startDsh();
    old.removeAllListeners();
    old.stop().finally(() => { if (!isQuitting) startDsh(); });
  };

  const startDsh = () => {
    // 捕获本次实例：回退 / 重启会把 dsh 换成新对象，旧实例的事件必须能被识别并忽略。
    const service = new DshService({
      logger: console,
      userKernelDir: USER_KERNEL_DIR,
      pluginsDir: PLUGINS_DIR,
      activationPatchPath: ACTIVATION_PATCH_PATH,
    });
    dsh = service;

    service.on('ready', (url) => {
      console.log(`[app] dsh 就绪: ${url}`);
      notifications.setBaseUrl(url);
      notifications.start();
      if (win && !win.isDestroyed()) {
        win.loadURL(url).catch(() => {});
      } else {
        win = createMainWindow(url, {
          onCloseRequest,
          onFocusChanged: (focused) => {
            notifications.setFocused(focused);
            // 窗口重新获得焦点即停止任务栏闪烁。
            if (focused) win?.flashFrame(false);
          }
        });
        // 主窗口真正显示（首帧就绪）后再关闪屏，避免中间出现空白帧。
        win.once('show', closeSplash);
        if (!tray) {
          tray = createTray({
            onShow: toggleWindow,
            onQuit: quitApp,
            onCheckUpdate: openUpdater,
            onFeedback: openFeedback,
            kernelVersion: updater ? updater.getCurrentVersion() : null,
          });
        }
      }
    });

    service.on('error', (err) => {
      if (dsh !== service || isQuitting) return;
      console.error('[app] dsh 错误:', err);
      // 用户内核（热更新产物）启动失败：删掉损坏产物，回退内置内核重试一次，
      // 避免一次失败的内核更新把应用卡死。
      if (service.usingUserKernel && !kernelFallbackAttempted) {
        kernelFallbackAttempted = true;
        console.warn('[app] 用户内核启动失败，弃用并回退内置内核:', USER_KERNEL_DIR);
        discardUserKernel();
        // 这里**不要** closeSplash()：闪屏要一直留到内置内核起来、主窗口首帧
        // 就绪为止（由下面的 win.once('show', closeSplash) 关）。早关一步，用户
        // 就会看着窗口消失、然后对着空屏幕等几秒 —— 那正是当初加闪屏要消灭的
        // 「点了没反应」，而且更像崩溃。第二次仍然失败会落到下面的分支，
        // 那里会关掉闪屏并弹出错误框，不会挂死。
        dsh = null;
        service.removeAllListeners();
        service.stop().finally(() => { if (!isQuitting) startDsh(); });
        return;
      }
      closeSplash();
      const msg = String(err && err.message ? err.message : err);
      // 有没有主窗口都走同一套「说明原因 + 给出出口」的弹框。不用 showErrorBox：
      // 它的窗口标题被系统固定成 Error，而且只有一个确定按钮、没有恢复入口。
      reportKernelCrash({
        detail: msg,
        title: 'DeepSeek 启动失败',
        message: 'dsh 内核启动失败，无法进入主界面',
        retryLabel: '重试',
      });
    });

    service.on('exit', ({ code, signal, crashed, detail }) => {
      console.log(`[app] dsh 退出 code=${code} signal=${signal}`);
      if (dsh !== service || isQuitting || !crashed) return;
      // 就绪前崩溃已由 'error' 处理（含内核回退），这里只管就绪「后」的崩溃：
      // 早期版本此处只是 loadURL('about:blank')，用户得到一个没有任何说明、
      // 也没有恢复入口的黑屏。
      if (!service.ready) return;
      reportKernelCrash({ code, signal, detail });
    });

    service.start().catch((err) => console.error('[app] 启动失败:', err));
  };

  const onCloseRequest = (event) => {
    if (!isQuitting) {
      event.preventDefault();
      if (win && !win.isDestroyed()) win.hide();
    }
  };

  const initUpdater = () => {
    const created = new KernelUpdater({
      logger: console,
      userKernelDir: USER_KERNEL_DIR,
      builtinKernelDir: BUILTIN_KERNEL_DIR,
      pluginsDir: PLUGINS_DIR,
      configPath: UPDATER_CONFIG_PATH,
      pnpmCliPath: PNPM_CLI_PATH,
      builtinNodeExe: BUILTIN_NODE_EXE,
      pnpmStoreDir: PNPM_STORE_DIR,
      activationPatchPath: ACTIVATION_PATCH_PATH,
      onRestart: () => {
        // 重启以应用更新：先清理 dsh 子进程（app.exit 会跳过 before-quit/will-quit，
        // 需手动 stop，避免孤儿进程占用端口），再 relaunch + exit。
        isQuitting = true;
        const doRelaunch = () => { app.relaunch(); app.exit(0); };
        if (dsh && !dsh.stopped) {
          dsh.stopped = true;
          dsh.stop().finally(doRelaunch);
        } else {
          doRelaunch();
        }
      },
    });

    updater = created;

    // 内核更新完成后重建托盘菜单，让上面显示的版本号跟着变。
    created.on('state', (state) => {
      if (state.phase !== 'done' || !tray) return;
      tray.setContextMenu(buildTrayMenu({
        onShow: toggleWindow,
        onQuit: quitApp,
        onCheckUpdate: openUpdater,
        onFeedback: openFeedback,
        kernelVersion: state.currentVersion,
      }));
    });

    ipcMain.handle('updater:get-state', () => created.getState());
    ipcMain.handle('updater:check', () => created.check());
    ipcMain.handle('updater:start-update', () => created.startUpdate());
    ipcMain.handle('updater:restart', () => created.restart());
    ipcMain.handle('updater:close', () => hideUpdaterWindow());
    ipcMain.handle('updater:cycle-registry', () => created.cycleRegistry());
  };

  const openUpdater = () => {
    if (!updater) return;
    showUpdaterWindow({ updater, mainWindow: win });
    updater.check().catch((err) => console.error('[app] 检查更新失败:', err));
  };

  const openFeedback = () => {
    shell.openExternal(ISSUES_URL).catch((err) => console.error('[app] 打开反馈页面失败:', err));
  };

  // 启动后延迟自动检查：距上次检查超过 24h 才请求。发现新版本才弹更新中心
  // （和托盘手动点「检查内核更新」打开的是同一个窗口）；没有新版本就什么都不做，
  // 不弹窗、不提示，安安静静地检查完就结束。
  const maybeAutoCheck = () => {
    // 节流状态由 updater 持有：它构造时就把 updater.json 读进来了，这里再读一遍
    // 等于同一份配置两个读者，迟早不一致。
    if (!updater || !updater.shouldAutoCheck()) return;
    setTimeout(() => {
      if (isQuitting || !updater) return;
      const u = updater;
      u.check().then((state) => {
        if (state.phase === 'available') showUpdaterWindow({ updater: u, mainWindow: win });
      }).catch(() => {});
    }, 8000);
  };

  ipcMain.on('window:minimize', () => win && win.minimize());
  ipcMain.on('window:maximize', () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.on('window:close', () => win && win.close());

  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) showWindow();
    else if (splash && !splash.isDestroyed()) splash.focus();
  });

  app.whenReady().then(() => {
    // 先弹闪屏给用户即时反馈，再并行做内核启动等耗时初始化。
    splash = createSplashWindow();
    ensureStartMenuShortcut();
    globalShortcut.register('CommandOrControl+Alt+Space', toggleWindow);
    initUpdater();
    maybeAutoCheck();
    // 上次弃用内核时若删到一半被杀掉，残骸会留在磁盘上（300+ MB）。异步清一遍，
    // 不占启动路径。
    sweepDiscardedKernels();
    startDsh();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    notifications.stop();
    closeSplash();
    destroyUpdaterWindow();
  });

  app.on('will-quit', (event) => {
    if (updater) updater.cancel();
    if (dsh && !dsh.stopped) {
      event.preventDefault();
      dsh.stopped = true;
      dsh.stop().finally(() => app.exit(0));
    }
  });

  app.on('window-all-closed', () => {
    // 保持托盘驻留；仅显式退出时真正退出。
  });
}
