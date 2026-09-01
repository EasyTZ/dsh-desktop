'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isNewer } = require('../shared/version');

const RELEASES_LATEST_URL = 'https://api.github.com/repos/EasyTZ/dsh-desktop/releases/latest';
// 距上次「成功」检查不足这个时长就不再自动查——跟内核更新用的是同一个节流常量值，
// 含义也一样：不是「用户会不会点更新」的问题，是没必要一天查好几次 GitHub API。
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 外壳自身版本的更新检查。跟内核更新（kernel-updater.js）是两回事：内核能在
 * 本地热更新替换，外壳是签名安装包 / 绿色版 zip，运行中替换不了自己的 exe，
 * 也没有「重启后切到新版」这种中间态可用。所以这里只做「查 GitHub 最新
 * Release、比对版本号、发现新版就提醒」，不下载、不安装——用户点了提醒之后
 * 去哪下载、装成安装版还是绿色版，都还是他自己的选择。
 *
 * 不用 electron-updater：CLAUDE.md 定死了「不引第三方运行时依赖」，这条规则
 * 没有为外壳自更新单开例外，何况差分静默更新对未签名的绿色版 zip 也用不上。
 *
 * `_fetchLatestRelease` / `_notify` 单独拆成可覆盖的方法，是为了让测试能在
 * 不联网、不弹真通知的前提下驱动 check()——参照 kernel-updater.test.js 换掉
 * `_fetchLatest` 的做法。
 */
class AppUpdateChecker {
  constructor(opts = {}) {
    this.logger = opts.logger ?? console;
    this.currentVersion = opts.currentVersion;
    this.configPath = opts.configPath;
    this._config = this._loadConfig();
    /** @type {{ phase: string, latestVersion: string|null, releaseUrl: string|null, error: string|null }} */
    this.state = { phase: 'idle', latestVersion: null, releaseUrl: null, error: null };
  }

  _loadConfig() {
    try {
      if (this.configPath && fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      }
    } catch (error) {
      this.logger.warn('[app-updater] 读取配置失败:', error?.message ?? error);
    }
    return {};
  }

  _saveConfig() {
    try {
      if (!this.configPath) return;
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this._config, null, 2) + '\n');
    } catch (error) {
      this.logger.warn('[app-updater] 写入配置失败:', error?.message ?? error);
    }
  }

  shouldAutoCheck() {
    const last = this._config.lastCheck;
    return !last || Date.now() - last > AUTO_CHECK_INTERVAL_MS;
  }

  /** @returns {Promise<{ version: string, url: string|null }>} */
  async _fetchLatestRelease() {
    const res = await fetch(RELEASES_LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
    const json = await res.json();
    const tag = typeof json?.tag_name === 'string' ? json.tag_name : '';
    if (!tag) throw new Error('Release 信息里没有 tag_name');
    return {
      version: tag.replace(/^v/, ''),
      url: typeof json?.html_url === 'string' ? json.html_url : null,
    };
  }

  /** 真弹系统通知；测试会整个覆盖掉这个方法，不走这条代码路径。 */
  _notify(version, releaseUrl) {
    try {
      const { Notification, shell } = require('electron');
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: 'DeepSeek Harness Desktop 有新版本',
        body: `v${version} 已发布，点击查看下载页`,
        silent: false,
      });
      n.on('click', () => {
        if (releaseUrl) shell.openExternal(releaseUrl).catch(() => {});
      });
      n.show();
    } catch (error) {
      this.logger.warn('[app-updater] 弹通知失败:', error?.message ?? error);
    }
  }

  async check() {
    this.state = { phase: 'checking', latestVersion: null, releaseUrl: null, error: null };
    try {
      const { version: latestVersion, url: releaseUrl } = await this._fetchLatestRelease();
      this._config.lastCheck = Date.now();

      if (isNewer(latestVersion, this.currentVersion)) {
        this.state = { phase: 'available', latestVersion, releaseUrl, error: null };
        // 同一个版本只提醒一次：不然每天一次的自动检查会在「用户已经看到过、
        // 还没来得及升级」的这几天里天天重复弹通知，从提醒变成骚扰。托盘菜单
        // 不受这条节流限制——它是静态展示，不是主动打扰。
        if (this._config.notifiedVersion !== latestVersion) {
          this._config.notifiedVersion = latestVersion;
          this._notify(latestVersion, releaseUrl);
        }
      } else {
        this.state = { phase: 'up-to-date', latestVersion, releaseUrl, error: null };
      }
      this._saveConfig();
    } catch (error) {
      this.state = { phase: 'error', latestVersion: null, releaseUrl: null, error: error?.message ?? String(error) };
      this.logger.warn('[app-updater] 检查更新失败:', this.state.error);
    }
    return this.state;
  }

  getState() {
    return this.state;
  }
}

module.exports = { AppUpdateChecker, AUTO_CHECK_INTERVAL_MS };
