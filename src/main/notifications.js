'use strict';

const { Notification } = require('electron');
const http = require('node:http');
const https = require('node:https');
const { randomUUID } = require('node:crypto');

const REMOTE_MUX_PATH = '/api/remote.mux';
const LEGACY_EVENTS_PATH = '/api/events.mux';
const REMOTE_EVENT_ENDPOINT = '$events';
const REMOTE_EVENT_PAYLOAD = { args: {} };
const RECONNECT_MS = 5000;

/**
 * 订阅 dsh 内核的转发事件流，在「任务完成」「待确认」时弹系统通知。
 *
 * 内核 0.1.2-rc.1 起使用 /api/remote.mux 多路复用 WebSocket：连上后要先用
 * `{ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }`
 * 打开一路事件流，随后收到的才是 `$events` 帧。内核 /api 请求需要签名 cookie；
 * Electron 主进程的 Node/undici WebSocket 没有 cookie jar，所以先拿 URL 行里的
 * launch token 换一次 cookie，再显式放进握手头。
 *
 * 0.1.1-rc.2 及更早的内核没有 launch token/cookie，地址行是干净的
 * `http://127.0.0.1:<port>`，事件通道还是旧的 /api/events.mux。开发态经常用全局
 * dsh 跑这个代码，因此 URL 没有 token 时自动退回旧协议，避免反复弹「HTTP 200」。
 *
 * 只在窗口未聚焦时通知（聚焦时用户看得到，不打扰）。
 */
class TaskNotifications {
  constructor(opts = {}) {
    this.logger = opts.logger ?? console;
    this.onActivate = opts.onActivate ?? null;
    // 每次真正弹出通知时回调（用于让主进程闪烁任务栏图标）。
    this.onAttention = opts.onAttention ?? null;
    this.baseUrl = null;
    this.focused = true;
    this.stopped = false;
    this.socket = null;
    this.streamId = null;
    this.connecting = false;
    this.reconnectTimer = null;
  }

  setBaseUrl(url) {
    this.baseUrl = url;
  }

  setFocused(focused) {
    this.focused = focused;
  }

  start() {
    if (this.stopped || !this.baseUrl) return;
    if (typeof WebSocket !== 'function') {
      this.logger.warn('[notify] 当前运行时不支持 WebSocket，系统通知不可用');
      return;
    }
    this.#connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.streamId = null;
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      try { socket.close(); } catch {}
    }
  }

  #connect() {
    if (this.stopped || !this.baseUrl || this.connecting) return;
    this.connecting = true;
    if (this.#hasLaunchToken()) {
      this.#acquireCookie()
        .then((cookie) => {
          if (this.stopped || !this.baseUrl) return;
          this.#openSocket(cookie);
        })
        .catch((error) => {
          this.logger.warn('[notify] 获取内核会话 cookie 失败:', error?.message ?? error);
          this.#scheduleReconnect();
        })
        .finally(() => {
          this.connecting = false;
        });
    } else {
      try {
        this.#openLegacySocket();
      } finally {
        this.connecting = false;
      }
    }
  }

  #hasLaunchToken() {
    try {
      return new URL(this.baseUrl).searchParams.has('token');
    } catch {
      return false;
    }
  }

  /**
   * 用地址行里的 launch token 换取 /api 鉴权 cookie。
   * @returns {Promise<string>} 可直接放进 Cookie 头的 name=value
   */
  #acquireCookie() {
    let url;
    try {
      url = new URL(this.baseUrl);
    } catch {
      return Promise.reject(new Error(`内核地址无效：${this.baseUrl}`));
    }
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.get(url, (res) => {
        res.resume();
        const setCookie = res.headers['set-cookie'];
        const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
        if (res.statusCode !== 303 || typeof raw !== 'string') {
          reject(new Error(`内核鉴权响应异常（HTTP ${res.statusCode ?? '无状态码'}）`));
          return;
        }
        const cookie = raw.split(';')[0].trim();
        if (!cookie) reject(new Error('内核鉴权响应里没有 set-cookie'));
        else resolve(cookie);
      });
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy(new Error('等待内核下发 cookie 超时'));
      });
    });
  }

  #openLegacySocket() {
    if (this.stopped || !this.baseUrl) return;
    let url;
    try {
      const u = new URL(LEGACY_EVENTS_PATH, this.baseUrl);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      url = u.toString();
    } catch {
      this.#scheduleReconnect();
      return;
    }

    let socket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.streamId = null;

    socket.addEventListener('message', (event) => this.#onMessage(socket, event && event.data));
    // 连接失败 / 断开统一走 close 重连；这里留空监听，避免无监听时的事件噪音。
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        this.streamId = null;
      }
      this.#scheduleReconnect();
    });
  }

  #openSocket(cookie) {
    if (this.stopped || !this.baseUrl) return;
    let url;
    try {
      const u = new URL(REMOTE_MUX_PATH, this.baseUrl);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      url = u.toString();
    } catch {
      this.#scheduleReconnect();
      return;
    }

    let socket;
    try {
      // 第二个参数在 W3C 那份 WebSocket 里是 protocols，只有 undici（主进程实际
      // 用的那个实现）额外认 `{ headers }`。tsconfig 的 lib 带了 DOM，checkJs 查到
      // 的是浏览器那份签名，于是把这个对象当成 protocols 报错——运行时没问题，是
      // 两份同名 API 的差异，所以断言一下。Cookie 为什么必须显式带，见类顶部注释。
      socket = new WebSocket(url, /** @type {any} */ ({ headers: { Cookie: cookie } }));
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.socket = socket;
    const streamId = randomUUID();
    this.streamId = streamId;

    socket.addEventListener('message', (event) => this.#onMessage(socket, event && event.data));
    // 连接失败 / 断开统一走 close 重连；这里留空监听，避免无监听时的事件噪音。
    socket.addEventListener('error', () => {});
    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.stopped) {
        try { socket.close(); } catch {}
        return;
      }
      try {
        socket.send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: REMOTE_EVENT_ENDPOINT,
          payload: REMOTE_EVENT_PAYLOAD,
        }));
      } catch (error) {
        this.logger.warn('[notify] 打开事件流失败:', error?.message ?? error);
        try { socket.close(); } catch {}
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        this.streamId = null;
      }
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.#connect(), RECONNECT_MS);
  }

  #onMessage(socket, data) {
    if (this.socket !== socket) return;
    if (typeof data === 'string') return this.#handleFrameText(data);
    if (data instanceof ArrayBuffer) return this.#handleFrameText(Buffer.from(data).toString('utf8'));
    if (ArrayBuffer.isView(data)) {
      return this.#handleFrameText(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'));
    }
    if (data && typeof data.text === 'function') {
      data.text().then((text) => this.#handleFrameText(text)).catch(() => {});
    }
  }

  #handleFrameText(text) {
    try {
      this.#handleFrame(JSON.parse(text));
    } catch {}
  }

  #handleFrame(json) {
    if (!json) return;
    // remote.mux：只有当前 stream 的 item 帧才是我们订阅的 $events 帧。
    if (json.type === 'item') {
      if (json.streamId === this.streamId) this.#handleValue(json.value);
      return;
    }
    // 旧内核：下行是 server-request 信封，真实 mux 帧在 payload 里。
    const payload = json.payload && typeof json.payload === 'object' ? json.payload : json;
    this.#handleLegacyValue(payload);
  }

  #handleValue(value) {
    if (!value || typeof value.type !== 'string') return;
    switch (value.type) {
      case 'ready':
      case 'cancel':
        return;
      case 'emit':
        this.#handleEmit(value);
        return;
      case 'waterfall':
        this.#handleWaterfall(value);
        return;
      default:
        return;
    }
  }

  #handleLegacyValue(payload) {
    if (!payload || typeof payload.type !== 'string') return;
    switch (payload.type) {
      case 'session/event': {
        const event = payload.event;
        if (event && event.type === 'turn/end') {
          this.#notify('任务完成', 'DeepSeek 已完成当前任务，等待你的下一步');
        }
        return;
      }
      case 'approval/requested':
        this.#notify('需要你的批准', `待批准操作：${payload.toolName ?? '未知操作'}`);
        return;
      case 'question/requested':
        this.#notify('需要你的回答', 'DeepSeek 有一个问题需要你确认');
        return;
      default:
        return;
    }
  }

  #handleEmit(frame) {
    if (frame.event !== 'api-session/status') return;
    // 当前转发事件源没有 turn/end；agent 从 running 回到 idle 即一轮任务结束。
    const running = frame.args && frame.args[1];
    if (running === false) {
      this.#notify('任务完成', 'DeepSeek 已完成当前任务，等待你的下一步');
    }
  }

  #handleWaterfall(frame) {
    switch (frame.event) {
      case 'approval/request':
        this.#notify('需要你的批准', `待批准操作：${frame.request?.toolName ?? '未知操作'}`);
        break;
      case 'user-questions/request':
        this.#notify('需要你的回答', 'DeepSeek 有一个问题需要你确认');
        break;
      default:
        break;
    }
  }

  #notify(title, body) {
    if (this.focused) return; // 窗口聚焦时不打扰
    if (!Notification.isSupported()) return;
    try {
      const n = new Notification({ title, body, silent: false });
      n.on('click', () => {
        if (typeof this.onActivate === 'function') this.onActivate();
      });
      n.show();
      if (typeof this.onAttention === 'function') this.onAttention();
    } catch (error) {
      this.logger.warn('[notify] 通知失败:', error?.message ?? error);
    }
  }
}

module.exports = { TaskNotifications };
