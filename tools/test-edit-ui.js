/*
 * test-edit-ui.js —— 「编辑游戏」弹窗行为测试（打桩掉真实绘制与窗口）
 * 覆盖：打开弹窗 / 浏览选文件 / 保存写入 customExe / 恢复默认 / 选封面 /
 *       清除封面 / 导入失败时弹窗不关 / 按钮点击命中 / Esc 取消 / 布局在面板内
 *
 * 运行：node tools/test-edit-ui.js
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

let pickReturn = null;
let pickCalls = [];
N.pickFile = (opts) => { pickCalls.push(opts); return pickReturn; };

const saved = [];
core.saveProfile = (g) => { saved.push(g); };
core.logLine = () => {};
core.openFolder = () => {};
core.settings = () => ({ zoom: 1, sort: 'default', padEnabled: true, gamesRoots: ['E:\\Games'], proxy: { type: 'none', host: '', port: 0 } });
core.loadLibrary = () => st.games;

let coverCalls = [];
core.setCoverFromLocalFile = (g, file) => {
  coverCalls.push({ game: g, file: file });
  return path.extname(file).toLowerCase() === '.webp' ? { ok: false, error: '不支持的图片格式' } : { ok: true, ext: 'png' };
};
let clearCalls = [];
core.clearCover = (g) => { clearCalls.push(g); return true; };

const st = ui.state;
st.clientW = 1600; st.clientH = 900;
st.games = [{
  id: 'g1', name: '空之轨迹', folder: 'Sora', path: 'E:\\Games\\Sora',
  exe: 'E:\\Games\\Sora\\game.exe', cover: 'cover.jpg', coverSource: 'bing',
  favorite: false, hidden: false, missing: false
}];
st.filtered = st.games.slice();
st.selected = 0;

const game = st.games[0];
const L = ui.__editLayout();

/* ---------------- 1. 打开 / 布局 ---------------- */
say('\n[1] 打开弹窗与布局');
ui.__openEdit(game);
ok('弹窗已打开', st.editOpen === true);
ok('输入框填入当前启动文件', editText === game.exe);
const G = L.G;
ok('输入框在面板内', L.exeEdit.x >= G.x && L.exeEdit.x + L.exeEdit.w <= G.x + G.w);
ok('浏览/默认按钮不重叠', L.exeBrowse.x >= L.exeEdit.x + L.exeEdit.w - 1);
ok('默认按钮右端不越界', L.exeDefault.x + L.exeDefault.w <= G.x + G.w - 20);
for (const b of ui.__editButtons()) {
  ok('按钮 ' + b.act + ' 在面板内', b.x >= G.x && b.y >= G.y && b.x + b.w <= G.x + G.w && b.y + b.h <= G.y + G.h);
}

/* ---------------- 2. 自定义启动文件 ---------------- */
say('\n[2] 自定义启动文件（.bat）');
const bat = 'E:\\Games\\Sora\\启动.bat';
pickReturn = bat;
ui.__editBrowseExe();
ok('浏览后输入框变成选中的 bat', editText === bat);
ok('文件对话框用了脚本过滤器', pickCalls[0].groups[0].patterns.join(',').indexOf('*.bat') >= 0);
st.editExeText = bat;
ui.__saveEdit();
ok('保存后写入 customExe', game.customExe === bat);
ok('保存后弹窗关闭', st.editOpen === false);
ok('启动目标用自定义路径', core.launchTargetOf(game).file === bat);
ok('启动方式按 bat 处理', core.buildLaunchSpec(core.launchTargetOf(game)).kind === 'bat');

ui.__openEdit(game);
ok('重新打开显示自定义路径', editText === bat);

/* ---------------- 3. 恢复默认 ---------------- */
say('\n[3] 恢复默认启动文件');
ui.__editDefaultExe();
ok('点默认后输入框回到自动识别的 exe', editText === game.exe);
ui.__saveEdit();
ok('保存后 customExe 清空', game.customExe === null);
ok('启动目标回退到默认 exe', core.launchTargetOf(game).file === game.exe);

/* ---------------- 4. 封面 ---------------- */
say('\n[4] 自定义封面');
ui.__openEdit(game);
const png = 'D:\\Pictures\\my-cover.png';
pickReturn = png;
ui.__editPickCover();
ok('选图后记录待保存封面', st.editCoverFile === png);
ok('封面对话框过滤器含 png/jpg', pickCalls[pickCalls.length - 1].groups[0].patterns.join(',').indexOf('*.png') >= 0);
ui.__saveEdit();
ok('保存时调用了封面导入', coverCalls.length === 1 && coverCalls[0].file === png);
ok('保存后弹窗关闭', st.editOpen === false);

// 导入失败（webp）：弹窗必须留着让用户重选
ui.__openEdit(game);
pickReturn = 'D:\\Pictures\\bad.webp';
ui.__editPickCover();
const savedBefore = saved.length;
const coverCallsBefore = coverCalls.length;
ui.__saveEdit();
ok('导入失败时弹窗不关', st.editOpen === true);
ok('导入失败时给出提示', /不支持/.test(st.editHint), st.editHint);
ok('导入失败时不落盘（未写 profile）', saved.length === savedBefore);
ok('导入失败不触发清除封面', clearCalls.length === 0);
ok('导入尝试确实发生过（被拒绝而非被跳过）', coverCalls.length === coverCallsBefore + 1);

/* ---------------- 5. 清除封面 ---------------- */
say('\n[5] 清除封面');
ui.__editToggleClearCover();
ok('勾选清除后清掉待保存封面', st.editCoverFile === null && st.editCoverClear === true);
ui.__saveEdit();
ok('保存时调用了清除封面', clearCalls.length === 1);
ok('保存后弹窗关闭', st.editOpen === false);

/* ---------------- 6. 点击与键盘 ---------------- */
say('\n[6] 按钮点击 / Esc 取消');
ui.__openEdit(game);
ui.__onLButtonDown(L.cancelBtn.x + 5, L.cancelBtn.y + 5);
ok('点取消关闭弹窗', st.editOpen === false);

ui.__openEdit(game);
ui.__onLButtonDown(G.x - 50, G.y - 50);
ok('点面板外关闭弹窗', st.editOpen === false);

ui.__openEdit(game);
ui.__onKeyDown(0x1B, 0, false);   // Esc
ok('Esc 关闭弹窗', st.editOpen === false);

ui.__openEdit(game);
pickReturn = 'E:\\Games\\Sora\\run.cmd';
ui.__onLButtonDown(L.exeBrowse.x + 4, L.exeBrowse.y + 4);
ok('点浏览按钮弹出文件框', editText === 'E:\\Games\\Sora\\run.cmd');
ui.__onKeyDown(0x0D, 0, false);   // Enter 保存
ok('Enter 保存并关闭', st.editOpen === false && game.customExe === 'E:\\Games\\Sora\\run.cmd');
ok('.cmd 走 cmd /c 启动', core.buildLaunchSpec(core.launchTargetOf(game)).kind === 'bat');

say('\n结果：' + (failed ? ('失败 ' + failed + ' 项') : '全部通过'));
process.exit(failed ? 1 : 0);
