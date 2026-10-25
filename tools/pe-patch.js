/*
 * GameBox 3 — tools/pe-patch.js
 * 把 PE 可执行文件的 Subsystem 从 CONSOLE(3) 改为 WINDOWS_GUI(2)
 * 作用：基于 node.exe 打包的 EXE 双击运行时不显示黑色控制台窗口
 */
'use strict';
const fs = require('fs');

function patchPeSubsystem(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5A4D) throw new Error('不是有效的 PE 文件（MZ 签名缺失）');
  const peOff = buf.readUInt32LE(0x3C);
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('不是有效的 PE 文件（PE 签名缺失）');
  const coff = peOff + 4;
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  if (buf.readUInt16LE(opt) !== 0x20B) throw new Error('不是 PE32+ 格式');
  void optSize;
  const subSysOff = opt + 68; // IMAGE_OPTIONAL_HEADER64.Subsystem
  const old = buf.readUInt16LE(subSysOff);
  if (old !== 3) return { changed: false, old: old };
  buf.writeUInt16LE(2, subSysOff); // IMAGE_SUBSYSTEM_WINDOWS_GUI
  fs.writeFileSync(file, buf);
  return { changed: true, old: old };
}

module.exports = { patchPeSubsystem: patchPeSubsystem };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('用法: node pe-patch.js <exe路径>'); process.exit(1); }
  try {
    const r = patchPeSubsystem(file);
    console.log(r.changed ? ('PE Subsystem: ' + r.old + ' -> 2 (WINDOWS_GUI)，控制台窗口已去除') : ('Subsystem 已是 ' + r.old + '，无需修改'));
  } catch (e) {
    console.error('PE 补丁失败: ' + e.message);
    process.exit(1);
  }
}
