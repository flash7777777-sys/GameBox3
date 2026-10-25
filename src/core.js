/*
 * GameBox 3 — core.js
 * 游戏库核心：目录扫描 / 主 EXE 智能识别 / Trainer 检测 / 一游戏一目录 profile /
 * 封面联网搜索（代理支持）/ 增量扫描 / 启动与进程托管
 * 零第三方运行时依赖（Node 内置模块），FFI 部分在 native.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const https = require('https');
const httpLib = require('http');
const net = require('net');
const tls = require('tls');

/* ---------------- 路径与配置 ---------------- */

// 打包版：数据放 exe 同目录 config\；源码版：放项目目录 config\
const APP_DIR = globalThis.__GAMEBOX_PACKAGED__ ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(APP_DIR, 'config');
const GAMES_DIR = path.join(CONFIG_DIR, 'games');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');
const LOG_PATH = path.join(CONFIG_DIR, 'launcher.log');
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions'); // 修改器看门狗的会话标志文件

for (const d of [CONFIG_DIR, GAMES_DIR, SESSIONS_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
}

function logLine(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
  try { fs.appendFileSync(LOG_PATH, line); } catch (e) {}
  if (globalThis.__GAMEBOX_DEBUG__) console.log(line.trim());
}

const DEFAULT_SETTINGS = {
  gamesRoots: [],     // 游戏根目录列表（可多个）；首次运行留空，由用户选择
  gamesRoot: '',      // 旧字段，仅用于迁移
  proxy: { type: 'none', host: '', port: 0 },
  zoom: 1.0,
  sort: 'default',
  padEnabled: true,   // 手柄操作界面（侧边栏开关）
  lastScan: null
};

function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch (e) {}
  s = Object.assign({}, DEFAULT_SETTINGS, s);
  s.proxy = Object.assign({}, DEFAULT_SETTINGS.proxy, s.proxy || {});
  // 迁移：旧版单一 gamesRoot → gamesRoots 数组
  if (!Array.isArray(s.gamesRoots)) s.gamesRoots = [];
  if (!s.gamesRoots.length && s.gamesRoot) s.gamesRoots = [s.gamesRoot];
  s.gamesRoots = s.gamesRoots.map(x => String(x || '').trim()).filter(Boolean);
  return s;
}
function saveSettings(s) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2)); } catch (e) { logLine('保存设置失败: ' + e.message); }
}

/* ---------------- 基础工具 ---------------- */

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'game';
}
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}
function cleanName(s) {
  return String(s || '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function nowISO() { return new Date().toISOString(); }
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) { h = (h * 31 + String(s).charCodeAt(i)) | 0; }
  return Math.abs(h);
}

/* ---------------- 目录扫描与主 EXE 识别 ---------------- */

const SKIP_DIRS = /^(\$RECYCLE\.BIN|System Volume Information|__MACOSX|\.git|_UnInstall|_Uninstall|_CommonRedist|CommonRedist|[Rr]edists?|__support|dotnet|directx|_redist|Installer|__INSTALL|Backup|Temp|tmp)$/i;
const HARD_BLACKLIST = /(unins\d*|uninstall|crash|bugsplat|bssndrpt|bugreport|errorreport|reporter|report\.exe|redist|vcredist|vc_redist|dxsetup|dxwebsetup|setup\.exe|config\.exe|unitycrash|crashsender|crashreporter|crashpad|notification|saveremovertool|protocolselector|installer|installer\.exe|message\.exe|diagnostic|launcher\.exe$|updater|patcher|patch\.exe|activat|eula|readme|help\.exe|manual)/i;
// 修改器：*Trainer.exe / *trainer.exe（及常见变体）
const TRAINER_RE = /[._\-\s][Tt]rainer[._\-\s\d]*\.exe$/i;

function findExes(root, maxDepth) {
  maxDepth = maxDepth || 5;
  const out = [];
  (function walk(d, depth) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      let isDir = false, isFile = false;
      try { isDir = e.isDirectory(); isFile = e.isFile(); } catch (_) {}
      if (isDir) {
        if (depth < maxDepth && !SKIP_DIRS.test(e.name)) walk(p, depth + 1);
      } else if (isFile && /\.exe$/i.test(e.name)) {
        try {
          const st = fs.statSync(p);
          out.push({ path: p, name: e.name, size: st.size, depth: depth });
        } catch (_) {}
      }
    }
  })(root, 0);
  return out;
}

function pickMainExe(exes, folderName) {
  if (!exes.length) return null;
  const nFolder = norm(cleanName(folderName));
  const initials = String(cleanName(folderName)).toLowerCase().split(' ').filter(Boolean).map(w => w[0]).join('');
  const scored = exes.map(x => {
    const base = x.name.replace(/\.exe$/i, '');
    let s = 0;
    let blacklisted = false;
    if (HARD_BLACKLIST.test(x.name) || TRAINER_RE.test(x.name)) blacklisted = true;
    const nExe = norm(base).replace(/(steam|epic|uplay|rockstar|win64|shipping)$/, '');
    if (nExe && nFolder) {
      if (nExe === nFolder) s += 100;
      else if (nExe.indexOf(nFolder) >= 0 || nFolder.indexOf(nExe) >= 0) s += 60;
      else {
        const p = nFolder.slice(0, Math.min(6, nFolder.length));
        if (p.length >= 3 && nExe.indexOf(p) === 0) s += 40;
        if (initials.length >= 2 && (initials.indexOf(nExe) === 0 || nExe.indexOf(initials) === 0)) s += 35;
      }
    }
    s += Math.min(40, Math.log10(Math.max(1, x.size)) * 3.2);
    s += Math.max(0, 10 - x.depth * 4);
    return { x: x, score: s, blacklisted: blacklisted };
  });
  const alive = scored.filter(o => !o.blacklisted);
  const pool = alive.length ? alive : scored;
  pool.sort((a, b) => b.score - a.score);
  return pool[0].x;
}

// 扫描一个游戏目录：主 EXE + Trainer 列表
function inspectGameDir(dir) {
  const exes = findExes(dir, 5);
  if (!exes.length) return { exe: null, exeName: null, trainers: [] };
  const main = pickMainExe(exes, path.basename(dir));
  const trainers = exes.filter(x => TRAINER_RE.test(x.name) && (!main || x.path !== main.path)).map(x => x.path);
  return { exe: main ? main.path : null, exeName: main ? main.name : null, trainers: trainers };
}

/* ---- 修改器探测：给封面打"金色小点"用（带缓存，避免每帧读盘） ---- */
const TRAINER_HINT = /(trainer|修改器|风灵|cheat)/i;
const trainerProbe = new Map(); // dir -> { at, found, path }
function probeTrainer(dir) {
  if (!dir) return { found: false };
  const now = Date.now();
  const hit = trainerProbe.get(dir);
  if (hit && now - hit.at < 5000) return hit;
  let found = false, foundPath = null;
  const scan = (d, depth) => {
    if (found) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (found) return;
      if (e.isFile() && /\.exe$/i.test(e.name) && TRAINER_HINT.test(e.name)) { found = true; foundPath = path.join(d, e.name); return; }
    }
    if (depth > 0) {
      for (const e of ents) {
        if (found) return;
        if (e.isDirectory() && !SKIP_DIRS.test(e.name)) scan(path.join(d, e.name), depth - 1);
      }
    }
  };
  scan(dir, 1);
  const rec = { at: now, found: found, path: foundPath };
  trainerProbe.set(dir, rec);
  return rec;
}

// 该游戏是否带修改器：优先用扫描记录的路径，否则现场探测游戏目录（兼容"扫完之后才放进修改器"）
function hasTrainer(game) {
  if (!game) return false;
  if (game.trainer && fs.existsSync(game.trainer)) return true;
  const dir = game.path || (game.exe ? path.dirname(game.exe) : null);
  if (!dir) return false;
  return probeTrainer(dir).found;
}

// 浅扫描：只读取根目录下的子文件夹名（快，不递归）
function scanRootDirs(root) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of ents) {
    let isDir = false;
    try { isDir = ent.isDirectory(); } catch (_) {}
    if (!isDir) continue;
    if (SKIP_DIRS.test(ent.name) || ent.name.startsWith('.')) continue;
    out.push({ folder: ent.name, path: path.join(root, ent.name) });
  }
  out.sort((a, b) => a.folder.localeCompare(b.folder, 'zh-Hans-CN'));
  return out;
}

// 兼容旧调用：完整扫描（含深度识别），用于手动刷新
function scanRoot(root) {
  const out = [];
  for (const f of scanRootDirs(root)) {
    const info = inspectGameDir(f.path);
    out.push({ folder: f.folder, path: f.path, exe: info.exe, exeName: info.exeName, trainers: info.trainers });
  }
  return out;
}

/* ---------------- 游戏根目录（支持多个） ---------------- */

function gameRoots() {
  const list = (settings.gamesRoots || []).filter(d => typeof d === 'string' && d.trim());
  return list;
}

function addGameRoot(dir) {
  const d = String(dir || '').trim();
  if (!d) return false;
  const list = gameRoots().slice();
  if (list.some(x => x.toLowerCase() === d.toLowerCase())) return false;
  list.push(d);
  settings.gamesRoots = list;
  settings.gamesRoot = list[0] || '';
  saveSettings(settings);
  logLine('添加游戏目录: ' + d);
  return true;
}

function removeGameRoot(dir) {
  const d = String(dir || '').trim().toLowerCase();
  settings.gamesRoots = gameRoots().filter(x => x.toLowerCase() !== d);
  settings.gamesRoot = settings.gamesRoots[0] || '';
  saveSettings(settings);
  logLine('移除游戏目录: ' + dir);
}

// 删除某根目录下的全部游戏 profile（移除目录时连带清理）
function removeGamesUnderRoot(root) {
  const base = path.resolve(root).toLowerCase();
  const pre = base + path.sep;
  let removed = 0;
  for (const g of loadLibrary()) {
    const p = path.resolve(g.path || '').toLowerCase();
    if (p === base || p.startsWith(pre)) {
      try { fs.rmSync(profileDirOf(g), { recursive: true, force: true }); removed++; } catch (e) {}
    }
  }
  if (removed) logLine('移除目录 ' + root + ' 下的 ' + removed + ' 款游戏');
  return removed;
}

// 启动快速清理：根目录可访问、但游戏文件夹已被删除的条目 → 从库中移除
function pruneMissingGames() {
  const roots = gameRoots();
  const alive = roots.filter(r => { try { return fs.statSync(r).isDirectory(); } catch (e) { return false; } });
  const removed = [];
  if (!alive.length) return { removed }; // 没有任何可用根目录（离线盘等）→ 不做删除
  for (const g of loadLibrary()) {
    if (!g.path) continue;
    const p = path.resolve(g.path).toLowerCase();
    const under = alive.find(r => p.startsWith(path.resolve(r).toLowerCase() + path.sep));
    if (!under) continue;             // 不属于当前可用的根目录 → 不动
    if (fs.existsSync(g.path)) continue;
    try {
      fs.rmSync(profileDirOf(g), { recursive: true, force: true });
      removed.push(g.name || g.folder);
    } catch (e) {}
  }
  if (removed.length) logLine('已移除不存在的游戏: ' + removed.join('、'));
  return { removed };
}

/* ---------------- Profile（一游戏一目录） ---------------- */

function profileDir(game) { return path.join(GAMES_DIR, slugify(game.folder)); }
// 实际磁盘目录：loadLibrary 会把目录名写进 id，删除时必须用它（slugify 可能和目录名不一致）
function profileDirOf(game) { return path.join(GAMES_DIR, game && game.id ? game.id : slugify(game && game.folder)); }
function profilePath(game) { return path.join(profileDir(game), 'profile.json'); }

function loadProfile(folder) {
  try {
    return JSON.parse(fs.readFileSync(path.join(GAMES_DIR, slugify(folder), 'profile.json'), 'utf8'));
  } catch (e) { return null; }
}

function saveProfile(g) {
  // 优先写到"已存在的真实目录"（loadLibrary 会把目录名放进 id）；新游戏则用 slugify(folder)
  const byId = g && g.id ? path.join(GAMES_DIR, g.id) : null;
  const dir = (byId && fs.existsSync(byId)) ? byId : profileDir(g);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  // cover 存相对文件名（与 profile.json 同目录）
  const data = Object.assign({}, g, { cover: g.cover || null });
  try { fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(data, null, 2)); } catch (e) { logLine('保存 profile 失败: ' + g.folder); }
}

function coverPath(g) {
  return g && g.cover ? path.join(profileDir(g), g.cover) : null;
}

// 载入全部 profile
function loadLibrary() {
  const games = [];
  let ents;
  try { ents = fs.readdirSync(GAMES_DIR, { withFileTypes: true }); } catch (e) { return games; }
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, ent.name, 'profile.json'), 'utf8'));
      p.id = ent.name;
      // 缺失标记每次载入重算：用户改了自定义启动路径后，界面上的"文件缺失"立即跟着变
      p.missing = gameMissing(p);
      // 自愈 1：GDI+ 无法解码 svg/webp 封面 → 置空触发重新搜索
      if (p.cover && /\.(svg|webp)$/i.test(p.cover)) {
        try { fs.unlinkSync(path.join(GAMES_DIR, ent.name, p.cover)); } catch (e) {}
        p.cover = null;
        p.coverSource = 'placeholder';
      }
      // 自愈 2：profile 里 cover 为空但目录下存在封面文件（旧版本字段写入缺陷），直接采用
      if (!p.cover) {
        try {
          const cf = fs.readdirSync(path.join(GAMES_DIR, ent.name)).find(f => /^cover\.(jpe?g|png|gif|bmp)$/i.test(f));
          if (cf) {
            p.cover = cf;
            if (!p.coverSource || p.coverSource === 'placeholder') p.coverSource = p.coverSource || 'bing';
            saveProfile(p);
          }
        } catch (e) {}
      }
      games.push(p);
    } catch (e) {}
  }
  return games;
}

/* ---------------- 增量扫描 ---------------- */

// 增量扫描（异步，逐个让出事件循环，界面不卡顿）：
// - 支持传入多个根目录
// - deep=true 时对每个文件夹都重新识别（启动时的"全面扫描"）
// - 已有 profile 默认保留名称/封面，只校验文件与补全缺失字段
async function incrementalScan(rootOrRoots, onProgress, deep) {
  const roots = (Array.isArray(rootOrRoots) ? rootOrRoots : [rootOrRoots]).filter(Boolean);
  const found = [];
  for (const r of roots) {
    for (const f of scanRootDirs(r)) found.push(f);
  }
  const existing = new Map(loadLibrary().map(g => [g.folder, g]));
  const now = nowISO();
  const result = { total: found.length, added: 0, updated: 0, newGames: [], roots: roots };
  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    // 每个文件夹之间让出事件循环（保证界面可交互、可实时看到进度）
    await new Promise(r => setImmediate(r));
    let g = existing.get(f.folder);
    if (!g) {
      // 新游戏：深度识别一次，建 profile（封面随后搜索）
      const info = inspectGameDir(f.path);
      g = {
        id: slugify(f.folder) + '-' + hashStr(f.path).toString(36),
        folder: f.folder,
        name: cleanName(f.folder),
        path: f.path,
        exe: info.exe,
        exeName: info.exeName,
        trainer: info.trainers[0] || null,
        cover: null,
        coverSource: null,
        coverUrl: null,
        addedAt: now,
        lastPlayed: null,
        hidden: false,
        favorite: false,
        missing: !(info.exe && fs.existsSync(info.exe))
      };
      g.missing = gameMissing(g); // 已设过自定义启动路径的不算缺失
      existing.set(f.folder, g);
      saveProfile(g);
      result.added++;
      result.newGames.push(g);
      logLine('新增游戏: ' + f.folder + ' -> ' + (info.exeName || '未找到EXE'));
    } else {
      let changed = false;
      if (g.path !== f.path) { g.path = f.path; changed = true; }
      // 全面扫描：重新识别可执行文件与修改器（名称缺失时补全）
      const info = deep ? inspectGameDir(f.path) : null;
      if (info) {
        if (info.exe && info.exe !== g.exe) { g.exe = info.exe; g.exeName = info.exeName; changed = true; }
        if (!g.trainer && info.trainers && info.trainers[0]) { g.trainer = info.trainers[0]; changed = true; }
        if (!g.name) { g.name = cleanName(f.folder); changed = true; }
      } else {
        const exeGone = !g.exe || !fs.existsSync(g.exe);
        if (exeGone) {
          const info2 = inspectGameDir(f.path); // 仅当原 EXE 丢失时重新识别
          if (info2.exe) { g.exe = info2.exe; g.exeName = info2.exeName; changed = true; }
        }
        if (!g.trainer) {
          const t = (inspectGameDir(f.path).trainers || [])[0];
          if (t) { g.trainer = t; changed = true; }
        }
      }
      g.missing = gameMissing(g); // 自定义路径优先：默认 exe 丢了但自定义文件还在 → 不算缺失
      if (changed) { saveProfile(g); result.updated++; }
    }
    if (onProgress) onProgress(f.folder, result, i + 1);
  }
  return result;
}

/* ---------------- 网络：代理 + 搜图 ---------------- */

let settings = loadSettings();
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function activeProxy() {
  const p = settings.proxy;
  if (p && p.type && p.type !== 'none' && String(p.host || '').trim() && Number(p.port) > 0) {
    return { type: p.type, host: String(p.host).trim(), port: Number(p.port) };
  }
  return null;
}

function httpConnectTunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    let settled = false;
    const fail = e => { if (!settled) { settled = true; try { sock.destroy(); } catch (_) {} reject(e); } };
    sock.setTimeout(15000, () => fail(new Error('HTTP 代理连接超时')));
    sock.on('error', fail);
    let acc = '';
    sock.on('connect', () => {
      sock.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\nProxy-Connection: keep-alive\r\n\r\n');
    });
    sock.on('data', d => {
      acc += d.toString('latin1');
      const idx = acc.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const statusLine = acc.split('\r\n')[0] || '';
      const m = statusLine.match(/^HTTP\/\d\.\d (\d{3})/);
      if (m && m[1] === '200') {
        if (!settled) { settled = true; sock.setTimeout(0); resolve(sock); }
      } else {
        fail(new Error('代理 CONNECT 失败: ' + statusLine.trim()));
      }
    });
  });
}

function socks5Connect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    let settled = false;
    const fail = e => { if (!settled) { settled = true; try { sock.destroy(); } catch (_) {} reject(e); } };
    sock.setTimeout(15000, () => fail(new Error('SOCKS5 连接超时')));
    sock.on('error', fail);
    let acc = Buffer.alloc(0);
    let phase = 0;
    sock.on('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    sock.on('data', d => {
      acc = Buffer.concat([acc, d]);
      if (phase === 0) {
        if (acc.length < 2) return;
        if (acc[0] !== 0x05) return fail(new Error('SOCKS5 响应版本错误'));
        if (acc[1] !== 0x00) return fail(new Error('SOCKS5 代理要求认证，仅支持无认证'));
        phase = 1;
        acc = acc.slice(2);
        const hostBuf = Buffer.from(String(host), 'utf8');
        const req = Buffer.alloc(7 + hostBuf.length);
        req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
        req[4] = hostBuf.length;
        hostBuf.copy(req, 5);
        req.writeUInt16BE(Number(port), 5 + hostBuf.length);
        sock.write(req);
      }
      if (phase === 1) {
        if (acc.length < 10) return;
        if (acc[1] !== 0x00) return fail(new Error('SOCKS5 连接失败, 错误码=' + acc[1]));
        if (!settled) { settled = true; sock.setTimeout(0); resolve(sock); }
      }
    });
  });
}

function proxyTunnel(proxy, host, port) {
  if (proxy.type === 'socks5') return socks5Connect(proxy, host, port);
  if (proxy.type === 'http') return httpConnectTunnel(proxy, host, port);
  return Promise.reject(new Error('未知代理类型: ' + proxy.type));
}

function httpRequest(rawUrl, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return reject(e); }
    const isTls = u.protocol === 'https:';
    const port = u.port || (isTls ? 443 : 80);
    const headers = Object.assign({ 'User-Agent': CHROME_UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' }, opts.headers || {});
    const proxy = activeProxy();
    const redirects = opts.redirects || 0;
    const timeoutMs = opts.timeout || 12000;

    const onResponse = res => {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location && redirects < 5) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, rawUrl).href; } catch (e) { return reject(e); }
        return resolve(httpRequest(next, Object.assign({}, opts, { redirects: redirects + 1 })));
      }
      const chunks = [];
      let bytes = 0;
      const max = opts.maxBytes || 14 * 1024 * 1024;
      res.on('data', c => {
        bytes += c.length;
        if (bytes > max) { res.destroy(); return; }
        chunks.push(c);
      });
      res.on('aborted', () => reject(new Error('response aborted')));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', buf: Buffer.concat(chunks) }));
      res.on('error', reject);
    };

    const send = (lib, options) => {
      const req = lib.request(Object.assign({}, options, { method: 'GET', headers: headers, timeout: timeoutMs }), onResponse);
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} });
      req.on('error', reject);
      req.end();
      return req;
    };

    if (!proxy) {
      send(isTls ? https : httpLib, { protocol: u.protocol, hostname: u.hostname, port: port, path: u.pathname + u.search });
    } else if (proxy.type === 'http' && !isTls) {
      const sock = net.connect(proxy.port, proxy.host);
      sock.on('error', reject);
      sock.setTimeout(timeoutMs, () => { try { sock.destroy(); } catch (_) {} });
      sock.on('connect', () => {
        send(httpLib, {
          protocol: 'http:', hostname: u.hostname, port: port,
          path: u.protocol + '//' + u.host + u.pathname + u.search,
          createConnection: () => sock
        });
      });
    } else {
      proxyTunnel(proxy, u.hostname, port).then(sock => {
        const tlsSock = tls.connect({ socket: sock, servername: u.hostname });
        tlsSock.once('error', reject);
        tlsSock.once('secureConnect', () => {
          send(https, {
            protocol: 'https:', hostname: u.hostname, port: port,
            path: u.pathname + u.search,
            createConnection: () => tlsSock
          });
        });
      }).catch(reject);
    }
  });
}

function getText(url, opts) {
  return httpRequest(url, Object.assign({ timeout: 12000, maxBytes: 6 * 1024 * 1024 }, opts || {}))
    .then(r => (r.status === 200 ? r.buf.toString('utf8') : Promise.reject(new Error('HTTP ' + r.status))));
}
function getJson(url, opts) { return getText(url, opts).then(t => JSON.parse(t)); }

const IMG_MAGIC = [
  [Buffer.from([0xFF, 0xD8, 0xFF]), 'jpg'],
  [Buffer.from([0x89, 0x50, 0x4E, 0x47]), 'png'],
  [Buffer.from([0x47, 0x49, 0x46, 0x38]), 'gif']
  // 注意：不接受 WebP —— GDI+ 无 WebP 解码器，存了也无法渲染
];
// 网络下载用：太小的图基本是占位图/错误页，直接丢弃
function isImage(buf) {
  if (!buf || buf.length < 12000) return null;
  return imageExtOf(buf);
}

// 本地文件用：不看大小，只认魔数（用户自己挑的小图也要能当封面）
function imageExtOf(buf) {
  if (!buf || buf.length < 32) return null;
  for (const [magic, ext] of IMG_MAGIC) {
    if (buf.slice(0, magic.length).equals(magic)) {
      if (ext === 'webp' && buf.slice(8, 12).toString('ascii') !== 'WEBP') continue;
      return ext;
    }
  }
  // BMP：'BM' —— GDI+ 能解，但不属于常见网络格式，故只在本地导入时放行
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp';
  return null;
}

async function downloadImage(url) {
  try {
    const r = await httpRequest(url, { timeout: 15000, maxBytes: 14 * 1024 * 1024 });
    if (r.status !== 200) return null;
    const ext = isImage(r.buf);
    if (!ext) return null;
    return { buf: r.buf, ext: ext };
  } catch (e) { return null; }
}

// 并发探测多个候选，取第一个通过校验的
function firstImage(urls) {
  const list = urls.filter(Boolean).slice(0, 6);
  if (!list.length) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    let remaining = list.length;
    const done = r => { if (!settled) { settled = true; resolve(r); } };
    list.forEach(u => {
      downloadImage(u).then(img => {
        if (img) done({ img: img, url: u });
        else if (--remaining === 0) done(null);
      }).catch(() => { if (--remaining === 0) done(null); });
    });
  });
}

function hasCJK(str) { return /[\u3400-\u9fff]/.test(String(str || '')); }

// Steam 商店搜索：优先中文（cc=cn&l=schinese），没结果再退回英文
async function steamSearchOnce(q, lang) {
  const u = 'https://store.steampowered.com/api/storesearch/?term=' + encodeURIComponent(q)
    + (lang === 'zh' ? '&cc=cn&l=schinese' : '&cc=us&l=en');
  try { return await getJson(u, { timeout: 12000 }); } catch (e) { return null; }
}

// 取应用详情（中文名 + 类型），一次请求拿到两样东西
async function steamAppInfo(appid) {
  // 某些游戏在国区不可见（success=false）→ 退回美区再取中文名
  for (const cc of ['cn', 'us']) {
    try {
      const u = 'https://store.steampowered.com/api/appdetails?appids=' + appid + '&l=schinese&cc=' + cc;
      const j = await getJson(u, { timeout: 12000 });
      const node = j && j[String(appid)];
      if (node && node.success && node.data) {
        return { id: appid, name: node.data.name || null, type: node.data.type || null };
      }
    } catch (e) {}
  }
  return null;
}

// 兼容旧调用
async function steamAppNameCN(appid) {
  const info = await steamAppInfo(appid);
  return info && info.name ? info.name : null;
}

// DLC / 升级包 / 原声之类不能当主游戏
const DLC_HINT = /(upgrade|bundle|soundtrack|season\s*pass|expansion|deluxe\s*edition\s*$|ultimate\s*edition\s*$|\bdlc\b|\bost\b|artbook|art\s*book|demo\b|beta\b|皮肤|升级包|音乐|原声)/i;

function rankCandidates(items, q) {
  const nq = norm(q);
  const scored = items.map((it, idx) => {
    const name = String(it.name || '');
    const ni = norm(name);
    let s = 0;
    if (ni && nq && ni === nq) s = 120;
    else if (ni && nq && (ni.indexOf(nq) >= 0 || nq.indexOf(ni) >= 0)) s = 90;
    else {
      const p = nq.slice(0, Math.min(6, nq.length));
      if (p.length >= 3 && ni.indexOf(p) === 0) s = 60;
    }
    // 中文名没法跟英文查询串比字面 → 用 Steam 搜索排序兜底（越靠前越可信）
    if (!s) s = 45 - idx * 3;
    if (DLC_HINT.test(name)) s -= 50;
    return { it: it, s: s, idx: idx };
  });
  scored.sort((a, b) => (b.s - a.s) || (a.idx - b.idx));
  return scored.map(x => x.it);
}

// 名称相似度（0~120）：用于判断 Steam 结果是不是"同一款游戏"
function nameScore(name, q) {
  const ni = norm(name), nq = norm(q);
  if (!ni || !nq) return 0;
  if (ni === nq) return 120;
  if (ni.indexOf(nq) >= 0 || nq.indexOf(ni) >= 0) return 90;
  const tokens = String(q).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  if (!tokens.length) return 0;
  const low = String(name).toLowerCase();
  const hit = tokens.filter(w => low.indexOf(w) >= 0).length;
  return Math.round((hit / tokens.length) * 80);
}

// 取应用的英文名（用来校验中文结果是不是同一款游戏）
async function steamAppNameEN(appid) {
  try {
    const u = 'https://store.steampowered.com/api/appdetails?appids=' + appid + '&l=english&cc=us';
    const j = await getJson(u, { timeout: 12000 });
    const node = j && j[String(appid)];
    if (node && node.success && node.data) return { name: node.data.name || null, type: node.data.type || null };
  } catch (e) {}
  return null;
}

// 找 Steam appid + 中文名：必须能确认是同一款游戏（英文名文本匹配），并排除 DLC/升级包
// 查询串变体：长标题 / 带 "- xxx" / 带版本后缀时，商店搜索经常直接返回空，需要逐步简化
function queryVariants(q) {
  const out = [];
  const push = v => { const t = String(v || '').replace(/\s+/g, ' ').trim(); if (t && out.indexOf(t) < 0) out.push(t); };
  push(q);
  let s = String(q)
    .replace(/[（(].*?[)）]/g, ' ')
    .replace(/\b(deluxe|digital|standard|ultimate|premium|definitive|remastered|edition|bundle)\b/gi, ' ')
    .replace(/\s*[-–—:：]\s*.*$/, ' ')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  push(s);
  const words = s.split(' ').filter(Boolean);
  if (words.length > 3) push(words.slice(0, 3).join(' '));
  if (words.length > 2) push(words.slice(0, 2).join(' '));
  return out.slice(0, 4);
}

async function steamFindAppid(query) {
  const q0 = String(query || '').replace(/\s+game$/i, '').trim();
  if (!q0) return null;
  let best = null, bestScore = 0;
  for (const q of queryVariants(q0)) {
    const r = await steamFindAppidOnce(q);
    if (r && r.score > bestScore) { bestScore = r.score; best = r.hit; }
    if (bestScore >= 90) break;
  }
  return bestScore >= 55 ? best : null;
}

async function steamFindAppidOnce(q) {
  if (!q) return null;
  const langs = hasCJK(q) ? ['zh', 'en'] : ['en', 'zh'];
  let best = null, bestScore = 0;
  for (const lang of langs) {
    const j = await steamSearchOnce(q, lang);
    const items = (j && Array.isArray(j.items)) ? j.items.filter(it => it && it.type === 'app' && it.id) : [];
    if (!items.length) continue;
    for (const c of rankCandidates(items, q).slice(0, 3)) {
      if (DLC_HINT.test(String(c.name || ''))) continue;
      const info = await steamAppInfo(c.id);           // 中文名 + 类型
      if (!info || info.type !== 'game') continue;
      let enName = c.name;
      if (lang !== 'en') {
        const en = await steamAppNameEN(c.id);         // 中文结果 → 反查英文名再校验
        if (en && en.name) enName = en.name;
      }
      const sc = nameScore(enName, q);
      if (sc > bestScore) { bestScore = sc; best = { id: c.id, name: enName, cnName: info.name }; }
      if (sc >= 90) break;
    }
    if (bestScore >= 90) break;
  }
  return best ? { hit: best, score: bestScore } : null;
}

async function bingImages(query) {
  try {
    const u = 'https://www.bing.com/images/search?q=' + encodeURIComponent(query) + '&form=HDRSC2&first=1';
    const html = await getText(u, { timeout: 12000 });
    const urls = [];
    const seen = new Set();
    const push = raw => {
      const v = String(raw || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
      if (/^https?:\/\//i.test(v) && !seen.has(v)) { seen.add(v); urls.push(v); }
    };
    let re = /"murl":"(https?:[^"]+)"/g, m;
    while ((m = re.exec(html))) push(m[1]);
    re = /murl(?:&quot;|")?:(?:&quot;|")?(https?:[^&"']+)/g;
    while ((m = re.exec(html))) push(m[1]);
    return urls.slice(0, 24);
  } catch (e) { return []; }
}

async function ddgImages(query) {
  try {
    const u = 'https://duckduckgo.com/?q=' + encodeURIComponent(query) + '&iax=images&ia=images';
    const html = await getText(u, { timeout: 12000 });
    const m = html.match(/vqd=["']?([\d-]+)["']?/);
    if (!m) return [];
    const u2 = 'https://duckduckgo.com/i.js?l=us-en&o=json&q=' + encodeURIComponent(query) + '&vqd=' + m[1] + '&f=,,,&p=1';
    const j = await getJson(u2, { timeout: 12000, headers: { 'Referer': 'https://duckduckgo.com/', 'Accept': 'application/json' } });
    return (j.results || []).map(r => r.image).filter(Boolean);
  } catch (e) { return []; }
}

const STEAM_CAPS = ['library_600x900.jpg', 'capsule_616x353.jpg', 'header.jpg'];

function searchQueries(game) {
  const qs = [];
  const folder = cleanName(game.folder || game.name);
  const base = game.exeName ? game.exeName.replace(/\.exe$/i, '').replace(/[._]+/g, ' ').replace(/[-_](steam|epic|uplay|win64|shipping)$/i, '').trim() : '';
  const exeQuery = base ? base + ' game' : '';
  if (norm(folder).length <= 8 && exeQuery) {
    qs.push(exeQuery);
    qs.push(folder + ' game');
  } else {
    qs.push(folder + ' game');
    if (exeQuery && norm(exeQuery) !== norm(folder + ' game')) qs.push(exeQuery);
  }
  qs.push(folder + ' cover art');
  return qs;
}

// 占位封面：纯代码绘制 SVG（非 AI 生成）
function makePlaceholderCover(game) {
  const name = cleanName(game.folder || game.name || 'Game');
  const initials = name.split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'G';
  const hue = hashStr(game.folder || name) % 360;
  const hue2 = (hue + 40) % 360;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="hsl(' + hue + ',45%,26%)"/>' +
    '<stop offset="1" stop-color="hsl(' + hue2 + ',50%,14%)"/>' +
    '</linearGradient></defs>' +
    '<rect width="600" height="900" fill="url(#g)"/>' +
    '<text x="300" y="440" font-family="Segoe UI,Arial,sans-serif" font-size="180" font-weight="700" fill="rgba(255,255,255,0.85)" text-anchor="middle" dominant-baseline="middle">' + initials + '</text>' +
    '<text x="300" y="620" font-family="Segoe UI,Arial,sans-serif" font-size="32" fill="rgba(255,255,255,0.45)" text-anchor="middle">' + escapeXml(name.slice(0, 22)) + '</text>' +
    '</svg>';
  return Buffer.from(svg, 'utf8');
}
function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function saveCoverFile(game, buf, ext, source, url) {
  const dir = profileDir(game);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  // 清理旧封面
  if (game.cover) {
    try {
      const old = path.join(dir, game.cover);
      if (fs.existsSync(old) && old !== path.join(dir, 'cover.' + ext)) fs.unlinkSync(old);
    } catch (e) {}
  }
  const file = 'cover.' + ext;
  try { fs.writeFileSync(path.join(dir, file), buf); } catch (e) { return false; }
  game.cover = file;
  game.coverSource = source;
  game.coverUrl = url || null;
  game.coverAt = nowISO();
  return true;
}

// 用本地图片替换封面（jpg / png / gif / bmp）。
// webp / svg / avif 一律拒绝：GDI+ 没有对应解码器，存了也渲染不出来，
// 反而会让卡片永久停在"占位图"状态（旧版本踩过 svg/webp 的坑）。
function setCoverFromLocalFile(game, src) {
  if (!game) return { ok: false, error: '未指定游戏' };
  if (!src || !fs.existsSync(src)) return { ok: false, error: '图片文件不存在：' + (src || '') };
  let buf;
  try { buf = fs.readFileSync(src); } catch (e) { return { ok: false, error: '读取图片失败：' + e.message }; }
  const ext = imageExtOf(buf);
  if (!ext) return { ok: false, error: '不支持的图片格式（仅支持 jpg / png / gif / bmp）' };
  if (buf.length > 24 * 1024 * 1024) return { ok: false, error: '图片过大（>24MB）' };
  if (!saveCoverFile(game, buf, ext, 'custom', null)) return { ok: false, error: '保存封面失败（目录不可写？）' };
  saveProfile(game);
  logLine('自定义封面: ' + (game.folder || game.name) + ' <- ' + src + ' (' + ext + ')');
  return { ok: true, ext: ext };
}

// 清除自定义封面，回到"可被自动搜索"的状态（下次扫描会重新找封面）
function clearCover(game) {
  if (!game) return false;
  const dir = profileDir(game);
  if (game.cover) {
    try { fs.unlinkSync(path.join(dir, game.cover)); } catch (e) {}
  }
  game.cover = null;
  game.coverSource = 'placeholder';
  game.coverUrl = null;
  game.coverAt = null;
  game.coverTriedAt = null; // 置空 = 允许下次扫描重新搜索
  saveProfile(game);
  logLine('清除封面: ' + (game.folder || game.name));
  return true;
}

// 为单个游戏搜索封面（Steam -> Bing -> DDG -> 占位图）
async function fetchCoverFor(game) {
  const queries = searchQueries(game);
  for (const q of queries) {
    let r = null;
    // Steam
    const hit = await steamFindAppid(q);
    if (hit) {
      const urls = STEAM_CAPS.map(cap => 'https://cdn.akamai.steamstatic.com/steam/apps/' + hit.id + '/' + cap);
      r = await firstImage(urls);
      if (r) { r.source = 'steam'; r.url = r.url; }
    }
    if (!r) {
      const urls = await bingImages(q);
      r = await firstImage(urls);
      if (r) r.source = 'bing';
    }
    if (!r) {
      const urls = await ddgImages(q);
      r = await firstImage(urls);
      if (r) r.source = 'ddg';
    }
    if (r) {
      // 顺带取官方中文名（用户手动改过名的不覆盖）
      if (hit && game.nameSource !== 'manual' && !hasCJK(game.name)) {
        const cnName = hit.cnName;
        if (cnName && hasCJK(cnName)) game.name = cnName;
        game.nameLocalizedAt = nowISO();
      }
      if (saveCoverFile(game, r.img.buf, r.img.ext, r.source, r.url)) {
        game.coverTriedAt = nowISO();
        saveProfile(game);
        return { ok: true, real: true, source: r.source, name: game.name };
      }
    }
  }
  // 不再保存 SVG 占位文件（GDI+ 无法解码 SVG，界面自带首字母占位）
  game.cover = null;
  game.coverSource = 'placeholder';
  game.coverTriedAt = nowISO();
  saveProfile(game);
  logLine('封面未找到: ' + (game.name || game.folder) + '（代理：' + (activeProxy() ? '已启用' : '未启用') + '）');
  return { ok: true, real: false };
}

// 清空"已尝试中文名"标记，便于重新补全
function resetNameLocalization() {
  let n = 0;
  for (const g of loadLibrary()) {
    if (g.nameSource === 'manual') continue;
    if (g.nameLocalizedAt) { try { delete g.nameLocalizedAt; } catch (e) {} n++; }
  }
  return n;
}

// 只补中文名（不抓封面）：给已有英文名的游戏用；成功/失败都会写时间戳，避免每次启动反复请求
async function localizeName(game) {
  if (!game || game.nameSource === 'manual') return null;
  if (hasCJK(game.name)) return null;
  if (game.nameLocalizedAt) return null;
  const qs = searchQueries(game);
  for (const q of qs.slice(0, 2)) {
    const hit = await steamFindAppid(q);
    if (!hit || !hit.id) continue;
    const cn = hit.cnName;
    game.nameLocalizedAt = nowISO();
    game.steamAppId = hit.id;
    if (cn && hasCJK(cn)) {
      game.name = cn;
      saveProfile(game);
      logLine('中文名: ' + game.folder + ' -> ' + cn);
      return cn;
    }
    saveProfile(game);
    return null;
  }
  game.nameLocalizedAt = nowISO();
  saveProfile(game);
  return null;
}

/* ---------------- 代理测试（含 Steam 检索验证） ---------------- */

async function testProxy() {
  const p = activeProxy();
  if (!p) return { ok: false, error: '尚未配置代理' };
  const out = { proxy: p.type + '://' + p.host + ':' + p.port, results: [] };
  const t = (name, url, maxBytes) => httpRequest(url, { timeout: 12000, maxBytes: maxBytes || 2 * 1024 * 1024 })
    .then(r => ({ name: name, ok: r.status > 0 && r.status < 400, status: r.status }))
    .catch(e => ({ name: name, ok: false, error: String(e.message || e) }));
  out.results.push(await t('Google', 'https://www.google.com/generate_204'));
  out.results.push(await t('Bing', 'https://cn.bing.com/'));
  // Steam 检索验证：搜索 -> appid -> 下载封面 -> 校验图片
  let steam = { name: 'Steam 图片检索', ok: false };
  try {
    const hit = await steamFindAppid('Portal 2');
    if (!hit) throw new Error('Steam 搜索未命中');
    const r = await httpRequest('https://cdn.akamai.steamstatic.com/steam/apps/' + hit.id + '/library_600x900.jpg', { timeout: 15000 });
    const ext = isImage(r.buf);
    if (!ext) throw new Error('封面校验失败');
    steam = { name: 'Steam 图片检索', ok: true, detail: hit.name + ' (appid ' + hit.id + ', ' + Math.round(r.buf.length / 1024) + 'KB ' + ext + ')' };
  } catch (e) {
    steam = { name: 'Steam 图片检索', ok: false, error: String(e.message || e) };
  }
  out.results.push(steam);
  out.ok = out.results.some(r => r.ok);
  return out;
}

/* ---------------- 启动与进程托管 ---------------- */

let running = []; // {pid, child, game, isTrainer, startedAt, exeName, exePath}

function runningInfo() {
  return running.map(r => ({ name: r.game ? r.game.name : '?', isTrainer: !!r.isTrainer, since: r.startedAt, gameId: r.game ? r.game.id : null }));
}

// 该镜像是否有进程在跑（tasklist 判断，兼容"引导 exe 秒退、真进程另起"的情况）
function imageRunning(exePath) {
  const name = path.basename(String(exePath || ''));
  if (!name || !/\.exe$/i.test(name)) return false;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq ' + name + '" /NH', { timeout: 6000, windowsHide: true });
    return out.toString('latin1').toLowerCase().indexOf(name.toLowerCase()) >= 0;
  } catch (e) { return false; }
}

// 按镜像名结束（含子进程），用于结束"引导器已退出但真进程还在"的游戏
function killImage(exePath, label) {
  const name = path.basename(String(exePath || ''));
  if (!name || !/\.exe$/i.test(name)) return false;
  try {
    execSync('taskkill /F /T /IM "' + name + '"', { stdio: 'ignore', timeout: 8000, windowsHide: true });
    logLine('按镜像结束' + (label ? '(' + label + ')' : '') + ': ' + name);
    return true;
  } catch (e) { return false; }
}

function onExitCleanup(entry) {
  return () => {
    running = running.filter(r => r !== entry);
    logLine('进程退出: pid=' + entry.pid + (entry.isTrainer ? ' [修改器]' : ''));
    // 游戏退出 → 3 秒后如果修改器还开着，把它关掉
    if (!entry.isTrainer) scheduleTrainerExit(3000, 0, entry.exePath);
    if (globalThis.__onRunningChange__) globalThis.__onRunningChange__();
  };
}

/* ---- 修改器：提权 + 看门狗（游戏退出 3 秒后自动关闭修改器） ---- */
// 修改器需要管理员权限，而本进程没提权 → 直接 taskkill 会被拒绝。
// 方案：由"提权看门狗"启动修改器并守着会话标志文件；标志一消失（游戏已退出）就自己关掉修改器，
// 整个过程不需要再弹 UAC。
function trainerFlagPath(tag) {
  return path.join(SESSIONS_DIR, String(tag || 'trainer').replace(/[^a-zA-Z0-9._-]/g, '_') + '.alive');
}

function writeWatchdogScript(trainerPath, flagPath) {
  const ps1 = path.join(SESSIONS_DIR, 'watchdog-' + Date.now() + '.ps1');
  const content = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$trainer = "' + String(trainerPath).replace(/"/g, '') + '"',
    '$flag = "' + String(flagPath).replace(/"/g, '') + '"',
    '$deadline = (Get-Date).AddHours(8)',
    '$t = Start-Process -FilePath $trainer -PassThru',
    'if ($t) { Set-Content -LiteralPath ($flag + ".pid") -Value $t.Id -Encoding ascii }',
    'while ((Test-Path -LiteralPath $flag) -and (Get-Process -Id $t.Id -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 700 }',
    'Start-Sleep -Milliseconds 400',
    'if ($t -and -not $t.HasExited) { Stop-Process -Id $t.Id -Force }',
    'Remove-Item -LiteralPath ($flag + ".pid") -Force -ErrorAction SilentlyContinue'
  ].join('\r\n');
  try { fs.writeFileSync(ps1, content, 'utf8'); } catch (e) { logLine('写看门狗脚本失败: ' + e.message); return null; }
  return ps1;
}

function elevateTrainerWithWatchdog(trainerPath, flagPath) {
  try {
    const ps1 = writeWatchdogScript(trainerPath, flagPath);
    if (!ps1) return null;
    const argList = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ps1 + '"';
    // GB_NO_ELEVATE=1 仅供自测（跳过 UAC，直接起看门狗）
    const verb = process.env.GB_NO_ELEVATE === '1' ? '' : ' -Verb RunAs';
    const cmd = '$p = Start-Process -FilePath "powershell.exe"' + verb + ' -WindowStyle Hidden -PassThru -ArgumentList \''
      + argList + '\'; if ($p) { $p.Id }';
    logLine('修改器改为提权看门狗托管: ' + trainerPath);
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', cmd],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    ps.stdout.on('data', () => {});
    ps.on('exit', () => {
      const pidFile = flagPath + '.pid';
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        let pid = 0;
        try { pid = parseInt(String(fs.readFileSync(pidFile, 'utf8')).trim(), 10) || 0; } catch (e) {}
        if (pid > 0) {
          clearInterval(timer);
          logLine('修改器 已由看门狗启动: pid=' + pid);
          running.push({
            pid: pid, child: null, game: null, isTrainer: true, startedAt: Date.now(),
            exeName: path.basename(trainerPath), exePath: trainerPath, flagPath: flagPath
          });
          if (globalThis.__onRunningChange__) globalThis.__onRunningChange__();
        } else if (tries > 40) {
          clearInterval(timer);
          logLine('看门狗未回报修改器 pid（UAC 可能被取消）');
        }
      }, 500);
    });
    return ps;
  } catch (e) { logLine('看门狗启动失败: ' + e.message); return null; }
}

// 游戏退出后延时结束残留修改器（提权的靠看门狗，非提权的直接结束）
let trainerExitTimer = null;
function scheduleTrainerExit(delayMs, attempt, gameExePath) {
  const delay = delayMs || 3000;
  const tries = attempt || 0;
  if (trainerExitTimer) clearTimeout(trainerExitTimer);
  trainerExitTimer = setTimeout(() => {
    trainerExitTimer = null;
    // 又有游戏在跑（或同一游戏的真进程仍在）→ 保留修改器
    if (running.some(r => !r.isTrainer)) return;
    if (gameExePath && imageRunning(gameExePath)) return;
    const trainers = running.filter(r => r.isTrainer);
    if (!trainers.length) return;
    // 修改器刚启动不久（引导 exe 秒退的误判场景）→ 再等一轮，最多 3 次
    const fresh = trainers.some(t => Date.now() - t.startedAt < 6000);
    if (fresh && tries < 3) { scheduleTrainerExit(3000, tries + 1, gameExePath); return; }
    logLine('游戏退出 ' + Math.round(delay / 1000) + ' 秒，结束残留修改器 ' + trainers.length + ' 个');
    for (const t of trainers) {
      if (t.flagPath) { try { fs.rmSync(t.flagPath, { force: true }); } catch (e) {} } // 看门狗随之关闭修改器
      if (t.exePath) killImage(t.exePath, '修改器');
      try { if (t.pid) execSync('taskkill /pid ' + t.pid + ' /t /f', { stdio: 'ignore', timeout: 6000, windowsHide: true }); } catch (e) {}
    }
    running = running.filter(r => !r.isTrainer);
    if (globalThis.__onRunningChange__) globalThis.__onRunningChange__();
  }, delay);
  if (trainerExitTimer.unref) trainerExitTimer.unref();
}

// 以管理员权限运行（UAC 弹窗确认后启动）；onPid(pid) 可选，用于跟踪提权后的进程
function elevateRun(exePath, label, onPid) {
  try {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      '$p = Start-Process -FilePath "' + exePath + '" -Verb RunAs -PassThru; if ($p) { $p.Id }'
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    ps.stdout.on('data', d => { out += d; });
    ps.on('exit', () => {
      const pid = parseInt(String(out).trim(), 10);
      if (pid > 0) {
        logLine(label + ' 已提权启动: pid=' + pid + ' ' + exePath);
        if (onPid) try { onPid(pid); } catch (e) {}
      } else {
        logLine(label + ' 提权启动被取消或失败（UAC 未确认）: ' + exePath);
      }
    });
    return ps;
  } catch (e) { logLine(label + ' 提权启动异常: ' + e.message); return null; }
}

/* ---------------- 启动目标解析（自定义路径 + 非 exe 脚本） ----------------
 * 规则：
 *   1) game.customExe 存在且文件真实存在 → 用它（用户手动指定的启动文件）
 *   2) 否则回退 game.exe（自动识别出来的 exe），保证老版本配置 100% 兼容
 *   3) 两者都不存在 → 保留最后一次的路径用于报错提示，让界面能指出"哪个文件没了"
 * 非 .exe 由解释器/系统关联程序启动：
 *   .bat/.cmd → cmd /d /c "file"
 *   .ps1      → powershell -NoProfile -ExecutionPolicy Bypass -File file
 *   .sh       → Git Bash / WSL 的 bash -lc（找不到 bash 时退回系统关联打开）
 *   其它       → cmd /c start "" "file"（交给 Windows 文件关联，如 .lnk/.jar/.vbs）
 */
function launchTargetOf(game) {
  if (!game) return null;
  const custom = game.customExe ? String(game.customExe).trim() : '';
  const fallback = game.exe ? String(game.exe).trim() : '';
  let file = '', customed = false;
  if (custom && fs.existsSync(custom)) { file = custom; customed = true; }
  else if (fallback && fs.existsSync(fallback)) { file = fallback; }
  else if (custom) { file = custom; customed = true; }
  else if (fallback) { file = fallback; }
  else return null;
  return { file: file, ext: path.extname(file).toLowerCase(), cwd: path.dirname(file), customed: customed };
}

// 是否"启动文件缺失"：自定义路径与默认 exe 任一可用即不算缺失
function gameMissing(g) {
  const t = launchTargetOf(g);
  return !t || !fs.existsSync(t.file);
}

// Windows 路径 → bash 能认的 POSIX 路径（C:\a\b.sh → /c/a/b.sh）
function toPosixPath(p) {
  let s = String(p).replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(s);
  if (m) s = '/' + m[1].toLowerCase() + '/' + m[2];
  return s.replace(/ /g, '\\ ');
}

let cachedBash = null;
function findBash() {
  if (cachedBash !== null) return cachedBash;
  const cands = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Windows\\System32\\bash.exe',            // 旧版 WSL
    'C:\\cygwin64\\bin\\bash.exe'
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) { cachedBash = c; return c; } } catch (e) {}
  }
  try {
    const out = execSync('where bash.exe', { timeout: 4000, windowsHide: true }).toString();
    const first = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (first) { cachedBash = first; return first; }
  } catch (e) {}
  cachedBash = '';
  return '';
}

// 根据目标文件类型给出 spawn 用的命令 / 参数
function buildLaunchSpec(t) {
  const f = t.file;
  const comspec = process.env.ComSpec || 'cmd.exe';
  if (t.ext === '.exe') return { cmd: f, args: [], opts: {}, kind: 'exe' };
  if (t.ext === '.bat' || t.ext === '.cmd') {
    // windowsVerbatimArguments：不让 node 再转义引号，cmd 才能正确拿到带空格的路径
    return { cmd: comspec, args: ['/d', '/c', '"' + f + '"'], opts: { windowsVerbatimArguments: true }, kind: 'bat' };
  }
  if (t.ext === '.ps1') {
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f], opts: {}, kind: 'ps1' };
  }
  if (t.ext === '.sh') {
    const bash = findBash();
    if (bash) return { cmd: bash, args: ['-lc', '"' + toPosixPath(f) + '"'], opts: { windowsVerbatimArguments: true }, kind: 'sh' };
  }
  return { cmd: comspec, args: ['/d', '/c', 'start', '', '"' + f + '"'], opts: { windowsVerbatimArguments: true }, kind: 'shell' };
}

// 启动游戏：确保同一时刻只有一款游戏 + 一个修改器
function launchGame(game, onMinimize, source) {
  const src = source || 'unknown';
  const t = launchTargetOf(game);
  if (!game || !t || !fs.existsSync(t.file)) {
    return { ok: false, error: '启动文件不存在：' + (t ? t.file : (game && (game.exeName || game.name))) };
  }
  const spec = buildLaunchSpec(t);
  const isExe = t.ext === '.exe';
  // 非 exe 只能靠解释器进程跟踪，exeName 置空（tasklist 里查不到 .bat）
  const exeName = isExe ? path.basename(t.file) : null;
  // 1) 同款游戏已在运行（含引导器已退出但真进程仍在的情况）→ 拒绝，避免开第二份
  const sameTracked = running.some(r => !r.isTrainer && r.game && r.game.id && r.game.id === game.id);
  if (sameTracked || (isExe && imageRunning(t.file))) {
    return { ok: false, duplicate: true, running: true, error: '「' + game.name + '」已在运行中' };
  }
  // 2) 启动冷却：引导器秒退时 running 记录会丢，用时间窗兜底。
  //    脚本启动器（bat/sh）比 exe 更容易秒退，冷却放宽到 20 秒，避免连点开两份
  const now = Date.now();
  const coolMs = isExe ? 6000 : 20000;
  if (game.__lastLaunchAt && now - game.__lastLaunchAt < coolMs) {
    return { ok: false, duplicate: true, error: '正在启动中，请稍候' };
  }
  // 3) 其他游戏 / 残留修改器在跑 → 先全部结束，保证"同时只有一款游戏 + 一个修改器"
  let killedPrev = false;
  let prevNames = [];
  for (const r of running.slice()) {
    if (r.isTrainer || (r.game && r.game.id !== game.id)) {
      killedPrev = true;
      if (!r.isTrainer && r.game && r.game.name && prevNames.indexOf(r.game.name) < 0) prevNames.push(r.game.name);
    }
  }
  for (const r of running.filter(r => !r.isTrainer && r.game && r.game.id !== game.id)) {
    if (r.exeName && imageRunning(r.exePath || r.exeName)) killImage(r.exePath || r.exeName, '上一款游戏');
  }
  if (killedPrev) {
    logLine('启动「' + game.name + '」[' + src + '] 前结束上一款游戏/修改器: ' + (prevNames.join('、') || '修改器'));
    killAllGames();
  }
  game.__lastLaunchAt = now;
  try {
    logLine('启动游戏[' + src + ']: ' + game.name + ' -> ' + t.file +
      (t.customed ? ' [自定义路径]' : '') + (spec.kind === 'exe' ? '' : ' [' + spec.kind + ' 解释器]'));
    const spawnOpts = Object.assign({
      cwd: t.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }, spec.opts);
    const child = spawn(spec.cmd, spec.args, spawnOpts);
    const entry = { pid: child.pid, child: child, game: game, isTrainer: false, startedAt: Date.now(), exeName: exeName, exePath: t.file, launchKind: spec.kind };
    running.push(entry);
    child.on('exit', onExitCleanup(entry));
    // 直接 spawn 失败（如需要管理员权限）时降级为 UAC 提权启动，避免未捕获异常
    child.on('error', (e) => {
      logLine('游戏直接启动失败(' + (e.code || e.message) + ')，尝试管理员权限: ' + t.file);
      elevateRun(t.file, '游戏');
    });
    game.lastPlayed = nowISO();
    if (game.folder) saveProfile(game); // 无 folder 的临时对象不落盘（避免污染 config/games）

    if (onMinimize) onMinimize();

    // Trainer：主程序启动 5 秒后自动启动（若游戏仍在运行）
    if (game.trainer && fs.existsSync(game.trainer)) {
      setTimeout(() => {
        if (!running.some(r => r === entry)) return; // 游戏已退出
        // 修改器同一时刻只允许一个：先清掉任何已在运行的修改器
        const oldTrainers = running.filter(r => r.isTrainer);
        if (oldTrainers.length) {
          for (const ot of oldTrainers) {
            if (ot.flagPath) { try { fs.rmSync(ot.flagPath, { force: true }); } catch (e) {} }
            if (ot.exePath) killImage(ot.exePath, '旧修改器');
            try { if (ot.pid) execSync('taskkill /pid ' + ot.pid + ' /t /f', { stdio: 'ignore', timeout: 6000, windowsHide: true }); } catch (e) {}
          }
          running = running.filter(r => !r.isTrainer);
          logLine('已结束旧修改器 ' + oldTrainers.length + ' 个');
        }
        // 会话标志：文件存在 = 游戏还在跑；删掉它，提权看门狗会在 3 秒内关掉修改器
        const flagPath = trainerFlagPath(game.id || game.folder || game.name);
        try { fs.writeFileSync(flagPath, '1'); } catch (e) {}
        try {
          const t = spawn(game.trainer, [], {
            cwd: path.dirname(game.trainer),
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          });
          const te = { pid: t.pid, child: t, game: { name: game.name + ' 修改器' }, isTrainer: true, startedAt: Date.now(), exeName: path.basename(game.trainer), exePath: game.trainer, flagPath: flagPath };
          running.push(te);
          t.on('exit', onExitCleanup(te));
          // 修改器普遍需要管理员权限（注入游戏内存）：EACCES 时改由提权看门狗托管启动
          t.on('error', (e) => {
            logLine('修改器直接启动失败(' + (e.code || e.message) + ')，改用提权看门狗: ' + game.trainer);
            running = running.filter(r => r !== te);
            if (globalThis.__onRunningChange__) globalThis.__onRunningChange__();
            elevateTrainerWithWatchdog(game.trainer, flagPath);
          });
          logLine('启动修改器: ' + game.trainer + ' (pid=' + t.pid + ')');
          if (globalThis.__onRunningChange__) globalThis.__onRunningChange__();
        } catch (e) {
          logLine('修改器启动失败: ' + e.message);
          elevateTrainerWithWatchdog(game.trainer, flagPath);
        }
      }, 5000);
    }
    if (globalThis.__onRunningChange__) globalThis.__onRunningChange__();
    return { ok: true, pid: child.pid, killedPrev: killedPrev, prevNames: prevNames };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// 结束所有相关进程（含 Trainer）：先按 pid 杀进程树，再按镜像名兜底
// （很多游戏的引导 exe 会秒退，真正的游戏进程另起，只靠 pid 杀不干净）
function killAllGames() {
  const entries = running.slice();
  for (const r of entries) {
    if (r.flagPath) { try { fs.rmSync(r.flagPath, { force: true }); } catch (e) {} } // 让提权看门狗关掉修改器
    if (r.pid) {
      try { execSync('taskkill /pid ' + r.pid + ' /t /f', { stdio: 'ignore', timeout: 8000, windowsHide: true }); } catch (e) {}
      logLine('结束进程: pid=' + r.pid + (r.isTrainer ? ' [修改器]' : ''));
    }
    if (r.exePath && imageRunning(r.exePath)) killImage(r.exePath, r.isTrainer ? '修改器' : '游戏');
    // 结束即清掉该游戏的启动冷却，避免"刚切走又想切回来"被 6 秒冷却挡住
    if (!r.isTrainer && r.game) { try { delete r.game.__lastLaunchAt; } catch (e) {} }
  }
  running = [];
  if (globalThis.__onRunningChange__) globalThis.__onRunningChange__();
}

function openFolder(dir) {
  try { exec('explorer "' + dir + '"'); } catch (e) {}
}

/* ---------------- 导出 ---------------- */

module.exports = {
  APP_DIR: APP_DIR, CONFIG_DIR: CONFIG_DIR, GAMES_DIR: GAMES_DIR,
  loadSettings: loadSettings, saveSettings: saveSettings,
  settings: function () { return settings; },
  applySettings: function (s) { settings = Object.assign({}, DEFAULT_SETTINGS, s); settings.proxy = Object.assign({}, DEFAULT_SETTINGS.proxy, settings.proxy || {}); },
  slugify: slugify, cleanName: cleanName,
  scanRoot: scanRoot, inspectGameDir: inspectGameDir,
  gameRoots: gameRoots, addGameRoot: addGameRoot, removeGameRoot: removeGameRoot,
  removeGamesUnderRoot: removeGamesUnderRoot, pruneMissingGames: pruneMissingGames,
  loadLibrary: loadLibrary, loadProfile: loadProfile, saveProfile: saveProfile,
  profileDir: profileDir, coverPath: coverPath,
  incrementalScan: incrementalScan,
  // 自定义启动文件 / 自定义封面
  launchTargetOf: launchTargetOf, gameMissing: gameMissing, buildLaunchSpec: buildLaunchSpec, findBash: findBash,
  setCoverFromLocalFile: setCoverFromLocalFile, clearCover: clearCover, imageExtOf: imageExtOf,
  fetchCoverFor: fetchCoverFor, localizeName: localizeName, hasCJK: hasCJK, resetNameLocalization: resetNameLocalization, testProxy: testProxy,
  activeProxy: activeProxy,
  launchGame: launchGame, killAllGames: killAllGames, runningInfo: runningInfo,
  imageRunning: imageRunning, killImage: killImage, hasTrainer: hasTrainer,
  _debugSteamSearch: steamFindAppid, _debugSteamCN: steamAppNameCN, _debugGetJson: getJson,
  // 调试/自测用
  _scheduleTrainerExit: scheduleTrainerExit,
  _writeWatchdogScript: writeWatchdogScript,
  _trainerFlagPath: trainerFlagPath,
  _elevateTrainerWithWatchdog: elevateTrainerWithWatchdog,
  openFolder: openFolder,
  logLine: logLine,
  _setRunning: function (r) { running = r; }
};
