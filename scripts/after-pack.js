'use strict';

// 打包完成后的两件收尾：裁语言包（全平台）、给 .app 做 ad-hoc 签名（仅 mac）。
//
// 为什么是 afterPack 而不是 beforeBuild：两件事的对象都是 electron-builder 已经
// 摆好的 appOutDir，之前不存在。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 保留的语言包。界面是中文，英文是 Chromium 的兜底语言。 */
const KEEP = new Set(['en-US.pak', 'zh-CN.pak']);

/**
 * 裁掉用不到的 Electron 语言包。
 *
 * locales/ 下有 55 个 .pak、46.6 MB，而这些只影响 Chromium 自带 UI 的文案（右键
 * 菜单、错误页），我们自己的界面与 dsh 的 web 应用都自带 i18n。Chromium 找不到
 * 请求的语言时回退 en-US，所以留 en-US + zh-CN 就够。
 *
 * macOS 的语言包在 `.app` 内部的 Electron Framework 里，而且是**每个 locale 一个
 * `.lproj` 目录**，跟这里假设的「一堆扁平 .pak」结构完全不同 —— 探测不到就直接
 * 跳过。省那 ~45MB 要另写一套遍历，没有 Mac 验证不了，不在这里猜。
 */
function pruneLocales(appOutDir) {
  const localesDir = path.join(appOutDir, 'locales');
  if (!fs.existsSync(localesDir)) return;

  let removed = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(localesDir)) {
    if (!name.endsWith('.pak') || KEEP.has(name)) continue;
    const full = path.join(localesDir, name);
    bytes += fs.statSync(full).size;
    fs.rmSync(full);
    removed += 1;
  }
  console.log(`  • 裁掉未用语言包  count=${removed} saved=${(bytes / 1024 / 1024).toFixed(1)}MB`);
}

/**
 * 给 `.app` 做 **ad-hoc 签名**（仅 macOS 目标，且只在 macOS 上能跑）。
 *
 * **为什么非签不可**：Apple Silicon 的内核**拒绝执行没有有效签名的二进制** ——
 * 不是 Gatekeeper 弹窗让你右键打开，是根本起不来。而 electron-builder 改动过
 * bundle（改名、塞 extraResources），Electron 自带的那份签名此时已经失效。
 *
 * **为什么要我们自己做**：原以为 electron-builder 找不到证书时会自己 ad-hoc 签，
 * **实测不会** —— CI 日志里明确写着
 * `skipped macOS application code signing ... allIdentities= 0 identities found`，
 * 它是整个跳过。这条假设错了整整一轮，所以在这里补上。
 *
 * ad-hoc 签名（`--sign -`）免费、不需要任何 Apple 账号，只需要 Xcode CLT（macOS
 * runner 自带）。它买到的是「能执行」；买不到「双击直接打开」—— 那需要 Developer
 * ID + 公证（99 USD/年），已决定不买，用户首次需在「隐私与安全」里确认打开。
 *
 * `--deep` 会连同嵌套的可执行文件一起签。这会覆盖 npm 分发的那些 darwin 二进制
 * （rg、sharp / koffi / node-pty 的 .node）原有的发布方签名 —— **可以接受**：
 * 我们并不依赖那些签名做任何校验，而 ad-hoc 同样满足 arm64 的执行要求。Apple 不
 * 推荐 `--deep` 用于正式分发（应当逐层签），但那条建议针对的是 Developer ID +
 * 公证的场景，跟这里不是一回事。
 *
 * 失败即**中止构建**：不像裁语言包那样可以跳过 —— 签不上就等于打出一个在 Apple
 * Silicon 上根本起不来的包，那种产物发出去比构建失败糟糕得多。
 */
function adhocSignMacApp(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.platform !== 'darwin') {
    // 交叉打包 mac 时（理论上做不到，这里只是防呆）没有 codesign 可用。
    console.log('  • 跳过 ad-hoc 签名：当前不在 macOS 上');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) {
    throw new Error(`ad-hoc 签名找不到 .app：${appPath}`);
  }

  // Finder、浏览器或文件提供器可能给源 Electron.app 写入 FinderInfo / ResourceFork
  // 等扩展属性，electron-builder 拷贝时会一并带进输出。codesign 对这种元数据会
  // 直接报 “resource fork, Finder information, or similar detritus not allowed”。
  // 输出包尚未签名，这时清掉整棵 .app 的扩展属性是确定且安全的构建归一化步骤；
  // 必须放在签名前，签完再改任何元数据都会破坏刚生成的签名。
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });

  console.log(`  • ad-hoc 签名  ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });

  // 立刻验一遍。签完不验等于没签 —— codesign 在个别情况下会「成功」但产出一个
  // 校验不过的签名，那种问题留到用户机器上才发现就太晚了。
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
  console.log('  • ad-hoc 签名校验通过');
}

module.exports = async (context) => {
  pruneLocales(context.appOutDir);
  adhocSignMacApp(context);
};
