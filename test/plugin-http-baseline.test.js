'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePluginSrcDir } = require('../src/shared/profile-plugins');
const { loadProfilePluginManifest } = require('../src/shared/profile-plugins');

// 插件的 HTTP 路由安全基线，逐个插件核一遍。
//
// 为什么这条测试住在**主仓库**而不是各个插件仓库里：拆仓之后，「这个插件自己
// 是对的」和「四个插件是同一套防线」变成了两件事，后者在任何单个插件仓库里都
// 测不了 —— 只有主仓库同时 vendor 了全部四个，能一次看全。
//
// 它防的是一个真实发生过的失误：终端面板里写了完整的 Origin / Content-Type 威
// 胁模型和防线，另外三个插件却一个都没有，而 dsh-git 恰恰是唯一有 commit /
// push / undo-commit 这类**会改用户仓库**的写路由的那个。同一个威胁在四个仓库
// 里有四种待遇，纯粹是因为没有任何东西会因此变红。
//
// 诚实说明这条测试查的是什么：它做的是**文本存在性检查**，只能保证防线「在」，
// 不能保证它「对」。防线本身是否正确由各插件仓库自己负责；这里守的是「新加一
// 个插件时不会整套忘掉」。这个粒度是刻意的 —— 跨进程真起一个 webServer 来发
// 跨源请求，成本远高于它能多抓到的东西。

const ROOT = path.join(__dirname, '..');

// 这条测试读的是**当前解析到的插件源码**：联调态读工作副本，非联调态读
// node_modules 里按 tag 拉下来的那份。所以它报红有两种含义，看一眼
// `npm run plugins-status` 就能分清：
//   - 联调中 → 你手上的代码真的缺防线，补上；
//   - 已解除 → 钉住的 tag 里还没有这条防线，需要给插件发新 tag 并升 package.json
//     的 pin。这不是误报，安装包里装的就是那份没防线的代码。
const HINT = '（非联调态报红 = 钉住的 tag 还不含这条防线，需发新 tag 并升 pin）';

/**
 * 解析出每个插件的两半入口源码（联调态下 node_modules 里是指向工作副本的链接）。
 */
function pluginEntries() {
  // 读 **profile 清单**（A1）。插件迁到 profile 层之后 plugins.json 就空了，而这里
  // 原先读的正是它——六条断言遍历 0 个对象、全部空转通过，等于这道防线安静地消失了。
  // 「测试还绿着」和「测试还在测东西」是两回事，这就是那个区别的实例。
  const plugins = loadProfilePluginManifest(path.join(ROOT, 'plugins'));
  return plugins.map((plugin) => {
    const dir = resolvePluginSrcDir({
      pluginsDir: path.join(ROOT, 'plugins'),
      nodeModulesDir: path.join(ROOT, 'node_modules'),
      packageName: plugin.packageName,
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const main = typeof pkg.main === 'string' ? pkg.main : 'lib/index.js';
    // 插件可以**只有 host 半**：dsh-plugin-manager 的面板并进插件市场之后，它就只剩
    // 路由、不再有浏览器半。没有 `./client` 导出时 clientFile 给 null，由调用方跳过，
    // 而不是退回一个猜出来的路径去读——那样读不到会抛，把「这插件没有 UI」这个正常
    // 情况报成测试失败。
    const client = pkg.exports?.['./client']?.default ?? null;
    return {
      packageName: plugin.packageName,
      dir,
      pkg,
      file: path.join(dir, ...main.split('/')),
      clientFile: client === null ? null : path.join(dir, ...client.replace(/^\.\//, '').split('/')),
    };
  });
}

/** 只要 host 半的入口（大多数基线只看它）。 */
function hostEntries() {
  return pluginEntries();
}

test('每个插件的 host 半都定义了 originAllowed，并真的调用了它', () => {
  for (const { packageName, file } of hostEntries()) {
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, /function originAllowed\s*\(/, `${packageName} 缺少 originAllowed 定义${HINT}`);
    // 定义了不调用等于没有 —— 必须出现在一个真实的调用位置上。
    assert.match(src, /!originAllowed\(req,/, `${packageName} 定义了 originAllowed 却没有在路由里调用${HINT}`);
  }
});

test('有 POST 路由的插件必须同时有 Content-Type 检查', () => {
  // Origin 头在「无 preflight 的简单请求」里可以缺席，光靠 Origin 挡不住用
  // text/plain 发出来的跨源 POST；两条检查是配套的，只有一条等于没有。
  for (const { packageName, file } of hostEntries()) {
    const src = fs.readFileSync(file, 'utf8');
    if (!/"POST"/.test(src)) continue; // 纯 GET 的插件（如余额查询）不需要
    assert.match(src, /function requireJson\s*\(/, `${packageName} 有 POST 路由但缺少 requireJson${HINT}`);
    assert.match(src, /!requireJson\(req\)/, `${packageName} 定义了 requireJson 却没有调用${HINT}`);
  }
});

test('originAllowed 的实现在四个插件之间保持一致', () => {
  // 这条防线的语义必须处处相同：一个插件把 localhost 漏掉、另一个把 https 放行，
  // 排查起来会比没有防线更费劲。无编译、单文件、零依赖是这些插件能被别人整个抄
  // 走就用的前提，所以这里的正确做法是「复制 + 校验一致」，而不是抽一个公共包
  // 给四个零依赖插件引入一个必须同步升版本的依赖。
  const bodies = hostEntries().map(({ packageName, file }) => {
    const src = fs.readFileSync(file, 'utf8');
    const start = src.indexOf('function originAllowed');
    assert.ok(start >= 0, `${packageName} 缺少 originAllowed`);
    const end = src.indexOf('\n}', start);
    // 去掉缩进与空行再比，避免纯格式差异造成假红。
    const body = src.slice(start, end).replace(/\s+/g, ' ').trim();
    return { packageName, body };
  });

  const [first, ...rest] = bodies;
  for (const other of rest) {
    assert.strictEqual(
      other.body, first.body,
      `${other.packageName} 的 originAllowed 与 ${first.packageName} 不一致 —— 同一个威胁必须同一种处理`,
    );
  }
});

// ---------------------------------------------------------------------------
// 全局命名空间护栏
// ---------------------------------------------------------------------------
//
// 桌面端插件跑在**上游内核的进程里**，而内核会自己热更新到新版本。凡是「上游也
// 往里写、撞了就抛」的全局命名空间，我们都必须主动避开，否则撞车只是时间问题，
// 且发生在用户机器上、表现为黑屏。已知有三个这样的命名空间：
//
//   1. cordis loader 的 entryId  —— `- insert:` 不去重，重复 id 抛
//      `duplicate loader entry id`。由 plugin-install.test.js 的 `dsdesktop-`
//      前缀规则守着。
//   2. cordis 的服务名 —— `ctx.provide` 见到已注册的名字直接抛
//      `service "x" has been registered at <...>`。上游当前 70 个服务名全是
//      `fs` / `shell` / `web` / `storage` / `sessions` / `terminals` 这类通用词，
//      我们曾经注册过 `git`、`balance`，正落在这个词表里。
//   3. webServer 的路由路径 —— `register` 见到重复 (kind, path) 直接抛
//      `webserver: duplicate exact route "..."`（上游源码注释原话：路由模式是
//      composition 级别的契约，撞了就是配置错误）。
//
// 第 1 条靠前缀解决，第 2 条靠**根本不占名字**解决（这些插件不向任何人提供能力，
// 用文档里的函数形式写即可），第 3 条靠统一前缀解决。下面三条测试分别守住 2 和 3。

/** 所有桌面端插件的路由必须挤在这个我们自己说了算的前缀下。 */
const ROUTE_PREFIX = '/api/dsdesktop/';

test('host 半一律是函数形式的插件，不注册任何 cordis 服务名', () => {
  // 服务名撞车 = boot 阶段抛异常 = 内核秒退 = 桌面端黑屏，和 duplicate loader
  // entry id 是同一类事故。这些插件一个都没有消费者（浏览器半走 HTTP），占名
  // 字纯亏。文档的函数形式（inject + apply）不碰服务表。
  for (const { packageName, file } of hostEntries()) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      src, /extends\s+Service/,
      `${packageName} 的 host 半是 Service 子类 —— 会占一个 cordis 服务名，撞上上游就是内核秒退${HINT}`,
    );
    assert.doesNotMatch(
      src, /super\s*\(\s*ctx\s*,/,
      `${packageName} 的 host 半在注册 cordis 服务名${HINT}`,
    );
    assert.match(
      src, /export function apply\s*\(/,
      `${packageName} 的 host 半缺少 export function apply —— 函数形式插件的入口${HINT}`,
    );
    assert.match(
      src, /export const inject\s*=/,
      `${packageName} 的 host 半缺少 export const inject${HINT}`,
    );
  }
});

test('路由路径全部来自一个 /api/dsdesktop/ 常量，不散落在 register 调用里', () => {
  for (const { packageName, file } of hostEntries()) {
    const src = fs.readFileSync(file, 'utf8');
    const declared = /const ROUTE(?:_PREFIX)? = "([^"]+)"/.exec(src);
    assert.ok(declared, `${packageName} 的 host 半没有 ROUTE / ROUTE_PREFIX 常量${HINT}`);
    assert.ok(
      declared[1].startsWith(ROUTE_PREFIX),
      `${packageName} 的路由常量是 ${declared[1]}，必须以 ${ROUTE_PREFIX} 开头${HINT}`,
    );
    // 常量存在但 register 里又写死一条字面量路径，等于常量白设。
    assert.doesNotMatch(
      src, /path:\s*"/,
      `${packageName} 在 webServer.register 里写死了路径字面量，应当由路由常量拼出${HINT}`,
    );
  }
});

test('浏览器半只请求 /api/dsdesktop/ 下的路径', () => {
  // 两半的路径是各写一遍的（host 注册、client fetch），改了一边忘了另一边就是
  // 「面板打开后一片 404」。这条把漂移在测试里抓住。
  for (const { packageName, clientFile } of pluginEntries()) {
    if (clientFile === null) continue; // 只有 host 半的插件没有可查的 fetch 路径
    const src = fs.readFileSync(clientFile, 'utf8');
    for (const [match] of src.matchAll(/\/api\/[a-zA-Z0-9./_-]+/g)) {
      assert.ok(
        match.startsWith(ROUTE_PREFIX),
        `${packageName} 的浏览器半请求了 ${match}，不在 ${ROUTE_PREFIX} 前缀下${HINT}`,
      );
    }
  }
});
