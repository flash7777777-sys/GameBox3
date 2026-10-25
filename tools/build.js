#!/usr/bin/env node
/*
 * GameBox 3 — tools/build.js
 * 打包独立 EXE（Node SEA + koffi 内嵌释放 + PE 无窗口补丁 + postject 注入）
 * 产物：dist/GameBox3.exe —— 双击即用，无需安装 Node
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const EXE_NAME = 'GameBox3.exe';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// 依赖解析：优先 tools/node_modules（历史布局），找不到则回退到项目根 node_modules
// （`npm install` 一般装在根目录），保证克隆后的仓库也能正常打包。
function inNodeModules(rel) {
  for (const base of [path.join(ROOT, 'tools', 'node_modules'), path.join(ROOT, 'node_modules')]) {
    const p = path.join(base, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const KOFFI_DIR = inNodeModules('koffi');
// koffi 原生平台包在 3.x 下可能是 @koromix/koffi-win32-x64 或 @koffi/koffi-win32-x64
const KOFFI_NATIVE_DIR =
  inNodeModules('@koromix/koffi-win32-x64') ||
  inNodeModules('@koffi/koffi-win32-x64');
const POSTJECT_API = inNodeModules('postject/dist/api.js');

function log(msg) { console.log('[build] ' + msg); }

/* ---------- 1. 收集 koffi 包文件（内嵌用） ----------
 * koffi 主包 + 平台原生包（@koromix/koffi-win32-x64，含 koffi.node）。
 * 平台包放在释放目录的 node_modules\ 下，保证 require('@koromix/...') 能解析。
 */
function collectKoffi() {
  const files = {};
  const includeExt = new Set(['.js', '.cjs', '.json', '.node', '.d.ts']);
  const skipDirs = new Set(['doc', 'vendor', 'lib']);
  function walk(dir, rel) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue; // 文档、编译依赖、C++ 源码不需要
        walk(full, r);
      } else if (includeExt.has(path.extname(ent.name).toLowerCase())) {
        files[r] = fs.readFileSync(full).toString('base64');
      }
    }
  }
  walk(KOFFI_DIR, '');
  if (fs.existsSync(KOFFI_NATIVE_DIR)) {
    walk(KOFFI_NATIVE_DIR, 'node_modules/@koromix/koffi-win32-x64');
  } else {
    console.error('[build] 警告：未找到 koffi 原生包 ' + KOFFI_NATIVE_DIR);
  }
  return files;
}

/* ---------- 2. 生成入口文件（模块打包 + koffi 释放） ---------- */
function buildEntry() {
  const koffiFiles = collectKoffi();
  const koffiSize = Object.values(koffiFiles).reduce((n, s) => n + s.length, 0);
  log('koffi 运行时已内联（' + Object.keys(koffiFiles).length + ' 个文件，' + (koffiSize / 1024 / 1024).toFixed(1) + ' MB）');

  const mods = ['core', 'native', 'gamepad', 'ui', 'app'];
  let entry = '';
  entry += '/* GameBox 3 — 打包入口（由 tools/build.js 自动生成，请勿手改） */\n';
  entry += "'use strict';\n";
  // koffi 释放：首次运行解压到临时目录并加载
  entry += `
var __KOFFI_FILES = ` + JSON.stringify(koffiFiles) + `;
(function () {
  var os = require('os'), path = require('path'), fs = require('fs');
  var dir = path.join(os.tmpdir(), 'gamebox3-koffi-v1');
  var marker = path.join(dir, '.ok');
  var nativeOk = path.join(dir, 'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node');
  try {
    // 标记存在且原生模块确实在位才复用；否则重新释放（防止上次释放不完整）
    if (!fs.existsSync(marker) || !fs.existsSync(nativeOk) || !fs.existsSync(path.join(dir, 'index.cjs'))) {
      try { fs.unlinkSync(marker); } catch (e) {}
      fs.mkdirSync(dir, { recursive: true });
      for (var rel in __KOFFI_FILES) {
        var p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, Buffer.from(__KOFFI_FILES[rel], 'base64'));
      }
      fs.writeFileSync(marker, 'ok');
    }
    // SEA 单文件模式下 require() 只能加载内置模块，外部文件必须用 createRequire
    var _cr = require('module').createRequire(path.join(dir, 'index.cjs'));
    globalThis.__KOFFI__ = _cr('./index.cjs');
  } catch (e) {
    try {
      require('child_process').execSync('cmd /c msg %username% "GameBox 初始化失败: ' + String(e.message).replace(/"/g, '') + '"', { stdio: 'ignore', windowsHide: true });
    } catch (_) {}
    console.error('[GameBox] koffi 运行时释放失败: ' + e.message);
    process.exit(1);
  }
})();
globalThis.__GAMEBOX_PACKAGED__ = true;
if (process.env.GAMEBOX_DEBUG) globalThis.__GAMEBOX_DEBUG__ = true;
`;
  // CommonJS 模块打包（供 SEA 单文件执行）
  entry += `
var __mods = {}, __cache = {};
function __def(name, fn) { __mods[name] = fn; }
function __req(name) {
  if (Object.prototype.hasOwnProperty.call(__mods, name)) {
    if (__cache[name]) return __cache[name].exports;
    var module = { exports: {} };
    __cache[name] = module;
    __mods[name](module, __req);
    return module.exports;
  }
  return require(name); // Node 内置模块
}
`;
  // 各模块注册（必须在入口执行之前）
  for (const m of mods) {
    let code = fs.readFileSync(path.join(SRC, m + '.js'), 'utf8').replace(/^#![^\n]*\n/, '');
    entry += `__def('./${m}', function (module, require) {\n${code}\n});\n`;
  }
  // 致命错误落盘（GUI 子系统无控制台，必须有）
  entry += `
(function () {
  var _fs = require('fs'), _path = require('path');
  var _dir = _path.join(_path.dirname(process.execPath), 'config');
  function fatal(tag, e) {
    try {
      _fs.mkdirSync(_dir, { recursive: true });
      _fs.appendFileSync(_path.join(_dir, 'launcher.log'),
        '[' + new Date().toISOString() + '] FATAL ' + tag + ': ' + (e && (e.stack || e.message) || e) + '\\n');
    } catch (_) {}
  }
  process.on('uncaughtException', function (e) { fatal('uncaughtException', e); });
  process.on('unhandledRejection', function (e) { fatal('unhandledRejection', e); });
  try {
    __req('./app');
  } catch (e) {
    fatal('startup', e);
    try {
      require('child_process').execSync('cmd /c msg %username% "GameBox 启动失败，详情见 config\\\\launcher.log"', { stdio: 'ignore', windowsHide: true });
    } catch (_) {}
    process.exit(1);
  }
})();
`;
  return entry;
}

/* ---------- 3. 打包流程 ---------- */
(async () => {
  try {
    if (!KOFFI_DIR || !fs.existsSync(KOFFI_DIR)) {
      console.error('[build] 未找到 koffi（先执行 `npm install` 安装 koffi）');
      process.exit(1);
    }
    if (!POSTJECT_API || !fs.existsSync(POSTJECT_API)) {
      console.error('[build] 未找到 postject（先执行 `npm install` 安装 postject）');
      process.exit(1);
    }
    // 清理旧的构建产物。注意：本机 rmSync 走"回收站"包装时，目录里几千个封面文件可能失败，
    // 这里不能让它中断构建——失败就逐项删除 GameBox3.exe / entry.js 等产物，config 保留。
    try {
      fs.rmSync(DIST, { recursive: true, force: true });
    } catch (e) {
      log('清理 dist 失败（忽略，继续覆盖构建）: ' + (e.message || e));
      for (const f of ['GameBox3.exe', 'entry.js', 'sea-config.json', 'sea-prep.blob']) {
        try { fs.rmSync(path.join(DIST, f), { force: true }); } catch (_) {}
      }
    }
    fs.mkdirSync(DIST, { recursive: true });

    // 入口
    const entry = buildEntry();
    fs.writeFileSync(path.join(DIST, 'entry.js'), entry);
    log('入口文件已生成（' + (entry.length / 1024 / 1024).toFixed(1) + ' MB）');

    // SEA blob
    fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify({
      main: 'entry.js',
      output: 'sea-prep.blob',
      disableExperimentalSEAWarning: true
    }, null, 2));
    log('正在编译 SEA blob（V8 代码缓存，约需 10-30 秒）...');
    cp.execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: DIST, stdio: 'inherit' });

    // 复制 node.exe 并去控制台
    const exePath = path.join(DIST, EXE_NAME);
    fs.copyFileSync(process.execPath, exePath);
    const { patchPeSubsystem } = require('./pe-patch');
    const pr = patchPeSubsystem(exePath);
    log(pr.changed ? 'PE Subsystem 已改为 WINDOWS_GUI（无黑窗）' : ('Subsystem=' + pr.old));

    // 注入
    const postject = require(POSTJECT_API);
    const blob = fs.readFileSync(path.join(DIST, 'sea-prep.blob'));
    await postject.inject(exePath, 'NODE_SEA_BLOB', blob, { sentinelFuse: FUSE });
    log('postject 注入完成');

    // 清理中间产物
    for (const f of ['entry.js', 'sea-config.json', 'sea-prep.blob']) {
      try { fs.unlinkSync(path.join(DIST, f)); } catch (e) {}
    }
    const sizeMb = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
    console.log('');
    console.log('========================================');
    console.log(' 打包完成: ' + exePath + ' (' + sizeMb + ' MB)');
    console.log(' 双击即可运行；拷贝到其他电脑后点「扫描新游戏」生成索引');
    console.log(' 封面与游戏数据保存在 exe 同目录 config\\ 下（一游戏一目录）');
    console.log('========================================');
  } catch (e) {
    console.error('[build] 失败: ' + (e && e.stack || e));
    process.exit(1);
  }
})();
