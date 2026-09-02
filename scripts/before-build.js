'use strict';

// dependencies 里只有插件的 git 依赖，它们只被 vendor 源码、不被运行时 require，
// 不需要 electron-builder 安装/rebuild/收集 node_modules。返回 false 告诉它依赖由
// 外部处理，跳过 installOrRebuild 与 node_modules 收集（同时避免其 spawn 子进程）。
module.exports = () => false;
