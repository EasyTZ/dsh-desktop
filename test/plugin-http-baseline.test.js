'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadPluginManifest, resolvePluginSrcDir } = require('../src/shared/plugin-install');

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

/** 解析出每个插件的 host 半入口源码（联调态下 node_modules 里是指向工作副本的链接）。 */
function hostEntries() {
  const plugins = loadPluginManifest(path.join(ROOT, 'plugins'));
  return plugins.map((plugin) => {
    const dir = resolvePluginSrcDir({
      pluginsDir: path.join(ROOT, 'plugins'),
      nodeModulesDir: path.join(ROOT, 'node_modules'),
      packageName: plugin.packageName,
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const main = typeof pkg.main === 'string' ? pkg.main : 'lib/index.js';
    return {
      packageName: plugin.packageName,
      file: path.join(dir, ...main.split('/')),
    };
  });
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
