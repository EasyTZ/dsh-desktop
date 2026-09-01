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
const { needsUnpack, unpackKernel } = require('../shared/kernel-unpack');
const { kernelPaths } = require('../shared/kernel-paths');
const { showUpdaterWindow, hideUpdaterWindow, destroyUpdaterWindow } = require('./updater-window');
const { reconcileProfilePlugins } = require('./profile-plugins-installer');

const APP_ID = 'com.deepseek.desktop';
const ISSUES_URL = 'https://github.com/EasyTZ/dsh-desktop/issues/new/choose';
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
  // 安全模式：只加载清单里标了 safeMode 的插件（当前只有插件管理面板）。
  // **刻意只存在内存里**：重启应用就回到正常模式，不会让用户卡在安全模式里
  // 出不来，也不需要再造一个「怎么退出安全模式」的入口。
  let safeMode = false;

  // 内核与插件路径：打包态走 resourcesPath，开发态走仓库根。
  const BUILTIN_KERNEL_DIR = app.isPackaged
    ? path.join(process.resourcesPath, 'kernel')
    : path.join(__dirname, '..', '..', 'kernel');
  // 随包分发的插件产物根（打包态是 extraResources 里的 plugins/，开发态是仓库的
  // plugins-dist/）。里面现在只有 profile/ 一层 —— 见 PROFILE_DIST_DIR。
  const PLUGINS_DIST_ROOT = app.isPackaged
    ? path.join(process.resourcesPath, 'plugins')
    : path.join(__dirname, '..', '..', 'plugins-dist');
  const USER_KERNEL_DIR = path.join(app.getPath('userData'), 'kernel');
  const UPDATER_CONFIG_PATH = path.join(app.getPath('userData'), 'updater.json');
  // 插件停用 overlay（patch 层栈第 4 层）：启动时经 `--patch` 交给内核。插件迁到
  // profile 层之后它**只用来停用条目**，不再负责挂载任何东西 —— 常态下是一份空的
  // `[]`。放 userData 而不是 resources：打包态 resources 只读，且内容随开关变化。
  const ACTIVATION_PATCH_PATH = path.join(app.getPath('userData'), 'desktop.patch.yml');
  // 插件开关状态：插件市场的 node 半写、启动路径读。必须落在可写的 userData 下。
  const PLUGIN_STATE_PATH = path.join(app.getPath('userData'), 'plugin-state.json');

  // 给内核进程注入桌面版专属路径：写进 process.env 一次，之后所有内核子进程
  // （DshService 启动的、kernel-updater 自检的）自动继承——比在每个 spawn 点
  // 各拼一份可靠，将来新增 spawn 点也不会漏。插件市场的 node 半只认这些变量，
  // 绝不硬编码 %APPDATA% 之类的机器路径。
  process.env.DSH_DESKTOP_PLUGIN_STATE = PLUGIN_STATE_PATH;

  const PNPM_CLI_PATH = path.join(BUILTIN_KERNEL_DIR, 'pnpm', 'bin', 'pnpm.cjs');
  // pnpm 的 PATH 垫片：让内核进程里的 `dsh plugin add`（市场的一键安装、以及启动
  // 对账）能找到随包分发的 pnpm，而不要求用户机器上装过。见 profile-plugins-installer。
  const PNPM_SHIM_DIR = path.join(app.getPath('userData'), 'pnpm-shim');
  // 播种账本：记「随应用分发的插件，我们给这个用户播过哪些种」。
  // 它是「用户卸载了就别再装回来」这条语义的**唯一**依据——没有它就分不清
  // 「从没装过」和「装过但被卸了」，两种情况下 profile 里都是查无此包。
  const PROFILE_SEED_STATE_PATH = path.join(app.getPath('userData'), 'profile-plugins-seeded.json');
  // profile 层插件的产物（tgz + index.json）。打包态跟着 plugins 资源走；开发态在
  // 仓库的 plugins-dist/ 下 —— 那是 `npm run pack-profile-plugins` 的输出，没跑过就
  // 没有这个目录，对账会安静跳过，正是开发时想要的行为。
  const PROFILE_DIST_DIR = path.join(PLUGINS_DIST_ROOT, 'profile');
  // 插件市场要能列出「随应用分发的插件」并把被卸载的那些装回来 —— 装回来用的是这个
  // 目录里的 tgz，所以位置得告诉它。不注入的话，用户卸掉一个自带插件就再也装不回来了
  // （npm 上还没发，市场里搜不到），那是一扇单向门。
  process.env.DSH_DESKTOP_PROFILE_DIST = PROFILE_DIST_DIR;
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
    // 已经在安全模式里还崩，说明问题不在插件，再给一次安全模式没有意义。
    const offerSafeMode = !safeMode;
    const buttons = offerSafeMode
      ? [retryLabel ?? '重启内核', '安全模式启动', '退出']
      : [retryLabel ?? '重启内核', '退出'];
    const quitIndex = buttons.length - 1;
    let choice = quitIndex;
    try {
      choice = dialog.showMessageBoxSync({
        type: 'error',
        title: title ?? 'DeepSeek 内核已停止',
        message: message ?? `dsh 内核已退出${where}`,
        detail: summarizeStderr(detail)
          + (offerSafeMode
            ? '\n\n如果这是插件引起的，可以选择「安全模式启动」：只加载插件管理面板，'
              + '进去把可疑插件关掉再正常重启。'
            : ''),
        buttons,
        defaultId: 0,
        cancelId: quitIndex,
        noLink: true,
      });
    } finally {
      crashDialogOpen = false;
    }
    if (choice === quitIndex) return quitApp();
    if (offerSafeMode && choice === 1) return enterSafeMode();
    restartKernel();
  };

  /**
   * 以安全模式重启内核：跳过除插件管理面板外的所有插件。
   *
   * 这是「插件把内核搞崩」唯一的逃生舱 —— 那类故障没有别的自愈路径：回退内置
   * 内核没用（内置装着同一批插件、用同一份 overlay），删 %APPDATA% 也没用
   * （插件在安装目录、overlay 每次启动从清单重新生成），不留这条路用户就只能
   * 等下一个版本。
   */
  const enterSafeMode = () => {
    if (isQuitting) return;
    safeMode = true;
    console.warn('[app] 进入安全模式：只加载 safeMode 插件');
    dialog.showMessageBox({
      type: 'info',
      title: '安全模式',
      message: '正在以安全模式重启内核',
      detail: '本次启动只加载插件管理面板，其余插件一律跳过。\n\n'
        + '打开「设置 → 插件」把可疑插件关掉，然后重启应用即可恢复正常启动'
        + '（安全模式只对本次运行有效，不会记住）。',
      buttons: ['知道了'],
      noLink: true,
    }).catch(() => {});
    restartKernel();
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

  /**
   * 重启整个应用（先停内核再 relaunch）。内核更新后的「重启以应用更新」与
   * 插件管理面板的「重启生效」共用这一条已验证的路径：app.exit 会跳过
   * before-quit/will-quit，不先手动 stop 会留下占着端口的孤儿内核进程。
   */
  const restartApp = () => {
    isQuitting = true;
    const doRelaunch = () => { app.relaunch(); app.exit(0); };
    if (dsh && !dsh.stopped) {
      dsh.stopped = true;
      dsh.stop().finally(doRelaunch);
    } else {
      doRelaunch();
    }
  };

  const startDsh = () => {
    // 捕获本次实例：回退 / 重启会把 dsh 换成新对象，旧实例的事件必须能被识别并忽略。
    const service = new DshService({
      logger: console,
      userKernelDir: USER_KERNEL_DIR,
      activationPatchPath: ACTIVATION_PATCH_PATH,
      pluginStatePath: PLUGIN_STATE_PATH,
      safeMode,
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
      // 端口绑不上不是内核的错（系统保留端口段 / 安全软件拦截），删了用户内核
      // 只会让用户白白重下一次，回退的内置内核照样撞同一个问题。DshService 已经
      // 换端口重试过若干次，走到这里说明重试也没用，直接报错给用户看。
      if (err && /** @type {any} */ (err).code === 'port-bind-failed') {
        console.error('[app] 内核端口绑定失败，跳过内核回退');
      } else if (service.usingUserKernel && !kernelFallbackAttempted) {
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

    // profile 层插件（插件市场）先对账再起内核：内核在 boot 时就会读 profile 的
    // bundles 层，装晚了这一次启动就看不到面板。对账失败**不阻塞启动**——最坏是
    // 市场这一次不可用，而不是应用打不开，所以这里 catch 掉一切继续往下走。
    //
    // 常态开销为零：版本一致时只读两个 package.json 就返回，不 spawn 任何进程。
    reconcileProfilePlugins({
      profileDistDir: PROFILE_DIST_DIR,
      nodeExe: BUILTIN_NODE_EXE,
      // 用**内置**内核的 dsh 入口，而不是当前生效的那个（可能是热更新出来的用户内核）：
      // `plugin` 子命令只在 profile 目录里跑 pnpm 并 reconcile bundles，不依赖内核版本；
      // 而内置内核一定在，用户内核可能正处在更新的中间状态。
      binJs: kernelPaths(BUILTIN_KERNEL_DIR).binJs,
      pnpmCliPath: PNPM_CLI_PATH,
      shimDir: PNPM_SHIM_DIR,
      seedStatePath: PROFILE_SEED_STATE_PATH,
      logger: console,
    }).catch((err) => {
      console.warn('[app] profile 插件对账失败（不影响启动）:', err);
      return { shimDir: null };
    }).then((result) => {
      // 垫片目录进内核进程的 PATH：市场面板里的一键安装走的也是 `dsh plugin add`，
      // 它内部 spawn 裸 `pnpm`，用户机器上不一定装了。
      if (result && result.shimDir) service.pnpmShimDir = result.shimDir;
      return service.start();
    }).catch((err) => console.error('[app] 启动失败:', err));
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
      configPath: UPDATER_CONFIG_PATH,
      pnpmCliPath: PNPM_CLI_PATH,
      profileDistDir: PROFILE_DIST_DIR,
      builtinNodeExe: BUILTIN_NODE_EXE,
      pnpmStoreDir: PNPM_STORE_DIR,
      activationPatchPath: ACTIVATION_PATCH_PATH,
      pluginStatePath: PLUGIN_STATE_PATH,
      // 开发态热更新出的新内核要重装插件，其中 git 依赖插件在仓库 node_modules；
      // 打包态全部源码都在 resources/plugins，无需这处候选。
      nodeModulesDir: app.isPackaged ? null : path.join(__dirname, '..', '..', 'node_modules'),
      onRestart: restartApp,
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

  // 标题栏没能定位到 dsh 侧边栏：多半是上游改了那个 CSS Modules 类名。日志里
  // 上面就是 `[dsh] 内核: ...` 那一行，两条一起看就知道是哪个内核版本改的。
  ipcMain.on('titlebar:sidebar-probe-failed', (_e, timeoutMs) => {
    console.warn(`[titlebar] ${timeoutMs}ms 内未匹配到 dsh 侧边栏（[class*="sidebarCol"]），`
      + '标题栏左段宽度将保持默认。上游可能已改动该类名。');
  });

  ipcMain.on('window:minimize', () => win && win.minimize());
  ipcMain.on('window:maximize', () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.on('window:close', () => win && win.close());
  // 插件管理面板的「重启生效」按钮：走与内核更新相同的重启路径（先停内核再
  // relaunch，理由见 restartApp 的注释）。
  ipcMain.on('app:restart', restartApp);

  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) showWindow();
    else if (splash && !splash.isDestroyed()) splash.focus();
  });

  /** 闪屏上的状态文案。闪屏是我们自己的页面，直接改它的 DOM 即可。 */
  const setSplashStatus = (text) => {
    if (!splash || splash.isDestroyed()) return;
    splash.webContents.executeJavaScript(
      `{const el=document.querySelector('.status');if(el)el.textContent=${JSON.stringify(text)};}`
    ).catch(() => { /* 闪屏可能刚好被关掉，忽略 */ });
  };

  /**
   * 首次启动时把打包成单文件的出厂内核铺开。
   *
   * 绿色版里内核是一个 kernel.tar.gz —— 15444 个小文件交给资源管理器解压要 181 秒，
   * 打成一个文件后用户那一步几乎瞬间完成，这十几秒挪到这里由我们自己做（见
   * src/shared/kernel-unpack.js）。解包只在首次发生：成功后归档会被删掉。
   */
  const unpackBuiltinKernelIfNeeded = async () => {
    if (!needsUnpack(BUILTIN_KERNEL_DIR)) return true;
    try {
      const result = await unpackKernel({
        kernelDir: BUILTIN_KERNEL_DIR,
        fallbackDir: USER_KERNEL_DIR,
        logger: console,
        onStatus: setSplashStatus,
      });
      setSplashStatus('正在启动内核…');
      if (result.usedFallback) {
        console.warn(`[app] 出厂内核解到了用户目录：${result.dir}`);
      }
      return true;
    } catch (error) {
      console.error('[app] 内核解包失败:', error);
      closeSplash();
      reportKernelCrash({
        detail: `${error?.message ?? error}\n\n磁盘空间不足或安全软件拦截都可能导致这一步失败。`,
        title: 'DeepSeek 启动失败',
        message: '内核解包失败，无法进入主界面',
        retryLabel: '重试',
      });
      return false;
    }
  };

  app.whenReady().then(async () => {
    // 先弹闪屏给用户即时反馈，再并行做内核启动等耗时初始化。
    splash = createSplashWindow();
    ensureStartMenuShortcut();
    globalShortcut.register('CommandOrControl+Alt+Space', toggleWindow);
    initUpdater();
    maybeAutoCheck();
    // 上次弃用内核时若删到一半被杀掉，残骸会留在磁盘上（300+ MB）。异步清一遍，
    // 不占启动路径。
    sweepDiscardedKernels();
    // 解包必须在 startDsh 之前完成：没铺开之前内核根本不存在。失败时上面已经
    // 弹过说明框，这里直接不往下走（对话框的「重试」会重启应用）。
    if (!(await unpackBuiltinKernelIfNeeded())) return;
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
