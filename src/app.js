/*
 * GameBox 3 — app.js
 * 入口：初始化 FFI → 创建窗口 → 启动 UI → 消息泵（帧限 60fps）
 */
'use strict';

const native = require('./native');
const ui = require('./ui');
const core = require('./core');

const fs = require('fs');
const TRACE = process.env.GAMEBOX_TRACE;
function trace(s) {
  if (TRACE) { try { fs.appendFileSync(TRACE, new Date().toISOString() + ' ' + s + '\n'); } catch (e) {} }
}

process.on('uncaughtException', function (e) {
  core.logLine('UNCAUGHT: ' + (e && e.stack || e));
  trace('UNCAUGHT: ' + (e && e.stack || e));
});

(function main() {
  trace('main-start');
  native.init();
  trace('init-done');
  native.createMainWindow('GameBox 3 · 游戏聚合启动器', 1280, 800);
  trace('window-created');
  ui.start();
  trace('ui-started');
  let last = 0;
  let dbg = 0;
  const pumpPromise = native.pump(function () {
    const now = Date.now();
    if (now - last >= 16) { // 帧限制 ~60fps，避免 setImmediate 空转烧 CPU
      last = now;
      ui.tick();
      native.presentIfDirty(ui.draw); // native 内部按 dirty 标记按需重绘
      if (now - dbg > 3000) { // 每 3 秒输出一次渲染状态（便于排障）
        dbg = now;
        const st = native.debugState();
        core.logLine('tick ' + JSON.stringify(st) + ' games=' + ui.state.games.length);
      }
    }
  });
  // 窗口关闭后必须真正结束进程：否则进程常驻会继续占用 config 里的封面文件
  pumpPromise.then(function () {
    trace('pump-exit');
    try { core.killAllGames(); } catch (e) {}
    setTimeout(function () { process.exit(0); }, 120);
  });
  trace('pump-called');
})();
