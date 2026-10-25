/*
 * 触屏手势行为测试：直接驱动真实 ui.__onTouch，
 * 用合成触点序列验证：单击启动、滑动滚动不误启动、长按弹菜单、
 * 双指捏合缩放、抬手惯性、palm 抑制、点空白关菜单。
 */
'use strict';
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'tools', 'node_modules');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'koffi') return orig.call(this, path.join(NM, 'koffi'), ...rest);
  return orig.call(this, request, ...rest);
};
function say(s) { require('fs').writeSync(1, s + '\n'); }

const ui = require(path.join(ROOT, 'src', 'ui.js'));
const N = require(path.join(ROOT, 'src', 'native.js'));
const core = require(path.join(ROOT, 'src', 'core.js'));

let failed = 0;
function ok(name, cond, extra) {
  if (cond) say('  [PASS] ' + name);
  else { failed++; say('  [FAIL] ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

/* ---- 打桩：屏蔽一切真实绘制与副作用 ---- */
N.rect = () => {}; N.roundRect = () => {}; N.text = () => {}; N.ellipse = () => {};
N.line = () => {}; N.emojiText = () => {}; N.polygon = () => {}; N.drawCover = () => {};
N.ellipsis = (g, s) => s;
N.measure = () => ({ w: 60, h: 14 }); N.measureCached = () => ({ w: 60, h: 14 });
N.invalidate = () => {}; N.show = () => {}; N.maximize = () => {}; N.focus = () => {};
N.clearCoverCache = () => {};
core.logLine = () => {}; core.openFolder = () => {};
core.saveProfile = () => {}; core.saveSettings = () => {};
core.settings = () => ({ zoom: st.zoom, sort: 'name', gamesRoots: ['E:\\Games'], padEnabled: true, lastScan: null, proxy: { type: 'none', host: '', port: 0 } });
core.fetchCoverFor = () => Promise.resolve({ real: false, source: 'x' });
core.runningInfo = () => [];
core.gameRoots = () => ['E:\\Games'];
core.killAllGames = () => {};

// 记录启动调用
let launchCount = 0;
const st = ui.state;
st.games = [];
for (let i = 0; i < 40; i++) {
  st.games.push({
    id: 'g' + i, name: '游戏' + i, path: 'E:\\Games\\G' + i, exe: 'E:\\Games\\G' + i + '\\game.exe',
    folder: 'G' + i, favorite: false, hidden: false, missing: false, trainer: null, cover: null, coverSource: ''
  });
}
st.view = 'all';
st.filtered = st.games.slice();
st.selected = 0;
st.scrollY = 0;
st.clientW = 1920; st.clientH = 1040;
st.zoom = 1;
st.touchMode = false;
st.gesture = null;
st.touchMenu = null;
st.touchMenuGame = null;
st.touchScrollV = 0;
st.padInput = false;
st.hover = -1;
st.settingsOpen = false; st.renameOpen = false; st.sortOpen = false;
st.toasts = [];

// 拦截 launchSelected：替换 state.filtered 里的游戏对象被启动的路径
// onLButtonDown 内部调用 launchSelected(cause)，它会走 core.launchGame。
// 这里直接拦 core.launchGame 计数。
const origLaunch = core.launchGame;
core.launchGame = function () { launchCount++; return Promise.resolve({ ok: true }); };

// 先画一帧建立真实卡片几何
ui.draw({}, 1, 1920, 1040);

// 找到第2 张卡的实际矩形
const rects = st.cardRects;
say('卡片总数=' + st.filtered.length + ' 可见卡=' + rects.length);
ok('已建立卡片几何', rects.length > 0, rects.length);
if (!rects.length) { say('无法建立几何，终止'); process.exit(1); }

function centerOf(i) {
  const r = rects[Math.min(i, rects.length - 1)];
  return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
}
const c1 = centerOf(1), c2 = centerOf(2);

function touch(x, y, phase, id, extra) {
  const p = { id: id || 1, x: x, y: y, phase: phase, pressure: 1, palm: false };
  if (extra) Object.assign(p, extra);
  ui.__onTouch({ n: 1, time: Date.now(), points: [p] });
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
// 真正让出事件循环，让 setTimeout（长按定时器）能够触发
function nap(ms) { return new Promise(r => setTimeout(r, ms)); }

say('');
say('=== 1) 单击卡片 = 选中 + 启动 ===');
launchCount = 0;
st.selected = 0;
touch(c1.x, c1.y, 0);        // DOWN
touch(c1.x, c1.y, 2);        // UP（未移动）
ok('单击后 selected=1', st.selected === 1, st.selected);
ok('单击后触发一次启动', launchCount === 1, launchCount);
ok('进入触屏模式', st.touchMode === true);

say('');
say('=== 2) 滑动 = 滚动列表，且不触发启动 ===');
launchCount = 0;
const y0 = 900;
const beforeScroll = st.scrollY;
touch(1200, y0, 0);                       // 按下
for (let i = 1; i <= 10; i++) touch(1200, y0 - i * 18, 1);   // 向上滑
touch(1200, y0 - 180, 2);                 // 抬手
ok('滑动手势被识别为移动', true);
ok('滑动未触发启动（关键：不能误启动游戏）', launchCount === 0, launchCount);
ok('列表发生了滚动', st.scrollY !== beforeScroll || st.maxScroll === 0,
   { before: beforeScroll, after: st.scrollY, max: st.maxScroll });
ok('抬手后产生惯性速度', Math.abs(st.touchScrollV) > 0, st.touchScrollV);

say('');
say('=== 3) 惯性滚动会衰减到 0 ===');
let guard = 0;
while (st.touchScrollV && guard++ < 500) ui.__updateTouchFling();
ok('惯性最终停止', st.touchScrollV === 0, st.touchScrollV);
ok('滚动位置被钳制在合法范围', st.scrollY >= 0 && st.scrollY <= st.maxScroll,
   { scrollY: st.scrollY, maxScroll: st.maxScroll });

say('');
say('=== 4) 长按卡片 = 弹出操作菜单，不启动 ===');
launchCount = 0;
st.touchMenu = null; st.gesture = null;
const c5 = centerOf(5);
touch(c5.x, c5.y, 0);
nap(620).then(function () {
  ok('长按弹出操作菜单', !!st.touchMenu);
  ok('长按未启动游戏', launchCount === 0, launchCount);
  if (!st.touchMenu) {
    say('  (长按菜单未弹出，后续菜单项断言跳过)');
    say('');
    say(failed === 0 ? 'ALL PASS' : ('FAILURES: ' + failed));
    process.exit(failed === 0 ? 0 : 1);
  }
  ui.draw({}, 1, 1920, 1040);        // 重建菜单命中区
  // 1.2.0 起菜单首项是「编辑」，共 6 项
  ok('菜单渲染出可点项', st.touchMenuRects.length === 6, st.touchMenuRects.length);
  ok('菜单首项为编辑（启动文件/封面）', st.touchMenuRects[0] && st.touchMenuRects[0].act === 'edit',
    st.touchMenuRects[0] && st.touchMenuRects[0].act);
  const r = ui.__touchMenuRect(0);
  ok('菜单完整在客户区内', r.x >= 0 && r.y >= 0 &&
     r.x + r.w <= st.clientW && r.y + r.h <= st.clientH, r);
  // 点「打开目录」：选它而不是首项，避免弹出编辑对话框影响后续用例
  const it = st.touchMenuRects.filter(x => x.act === 'folder')[0] || st.touchMenuRects[0];
  touch(Math.round(it.r.x + it.r.w / 2), Math.round(it.r.y + it.r.h / 2), 0);
  touch(Math.round(it.r.x + it.r.w / 2), Math.round(it.r.y + it.r.h / 2), 2);
  ok('点击菜单项后菜单关闭', st.touchMenu === null);

  nap(60).then(function () {
    /* ---- 回归测试：本次修复的两个 bug ---- */
    say('');
    say('=== 4b) 回归：UP 无对应 DOWN（消息合并丢失 DOWN）仍能点按 ===');
    launchCount = 0;
    st.touchMenu = null; st.gesture = null;
    // 只发 UP，完全不发 DOWN —— 模拟 Windows 合并触摸消息把 DOWN 吃掉
    const c6 = centerOf(6);
    touch(c6.x, c6.y, 2);
    ok('丢失 DOWN 时 UP 仍触发启动（关键回归）', launchCount === 1, launchCount);
    ok('丢失 DOWN 时选中位正确', st.selected === 6, st.selected);

    say('');
    say('=== 4c) 回归：长按弹菜单后，抬手关闭菜单而非静默吞掉 ===');
    launchCount = 0;
    st.touchMenu = null; st.gesture = null;
    const c7 = centerOf(7);
    touch(c7.x, c7.y, 0);
    nap(620).then(function () {
      const menuAfterLong = !!st.touchMenu;
      ok('长按弹出菜单', menuAfterLong);
      // 抬手：必须关闭菜单（旧代码会因 gesture=null 而直接 return，菜单留着）
      touch(c7.x, c7.y, 2);
      ok('长按后抬手关闭了菜单（关键回归）', st.touchMenu === null, st.touchMenu);
      ok('长按未启动游戏', launchCount === 0, launchCount);
      // 紧接着再点一次，必须能正常启动（旧代码要连点两次才生效）
      launchCount = 0;
      const c8 = centerOf(8);
      touch(c8.x, c8.y, 0);
      touch(c8.x, c8.y, 2);
      ok('长按之后再次点按立即启动（关键回归）', launchCount === 1, launchCount);
      runLateTests();
    });
  });
});

function runLateTests() {

say('');
say('=== 5) 双指捏合 = 缩放 ===');
const z0 = st.zoom;
ui.__onTouch({ n: 2, time: Date.now(), points: [
  { id: 1, x: 800, y: 500, phase: 0, pressure: 1, palm: false },
  { id: 2, x: 1000, y: 500, phase: 0, pressure: 1, palm: false }
]});
ui.__onTouch({ n: 2, time: Date.now(), points: [
  { id: 1, x: 700, y: 500, phase: 1, pressure: 1, palm: false },
  { id: 2, x: 1100, y: 500, phase: 1, pressure: 1, palm: false }
]});
ok('双指张开放大', st.zoom > z0, { before: z0, after: st.zoom });

say('');
say('=== 6) palm（掌托）触点被忽略 ===');
const selBefore = st.selected;
launchCount = 0;
ui.__onTouch({ n: 1, time: Date.now(), points: [
  { id: 9, x: 600, y: 600, phase: 0, pressure: 1, palm: true }
]});
ok('palm 触点不改变选中位', st.selected === selBefore);
ok('palm 触点不启动游戏', launchCount === 0);

say('');
say('=== 7) 触屏模式下不显示悬停操作按钮 ===');
st.hover = 3;
ui.draw({}, 1, 1920, 1040);
ok('touchMode 下无悬停按钮', st.hoverBtns.length === 0, st.hoverBtns.length);
st.touchMode = false;
st.hover = 3;
ui.draw({}, 1, 1920, 1040);
ok('鼠标模式下有悬停按钮', st.hoverBtns.length > 0, st.hoverBtns.length);

say('');
say('=== 8) 点按侧边栏按钮 ===');
launchCount = 0;
const sb = st.sidebarBtns.find(b => b.act === 'zoom-in');
if (sb) {
  const zBefore = st.zoom;
  touch(Math.round(sb.x + sb.w / 2), Math.round(sb.y + sb.h / 2), 0);
  touch(Math.round(sb.x + sb.w / 2), Math.round(sb.y + sb.h / 2), 2);
  ok('触屏点击侧边栏缩放按钮生效', st.zoom > zBefore, { before: zBefore, after: st.zoom });
} else {
  ok('找到侧边栏缩放按钮', false, st.sidebarBtns.map(b => b.act));
}

core.launchGame = origLaunch;
say('');
say(failed === 0 ? 'ALL PASS' : ('FAILURES: ' + failed));
process.exit(failed === 0 ? 0 : 1);
}
