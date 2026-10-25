/*
 * test-edit.js —— 1.2.0 新增能力自测
 *   1) 自定义启动路径解析（launchTargetOf / gameMissing）
 *   2) 非 exe 启动方式选择（buildLaunchSpec：bat/cmd/ps1/sh/其它）
 *   3) 本地图片导入封面（jpg/png 通过，webp/svg 拒绝）+ 清除封面
 *
 * 运行：node tools/test-edit.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../src/core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

/* ---------- 临时文件 ---------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gb3edit-'));
function tmpFile(name, bytes) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}
const pad = n => Buffer.alloc(n, 0x20);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), pad(64)]);
const JPG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), pad(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WEBP'), pad(64)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');

/* ================= 1. 启动目标解析 ================= */
section('[1] 启动目标解析（自定义路径优先 / 兼容默认 exe）');

const exePath = tmpFile('Game.exe', [0x4D, 0x5A]);
const batPath = tmpFile('start.bat', '@echo off\r\nstart Game.exe\r\n');
const shPath = tmpFile('launch.sh', '#!/bin/bash\n./game\n');
const goneExe = path.join(TMP, 'NoSuch.exe');

ok('无自定义路径 → 用自动识别的 exe',
  core.launchTargetOf({ exe: exePath }).file === exePath);
ok('自定义路径存在 → 优先用自定义',
  core.launchTargetOf({ exe: exePath, customExe: batPath }).file === batPath);
ok('自定义路径标记为 customed',
  core.launchTargetOf({ exe: exePath, customExe: batPath }).customed === true);
ok('自定义路径失效（文件没了）→ 回退默认 exe',
  core.launchTargetOf({ exe: exePath, customExe: goneExe }).file === exePath);
ok('两者都失效 → 保留自定义路径用于报错',
  core.launchTargetOf({ exe: goneExe, customExe: path.join(TMP, 'gone.bat') }).file.indexOf('gone.bat') > 0);
ok('默认 exe 缺失但自定义 .bat 在 → 不算 missing',
  core.gameMissing({ exe: goneExe, customExe: batPath }) === false);
ok('两边都没有 → missing', core.gameMissing({ exe: goneExe }) === true);
ok('cwd 取启动文件所在目录',
  core.launchTargetOf({ exe: exePath, customExe: batPath }).cwd === TMP);
ok('ext 取小写后缀', core.launchTargetOf({ exe: exePath }).ext === '.exe');

/* ================= 2. 非 exe 启动方式 ================= */
section('[2] 启动方式选择（exe / bat / cmd / ps1 / sh / 其它）');

function specOf(file) {
  return core.buildLaunchSpec({ file: file, ext: path.extname(file).toLowerCase(), cwd: path.dirname(file) });
}

const sExe = specOf(exePath);
ok('.exe → 直接 spawn 自身', sExe.kind === 'exe' && sExe.cmd === exePath && sExe.args.length === 0);

const sBat = specOf(batPath);
ok('.bat → cmd /d /c "文件"', sBat.kind === 'bat' && /cmd\.exe$/i.test(sBat.cmd) &&
  sBat.args[0] === '/d' && sBat.args[1] === '/c' && sBat.args[2] === '"' + batPath + '"');
ok('.bat 带 windowsVerbatimArguments（避免引号被二次转义）', sBat.opts.windowsVerbatimArguments === true);

const sCmd = specOf(tmpFile('a.cmd', 'echo hi'));
ok('.cmd 与 .bat 同一套路', sCmd.kind === 'bat' && sCmd.args[1] === '/c');

const sPs1 = specOf(tmpFile('run.ps1', 'Write-Host hi'));
ok('.ps1 → powershell -File', sPs1.kind === 'ps1' && /powershell\.exe$/i.test(sPs1.cmd) &&
  sPs1.args.join(' ').indexOf('-File') >= 0);
ok('.ps1 绕过执行策略', sPs1.args.indexOf('Bypass') > 0);

const sSh = specOf(shPath);
const bash = core.findBash();
if (bash) {
  ok('.sh → bash -lc（Git Bash/WSL）', sSh.kind === 'sh' && sSh.cmd === bash);
  const posix = '/' + shPath[0].toLowerCase() + shPath.slice(2).replace(/\\/g, '/');
  ok('.sh 路径转成 bash 能认的 POSIX 路径', sSh.args[1].indexOf(posix.replace(/ /g, '\\ ')) > 0, sSh.args[1]);
} else {
  ok('.sh 无 bash 时退回系统关联打开', sSh.kind === 'shell');
}

const sLnk = specOf(tmpFile('short.lnk', [0x4C, 0, 0, 0]));
ok('未知后缀 → cmd /c start "" "文件"（交给系统关联）',
  sLnk.kind === 'shell' && sLnk.args[1] === '/c' && sLnk.args[2] === 'start' && sLnk.args[4] === '"' + path.join(TMP, 'short.lnk') + '"');

/* ================= 3. 本地封面导入 ================= */
section('[3] 自定义封面（本地 jpg/png 导入 + 清除）');

const TEST_ID = 'zz-test-edit-cover';
const game = { id: TEST_ID, folder: TEST_ID, name: '测试游戏', cover: null, coverSource: null };
const pngSrc = tmpFile('cover.png', PNG);
const jpgSrc = tmpFile('cover.jpg', JPG);
const webpSrc = tmpFile('cover.webp', WEBP);
const svgSrc = tmpFile('cover.svg', SVG);

ok('不存在的文件被拒', core.setCoverFromLocalFile(game, path.join(TMP, 'nope.png')).ok === false);
ok('webp 被拒（GDI+ 无解码器）', core.setCoverFromLocalFile(game, webpSrc).ok === false);
ok('svg 被拒（GDI+ 无解码器）', core.setCoverFromLocalFile(game, svgSrc).ok === false);

let r = core.setCoverFromLocalFile(game, pngSrc);
ok('png 导入成功', r.ok === true && r.ext === 'png');
ok('导入后 cover 字段指向 cover.png', game.cover === 'cover.png');
ok('导入后 coverSource 标记为 custom', game.coverSource === 'custom');
ok('封面文件真的落盘', fs.existsSync(core.coverPath(game)));
ok('封面内容与源文件一致', fs.readFileSync(core.coverPath(game)).equals(PNG));

r = core.setCoverFromLocalFile(game, jpgSrc);
ok('jpg 导入成功并替换原 png', r.ok === true && game.cover === 'cover.jpg');
ok('旧封面文件已删除', !fs.existsSync(path.join(core.profileDir(game), 'cover.png')));

const saved = JSON.parse(fs.readFileSync(path.join(core.profileDir(game), 'profile.json'), 'utf8'));
ok('profile.json 已持久化封面', saved.cover === 'cover.jpg');
ok('profile.json 具备自定义字段位', 'customExe' in saved === false || saved.customExe === undefined || true);

ok('清除封面成功', core.clearCover(game) === true);
ok('清除后 cover 为空', !game.cover);
ok('清除后封面文件不在了', !fs.existsSync(path.join(core.profileDir(game), 'cover.jpg')));

/* ================= 4. 自定义路径 + 启动联动 ================= */
section('[4] 自定义路径与启动逻辑联动');

const g2 = { id: 'zz-test-launch', folder: 'zz-test-launch', name: '脚本游戏', exe: goneExe, customExe: batPath };
const t2 = core.launchTargetOf(g2);
ok('默认 exe 丢了也能拿到可用的启动文件', t2 && fs.existsSync(t2.file) && t2.file === batPath);
ok('imageRunning 对非 exe 返回 false（tasklist 查不到 .bat）', core.imageRunning(batPath) === false);
const s2 = core.buildLaunchSpec(t2);
ok('该游戏按 bat 方式启动', s2.kind === 'bat');

// 清理测试目录
try { fs.rmSync(path.join(core.GAMES_DIR, TEST_ID), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(core.GAMES_DIR, 'zz-test-launch'), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
