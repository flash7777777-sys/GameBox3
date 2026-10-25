/*
 * GameBox 3 — ui.js
 * 界面状态 / 布局 / 渲染 / 交互（PlayNite 风格深色游戏库）
 * 仅搜索/路径/代理输入框使用原生 EDIT（保证中文输入法），其余全部 GDI+ 自绘
 */
'use strict';

const core = require('./core');
const native = require('./native');
const gamepad = require('./gamepad');
const fs = require('fs');
const path = require('path');

const N = native;
const C = N.C;

/* ================= 版本 / 作者 ================= */
// 版本号规则（与用户约定）：
//   修复 BUG          → 最后一位 +1（PATCH）
//   新增功能          → 中间一位 +1（MINOR）
//   大版本功能变更     → 第一位 +1（MAJOR）
// 当前版本 1.1.3：1.0.0（封面墙/扫描/手柄/修改器托管）+ 1.1.0 新增触屏手势支持，
// 1.1.1 修复触屏闪退，1.1.2 修复点按被状态机吞掉，1.1.3 修复触摸坐标未做
// ScreenToClient 转换（多显示器下点不中卡片）；
// 1.2.0 新增「编辑游戏」：自定义启动文件路径（支持 .exe/.bat/.cmd/.sh/.ps1 等）
// + 上传本地 jpg/png 图片自定义封面；1.2.1 修复弹窗打开时鼠标仍会选定/联动
// 背后卡片（hover 冻结 + 滚轮屏蔽 + 打开弹窗即清悬停残留）。
// 后续改动请按上述规则递增。
const VERSION = '1.2.1';
const AUTHOR = 'flash777@qq.com';

/* ================= 状态 ================= */

const state = {
  games: [], filtered: [],
  view: 'all',            // all | favorite | recent | hidden
  query: '', sort: 'default', zoom: 1.0,
  selected: 0, hover: -1,
  padInput: false,       // true=当前由手柄/键盘导航控制选择（忽略鼠标悬停）；鼠标真正移到另一张卡才交还控制权
  // ---- 触屏手势状态 ----
  touchMode: false,      // 检测到触屏交互后置true：隐藏纯悬停才有的操作按钮，改用长按
  gesture: null,         // 当前手势 {t0, x0,y0, x,y, moved, longFired, samples[]}
  touchScrollV: 0,       // 惯性滚动速度（逻辑 px/帧）
  touchLongTimer: 0,     // 长按定时器句柄
  touchMenu: null,       // 长按弹出的操作菜单 {x,y,game,items,rowH}
  touchMenuRects: [],    // 菜单项命中区（每帧重建）
  touchMenuGame: null,   // 菜单对应的游戏（执行动作时用）
  scrollY: 0, maxScroll: 0,
  clientW: 1200, clientH: 760,
  scanning: false, scanTotal: 0, scanDone: 0, scanCurrent: '',
  toasts: [],
  settingsOpen: false, proxyTestResult: '', proxyTestOk: false,
  runningCount: 0, runningGames: 0, runningTrainers: 0, restoreLockUntil: 0, emptyBtn: null,
  renameOpen: false, renameGame: null,
  // ---- 编辑游戏弹窗（自定义启动文件 / 自定义封面）----
  editOpen: false, editGame: null,
  editExeText: '',       // 弹窗里的启动文件路径（保存时写入 game.customExe）
  editCoverFile: null,   // 本次挑选的本地图片（未保存前仅预览）
  editCoverClear: false, // 勾选"清除封面"后保存时执行
  editHint: '',          // 弹窗底部提示（格式错误等）
  padEnabled: true, padLogAt: 0,
  sidebarBtns: [], cardRects: [], visibleIdx: [], hoverBtns: [],
  scrollbar: null, dragScroll: null,
  sortOpen: false, sortItemRects: [],
  lastClickCard: -1, lastClickTime: 0,
  mouse: { x: -1, y: -1 }
};

/* ================= 控件（仅原生 EDIT） ================= */

const controls = { search: null, proxyHost: null, proxyPort: null, renameEdit: null, editExe: null };
const CTRL = { search: 101, proxyHost: 203, proxyPort: 204, renameEdit: 205, editExe: 206 };
let suppressFormSync = false; // 程序化填充输入框时，忽略 EN_CHANGE 回写

const WS_CHILD_VIS = 0x40000000 | 0x10000000; // WS_CHILD | WS_VISIBLE
const WS_CHILD_ONLY = 0x40000000;             // WS_CHILD（不自动显示，用 showChild 切换）
const WS_BORDER = 0x00800000;
const WS_TABSTOP = 0x00010000;
const ES_AUTOHSCROLL = 0x0080;

function createControls() {
  // 注意 EDIT 样式位：0x0001 = ES_CENTER（不是 TABSTOP！），0x0008 = ES_UPPERCASE
  controls.search = N.createChild('EDIT', '', WS_CHILD_VIS | WS_BORDER | ES_AUTOHSCROLL, 0, 0, 10, 10, CTRL.search);
  // 设置弹窗的输入框：必须带 WS_CHILD，否则会被创建成独立弹窗（屏幕坐标系，偏移到窗口外且点不到）
  const editStyle = WS_CHILD_ONLY | WS_BORDER | ES_AUTOHSCROLL | WS_TABSTOP;
  controls.proxyHost = N.createChild('EDIT', '', editStyle, 0, 0, 10, 10, CTRL.proxyHost);
  controls.proxyPort = N.createChild('EDIT', '', editStyle, 0, 0, 10, 10, CTRL.proxyPort);
  controls.renameEdit = N.createChild('EDIT', '', editStyle, 0, 0, 10, 10, CTRL.renameEdit);
  controls.editExe = N.createChild('EDIT', '', editStyle, 0, 0, 10, 10, CTRL.editExe);
}

function setEditsVisible(visible) {
  N.showChild(controls.proxyHost, visible);
  N.showChild(controls.proxyPort, visible);
}

/* ================= 数据 ================= */

function reloadGames() {
  state.games = core.loadLibrary();
  applyFilter();
}

function applyFilter() {
  const q = state.query.trim().toLowerCase();
  // 记住当前选中的游戏 id：排序变化（如"最近启动"）后仍指向同一个游戏，
  // 否则退出游戏后 selected 下标会滑到别的游戏上
  const prevId = state.filtered[state.selected] ? state.filtered[state.selected].id : null;
  let list = state.games.filter(g => {
    if (state.view === 'hidden') { if (!g.hidden) return false; }
    else {
      if (g.hidden) return false;
      if (state.view === 'favorite' && !g.favorite) return false;
      if (state.view === 'recent' && !g.lastPlayed) return false;
    }
    if (q && g.name.toLowerCase().indexOf(q) < 0 && g.folder.toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  if (state.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  else if (state.sort === 'recent') list.sort((a, b) => (b.lastPlayed || '').localeCompare(a.lastPlayed || ''));
  else if (state.sort === 'added') list.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  state.filtered = list;
  if (prevId) {
    const j = list.findIndex(g => g.id === prevId);
    if (j >= 0) state.selected = j;
  }
  if (state.selected >= list.length) state.selected = Math.max(0, list.length - 1);
  state.scrollY = Math.min(state.scrollY, state.maxScroll);
  N.invalidate();
}

/* ================= 布局 ================= */

function layout() {
  const z = state.zoom;
  return {
    sidebar: Math.round(206 * Math.min(1.15, Math.max(0.85, z))),
    topbar: Math.round(42 * z),
    cardW: Math.round(146 * z),
    nameH: Math.round(42 * z),
    gap: Math.round(14 * z),
    scrollW: 10
  };
}

function gridGeom() {
  const L = layout();
  const gx = L.sidebar + 18;
  const gy = L.topbar + 16;
  const gw = state.clientW - gx - 18 - L.scrollW - 8;
  const cols = Math.max(1, Math.floor((gw + L.gap) / (L.cardW + L.gap)));
  const rowH = L.cardW * 1.5 + L.nameH + L.gap;
  const rows = Math.ceil(state.filtered.length / cols);
  const contentH = rows * rowH + 8;
  const viewH = state.clientH - gy - 14;
  state.maxScroll = Math.max(0, contentH - viewH);
  return { gx: gx, gy: gy, gw: gw, cols: cols, rowH: rowH, viewH: viewH, contentH: contentH, L: L };
}

function cardRect(i) {
  const G = gridGeom();
  const L = G.L;
  const col = i % G.cols;
  const row = Math.floor(i / G.cols);
  return {
    x: G.gx + col * (L.cardW + L.gap),
    y: G.gy + row * G.rowH - state.scrollY,
    w: L.cardW, h: L.cardW * 1.5,
    nameY: G.gy + row * G.rowH - state.scrollY + L.cardW * 1.5 + 4,
    nameH: L.nameH
  };
}

/* ================= Toast ================= */

function toast(msg, type, ms) {
  state.toasts.push({ msg: msg, type: type || 'info', until: Date.now() + (ms || 3600) });
  if (state.toasts.length > 4) state.toasts.shift();
  N.invalidate();
}

/* ================= 文本换行 ================= */

function wrapText(g, s, px, maxW, maxLines) {
  const str = String(s || '');
  if (!str) return [''];
  const lines = [];
  let cur = '';
  const tokens = str.split(/(\s+)/);
  let truncated = false;
  for (const tk of tokens) {
    if (truncated) break;
    if (!tk) continue;
    if (/^\s+$/.test(tk)) { if (cur) cur += ' '; continue; }
    const test = cur + tk;
    const w = N.measureCached(g, test, px, 10000, 200).w;
    if (w <= maxW || !cur) {
      if (w > maxW && !cur) {
        let piece = '';
        for (const ch of tk) {
          if (N.measureCached(g, piece + ch, px, 10000, 200).w > maxW && piece) {
            lines.push(piece);
            piece = ch;
            if (lines.length >= maxLines) { truncated = true; break; }
          } else piece += ch;
        }
        cur = piece;
      } else cur = test;
    } else {
      lines.push(cur);
      cur = tk;
      if (lines.length >= maxLines) { truncated = true; break; }
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  else if (cur && lines.length >= maxLines) truncated = true;
  if (lines.length > maxLines) lines.length = maxLines;
  if (truncated && lines.length) {
    let last = lines[maxLines - 1] || '';
    while (last && N.measureCached(g, last + "…", px, 10000, 200).w > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines.slice(0, maxLines);
}

/* ================= 渲染 ================= */

function draw(g, scale, cw, ch) {
  state.clientW = cw; state.clientH = ch;
  state.emptyBtn = null;
  state.touchMenuRects = [];
  const L = layout();
  const G = gridGeom();
  drawSidebar(g, L);
  drawTopbar(g, L, G);
  if (state.filtered.length === 0) drawEmptyState(g, L, G);
  else drawGrid(g, L, G);
  drawScrollbar(g, L, G);
  if (state.sortOpen) drawSortMenu(g, L, G);
  drawScanProgress(g, L);
  if (state.settingsOpen) drawSettings(g);
  if (state.renameOpen) drawRename(g);
  if (state.editOpen) drawEdit(g);
  if (state.touchMenu) drawTouchMenu(g);
  drawToasts(g, L);
}

function inRect(p, r) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function drawSidebar(g, L) {
  const W = L.sidebar;
  const H = state.clientH;
  N.rect(g, 0, 0, W, H, C.panel); // 不再画分隔竖线（高 DPI 下会渲染成一条突兀的线）

  // 品牌
  const pad = 14;
  N.roundRect(g, pad, 14, 38, 38, 9, C.accent, null, 0);
  N.text(g, 'G', pad, 19, 38, 28, 19, 0xFFFFFFFF, 1);
  N.text(g, 'GameBox 3', pad + 48, 16, W - pad - 48, 22, 15.5, C.text);
  N.text(g, '绿色版 · 原生窗口', pad + 48, 38, W - pad - 48, 16, 10.5, C.text3);

  // 导航
  const items = [
    { id: 'all', label: '全部游戏', count: state.games.filter(x => !x.hidden).length },
    { id: 'favorite', label: '收藏', count: state.games.filter(x => !x.hidden && x.favorite).length },
    { id: 'recent', label: '最近启动', count: state.games.filter(x => !x.hidden && x.lastPlayed).length },
    { id: 'hidden', label: '已隐藏', count: state.games.filter(x => x.hidden).length }
  ];
  let y = 68;
  state.sidebarBtns = [];
  for (const it of items) {
    const active = state.view === it.id;
    const r = { x: 10, y: y, w: W - 20, h: 34, act: 'view', id: it.id };
    if (active) N.roundRect(g, r.x, r.y, r.w, r.h, 8, C.accentSoft, null, 0);
    else if (inRect(state.mouse, r)) N.roundRect(g, r.x, r.y, r.w, r.h, 8, 0x0AFFFFFF, null, 0);
    N.text(g, it.label, r.x + 12, r.y + 9, r.w - 60, 18, 12.5, active ? C.text : C.text2);
    N.text(g, String(it.count), r.x + r.w - 44, r.y + 10, 34, 16, 11, C.text3, 2);
    state.sidebarBtns.push(r);
    y += 36;
  }

  // 缩放
  y += 8;
  N.text(g, '界面缩放', 12, y + 3, W - 24, 15, 10.5, C.text3);
  y += 20;
  const zbW = (W - 20 - 16) / 3;
  const zr = [
    { x: 10, y: y, w: zbW, h: 32, act: 'zoom-out', label: '－' },
    { x: 10 + zbW + 8, y: y, w: zbW, h: 32, act: null, label: Math.round(state.zoom * 100) + '%' },
    { x: 10 + (zbW + 8) * 2, y: y, w: zbW, h: 32, act: 'zoom-in', label: '＋' }
  ];
  for (const b of zr) {
    const hov = inRect(state.mouse, b);
    N.roundRect(g, b.x, b.y, b.w, b.h, 8, hov && b.act ? C.cardHover : C.card, C.border, 1);
    N.text(g, b.label, b.x, b.y + (b.act ? 6 : 8), b.w, 20, b.act ? 15 : 12, b.act ? C.text : C.text2, 1);
    if (b.act) state.sidebarBtns.push(b);
  }
  y += 42;

  // 手柄操作开关（允许/禁止手柄控制界面）
  const padRow = { x: 10, y: y, w: W - 20, h: 34, act: 'pad-toggle' };
  const padOn = state.padEnabled;
  const padHov = inRect(state.mouse, padRow);
  N.roundRect(g, padRow.x, padRow.y, padRow.w, padRow.h, 8, padHov ? C.cardHover : C.card, C.border, 1);
  N.text(g, '手柄操作', padRow.x + 12, padRow.y + 9, padRow.w - 70, 18, 12, padOn ? C.text : C.text2);
  // 开关（药丸 + 圆钮）
  const swW = 38, swH = 20, swX = padRow.x + padRow.w - swW - 10, swY = padRow.y + (padRow.h - swH) / 2;
  N.roundRect(g, swX, swY, swW, swH, swH / 2, padOn ? C.accent : 0xFF2A3648, null, 0);
  const knobR = swH - 6;
  N.ellipse(g, padOn ? (swX + swW - knobR - 3) : (swX + 3), swY + 3, knobR, knobR, 0xFFFFFFFF, null, 0);
  state.sidebarBtns.push(padRow);
  y += 42;

  // 主操作
  const scanR = { x: 10, y: y, w: W - 20, h: 38, act: 'scan' };
  N.roundRect(g, scanR.x, scanR.y, scanR.w, scanR.h, 9, C.accent, null, 0);
  N.text(g, state.scanning ? '扫描中...' : '扫描新游戏', scanR.x, scanR.y + 10, scanR.w, 18, 12.5, 0xFFFFFFFF, 1);
  state.sidebarBtns.push(scanR);
  y += 46;

  const setR = { x: 10, y: y, w: W - 20, h: 36, act: 'settings' };
  N.roundRect(g, setR.x, setR.y, setR.w, setR.h, 9, C.card, C.border, 1);
  N.text(g, '设置（目录 / 代理）', setR.x, setR.y + 9, setR.w, 18, 12.5, C.text2, 1);
  state.sidebarBtns.push(setR);
  y += 44;

  const exitR = { x: 10, y: y, w: W - 20, h: 30, act: 'exit' };
  N.roundRect(g, exitR.x, exitR.y, exitR.w, exitR.h, 8, null, C.border, 1);
  N.text(g, '退出（结束游戏进程）', exitR.x, exitR.y + 7, exitR.w, 16, 11, C.text3, 1);
  state.sidebarBtns.push(exitR);

  // 底部统计
  const s = core.settings();
  const info = ['共 ' + state.games.filter(x => !x.hidden).length + ' 款游戏'];
  if (state.runningCount > 0) info.push('运行中：' + state.runningGames + ' 款游戏' + (state.runningTrainers ? ' + ' + state.runningTrainers + ' 修改器' : ''));
  const rts = core.gameRoots();
  info.push(rts.length ? (rts.length === 1 ? rts[0] : ('游戏目录 ' + rts.length + ' 个')) : '尚未设置游戏目录');
  info.push(s.lastScan ? ('上次扫描 ' + fmtTime(s.lastScan)) : '尚未扫描');
  // 版本号 + 作者（主界面左下角）
  info.push('版本 ' + VERSION + '　作者 ' + AUTHOR);
  if (gamepad.isConnected()) info.push(state.padEnabled ? '🎮 手柄已连接（可操作）' : '🎮 手柄已连接（已禁用）');
  let iy = H - 14 - info.length * 16;
  for (const line of info) {
    if (line.indexOf('🎮') === 0) N.emojiText(g, line, 10, iy, W - 20, 15, 10.5, C.ok);
    else N.text(g, N.ellipsis(g, line, 10.5, W - 22), 10, iy, W - 20, 15, 10.5, C.text3);
    iy += 16;
  }
}

function drawTopbar(g, L, G) {
  const y = 8, h = L.topbar - 16;
  const sx = L.sidebar + 18, sw = Math.min(360, G.gw * 0.42);
  // 搜索框
  N.roundRect(g, sx, y, sw, h, 8, C.panel, C.border, 1);
  // 放大镜（自绘）
  const cxs = sx + 18, cys = y + h / 2;
  N.ellipse(g, cxs - 6, cys - 6, 11, 11, null, C.text3, 1.5);
  N.line(g, cxs + 4, cys + 4, cxs + 8, cys + 8, C.text3, 1.5);
  N.moveChild(controls.search, sx + 32, y + 1, sw - 42, h - 2);

  // 排序（自绘下拉）
  const cx = sx + sw + 12, cw2 = 116;
  const sortLabel = { default: '默认排序', name: '名称 A→Z', recent: '最近启动', added: '最近添加' }[state.sort];
  const sortR = { x: cx, y: y, w: cw2, h: h, act: 'sort' };
  N.roundRect(g, sortR.x, sortR.y, sortR.w, sortR.h, 8, C.panel, C.border, 1);
  N.text(g, sortLabel, sortR.x + 12, sortR.y + h / 2 - 8, sortR.w - 34, 16, 11.5, C.text2);
  N.polygon(g, [[sortR.x + sortR.w - 20, sortR.y + h / 2 - 3], [sortR.x + sortR.w - 10, sortR.y + h / 2 - 3], [sortR.x + sortR.w - 15, sortR.y + h / 2 + 4]], C.text3, null, 0);
  state.sidebarBtns.push(sortR);
  state.sortBtnRect = sortR;

  // 运行中指示
  if (state.runningCount > 0) {
    const parts = [];
    if (state.runningGames > 0) parts.push(state.runningGames + ' 款游戏');
    if (state.runningTrainers > 0) parts.push(state.runningTrainers + ' 个修改器');
    const txt = '● 运行中：' + (parts.join(' · ') || state.runningCount + ' 个进程');
    const tw = N.measure(g, txt, 11.5, 500, 40).w + 24;
    N.roundRect(g, state.clientW - tw - 20, y + h / 2 - 13, tw, 26, 13, 0x2234D399, C.ok, 1);
    N.text(g, txt, state.clientW - tw - 20, y + h / 2 - 8, tw, 16, 11.5, C.ok, 1);
  }
}

function drawSortMenu(g, L, G) {
  void G;
  const r = state.sortBtnRect;
  if (!r) return;
  const items = [
    { id: 'default', label: '默认排序' },
    { id: 'name', label: '名称 A→Z' },
    { id: 'recent', label: '最近启动' },
    { id: 'added', label: '最近添加' }
  ];
  const ih = 30;
  const mw = 140;
  const mx = Math.min(r.x, state.clientW - mw - 10);
  const my = r.y + r.h + 4;
  N.roundRect(g, mx, my, mw, items.length * ih + 8, 8, C.panel, C.border, 1);
  state.sortItemRects = [];
  for (let i = 0; i < items.length; i++) {
    const ir = { x: mx + 4, y: my + 4 + i * ih, w: mw - 8, h: ih, id: items[i].id };
    if (state.sort === items[i].id) N.roundRect(g, ir.x, ir.y, ir.w, ir.h, 6, C.accentSoft, null, 0);
    else if (inRect(state.mouse, ir)) N.roundRect(g, ir.x, ir.y, ir.w, ir.h, 6, 0x0AFFFFFF, null, 0);
    N.text(g, items[i].label, ir.x + 12, ir.y + 7, ir.w - 24, 16, 11.5, state.sort === items[i].id ? C.text : C.text2);
    state.sortItemRects.push(ir);
  }
}

// 空状态引导：没有目录 → 引导选择；有目录但没有游戏 → 提示重新扫描
function drawEmptyState(g, L, G) {
  const noRoot = core.gameRoots().length === 0;
  const cw = Math.min(560, G.gw - 20);
  const cx = G.gx + (G.gw - cw) / 2;
  const cy = G.gy + Math.max(30, G.viewH * 0.16);
  const ch = noRoot ? 236 : 196;
  N.roundRect(g, cx, cy, cw, ch, 16, C.card, C.borderSoft, 1);

  N.text(g, noRoot ? '欢迎使用 GameBox 3' : '这些目录里还没有找到游戏', cx, cy + 24, cw, 32, 21, C.text, 1);
  N.text(g,
    noRoot ? '先选择存放游戏的文件夹，我们会自动扫描游戏并搜索封面、识别修改器'
      : '请确认目录里含有游戏文件夹，或添加其他目录后再扫描',
    cx + 28, cy + 66, cw - 56, 44, 12.5, C.text3, 1);

  const bw = 210, bh = 44;
  const btn = { x: cx + (cw - bw) / 2, y: cy + 108, w: bw, h: bh, act: noRoot ? 'welcome-add' : 'welcome-rescan' };
  const hov = inRect(state.mouse, btn);
  N.roundRect(g, btn.x, btn.y, btn.w, btn.h, 10, hov ? 0xFF6E9BFF : C.accent, null, 0);
  N.text(g, noRoot ? '选择游戏目录' : '重新扫描', btn.x, btn.y + 12, btn.w, 22, 14, 0xFFFFFFFF, 1);
  state.emptyBtn = btn;

  N.text(g, noRoot ? '支持添加多个目录，可随时在「设置」里增删' : '也可以在「设置」里添加更多游戏目录',
    cx + 20, cy + ch - 36, cw - 40, 18, 11, C.text3, 1);
}

function drawGrid(g, L, G) {
  const list = state.filtered;
  state.cardRects = [];
  state.visibleIdx = [];
  state.hoverBtns = [];
  for (let i = 0; i < list.length; i++) {
    const r = cardRect(i);
    if (r.y + r.h + r.nameH < G.gy - 20 || r.y > state.clientH + 20) continue;
    state.cardRects.push(r);
    state.visibleIdx.push(i);
    const gm = list[i];
    const hovered = state.hover === i;
    const selected = state.selected === i;
    // 手柄/键盘导航期间（padInput=true）完全屏蔽鼠标悬停视觉，选中位始终跟随手柄；
    // 只有鼠标真正移到"另一张卡"时才会交还鼠标控制权（见 onMouseMove）。
    // 触屏模式下没有 hover，操作按钮改由长按菜单提供，这里一律不显示悬停视觉
    const hoveredVis = (state.padInput || state.touchMode) ? false : hovered;
    const ringed = (state.padInput || state.touchMode) ? selected : (state.hover >= 0 ? hovered : selected);
    const running = isRunning(gm);
    const rad = Math.round(10 * state.zoom);

    N.roundRect(g, r.x - 2, r.y - 2, r.w + 4, r.h + 4, rad + 1,
      hoveredVis ? C.cardHover : C.card,
      C.borderSoft,
      1);

    const coverAbs = gm.cover ? core.coverPath(gm) : null;
    N.drawCover(g, coverAbs, r.x, r.y, r.w, r.h, rad, C.card, initialsOf(gm.name));

    // 悬停 / 手柄选中：封面外套蓝色圆角描边（同一时刻只会有一个）
    if (ringed) {
      const lw = 3;
      N.roundRect(g, r.x - lw, r.y - lw, r.w + lw * 2, r.h + lw * 2, rad + lw, null, C.accent, lw);
    }

    // 目录里有修改器 → 封面右上角一个金色小点（悬停时会被操作按钮盖住，属正常）
    if (core.hasTrainer(gm)) trainerDot(g, r);

    if (hoveredVis && !gm.missing) {
      // 操作按钮（右上角）
      const bs = Math.round(26 * state.zoom);
      const bx = r.x + r.w - bs - 6, by = r.y + 6;
      const acts = [
        { act: 'edit', icon: '⚙' },
        { act: 'folder', icon: '📁' },
        { act: 'rename', icon: '✏' },
        { act: 'cover', icon: '🖼' },
        { act: 'fav', icon: gm.favorite ? '★' : '☆' },
        { act: 'hide', icon: '🚫' }
      ];
      for (let k = 0; k < acts.length; k++) {
        const br = { x: bx, y: by + k * (bs + 4), w: bs, h: bs };
        const bh = inRect(state.mouse, br);
        N.roundRect(g, br.x, br.y, br.w, br.h, 6, bh ? C.accent : 0xCC0A0E16, C.border, 1);
        N.emojiText(g, acts[k].icon, br.x, br.y + bs * 0.14, bs, bs * 0.75, 11 * state.zoom, 0xFFFFFFFF, 1);
        state.hoverBtns.push({ r: br, act: acts[k].act, game: gm });
      }
    }

    if (gm.missing) badge(g, r, '文件缺失', C.warn, 'bl');
    if (running) badge(g, r, '运行中', C.ok, 'br');
    if (gm.favorite) badge(g, r, '★', C.warn, 'tl');

    const lines = wrapText(g, gm.name, 12.5 * state.zoom, r.w - 4, 2);
    let ny = r.nameY + 4;
    for (const ln of lines) {
      N.text(g, ln, r.x - 2, ny, r.w + 4, Math.round(17 * state.zoom), 12.5 * state.zoom, ringed ? C.text : C.text2, 1);
      ny += Math.round(17 * state.zoom);
    }
  }
}

// 右上角金色圆点：表示该游戏目录中有修改器（Trainer）
function trainerDot(g, r) {
  const zs = Math.max(0.85, Math.min(1.6, state.zoom));
  const cx = r.x + r.w - Math.round(13 * zs);
  const cy = r.y + Math.round(13 * zs);
  const d = Math.round(10 * zs);
  N.ellipse(g, cx - d, cy - d, d * 2, d * 2, 0x33FFD24D, null, 0);              // 外层柔光
  N.ellipse(g, cx - d / 2, cy - d / 2, d, d, 0xFFF7C948, 0xE60A0E16, 1.5);      // 金点 + 深色描边
}

function badge(g, r, txt, color, pos) {
  const px = 9.5;
  const tw = N.measure(g, txt, px, 300, 20).w + 14;
  const bw = Math.min(tw, r.w - 10);
  let bx, by;
  if (pos === 'tl') { bx = r.x + 5; by = r.y + 5; }
  else if (pos === 'bl') { bx = r.x + 5; by = r.y + r.h - 22; }
  else { bx = r.x + r.w - bw - 5; by = r.y + r.h - 22; }
  N.roundRect(g, bx, by, bw, 17, 8, 0xDD0A0E16, color, 1);
  N.text(g, txt, bx, by + 2, bw, 13, px, color, 1);
}

function drawScrollbar(g, L, G) {
  if (state.maxScroll <= 0) { state.scrollbar = null; return; }
  const x = state.clientW - L.scrollW - 6;
  const y = G.gy, h = G.viewH;
  N.roundRect(g, x, y, L.scrollW, h, 5, 0x2EFFFFFF, null, 0);
  const thumbH = Math.max(30, h * h / (G.contentH + h));
  const thumbY = y + (h - thumbH) * (state.scrollY / state.maxScroll);
  N.roundRect(g, x, thumbY, L.scrollW, thumbH, 5, 0x8AFFFFFF, null, 0);
  state.scrollbar = { x: x, y: y, w: L.scrollW, h: h, thumbY: thumbY, thumbH: thumbH };
}

function drawScanProgress(g, L) {
  if (!state.scanning) return;
  const w = Math.min(430, state.clientW - L.sidebar - 60);
  const x = state.clientW - w - 20, y = state.clientH - 52;
  N.roundRect(g, x, y, w, 34, 8, C.panel, C.border, 1);
  const pct = state.scanTotal ? state.scanDone / state.scanTotal : 0;
  N.roundRect(g, x + 2, y + 2, (w - 4) * pct, 30, 6, C.accentSoft, null, 0);
  const txt = '快速扫描变更 ' + state.scanDone + '/' + state.scanTotal + (state.scanCurrent ? ' · ' + state.scanCurrent : '');
  N.text(g, N.ellipsis(g, txt, 11, w - 20), x + 10, y + 10, w - 20, 16, 11, C.text2);
}

function drawToasts(g, L) {
  void L;
  const now = Date.now();
  state.toasts = state.toasts.filter(t => t.until > now);
  let y = state.clientH - 64;
  for (let i = state.toasts.length - 1; i >= 0; i--) {
    const t = state.toasts[i];
    const color = t.type === 'err' ? C.danger : (t.type === 'ok' ? C.ok : (t.type === 'warn' ? C.warn : C.accent));
    const tw = N.measure(g, t.msg, 12, 500, 40).w + 44;
    const w = Math.min(tw, 430);
    const x = state.clientW - w - 16;
    N.roundRect(g, x, y, w, 32, 8, 0xF0131A24, C.border, 1);
    N.ellipse(g, x + 12, y + 12, 8, 8, color, null, 0);
    N.text(g, N.ellipsis(g, t.msg, 12, w - 40), x + 28, y + 8, w - 40, 16, 12, C.text);
    y -= 40;
  }
}

/* 版本号 + 作者已并入左侧栏底部信息区（见 drawSidebar），
   避免与底部卡片重叠导致文字压在封面上看不清。 */

/* ================= 设置弹窗 ================= */

function settingsGeom() {
  const rows = Math.max(1, Math.min(4, core.gameRoots().length));
  const w = Math.min(600, state.clientW - 40);
  const h = Math.min(state.clientH - 40, 470 + rows * 38);
  return { x: (state.clientW - w) / 2, y: (state.clientH - h) / 2, w: w, h: h, rows: rows };
}

function settingsLayout() {
  const G = settingsGeom();
  const ix = G.x + 24, iw = G.w - 48;
  const btnW = 84, btnH = 32;
  const listY = G.y + 92;
  const listH = G.rows * 38;
  const addY = listY + listH + 4;
  const proxyLabelY = addY + 44;
  const radioY = proxyLabelY + 22;
  const hintY = radioY + 36;
  const fieldLabelY = hintY + 24;
  const editY = fieldLabelY + 16;
  const testY = editY + 38;
  const resultY = testY + 40;
  return {
    G: G, ix: ix, iw: iw,
    listY: listY, listH: listH, addY: addY,
    proxyLabelY: proxyLabelY, radioY: radioY, hintY: hintY, fieldLabelY: fieldLabelY,
    hostEdit: { x: ix + 148, y: editY, w: iw - 148 - 96, h: 26 },
    portEdit: { x: ix + iw - 92, y: editY, w: 92, h: 26 },
    addBtn: { x: ix, y: addY, w: 148, h: 30, act: 'add-root' },
    scanBtn: { x: ix + 156, y: addY, w: 118, h: 30, act: 'rescan' },
    nameBtn: { x: ix + 282, y: addY, w: 126, h: 30, act: 'localize' },
    testBtn: { x: ix, y: testY, w: 150, h: 30, act: 'test' },
    result: { x: ix, y: resultY, w: iw, h: 72 },
    noteY: G.y + G.h - 84,
    saveBtn: { x: G.x + G.w - 24 - btnW - 92, y: G.y + G.h - 48, w: btnW, h: btnH, act: 'save' },
    cancelBtn: { x: G.x + G.w - 24 - btnW, y: G.y + G.h - 48, w: btnW, h: btnH, act: 'cancel' }
  };
}

// 已添加的游戏目录行（最多显示 4 行）+ 每行的"移除"按钮
function rootRowRects() {
  const L = settingsLayout();
  const roots = core.gameRoots().slice(0, 4);
  const out = [];
  for (let i = 0; i < roots.length; i++) {
    const y = L.listY + i * 38;
    out.push({
      path: roots[i],
      row: { x: L.ix, y: y, w: L.iw, h: 32 },
      remove: { x: L.ix + L.iw - 62, y: y + 4, w: 58, h: 24, act: 'remove-root', path: roots[i] }
    });
  }
  return out;
}

function openSettings() {
  if (state.renameOpen) closeRename();
  state.settingsOpen = true;
  state.hover = -1; // 弹窗压住背景后，卡片的悬停高亮/按钮立即失效
  state.sortOpen = false;
  const s = core.settings();
  const hostText = (s.proxy && s.proxy.host) || '';
  const portText = (s.proxy && s.proxy.port) ? String(s.proxy.port) : '';
  // 程序化 SetWindowText 也会触发 EN_CHANGE → 回调会把"还没填完"的字段写回内存（端口被清 0），
  // 所以填充期间必须抑制表单同步
  suppressFormSync = true;
  try {
    N.editSetText(controls.proxyHost, hostText);
    N.editSetText(controls.proxyPort, portText);
  } finally {
    suppressFormSync = false;
  }
  state.proxyTestResult = '';
  state.proxyTestOk = false;
  setEditsVisible(true);
  layoutSettingsControls();
  N.invalidate();
}

function closeSettings() {
  state.settingsOpen = false;
  setEditsVisible(false);
  N.setFocusMain();
  N.invalidate();
}

function layoutSettingsControls() {
  if (!state.settingsOpen) return;
  const L = settingsLayout();
  N.moveChild(controls.proxyHost, L.hostEdit.x, L.hostEdit.y, L.hostEdit.w, L.hostEdit.h);
  N.moveChild(controls.proxyPort, L.portEdit.x, L.portEdit.y, L.portEdit.w, L.portEdit.h);
  // 刚显示时 EDIT 常常只画底色不画文字（点一下才出现）→ 立即强制重绘
  N.redrawChild(controls.proxyHost);
  N.redrawChild(controls.proxyPort);
}

// 代理类型单选（自绘，与输入框分行排列）
function proxyTypeRects() {
  const L = settingsLayout();
  const opts = [{ v: 'none', l: '不使用' }, { v: 'http', l: 'HTTP' }, { v: 'socks5', l: 'SOCKS5' }];
  const bw = 92, bh = 28;
  const rects = [];
  for (let i = 0; i < opts.length; i++) {
    rects.push({ x: L.ix + i * (bw + 8), y: L.radioY, w: bw, h: bh, v: opts[i].v, l: opts[i].l });
  }
  return rects;
}

function settingsBtnRects() {
  const L = settingsLayout();
  return [L.addBtn, L.scanBtn, L.nameBtn, L.testBtn, L.saveBtn, L.cancelBtn];
}

function drawSettings(g) {
  const L = settingsLayout();
  const G = L.G, ix = L.ix, iw = L.iw;
  N.rect(g, 0, 0, state.clientW, state.clientH, 0x99050810);
  N.roundRect(g, G.x, G.y, G.w, G.h, 14, C.panel, C.border, 1);
  N.text(g, '⚙ 设置', G.x + 24, G.y + 18, 300, 24, 15, C.text);
  N.text(g, '游戏目录与网络代理；封面和数据保存在 exe 同目录 config\\ 下（一游戏一目录）', G.x + 24, G.y + 46, G.w - 48, 16, 10.5, C.text3);

  // ---- 游戏目录列表 ----
  const roots = core.gameRoots();
  N.text(g, '游戏目录（' + roots.length + ' 个）', ix, G.y + 70, iw, 15, 11, C.text2, 0);
  const rows = rootRowRects();
  if (!roots.length) {
    N.roundRect(g, ix, L.listY, iw, 32, 8, C.bg, C.border, 1);
    N.text(g, '尚未添加游戏目录，点击下方「添加目录」选择游戏所在文件夹', ix + 12, L.listY + 9, iw - 24, 16, 10.5, C.text3, 0);
  }
  for (const it of rows) {
    N.roundRect(g, it.row.x, it.row.y, it.row.w, it.row.h, 8, C.card, C.border, 1);
    N.text(g, N.ellipsis(g, it.path, 11, it.row.w - 86), it.row.x + 12, it.row.y + 9, it.row.w - 86, 16, 11, C.text2, 0);
    const hov = inRect(state.mouse, it.remove);
    N.roundRect(g, it.remove.x, it.remove.y, it.remove.w, it.remove.h, 6, hov ? 0x33FF5B6A : C.panel, C.border, 1);
    N.text(g, '移除', it.remove.x, it.remove.y + 4, it.remove.w, 15, 10.5, hov ? C.danger : C.text3, 1);
  }

  // ---- 网络代理 ----
  N.text(g, '网络代理（访问 Steam / Google / GitHub）', ix, L.proxyLabelY, iw, 15, 11, C.text2, 0);
  const s = core.settings();
  for (const r of proxyTypeRects()) {
    const on = s.proxy.type === r.v;
    const rh = inRect(state.mouse, r);
    N.roundRect(g, r.x, r.y, r.w, r.h, 7, on ? C.accent : (rh ? C.cardHover : C.card), on ? null : C.border, 1);
    N.text(g, r.l, r.x, r.y + 6, r.w, 16, 11, on ? 0xFFFFFFFF : C.text2, 1);
  }
  N.text(g, '常见端口：Clash 7890(混合) / 7891(SOCKS5)；v2rayN 10809(HTTP) / 10808(SOCKS5)', ix, L.hintY, iw, 14, 10, C.text3, 0);

  N.text(g, '地址', L.hostEdit.x, L.fieldLabelY, 100, 13, 10, C.text3, 0);
  N.text(g, '端口', L.portEdit.x, L.fieldLabelY, 60, 13, 10, C.text3, 0);
  N.roundRect(g, L.hostEdit.x, L.hostEdit.y, L.hostEdit.w, L.hostEdit.h, 6, C.card, null, 0);
  N.roundRect(g, L.portEdit.x, L.portEdit.y, L.portEdit.w, L.portEdit.h, 6, C.card, null, 0);

  // ---- 按钮 ----
  const labels = { 'add-root': '＋ 添加目录', rescan: '全面扫描', localize: '补全中文名', test: '测试代理连通性', save: '保存', cancel: '取消' };
  for (const b of settingsBtnRects()) {
    const hov = inRect(state.mouse, b);
    const primary = b.act === 'save';
    N.roundRect(g, b.x, b.y, b.w, b.h, 8, primary ? C.accent : C.card, primary ? null : C.border, 1);
    if (hov) N.roundRect(g, b.x, b.y, b.w, b.h, 8, 0x14FFFFFF, null, 0);
    N.text(g, labels[b.act] || '', b.x, b.y + 7, b.w, 16, 11.5, primary ? 0xFFFFFFFF : C.text2, 1);
  }

  // ---- 测试结果 ----
  if (state.proxyTestResult) {
    N.roundRect(g, L.result.x, L.result.y, L.result.w, L.result.h, 8, C.bg, C.border, 1);
    N.text(g, state.proxyTestResult, L.result.x + 12, L.result.y + 8, L.result.w - 24, L.result.h - 16, 10.5, state.proxyTestOk ? C.ok : C.warn);
  }
  N.text(g, '代理修改即时生效；移除目录会同时移除该目录下的游戏条目', ix, L.noteY, iw, 14, 10, C.text3);
}

/* ================= 重命名弹窗 ================= */

function renameGeom() {
  const w = Math.min(460, state.clientW - 60);
  const h = 200;
  return { x: (state.clientW - w) / 2, y: (state.clientH - h) / 2, w: w, h: h };
}

function renameLayout() {
  const G = renameGeom();
  const ix = G.x + 24, iw = G.w - 48;
  const bw = 84, bh = 32;
  return {
    G: G, ix: ix, iw: iw,
    edit: { x: ix, y: G.y + 82, w: iw, h: 30 },
    saveBtn: { x: G.x + G.w - 24 - bw - 92, y: G.y + G.h - 48, w: bw, h: bh, act: 'rename-save' },
    cancelBtn: { x: G.x + G.w - 24 - bw, y: G.y + G.h - 48, w: bw, h: bh, act: 'rename-cancel' }
  };
}

function openRename(game) {
  if (!game) return;
  state.renameOpen = true;
  state.renameGame = game;
  state.hover = -1; // 弹窗压住背景后，卡片的悬停高亮/按钮立即失效
  suppressFormSync = true;
  try { N.editSetText(controls.renameEdit, game.name || game.folder || ''); } finally { suppressFormSync = false; }
  const L = renameLayout();
  N.moveChild(controls.renameEdit, L.edit.x, L.edit.y, L.edit.w, L.edit.h);
  N.showChild(controls.renameEdit, true);
  N.redrawChild(controls.renameEdit);
  N.setFocus(controls.renameEdit);
  N.invalidate();
}

function closeRename() {
  state.renameOpen = false;
  state.renameGame = null;
  N.showChild(controls.renameEdit, false);
  N.setFocusMain();
  N.invalidate();
}

function saveRename() {
  const g = state.renameGame;
  if (!g) { closeRename(); return; }
  const name = N.editGetText(controls.renameEdit).trim();
  if (!name) { toast('游戏名称不能为空', 'warn'); return; }
  g.name = name;
  g.nameSource = 'manual'; // 手动命名后不再被自动中文名覆盖
  core.saveProfile(g);
  core.logLine('重命名: ' + g.folder + ' -> ' + name);
  closeRename();
  reloadGames();
  toast('已重命名为「' + name + '」', 'ok', 2500);
}

function drawRename(g) {
  const L = renameLayout();
  const G = L.G;
  N.rect(g, 0, 0, state.clientW, state.clientH, 0x99050810);
  N.roundRect(g, G.x, G.y, G.w, G.h, 14, C.panel, C.border, 1);
  N.text(g, '重命名游戏', G.x + 24, G.y + 18, 300, 24, 15, C.text, 0);
  const sub = '当前：' + (state.renameGame ? (state.renameGame.folder || '') : '');
  N.text(g, N.ellipsis(g, sub, 10.5, G.w - 48), G.x + 24, G.y + 48, G.w - 48, 16, 10.5, C.text3, 0);
  N.text(g, '名称', L.ix, G.y + 64, 60, 14, 10, C.text3, 0);
  N.roundRect(g, L.edit.x, L.edit.y, L.edit.w, L.edit.h, 6, C.card, null, 0);

  for (const b of [L.saveBtn, L.cancelBtn]) {
    const hov = inRect(state.mouse, b);
    const primary = b.act === 'rename-save';
    N.roundRect(g, b.x, b.y, b.w, b.h, 8, primary ? C.accent : C.card, primary ? null : C.border, 1);
    if (hov) N.roundRect(g, b.x, b.y, b.w, b.h, 8, 0x14FFFFFF, null, 0);
    N.text(g, primary ? '保存' : '取消', b.x, b.y + 7, b.w, 16, 11.5, primary ? 0xFFFFFFFF : C.text2, 1);
  }
}

/* ================= 编辑游戏弹窗 =================
 * 两项自定义：
 *   1) 启动文件：任意可执行文件/脚本（.exe / .bat / .cmd / .ps1 / .sh / .lnk …），
 *      存进 game.customExe；留空或填回默认 exe 即恢复自动识别（老配置不受影响）
 *   2) 封面：本地 jpg / png / gif / bmp，导入时校验魔数（GDI+ 解不了的 webp/svg 直接拒）
 * 弹窗沿用重命名弹窗的模板：遮罩 + 圆角面板 + 原生 EDIT（保证中文路径/输入法）。
 */
const EXE_FILTER = [
  { desc: '可执行文件与脚本', patterns: ['*.exe', '*.bat', '*.cmd', '*.ps1', '*.sh', '*.lnk', '*.jar', '*.vbs', '*.wsf'] },
  { desc: '所有文件', patterns: ['*.*'] }
];
const COVER_FILTER = [
  { desc: '图片文件', patterns: ['*.jpg', '*.jpeg', '*.png', '*.gif', '*.bmp'] },
  { desc: '所有文件', patterns: ['*.*'] }
];

function editGeom() {
  const w = Math.min(560, Math.max(420, state.clientW - 60));
  const h = 368;
  return { x: (state.clientW - w) / 2, y: Math.max(16, (state.clientH - h) / 2), w: w, h: h };
}

function editLayout() {
  const G = editGeom();
  const ix = G.x + 24, iw = G.w - 48;
  const bw = 76, rowH = 32;
  return {
    G: G, ix: ix, iw: iw,
    exeEdit: { x: ix, y: G.y + 92, w: iw - (bw + 8) * 2, h: rowH },
    exeBrowse: { x: ix + iw - bw * 2 - 8, y: G.y + 92, w: bw, h: rowH, act: 'edit-browse-exe' },
    exeDefault: { x: ix + iw - bw, y: G.y + 92, w: bw, h: rowH, act: 'edit-default-exe' },
    coverPick: { x: ix, y: G.y + 184, w: 132, h: 30, act: 'edit-pick-cover' },
    coverClear: { x: ix + 140, y: G.y + 184, w: 116, h: 30, act: 'edit-clear-cover' },
    coverPreview: { x: ix + iw - 70, y: G.y + 166, w: 66, h: 96 },
    saveBtn: { x: G.x + G.w - 24 - 88 - 92, y: G.y + G.h - 48, w: 88, h: 32, act: 'edit-save' },
    cancelBtn: { x: G.x + G.w - 24 - 88, y: G.y + G.h - 48, w: 88, h: 32, act: 'edit-cancel' }
  };
}

function editButtons() {
  const L = editLayout();
  return [L.exeBrowse, L.exeDefault, L.coverPick, L.coverClear, L.saveBtn, L.cancelBtn];
}

function openEdit(game) {
  if (!game) return;
  state.editOpen = true;
  state.editGame = game;
  state.hover = -1; // 弹窗压住背景后，卡片的悬停高亮/按钮立即失效
  state.editCoverFile = null;
  state.editCoverClear = false;
  state.editHint = '';
  const t = core.launchTargetOf(game);
  const cur = t ? t.file : (game.exe || '');
  state.editExeText = cur;
  suppressFormSync = true;
  try { N.editSetText(controls.editExe, cur); } finally { suppressFormSync = false; }
  const L = editLayout();
  N.moveChild(controls.editExe, L.exeEdit.x, L.exeEdit.y, L.exeEdit.w, L.exeEdit.h);
  N.showChild(controls.editExe, true);
  N.redrawChild(controls.editExe);
  N.setFocus(controls.editExe);
  N.invalidate();
}

function closeEdit() {
  state.editOpen = false;
  state.editGame = null;
  state.editCoverFile = null;
  state.editCoverClear = false;
  state.editHint = '';
  N.showChild(controls.editExe, false);
  N.setFocusMain();
  N.invalidate();
}

// 浏览：系统文件对话框（同步模态，与「添加目录」的 pickFolder 同一套路）
function editBrowseExe() {
  const g = state.editGame;
  if (!g) return;
  const cur = N.editGetText(controls.editExe).trim();
  let initDir = null;
  try { if (cur && fs.existsSync(cur)) initDir = path.dirname(cur); } catch (e) {}
  if (!initDir && g.exe && fs.existsSync(g.exe)) initDir = path.dirname(g.exe);
  if (!initDir && g.path && fs.existsSync(g.path)) initDir = g.path;
  const p = N.pickFile({
    title: '选择启动文件（exe / bat / cmd / ps1 / sh …）',
    groups: EXE_FILTER,
    initialDir: initDir || null,
    file: cur || ''
  });
  if (!p) return; // 用户取消
  suppressFormSync = true;
  try { N.editSetText(controls.editExe, p); } finally { suppressFormSync = false; }
  state.editExeText = p;
  state.editHint = '';
  N.redrawChild(controls.editExe);
  N.invalidate();
}

// 恢复默认：填回自动识别出来的 exe（保存时 customExe 会被清空）
function editDefaultExe() {
  const g = state.editGame;
  if (!g) return;
  suppressFormSync = true;
  try { N.editSetText(controls.editExe, g.exe || ''); } finally { suppressFormSync = false; }
  state.editExeText = g.exe || '';
  state.editHint = '已填回自动识别的启动文件，保存后生效';
  N.redrawChild(controls.editExe);
  N.invalidate();
}

function editPickCover() {
  const g = state.editGame;
  if (!g) return;
  let initDir = null;
  if (g.path && fs.existsSync(g.path)) initDir = g.path;
  const p = N.pickFile({ title: '选择封面图片（jpg / png / gif / bmp）', groups: COVER_FILTER, initialDir: initDir });
  if (!p) return;
  state.editCoverFile = p;
  state.editCoverClear = false;
  state.editHint = '待保存封面：' + path.basename(p);
  N.invalidate();
}

function editToggleClearCover() {
  state.editCoverClear = !state.editCoverClear;
  if (state.editCoverClear) { state.editCoverFile = null; state.editHint = '保存后将清除封面，下次扫描会重新搜索'; }
  else state.editHint = '';
  N.invalidate();
}

function saveEdit() {
  const g = state.editGame;
  if (!g) { closeEdit(); return; }
  const name = g.name || g.folder || '游戏';
  const txt = N.editGetText(controls.editExe).trim();
  let warn = '';

  // ---- 1) 启动文件路径 ----
  if (txt && txt !== (g.exe || '')) g.customExe = txt;
  else g.customExe = null;                       // 留空 / 与默认一致 → 回到自动识别
  if (g.customExe && !fs.existsSync(g.customExe)) {
    warn = '启动文件当前不存在，已保存路径：' + g.customExe;
  }

  // ---- 2) 封面 ----
  let coverMsg = '';
  if (state.editCoverFile) {
    const r = core.setCoverFromLocalFile(g, state.editCoverFile);
    if (!r.ok) { state.editHint = r.error; N.invalidate(); return; } // 保留弹窗，让用户换一张
    coverMsg = '封面已更新';
  } else if (state.editCoverClear) {
    core.clearCover(g);
    coverMsg = '封面已清除';
  }

  core.saveProfile(g);
  g.missing = core.gameMissing(g);
  reloadGames();
  closeEdit();
  if (coverMsg) toast(coverMsg + '：' + name, 'ok', 2600);
  if (warn) toast(warn, 'warn', 5000);
  else if (!coverMsg) toast(g.customExe ? '已保存自定义启动文件：' + name : '已恢复默认启动文件：' + name, 'ok', 2600);
  core.logLine('编辑游戏: ' + name + ' customExe=' + (g.customExe || '-'));
}

function drawEdit(g) {
  const L = editLayout();
  const G = L.G;
  const gm = state.editGame;
  N.rect(g, 0, 0, state.clientW, state.clientH, 0x99050810);
  N.roundRect(g, G.x, G.y, G.w, G.h, 14, C.panel, C.border, 1);
  N.text(g, '编辑游戏', G.x + 24, G.y + 18, 300, 24, 15, C.text, 0);
  const sub = gm ? (gm.name || gm.folder || '') : '';
  N.text(g, N.ellipsis(g, sub, 10.5, G.w - 48), G.x + 24, G.y + 48, G.w - 48, 16, 10.5, C.text3, 0);

  // ---- 启动文件 ----
  N.text(g, '启动文件（支持 .exe / .bat / .cmd / .ps1 / .sh 等）', L.ix, G.y + 72, L.iw, 14, 10.5, C.text3, 0);
  N.roundRect(g, L.exeEdit.x, L.exeEdit.y, L.exeEdit.w, L.exeEdit.h, 6, C.card, null, 0);
  const defTxt = gm ? (gm.exe || '（未识别到可执行文件）') : '';
  N.text(g, N.ellipsis(g, '默认：' + defTxt, 10, L.iw), L.ix, G.y + 130, L.iw, 14, 10, C.text3, 0);

  // ---- 封面 ----
  N.text(g, '封面图片（jpg / png / gif / bmp）', L.ix, G.y + 162, L.iw, 14, 10.5, C.text3, 0);
  let prev = state.editCoverFile;
  if (!prev && !state.editCoverClear && gm && gm.cover) prev = core.coverPath(gm);
  const pv = L.coverPreview;
  N.roundRect(g, pv.x - 2, pv.y - 2, pv.w + 4, pv.h + 4, 8, C.card, C.borderSoft, 1);
  N.drawCover(g, prev, pv.x, pv.y, pv.w, pv.h, 6, C.card, gm ? initialsOf(gm.name) : 'G');
  const curCover = state.editCoverClear ? '（将清除）'
    : (state.editCoverFile ? path.basename(state.editCoverFile)
      : (gm && gm.cover ? (gm.coverSource === 'custom' ? '自定义封面' : '自动封面') : '无封面'));
  N.text(g, N.ellipsis(g, curCover, 10, L.iw - 90), L.ix, G.y + 224, L.iw - 90, 14, 10, C.text3, 0);

  // ---- 提示 ----
  if (state.editHint) {
    N.text(g, N.ellipsis(g, state.editHint, 10, L.iw), L.ix, G.y + 292, L.iw, 15, 10, state.editHint.indexOf('不存在') >= 0 ? C.warn : C.text2, 0);
  }

  // ---- 按钮 ----
  const labels = {
    'edit-browse-exe': '浏览…', 'edit-default-exe': '默认',
    'edit-pick-cover': '选择图片…', 'edit-clear-cover': state.editCoverClear ? '✓ 清除封面' : '清除封面',
    'edit-save': '保存', 'edit-cancel': '取消'
  };
  for (const b of editButtons()) {
    const hov = inRect(state.mouse, b);
    const primary = b.act === 'edit-save';
    const on = (b.act === 'edit-clear-cover' && state.editCoverClear);
    N.roundRect(g, b.x, b.y, b.w, b.h, 8, primary ? C.accent : (on ? C.warn : C.card), primary || on ? null : C.border, 1);
    if (hov) N.roundRect(g, b.x, b.y, b.w, b.h, 8, 0x14FFFFFF, null, 0);
    N.text(g, labels[b.act] || '', b.x, b.y + 7, b.w, 16, 11.5, (primary || on) ? 0xFF0A0E16 : C.text2, 1);
  }
}

/* ================= 交互 ================= */

// 任一模态浮层（编辑/重命名/设置/长按菜单）打开期间，背景卡片的
// hover、选中、滚轮一律冻结——鼠标只是恰好压在弹窗底下的卡片上，
// 不代表用户想选它。
function modalOpen() {
  return !!(state.editOpen || state.renameOpen || state.settingsOpen || state.touchMenu);
}

function cardAt(x, y) {
  for (let i = 0; i < state.cardRects.length; i++) {
    const r = state.cardRects[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h + r.nameH) return state.visibleIdx[i];
  }
  return -1;
}

function onLButtonDown(x, y, wparam, injected) {
  void wparam;
  if (state.editOpen) {
    const G = editLayout().G;
    for (const b of editButtons()) {
      if (inRect({ x: x, y: y }, b)) {
        if (b.act === 'edit-save') saveEdit();
        else if (b.act === 'edit-cancel') closeEdit();
        else if (b.act === 'edit-browse-exe') editBrowseExe();
        else if (b.act === 'edit-default-exe') editDefaultExe();
        else if (b.act === 'edit-pick-cover') editPickCover();
        else if (b.act === 'edit-clear-cover') editToggleClearCover();
        return;
      }
    }
    if (!inRect({ x: x, y: y }, G)) { closeEdit(); return; }
    return; // 输入框由原生控件处理
  }
  if (state.renameOpen) {
    const L = renameLayout();
    if (inRect({ x: x, y: y }, L.saveBtn)) { saveRename(); return; }
    if (inRect({ x: x, y: y }, L.cancelBtn)) { closeRename(); return; }
    if (!inRect({ x: x, y: y }, L.G)) { closeRename(); return; }
    return; // 输入框由原生控件处理
  }
  if (state.settingsOpen) {
    const G = settingsGeom();
    if (!inRect({ x: x, y: y }, G)) { closeSettings(); return; }
    // 目录行的"移除"按钮
    for (const it of rootRowRects()) {
      if (inRect({ x: x, y: y }, it.remove)) {
        const r = N.msgBox('确定移除游戏目录？\n' + it.path + '\n\n该目录下已收录的游戏条目会一并删除（不会删除游戏文件）。', '移除目录', N.MB_YESNO);
        if (r === N.IDYES) dropRoot(it.path);
        return;
      }
    }
    // 代理类型
    for (const r of proxyTypeRects()) {
      if (inRect({ x: x, y: y }, r)) {
        const s = core.settings();
        s.proxy.type = r.v;
        core.applySettings(s);
        applyProxyFromForm(); // 类型切换后立刻把输入框里的地址/端口一并生效
        state.proxyTestResult = '';
        N.invalidate();
        return;
      }
    }
    // 按钮
    for (const b of settingsBtnRects()) {
      if (inRect({ x: x, y: y }, b)) {
        if (b.act === 'test') runProxyTest();
        else if (b.act === 'save') saveSettingsFromForm();
        else if (b.act === 'add-root') chooseRoot();
        else if (b.act === 'rescan') { closeSettings(); doScan(true, true); }
        else if (b.act === 'localize') { closeSettings(); localizeAllNames(); }
        else closeSettings();
        return;
      }
    }
    return; // 其余点击由原生 EDIT 处理
  }
  // 空状态引导按钮
  if (state.emptyBtn && inRect({ x: x, y: y }, state.emptyBtn)) {
    if (state.emptyBtn.act === 'welcome-add') chooseRoot();
    else doScan(true, true);
    return;
  }
  if (state.sortOpen) {
    for (const ir of state.sortItemRects) {
      if (inRect({ x: x, y: y }, ir)) {
        state.sort = ir.id;
        state.sortOpen = false;
        const s = core.settings();
        s.sort = ir.id;
        core.saveSettings(s);
        applyFilter();
        return;
      }
    }
    state.sortOpen = false;
    N.invalidate();
    return;
  }
  // 侧边栏
  for (const b of state.sidebarBtns) {
    if (inRect({ x: x, y: y }, b)) {
      if (b.act === 'view') { state.view = b.id; state.selected = 0; state.scrollY = 0; applyFilter(); }
      else if (b.act === 'zoom-in') setZoom(state.zoom + 0.1);
      else if (b.act === 'zoom-out') setZoom(state.zoom - 0.1);
      else if (b.act === 'pad-toggle') togglePad();
      else if (b.act === 'scan') doScan(false, true);
      else if (b.act === 'settings') openSettings();
      else if (b.act === 'exit') requestExit();
      else if (b.act === 'sort') { state.sortOpen = !state.sortOpen; N.invalidate(); }
      return;
    }
  }
  // 滚动条
  if (state.scrollbar && inRect({ x: x, y: y }, state.scrollbar)) {
    const sb = state.scrollbar;
    const ratio = (y - sb.y - sb.thumbH / 2) / Math.max(1, sb.h - sb.thumbH);
    state.scrollY = Math.max(0, Math.min(state.maxScroll, ratio * state.maxScroll));
    state.dragScroll = { startY: y, startScroll: state.scrollY };
    N.invalidate();
    return;
  }
  // 卡片操作按钮
  for (const hb of state.hoverBtns) {
    if (inRect({ x: x, y: y }, hb.r)) { doCardAction(hb.act, hb.game); return; }
  }
  // 卡片（单击即启动）
  const idx = cardAt(x, y);
  if (idx >= 0) {
    state.selected = idx;
    N.invalidate();
    // 注入的点击（手柄映射成鼠标、宏、自动化工具）只做选中，不启动游戏，
    // 否则"游戏退出后光标停在某张卡上"时会被误点启动
    if (injected) { core.logLine('忽略注入的鼠标点击 ' + x + ',' + y); return; }
    launchSelected('click@' + Math.round(x) + ',' + Math.round(y));
  }
}

function onLButtonUp() { state.dragScroll = null; }

function onMouseMove(x, y, wparam) {
  void wparam;
  state.mouse.x = x; state.mouse.y = y;
  if (modalOpen()) {
    // 弹窗打开时冻结背景：清掉 hover 与悬停按钮，不抢选中位
    if (state.hover !== -1) { state.hover = -1; N.invalidate(); }
    return;
  }
  const oldHover = state.hover;
  const nh = cardAt(x, y);
  state.hover = nh;
  // 手柄/键盘操作时（padInput=true），鼠标可能静止地停在某张卡上；
  // 只有当鼠标真正移动到"另一张卡"时才交还鼠标控制权，并同步选中位，
  // 这样选择会始终跟随手柄，不会被静止的鼠标悬停抢走。
  if (nh >= 0 && nh !== oldHover) {
    state.padInput = false;
    if (nh !== state.selected) { state.selected = nh; N.invalidate(); }
  } else if (oldHover !== nh) {
    // 移出卡片区（或同卡内轻微抖动）：保留 padInput，不抢回选中位
    N.invalidate();
  }
  if (state.dragScroll && state.scrollbar) {
    const sb = state.scrollbar;
    const dy = y - state.dragScroll.startY;
    const ratio = dy / Math.max(1, sb.h - sb.thumbH);
    state.scrollY = Math.max(0, Math.min(state.maxScroll, state.dragScroll.startScroll + ratio * state.maxScroll));
  }
}

function onMouseWheel(delta, x, y) {
  void x; void y;
  if (modalOpen()) return;
  const L = layout();
  const step = L.cardW * 1.5 * 0.85;
  state.scrollY = Math.max(0, Math.min(state.maxScroll, state.scrollY - (delta > 0 ? step : -step)));
  N.invalidate();
}

/* ================= 触屏手势 =================
 * 目标交互（与鼠标路径共用同一套业务函数，保证行为一致）：
 *   单击卡片      → 选中 + 启动游戏（同鼠标单击）
 *   上下滑动      → 滚动封面墙；抬手带惯性
 *   长按卡片      → 弹出该卡的操作菜单（触屏没有 hover，这是关键补偿）
 *   横向滑动      → 切换选中卡（左右划一格）
 *   双指捏合      → 缩放界面
 *   点侧边栏/按钮 → 同鼠标单击
 *
 * 设计要点：
 *  - 触屏没有 hover，故第一次触屏交互即进入 touchMode，隐藏悬停按钮改用长按
 *  - 用「位移阈值」区分点按与滑动：超过 10px 就不再当作点按，避免滑动误启动游戏
 *  - 长按 500ms 触发菜单；若在长按触发前移动超过阈值则取消长按
 */
const TOUCH_TAP_SLOP = 10;      // 超过这个位移就不算点按（逻辑 px）
const TOUCH_LONG_PRESS = 500;   // 长按触发时间 ms
const TOUCH_FLING_MIN = 0.6;    // 惯性滚动的最小初速度（px/帧）
const TOUCH_FLING_DECAY = 0.94; // 惯性衰减
const TOUCH_H_EDGE = 60;        // 横向滑动判定：起始 x 需离左右边缘足够远（避开侧边栏/滚动条）

function touchDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function clearTouchLongPress() {
  if (state.touchLongTimer) { clearTimeout(state.touchLongTimer); state.touchLongTimer = 0; }
}

// 触屏进入卡片时：与鼠标 hover 等价的「选中 + 高亮」
function touchSelectCardAt(x, y) {
  const idx = cardAt(x, y);
  if (idx < 0) return -1;
  state.padInput = false;      // 触屏接管控制权
  state.hover = -1;
  if (idx !== state.selected) { state.selected = idx; N.invalidate(); }
  return idx;
}

// 长按：在触点处弹出该卡的操作菜单
function touchLongPressAt(x, y) {
  const idx = touchSelectCardAt(x, y);
  if (idx < 0) return;
  const g = state.filtered[idx];
  if (!g) return;
  const items = [
    { act: 'edit', label: '编辑（启动文件/封面）' },
    { act: 'folder', label: '打开目录' },
    { act: 'rename', label: '重命名' },
    { act: 'cover', label: '重新搜封面' },
    { act: 'fav', label: g.favorite ? '取消收藏' : '收藏' },
    { act: 'hide', label: '隐藏' }
  ];
  openTouchMenu(x, y, g, items);
  core.logLine('触屏长按菜单：' + g.name);}

// 触屏操作菜单（自绘，复用设置弹窗的遮罩风格）
function openTouchMenu(x, y, g, items) {
  state.touchMenu = { x: x, y: y, game: g, items: items, w: 200, rowH: 40 };
  state.touchMenuGame = g;
  state.hover = -1; // 菜单压住背景后，卡片的悬停高亮/按钮立即失效
  N.invalidate();
}

function touchMenuRect(i) {
  const m = state.touchMenu;
  const H = m.items.length * m.rowH + 16;
  // 贴边收拢，保证整个菜单都在客户区内
  let px = m.x, py = m.y;
  px = Math.max(8, Math.min(px, state.clientW - m.w - 8));
  py = Math.max(8, Math.min(py, state.clientH - H - 8));
  return { x: px, y: py, w: m.w, h: H, G: { x: px, y: py, w: m.w, h: H } };
}

function closeTouchMenu() { state.touchMenu = null; N.invalidate(); }

function drawTouchMenu(g) {
  const m = state.touchMenu;
  if (!m || state.settingsOpen || state.renameOpen || state.editOpen) return;
  const r = touchMenuRect(0);
  N.rect(g, 0, 0, state.clientW, state.clientH, 0x99000000);       // 遮罩
  N.roundRect(g, r.x, r.y, r.w, r.h, 12, C.panel, C.border, 1);
  let y = r.y + 8;
  for (let i = 0; i < m.items.length; i++) {
    const it = m.items[i];
    state.touchMenuRects.push({ r: { x: r.x + 8, y: y, w: r.w - 16, h: m.rowH - 6 }, act: it.act });
    N.roundRect(g, r.x + 8, y, r.w - 16, m.rowH - 6, 8, C.card, C.borderSoft, 1);
    N.text(g, it.label, r.x + 8, y + 9, r.w - 16, m.rowH - 6, 12, C.text, 1);
    y += m.rowH;
  }
}

/* 触屏主入口：接收 native 解析好的触点批次 */
const TOUCH_DBG = process.env.GAMEBOX_TOUCH_DEBUG;
function tdbg(s) {
  if (!TOUCH_DBG) return;
  try { require('fs').appendFileSync(TOUCH_DBG, new Date().toISOString() + ' [ui] ' + s + '\n'); } catch (e) {}
}

function onTouch(t) {
  if (!t || !t.points || !t.points.length) { tdbg('onTouch bail: 空触点'); return; }
  state.touchMode = true;   // 只要有真实触屏交互就永久进入触屏模式
  tdbg('onTouch n=' + t.n + ' pts=' + t.points.map(function (q) { return q.id + '@' + Math.round(q.x) + ',' + Math.round(q.y) + '/ph' + q.phase + (q.palm ? '/PALM' : ''); }).join(' | '));

  // 掌托/误触抑制：palm 触点不参与交互
  const pts = t.points.filter(p => !p.palm);
  if (!pts.length) return;

  // ---- 双指：捏合缩放 ----
  if (pts.length >= 2) {
    clearTouchLongPress();
    const d = touchDist(pts[0], pts[1]);
    const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
    const g0 = state.gesture;
    if (!g0 || !g0.pinch) {
      state.gesture = { pinch: true, dist: d, cx: cx, cy: cy };
      return;
    }
    const ratio = d / (g0.dist || d);
    if (ratio > 1.01 || ratio < 0.99) {
      setZoom(state.zoom * (ratio > 1 ? 1 + (ratio - 1) * 0.9 : 1 + (ratio - 1) * 0.9));
      state.gesture.dist = d; state.gesture.cx = cx; state.gesture.cy = cy;
    }
    return;
  }

  const p = pts[0];
  const phase = p.phase; // 0=DOWN 1=UPDATE 2=UP

  if (phase === 0) {                       // ---- 按下 ----
    clearTouchLongPress();
    state.touchScrollV = 0;
    state.gesture = {
      t0: Date.now(), x0: p.x, y0: p.y, x: p.x, y: p.y,
      moved: false, longFired: false, pinch: false,
      lastY: p.y, lastT: Date.now(), v: 0
    };
    // 长按 → 菜单
    // 注意：这里【不能】把 state.gesture 置 null。置空后随后的 UP 会因为
    // 拿不到手势而直接 return，导致"长按弹了菜单、抬手既不关菜单也不启动游戏"，
    // 之后两次点击都会被吞掉（这正是"点封面没反应"的成因之一）。
    state.touchLongTimer = setTimeout(function () {
      const g0 = state.gesture;
      if (!g0 || g0.moved || g0.longFired) return;
      g0.longFired = true;
      touchLongPressAt(g0.x0, g0.y0);
    }, TOUCH_LONG_PRESS);
    N.invalidate();
    return;
  }

  if (phase === 1) {                       // ---- 移动 ----
    const g0 = state.gesture;
    if (!g0 || g0.pinch) return;           // 没有按下、或正在双指捏合 → 忽略移动
    g0.x = p.x; g0.y = p.y;
    const dx = p.x - g0.x0, dy = p.y - g0.y0;
    if (!g0.moved && Math.hypot(dx, dy) > TOUCH_TAP_SLOP) {
      g0.moved = true;
      clearTouchLongPress();               // 一旦判定为滑动就取消长按
      touchSelectCardAt(g0.x0, g0.y0);    // 滑动时也跟随高亮，手感更自然
    }
    const now = Date.now();
    const dt = Math.max(1, now - g0.lastT);
    // 指数平滑的瞬时速度（px/帧，按 60fps 归一）
    g0.v = g0.v * 0.7 + ((g0.lastY - p.y) / dt * 16) * 0.3;
    g0.lastY = p.y; g0.lastT = now;

    if (g0.moved) {
      //纵向为主 → 滚动；横向为主 → 切换选中卡
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (ady >= adx && state.maxScroll > 0 && !state.settingsOpen && !state.renameOpen) {
        state.scrollY -= dy - (g0.prevDy || 0);
        state.scrollY = Math.max(0, Math.min(state.maxScroll, state.scrollY));
        N.invalidate();
      } else if (adx > ady) {
        const L = layout();
        if (g0.x0 > L.sidebar + TOUCH_H_EDGE && g0.x0 < state.clientW - L.scrollW - TOUCH_H_EDGE) {
          const cell = Math.round((dx - (g0.prevDx || 0)) / Math.max(1, L.cardW * 0.55));
          if (cell !== 0) {
            navigate(cell, 0);
            g0.prevDx = dx;
          }
        }
      }
      g0.prevDy = dy;
    }
    return;
  }

  // ---- 抬起 ----
  clearTouchLongPress();
  let g1 = state.gesture;
  state.gesture = null;
  if (!g1) {
    // 没有对应的 DOWN：Windows 会合并触摸消息（快速点按时 DOWN 可能被合并进
    // 后续消息而丢失），或 DOWN 早于 onTouch 注册就到达。
    // 此时用当前 UP 坐标合成一次点按，保证「点一下」永远有响应。
    tdbg('up: 无对应 DOWN，合成点按');
    g1 = { x0: p.x, y0: p.y, moved: false, longFired: false, v: 0, t0: Date.now() };
  }

  // 点按（未移动、未触发长按）→ 与鼠标单击走同一条业务路径
  if (!g1.moved && !g1.longFired) {
    if (state.touchMenu) {
      // 命中菜单项则执行，否则关闭菜单
      let hit = null;
      for (const mr of state.touchMenuRects) {
        if (inRect({ x: g1.x0, y: g1.y0 }, mr.r)) { hit = mr; break; }
      }
      state.touchMenu = null;
      if (hit) { doCardAction(hit.act, state.touchMenuGame); N.invalidate(); }
      else N.invalidate();
      return;
    }
    onLButtonDown(g1.x0, g1.y0, 0, false);  // false=非注入输入，允许启动
    tdbg('tap → onLButtonDown(' + Math.round(g1.x0) + ',' + Math.round(g1.y0) + ')');
    return;
  }
  // 长按已触发过（菜单已弹出）：抬手负责把菜单关掉，不再静默吞掉这次交互
  if (g1.longFired) {
    tdbg('up: longFired → 关闭菜单');
    if (state.touchMenu) closeTouchMenu();
    return;
  }
  // 滑动抬手 → 惯性滚动
  if (g1.moved && Math.abs(g1.v) > TOUCH_FLING_MIN && state.maxScroll > 0 && !state.settingsOpen && !state.renameOpen) {
    state.touchScrollV = g1.v;
    N.invalidate();
  }
}

// 惯性滚动（由 tick 驱动）
function updateTouchFling() {
  if (!state.touchScrollV) return;
  state.scrollY += state.touchScrollV;
  state.scrollY = Math.max(0, Math.min(state.maxScroll, state.scrollY));
  state.touchScrollV *= TOUCH_FLING_DECAY;
  if (Math.abs(state.touchScrollV) < 0.15) state.touchScrollV = 0;
  N.invalidate();
}

function onKeyDown(vk, lparam, injected) {
  if (state.editOpen) {
    // Enter 保存 / Esc 取消；其余交给原生 EDIT（保证中文输入法与退格）
    if (vk === 0x0D) { saveEdit(); return; }
    if (vk === 0x1B) { closeEdit(); return; }
    return;
  }
  if (state.renameOpen) {
    if (vk === 0x0D) { saveRename(); return; }
    if (vk === 0x1B) { closeRename(); return; }
    return;
  }
  if ((vk === 0xBB || vk === 0xBD || vk === 0x60) && N.isKeyDown(0x11)) { // Ctrl + +/-/0
    if (vk === 0xBB) setZoom(state.zoom + 0.1);
    else if (vk === 0xBD) setZoom(state.zoom - 0.1);
    else setZoom(1.0);
    return;
  }
  if (state.settingsOpen) {
    if (vk === 0x1B) closeSettings();
    return;
  }
  const cols = gridGeom().cols;
  switch (vk) {
    case 0x26: navigate(0, -1); break;
    case 0x28: navigate(0, 1); break;
    case 0x25: navigate(-1, 0); break;
    case 0x27: navigate(1, 0); break;
    case 0x0D: if (!injected) launchSelected('key-Enter'); break;
    case 0x21: navigate(-cols, 0); break;
    case 0x22: navigate(cols, 0); break;
    case 0x24: state.selected = 0; ensureVisible(); N.invalidate(); break;
    case 0x23: state.selected = Math.max(0, state.filtered.length - 1); ensureVisible(); N.invalidate(); break;
    case 0x74: doScan(false, true); break;
    case 0x70: openSettings(); break;
  }
}

function navigate(dx, dy) {
  const cols = gridGeom().cols;
  let i = state.selected;
  if (dx === 6) i += cols * 2;
  else if (dx === -6) i -= cols * 2;
  else i += dx + dy * cols;
  i = Math.max(0, Math.min(Math.max(0, state.filtered.length - 1), i));
  // 手柄/键盘导航时进入"手柄控制"模式：清掉鼠标悬停并屏蔽其视觉，
  // 选中位交由手柄/键盘驱动，直到鼠标真正移到另一张卡（见 onMouseMove）
  const hadHover = state.hover >= 0;
  state.hover = -1;
  // 触屏手势复用导航逻辑，但触屏模式下不能进入"手柄控制"模式，
  // 否则 touchMode 与 padInput 会互相覆盖选中位的归属
  if (!state.touchMode) state.padInput = true;
  if (i !== state.selected) {
    state.selected = i;
    ensureVisible();
    N.invalidate();
  } else if (hadHover) {
    N.invalidate();
  }
}

function ensureVisible() {
  if (state.selected < 0 || state.selected >= state.filtered.length) return;
  const r = cardRect(state.selected);
  const G = gridGeom();
  if (r.y < G.gy) state.scrollY -= (G.gy - r.y);
  else if (r.y + r.h + r.nameH > G.gy + G.viewH) state.scrollY += (r.y + r.h + r.nameH - G.gy - G.viewH);
  state.scrollY = Math.max(0, Math.min(state.maxScroll, state.scrollY));
}

function setZoom(z) {
  state.zoom = Math.round(Math.max(0.6, Math.min(2.0, z)) * 10) / 10;
  const s = core.settings();
  s.zoom = state.zoom;
  core.saveSettings(s);
  if (state.settingsOpen) layoutSettingsControls();
  N.invalidate();
}

function togglePad() {
  state.padEnabled = !state.padEnabled;
  const s = core.settings();
  s.padEnabled = state.padEnabled;
  core.saveSettings(s);
  core.logLine('手柄操作: ' + (state.padEnabled ? '启用' : '禁用'));
  toast(state.padEnabled ? '手柄操作已启用（需启动器为当前窗口）' : '手柄操作已禁用', state.padEnabled ? 'ok' : 'info', 2600);
  N.invalidate();
}

/* ================= 动作 ================= */

function launchSelected(source) {
  const src = source || 'unknown';
  // 窗口刚从最小化恢复的头 400ms 内忽略启动输入：游戏退出瞬间常有"幽灵点击/幽灵按键"
  // 落到刚出现的启动器上，导致莫名其妙启动了另一款游戏
  if (Date.now() < (state.restoreLockUntil || 0)) {
    core.logLine('忽略恢复瞬间的启动输入[' + src + ']');
    return;
  }
  const g = state.filtered[state.selected];
  if (!g) return;
  if (g.missing) { toast('「' + g.name + '」的启动文件不存在', 'err'); return; }
  const r = core.launchGame(g, function () { N.show(false); }, src);
  if (r.ok) {
    state.graceUntil = Date.now() + 20000; // 20 秒内不因进程退出自动弹回窗口
    if (r.killedPrev && r.prevNames && r.prevNames.length) {
      toast('已结束「' + r.prevNames.join('、') + '」并启动「' + g.name + '」', 'warn', 4500);
    } else {
      toast('已启动「' + g.name + '」，启动器已最小化', 'ok');
    }
    applyFilter();
  } else if (r.duplicate) {
    // 连点/连按：已在运行则提示一次，"正在启动中"静默忽略
    if (r.running) toast(r.error, 'warn', 2200);
  } else {
    toast('启动失败：' + r.error, 'err', 5000);
  }
}

function doCardAction(act, g) {
  if (act === 'edit') {
    openEdit(g);
  } else if (act === 'rename') {
    openRename(g);
  } else if (act === 'folder') {
    const t = core.launchTargetOf(g);
    core.openFolder(path.dirname((t && t.file) || g.path || ''));
  } else if (act === 'cover') {
    toast('正在重新搜索「' + g.name + '」封面...', 'info', 1500);
    core.fetchCoverFor(g).then(r => {
      N.invalidate();
      toast(r.real ? '封面已更新（' + r.source + '）' : '未找到合适图片，使用占位图', r.real ? 'ok' : 'warn');
    });
  } else if (act === 'fav') {
    g.favorite = !g.favorite;
    core.saveProfile(g);
    applyFilter();
    toast(g.favorite ? '已收藏「' + g.name + '」' : '已取消收藏', 'info', 2000);
  } else if (act === 'hide') {
    g.hidden = true;
    core.saveProfile(g);
    applyFilter();
    toast('已隐藏「' + g.name + '」，可在「已隐藏」中恢复', 'info');
  }
}

// 全面扫描：遍历所有游戏目录 → 识别游戏/修改器 → 补搜缺失封面
async function doScan(deep, fixCovers) {
  if (state.scanning) { toast('正在扫描中，请稍候', 'warn'); return; }
  const roots = core.gameRoots();
  if (!roots.length) {
    toast('还没有添加游戏目录，请先在设置里添加', 'warn', 3200);
    openSettings();
    return;
  }
  state.scanning = true;
  state.scanCurrent = '读取目录...';
  state.scanDone = 0;
  state.scanTotal = 0;
  core.logLine('开始扫描（' + (deep ? '全面' : '增量') + '）：' + roots.join(' | '));
  N.invalidate();
  let res;
  try {
    res = await core.incrementalScan(roots, function (folder, r, done) {
      state.scanCurrent = folder;
      state.scanTotal = r.total;
      state.scanDone = done;
      N.invalidate();
    }, !!deep);
  } catch (e) {
    state.scanning = false;
    toast('扫描失败：' + e.message, 'err', 5000);
    return;
  }
  reloadGames();
  N.clearCoverCache(); // 扫描可能新增/替换封面，清掉预缩放缓存强制重建
  // 封面搜索范围：
  //  - 新发现的游戏：必搜
  //  - 没有真实封面且"从未尝试过"的：补搜（防止上次扫描中断留下空封面）
  //  - 手动扫描（fixCovers=true）：缺封面的全部重试（例如后配代理/换代理后需要补图）
  const need = res.newGames.slice();
  for (const g of core.loadLibrary()) {
    if (need.find(x => x.id === g.id)) continue;
    const noReal = !g.cover || g.coverSource === 'placeholder';
    if (!noReal) continue;
    if (fixCovers || !g.coverTriedAt) need.push(g);
  }
  // 中文名补全：只处理没有中文名、未手动改名、且从未尝试过的游戏（每个游戏一生只试一次）
  const nameNeed = core.loadLibrary().filter(g =>
    g.nameSource !== 'manual' && !core.hasCJK(g.name) && !g.nameLocalizedAt);
  state.scanTotal = need.length + nameNeed.length;
  state.scanDone = 0;
  let realCount = 0;
  let renamed = 0;
  for (const g of need) {
    state.scanCurrent = g.name;
    N.invalidate();
    try {
      const r = await core.fetchCoverFor(g);
      if (r.real) realCount++;
      if (r.name && r.name !== g.name) renamed++;
    } catch (e) {}
    state.scanDone++;
    N.invalidate();
  }
  for (const g of nameNeed) {
    state.scanCurrent = '获取中文名 · ' + g.name;
    N.invalidate();
    try { if (await core.localizeName(g)) renamed++; } catch (e) {}
    state.scanDone++;
    N.invalidate();
  }
  const st = core.settings();
  st.lastScan = new Date().toISOString();
  core.saveSettings(st);
  state.scanning = false;
  state.scanCurrent = '';
  reloadGames();
  const total = core.loadLibrary().length;
  core.logLine('扫描完成：共 ' + total + ' 款，新增 ' + res.added + '，封面 ' + realCount + ' 个');
  const missing = core.loadLibrary().filter(g => !g.cover || g.coverSource === 'placeholder').length;
  if (missing) toast('还有 ' + missing + ' 款游戏缺封面，可点「扫描新游戏」重试（确认已在设置里配好代理）', 'warn', 5000);
  const extra = [];
  if (realCount) extra.push(realCount + ' 个封面');
  if (renamed) extra.push(renamed + ' 个中文名');
  if (res.added > 0) toast('扫描完成：新增 ' + res.added + ' 款游戏' + (extra.length ? '（' + extra.join('、') + '）' : ''), 'ok', 4500);
  else toast('扫描完成：共 ' + total + ' 款游戏' + (extra.length ? '，更新 ' + extra.join('、') : ''), 'info', 3200);
}

// 手动补全中文名（清掉"已尝试"标记后重跑一遍）
async function localizeAllNames() {
  if (state.scanning) { toast('正在扫描中，请稍候', 'warn'); return; }
  const n = core.resetNameLocalization();
  const lib = core.loadLibrary().filter(g => g.nameSource !== 'manual' && !core.hasCJK(g.name));
  if (!lib.length) { toast('没有需要补全中文名的游戏', 'info', 2500); return; }
  state.scanning = true;
  state.scanTotal = lib.length;
  state.scanDone = 0;
  let ok = 0;
  for (const g of lib) {
    state.scanCurrent = '中文名 · ' + g.name;
    N.invalidate();
    try { if (await core.localizeName(g)) ok++; } catch (e) {}
    state.scanDone++;
    N.invalidate();
  }
  state.scanning = false;
  state.scanCurrent = '';
  reloadGames();
  toast('中文名补全完成：' + ok + ' / ' + lib.length + ' 款', ok ? 'ok' : 'info', 3500);
  core.logLine('补全中文名: ' + ok + '/' + lib.length + '（清理标记 ' + n + '）');
}

// 选择并添加一个游戏目录（系统原生文件夹对话框）
function chooseRoot() {
  const dir = N.pickFolder('选择存放游戏的目录');
  if (!dir) return;
  let ok = false;
  try { ok = fs.statSync(dir).isDirectory(); } catch (e) {}
  if (!ok) { toast('目录不可访问：' + dir, 'err', 4000); return; }
  if (!core.addGameRoot(dir)) { toast('该目录已在列表中', 'warn'); return; }
  toast('已添加游戏目录：' + dir, 'ok', 3000);
  if (state.settingsOpen) { layoutSettingsControls(); N.invalidate(); }
  doScan(false, true);
}

// 移除某个游戏目录（连带移除该目录下的游戏条目）
function dropRoot(dir) {
  const n = core.removeGamesUnderRoot(dir);
  core.removeGameRoot(dir);
  reloadGames();
  if (!core.gameRoots().length) state.selected = 0;
  toast('已移除目录' + (n ? '（连带 ' + n + ' 款游戏）' : '') + '：' + dir, 'info', 3500);
  if (state.settingsOpen) { layoutSettingsControls(); N.invalidate(); }
}

function requestExit() {
  const running = core.runningInfo();
  if (running.length > 0) {
    const names = running.map(r => r.name).join('、');
    const r = N.msgBox('以下游戏进程正在运行：\n' + names + '\n\n退出将结束所有这些进程。确定退出？', 'GameBox', N.MB_YESNO);
    if (r !== N.IDYES) return;
  }
  core.killAllGames();
  N.quit();
}

function onClose() {
  const running = core.runningInfo();
  if (running.length > 0) {
    const names = running.map(r => r.name).join('、');
    const r = N.msgBox('以下游戏进程正在运行：\n' + names + '\n\n关闭窗口将结束所有这些进程。确定关闭？', 'GameBox', N.MB_YESNO);
    if (r !== N.IDYES) return false;
  }
  core.killAllGames();
  return true;
}

/* ================= 代理测试 ================= */

async function runProxyTest() {
  applyProxyFromForm(); // 测试前先同步输入框内容：测的就是当前填写的地址/端口
  const s = core.settings();
  if (s.proxy.type === 'none') {
    state.proxyTestOk = false;
    state.proxyTestResult = '当前为"不使用代理"，请先选择 HTTP 或 SOCKS5 并填写地址和端口';
    N.invalidate();
    return;
  }
  const host = String(s.proxy.host || '').trim();
  const port = Number(s.proxy.port) || 0;
  if (!host || !port) {
    state.proxyTestOk = false;
    state.proxyTestResult = '请先填写代理地址和端口（测试将使用输入框中的当前内容）';
    N.invalidate();
    return;
  }
  state.proxyTestResult = '正在测试代理 ' + s.proxy.type + '://' + host + ':' + port + ' ...';
  state.proxyTestOk = false;
  N.invalidate();
  const r = await core.testProxy();
  const lines = [];
  for (const x of r.results || []) {
    if (x.ok) lines.push('✓ ' + x.name + (x.detail ? '：' + x.detail : ''));
    else lines.push('✗ ' + x.name + '：' + (x.error || ('HTTP ' + x.status)));
  }
  state.proxyTestResult = (r.proxy ? ('代理 ' + r.proxy + '\n') : (r.error ? (r.error + '\n') : '')) + lines.join('\n');
  state.proxyTestOk = r.ok;
  N.invalidate();
}

/* ================= 命令处理 ================= */

// 把输入框里的地址/端口立即写进内存设置（不落盘），保证"输入即生效"、测试也测新值
function applyProxyFromForm() {
  if (!state.settingsOpen || suppressFormSync) return;
  const s = core.settings();
  const host = N.editGetText(controls.proxyHost).trim();
  const portText = N.editGetText(controls.proxyPort).trim();
  const port = parseInt(portText, 10) || 0;
  const changed = s.proxy.host !== host || s.proxy.port !== port;
  s.proxy.host = host;
  s.proxy.port = port;
  core.applySettings(s);
  if (changed) {
    state.proxyTestResult = ''; // 地址变了，旧测试结果作废
    N.invalidate();
  }
}

function onCommand(id, code) {
  if (code !== N.WM.EN_CHANGE) return;
  if (id === CTRL.search) {
    state.query = N.editGetText(controls.search);
    state.sortOpen = false;
    applyFilter();
  } else if (id === CTRL.proxyHost || id === CTRL.proxyPort) {
    applyProxyFromForm(); // 边打字边生效
  } else if (id === CTRL.editExe) {
    if (!suppressFormSync) state.editExeText = N.editGetText(controls.editExe);
  }
}

function saveSettingsFromForm() {
  const s = core.settings();
  const pHost = N.editGetText(controls.proxyHost).trim();
  const pPort = parseInt(N.editGetText(controls.proxyPort).trim(), 10) || 0;
  if (s.proxy.type !== 'none' && (!pHost || !pPort)) { toast('请填写代理地址和端口', 'warn'); return; }
  s.proxy.host = pHost;
  s.proxy.port = pPort;
  core.applySettings(s);
  core.saveSettings(s);
  closeSettings();
  toast(s.proxy.type === 'none'
    ? '设置已保存（未使用代理）'
    : '设置已保存：代理 ' + s.proxy.type + '://' + pHost + ':' + pPort, 'ok', 4000);
}

/* ================= 工具 ================= */

function initialsOf(name) {
  const parts = String(name || 'G').replace(/[._]/g, ' ').split(/\s+/).filter(Boolean);
  return parts.map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'G';
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function isRunning(g) {
  const info = core.runningInfo();
  for (const r of info) if (r.gameId === g.id) return true;
  return false;
}

/* ================= 启动 ================= */

function start() {
  createControls();
  N.handlers.onLButtonDown = onLButtonDown;
  N.handlers.onLButtonUp = onLButtonUp;
  N.handlers.onMouseMove = onMouseMove;
  N.handlers.onMouseWheel = onMouseWheel;
  N.handlers.onTouch = onTouch;
  N.handlers.onKeyDown = onKeyDown;
  N.handlers.onCommand = onCommand;
  N.handlers.onClose = onClose;
  N.handlers.onSize = function (type, w, h) {
    void type;
    state.clientW = w; state.clientH = h;
    if (state.settingsOpen) layoutSettingsControls();
    N.invalidate();
  };

  globalThis.__onRunningChange__ = function () {
    const info = core.runningInfo();
    state.runningCount = info.length;
    state.runningGames = info.filter(x => !x.isTrainer).length;
    state.runningTrainers = info.filter(x => x.isTrainer).length;
    // 游戏全部退出后恢复窗口；但刚启动的 20 秒内不自动弹回
    // （部分游戏的主 exe 只是引导器，秒退后由真进程接管，自动弹回会让人误以为没启动）
    if (info.length === 0 && N.isMinimized() && Date.now() > (state.graceUntil || 0)) {
      N.show(true, true); // 游戏退出后恢复窗口，并直接最大化
      N.maximize();
      N.focus();
      // 恢复瞬间：屏蔽手柄输入 + 忽略 400ms 内的启动输入（防"幽灵点击/按键"启动别的游戏）
      state.restoreLockUntil = Date.now() + 400;
      state.hover = -1;
      state.padInput = false; // 恢复窗口后默认交还鼠标控制权
      gamepad.suppress(1200);
    }
    N.invalidate();
  };

  if (gamepad.start()) {
    // 手柄输入只在启动器处于前台（可见且激活）时才生效：
    // 游戏全屏运行时窗口在后台，手柄按键属于游戏，绝不能被启动器当成本地操作
    // 手柄操作的前提：①开关允许 ②设置面板没开 ③窗口未最小化 ④启动器是当前激活窗口
    // 只要不满足，一切手柄操作（方向/A/B/START）全部屏蔽，避免后台误启动游戏
    const padBlockReason = function () {
      if (!state.padEnabled) return '手柄操作已关闭';
      if (state.settingsOpen) return '设置面板打开中';
      if (N.isMinimized()) return '启动器已最小化';
      if (!N.isForeground()) return '启动器不是当前激活窗口';
      return '';
    };
    const padActive = function () { return !padBlockReason(); };
    const padBlocked = function (what) {
      const why = padBlockReason();
      if (!why) return false;
      const now = Date.now();
      if (now - state.padLogAt > 3000) {
        state.padLogAt = now;
        core.logLine('屏蔽手柄' + what + '：' + why);
      }
      return true;
    };
    gamepad.cb.onNavigate = function (dx, dy) { if (!padActive()) { padBlocked('方向键'); return; } navigate(dx, dy); };
    gamepad.cb.onA = function () {
      if (state.settingsOpen) { padBlocked('A'); return; }
      if (!padActive()) { padBlocked('A'); return; }
      launchSelected('gamepad-A');
    };
    gamepad.cb.onB = function () {
      if (state.settingsOpen) { closeSettings(); return; } // 设置面板里 B = 关闭
      if (!padActive()) { padBlocked('B'); return; }
      N.show(false);
    };
    gamepad.cb.onStart = function () { if (!padActive()) { padBlocked('START'); return; } doScan(false, true); };
  }

  const s = core.settings();
  state.zoom = s.zoom || 1.0;
  state.sort = s.sort || 'default';
  state.padEnabled = s.padEnabled !== false; // 默认开启

  reloadGames();
  // 启动流程：先快速清理"游戏已被删除"的条目，再全面扫描（识别游戏/修改器 + 补搜封面）
  if (core.gameRoots().length) {
    const pr = core.pruneMissingGames();
    if (pr.removed.length) {
      reloadGames();
      toast('已移除不存在的游戏：' + pr.removed.slice(0, 3).join('、') + (pr.removed.length > 3 ? ' 等' : ''), 'info', 4000);
    }
    doScan(false, false); // 每次进入：只找新游戏；已有封面的不重复搜
  }

  // 仅调试：GAMEBOX_OPEN_SETTINGS=1 时自动打开设置面板（便于截图验证原生输入框）
  if (process.env.GAMEBOX_OPEN_SETTINGS === '1') setTimeout(openSettings, 1200);
}

function tick() {
  // toast 存活期间持续重绘（过期消失）
  if (state.toasts.length) N.invalidate();
  // 触屏惯性滚动期间需要持续重绘
  if (state.touchScrollV) updateTouchFling();
}

module.exports = {
  start: start,
  state: state,
  draw: draw,
  tick: tick,
  toast: toast,
  // 调试用（不影响运行）
  __controls: controls,
  __openSettings: openSettings,
  __closeSettings: closeSettings,
  __settingsLayout: settingsLayout,
  __applyProxyFromForm: applyProxyFromForm,
  __saveSettings: saveSettingsFromForm,
  __runProxyTest: runProxyTest,
  __togglePad: togglePad,
  __openRename: openRename,
  __saveRename: saveRename,
  __renameLayout: renameLayout,
  __openEdit: openEdit,
  __closeEdit: closeEdit,
  __saveEdit: saveEdit,
  __editLayout: editLayout,
  __editButtons: editButtons,
  __editBrowseExe: editBrowseExe,
  __editDefaultExe: editDefaultExe,
  __editPickCover: editPickCover,
  __editToggleClearCover: editToggleClearCover,
  __drawEdit: drawEdit,
  __onLButtonDown: onLButtonDown,
  __onMouseMove: onMouseMove,
  __onMouseWheel: onMouseWheel,
  __openTouchMenu: openTouchMenu,
  __cardAt: cardAt,
  __onKeyDown: onKeyDown,
  __onTouch: onTouch,
  __updateTouchFling: updateTouchFling,
  __touchMenuRect: touchMenuRect,
  __drawTouchMenu: drawTouchMenu
};
