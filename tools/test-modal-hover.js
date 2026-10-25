/*
 * test-modal-hover.js —— 弹窗打开时背景卡片不得被鼠标选定/联动（1.2.1 修复回归）
 * 覆盖：无弹窗时 hover 正常跟随；打开编辑弹窗即清悬停；
 *       弹窗期间鼠标移动不更新 hover/selected；滚轮不滚动；
 *       长按菜单同样冻结；关闭后恢复联动。
 *
 * 运行：node tools/test-modal-hover.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Module = require('module');
const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'tools', 'node_modules');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'koffi') return orig.call(this, path.join(NM, 'koffi'), ...rest);
  return orig.call(this, request, ...rest);
};
function say(s) { fs.writeSync(1, s + '\n'); }

const ui = require(path.join(ROOT, 'src', 'ui.js'));
const N = require(path.join(ROOT, 'src', 'native.js'));
const core = require(path.join(ROOT, 'src', 'core.js'));

let failed = 0;
function ok(name, cond, extra) {
  if (cond) say('  [PASS] ' + name);
  else { failed++; say('  [FAIL] ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

/* ---------------- 打桩 ---------------- */
N.rect = () => {}; N.roundRect = () => {}; N.text = () => {}; N.ellipse = () => {};
N.line = () => {}; N.emojiText = () => {}; N.polygon = () => {}; N.drawCover = () => {};
N.ellipsis = (g, s) => s;
N.measure = () => ({ w: 60, h: 14 }); N.measureCached = () => ({ w: 60, h: 14 });
N.invalidate = () => {}; N.show = () => {}; N.setFocus = () => {}; N.setFocusMain = () => {};
N.moveChild = () => {}; N.redrawChild = () => {}; N.showChild = () => {};
N.createChild = () => ({ fake: true });
let editText = '';
N.editSetText = (h, s) => { editText = String(s); };
N.editGetText = () => editText;
N.pickFile = () => null;
core.saveProfile = () => {}; core.logLine = () => {}; core.openFolder = () => {};
core.settings = () => ({ zoom: 1, sort: 'default', padEnabled: true, gamesRoots: ['E:\\Games'], proxy: { type: 'none', host: '', port: 0 } });
core.loadLibrary = () => st.games;

const st = ui.state;
st.clientW = 1600; st.clientH = 900;
st.games = [{
  id: 'g1', name: '空之轨迹', folder: 'Sora', path: 'E:\\Games\\Sora',
  exe: 'E:\\Games\\Sora\\game.exe', cover: 'cover.jpg', coverSource: 'bing',
  favorite: false, hidden: false, missing: false
}, {
  id: 'g2', name: '另一款', folder: 'Other', path: 'E:\\Games\\Other',
  exe: 'E:\\Games\\Other\\game.exe', cover: '', coverSource: 'none',
  favorite: false, hidden: false, missing: false
}];
st.filtered = st.games.slice();
st.selected = 0;

// 两张卡片矩形（第二张在弹窗外，用来模拟"鼠标压在弹窗底下的背景卡"）
st.visibleIdx = [0, 1];
st.cardRects = [
  { x: 300, y: 200, w: 200, h: 300, nameH: 30 },
  { x: 300, y: 600, w: 200, h: 300, nameH: 30 }
];
const CARD2 = { x: 310, y: 610 }; // 卡2 内部一点（背景位置）
const CARD1 = { x: 310, y: 210 }; // 卡1 内部一点

/* ---------------- 1. 无弹窗：hover 正常跟随 ---------------- */
say('\n[1] 无弹窗时鼠标悬停正常联动');
st.hover = -1; st.selected = 0;
ui.__onMouseMove(CARD2.x, CARD2.y, 0);
ok('悬停更新到卡片2', st.hover === 1, st.hover);
ok('选中位跟随悬停', st.selected === 1, st.selected);

/* ---------------- 2. 打开编辑弹窗：立即清悬停 ---------------- */
say('\n[2] 打开编辑弹窗即清悬停残留');
ui.__openEdit(st.games[0]);
ok('弹窗已打开', st.editOpen === true);
ok('打开弹窗清掉了 hover（不再显示卡片高亮/按钮）', st.hover === -1, st.hover);

/* ---------------- 3. 弹窗期间鼠标移动不联动 ---------------- */
say('\n[3] 弹窗期间鼠标移动冻结背景');
ui.__onMouseMove(CARD1.x, CARD1.y, 0); // 鼠标移到另一张背景卡上
ok('hover 保持 -1', st.hover === -1, st.hover);
ok('selected 不被抢走（仍是 1）', st.selected === 1, st.selected);

say('\n[4] 弹窗期间滚轮不滚动背景');
st.maxScroll = 500; st.scrollY = 120;
ui.__onMouseWheel(-120, 800, 450);
ok('scrollY 保持不变', st.scrollY === 120, st.scrollY);

/* ---------------- 5. 长按菜单同样冻结 ---------------- */
say('\n[5] 长按菜单打开时同样冻结');
ui.__onKeyDown(0x1B, 0, false); // Esc 关编辑弹窗
ok('编辑弹窗已关', st.editOpen === false);
st.hover = 1;
ui.__openTouchMenu(CARD2.x, CARD2.y, st.games[0], [{ act: 'edit', label: '编辑' }]);
ok('菜单已打开', st.touchMenu !== null);
ok('打开菜单清掉了 hover', st.hover === -1, st.hover);
ui.__onMouseMove(CARD2.x, CARD2.y, 0);
ok('菜单期间移动鼠标 hover 保持 -1', st.hover === -1, st.hover);
ui.__onMouseWheel(-120, 800, 450);
ok('菜单期间滚轮不动', st.scrollY === 120, st.scrollY);
st.touchMenu = null;

/* ---------------- 6. 关闭后恢复联动 ---------------- */
say('\n[6] 关闭弹窗后恢复联动');
ui.__onMouseMove(CARD1.x, CARD1.y, 0);
ok('hover 恢复更新到卡片1', st.hover === 0, st.hover);
ok('选中位恢复跟随', st.selected === 0, st.selected);

say('\n结果：' + (failed ? ('失败 ' + failed + ' 项') : '全部通过'));
process.exit(failed ? 1 : 0);
