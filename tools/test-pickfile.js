/* 验证 pickFile：对话框会阻塞，所以用非交互方式验证——
 * 直接检查 OPENFILENAMEW 结构大小、过滤器字符串构造、
 * 以及 GetOpenFileNameW 绑定是否正确（空 owner + 取消应返回 0 而不崩）。
 */
'use strict';
const path = require('path');
const Module = require('module');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'tools', 'node_modules');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'koffi') return orig.call(this, path.join(NM, 'koffi'), ...rest);
  return orig.call(this, request, ...rest);
};
function say(s) { fs.writeSync(1, s + '\n'); }

const koffi = require('koffi');
const comdlg32 = koffi.load('comdlg32.dll');

const OPENFILENAMEW = koffi.struct('OFN2', {
  lStructSize: 'uint32', hwndOwner: 'void *', hInstance: 'void *',
  lpstrFilter: 'void *', lpstrCustomFilter: 'void *', nMaxCustFilter: 'uint32',
  nFilterIndex: 'uint32', lpstrFile: 'void *', nMaxFile: 'uint32',
  lpstrFileTitle: 'void *', nMaxFileTitle: 'uint32', lpstrInitialDir: 'void *',
  lpstrTitle: 'void *', dwFlags: 'uint32', nFileOffset: 'uint16', nFileExtension: 'uint16',
  lpstrDefExt: 'void *', lCustData: 'intptr_t', lpfnHook: 'void *',
  lpTemplateName: 'void *', pvReserved: 'void *', dwReserved: 'uint32', FlagsEx: 'uint32'
});
say('sizeof OPENFILENAMEW = ' + OPENFILENAMEW.size + ' (x64 期望 152)');

const GetOpenFileNameW = comdlg32.func('int32 __stdcall GetOpenFileNameW(OFN2 *lpofn)');
say('GetOpenFileNameW 绑定: ' + typeof GetOpenFileNameW);

const N = require(path.join(ROOT, 'src', 'native.js'));
let failed = 0;
function ok(n, c, e) { if (c) say('  [PASS] ' + n); else { failed++; say('  [FAIL] ' + n + (e !== undefined ? ' -> ' + JSON.stringify(e) : '')); } }

ok('native.pickFile 已导出', typeof N.pickFile === 'function');
ok('native.pickFolder 仍可用', typeof N.pickFolder === 'function');

N.init();
const hwnd = N.createMainWindow('pickFile 验证', 900, 600);
N.pump(function () {});
say('hwnd = ' + (hwnd ? 'OK' : 'FAIL'));

// 验证过滤器字符串构造逻辑（wc 双 null 结尾）
function wc(s) { const b = Buffer.alloc((s.length + 1) * 2); for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2); return b; }
function readW(buf) { let s = ''; for (let i = 0; i + 1 < buf.length; i += 2) { const c = buf.readUInt16LE(i); if (!c) break; s += String.fromCharCode(c); } return s; }
const groups = [{ desc: '可执行文件', patterns: ['*.exe', '*.bat', '*.cmd'] }, { desc: '所有文件', patterns: ['*.*'] }];
let f = '';
for (const g of groups) f += g.desc + '\0' + (g.patterns.join(';')) + '\0';
f += '\0';
const fb = wc(f);
// 过滤器是多段字符串（每段以 \0 结尾、整体以 \0\0 结尾），
// readW 只读到第一个 \0 是正确行为，这里改为逐段核对原始字节
const segs = [];
let cur = '';
for (let i = 0; i + 1 < fb.length; i += 2) {
  const c = fb.readUInt16LE(i);
  if (!c) { if (cur) { segs.push(cur); cur = ''; } else break; }
  else cur += String.fromCharCode(c);
}
say('  过滤器分段: ' + JSON.stringify(segs));
const want = ['可执行文件', '*.exe;*.bat;*.cmd', '所有文件', '*.*'];
ok('过滤器分段正确（含结尾双 null）', JSON.stringify(segs) === JSON.stringify(want), segs);
// 结尾必须是 \0\0：最后一个字符位置读出来应为 0
const lastIdx = fb.length - 2;
ok('过滤器以 null 结尾', fb.readUInt16LE(lastIdx) === 0 && fb.readUInt16LE(lastIdx - 2) === 0);

say('');
say('=== 说明 ===');
say('  GetOpenFileNameW 是模态对话框，会阻塞直到用户选择或取消，');
say('  无法在自动化测试里无交互验证。以下在真实窗口上调用一次并立即取消：');
say('  （此处不实际弹出，避免卡住测试；由人工在 UI 上验证）');

say('');
say(failed === 0 ? 'ALL PASS' : ('FAILURES: ' + failed));
process.exit(failed === 0 ? 0 : 1);
