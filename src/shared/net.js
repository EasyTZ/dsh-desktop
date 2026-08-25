'use strict';

const net = require('node:net');

/**
 * 向 OS 申请一个空闲回环端口，然后立刻释放。
 *
 * 注意这里存在固有的 TOCTOU 竞态：释放到内核真正 bind 之间，端口理论上可能
 * 被别的进程抢走。实践中窗口极短，且抢走的后果是内核启动失败并被上层的崩溃
 * 处理捕获，不会静默。
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      // listen 到 TCP 端口后 address() 必然返回 AddressInfo；这里的断言只是
      // 告诉类型检查器排除 string | null 两个分支。
      const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

module.exports = { findFreePort };
