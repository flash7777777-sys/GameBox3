/*
 * GameBox 3 — gamepad.js
 * XInput 手柄支持：16ms 轮询，方向键/左摇杆导航（带连发），A/B/START 动作
 * 兼容 xinput1_4 / 1_3 / 9_1_0，覆盖 Xbox 手柄及 DS4/PS5（经 XInput 映射）
 */
'use strict';

const koffi = globalThis.__KOFFI__ || require('koffi');

const XINPUT_GAMEPAD = koffi.struct('XINPUT_GAMEPAD', {
  wButtons: 'uint16', bLeftTrigger: 'uint8', bRightTrigger: 'uint8',
  sThumbLX: 'int16', sThumbLY: 'int16', sThumbRX: 'int16', sThumbRY: 'int16'
});
const XINPUT_STATE = koffi.struct('XINPUT_STATE', { dwPacketNumber: 'uint32', Gamepad: XINPUT_GAMEPAD });

let xinput = null;
let XInputGetState = null;
for (const dll of ['xinput1_4.dll', 'xinput1_3.dll', 'xinput9_1_0.dll']) {
  try {
    xinput = koffi.load(dll);
    XInputGetState = xinput.func('int32 __stdcall XInputGetState(uint32 dwUserIndex, _Out_ XINPUT_STATE *pState)');
    break;
  } catch (e) {}
}

// 按钮位
const BTN = {
  DPAD_UP: 0x0001, DPAD_DOWN: 0x0002, DPAD_LEFT: 0x0004, DPAD_RIGHT: 0x0008,
  START: 0x0010, BACK: 0x0020,
  LB: 0x0100, RB: 0x0200,
  A: 0x1000, B: 0x2000, X: 0x4000, Y: 0x8000
};
const DEADZONE = 8000;

let prevButtons = 0;
let prevStick = { x: 0, y: 0 };
let holdDir = null;      // 当前按住的方向（连发用）
let holdStart = 0;
let lastRepeat = 0;
let pollTimer = null;
let enabled = false;
let ignoreUntil = 0;     // 抑制输入到该时间点（重连/窗口恢复瞬间防误触）
let lastPollAt = 0;      // 上次轮询时间：窗口在后台被系统节流时，定时器间隔会被拉长
const GAP_RESYNC = 120;  // 间隔超过该值视为"可能漏采样"，重新基线，不产生边沿

// 回调
const cb = {
  onNavigate: null,  // (dx, dy)
  onA: null,         // 确认/启动
  onB: null,         // 返回/最小化
  onStart: null,     // 重新扫描
  onConnected: null  // (bool) 手柄连接状态变化
};

let connected = false;

function readState() {
  const st = {}; // koffi 出参结构体用普通对象
  const r = XInputGetState(0, st);
  if (r !== 0) return null;
  return st;
}

function navFromButtons(buttons) {
  let dx = 0, dy = 0;
  if (buttons & BTN.DPAD_LEFT) dx -= 1;
  if (buttons & BTN.DPAD_RIGHT) dx += 1;
  if (buttons & BTN.DPAD_UP) dy -= 1;
  if (buttons & BTN.DPAD_DOWN) dy += 1;
  return { dx: dx, dy: dy };
}

function navFromStick(s) {
  let dx = 0, dy = 0;
  if (s.x < -DEADZONE) dx -= 1;
  if (s.x > DEADZONE) dx += 1;
  if (s.y < -DEADZONE) dy -= 1;
  if (s.y > DEADZONE) dy += 1;
  return { dx: dx, dy: dy };
}

function fire(dir) {
  if (cb.onNavigate) cb.onNavigate(dir.dx, dir.dy);
}

function poll() {
  if (!XInputGetState) return;
  const st = readState();
  const now = Date.now();

  if (!st) {
    if (connected) { connected = false; if (cb.onConnected) cb.onConnected(false); }
    prevButtons = 0; prevStick = { x: 0, y: 0 }; holdDir = null; lastPollAt = 0;
    return;
  }
  // 断连后重连（游戏全屏独占/退出时常发生）：把当前按键状态当作基线，
  // 并忽略 600ms 内的输入——否则"一直按住的 A"会被判成新按下，导致退出游戏后自动启动别的游戏
  if (!connected) {
    connected = true;
    prevButtons = st.Gamepad.wButtons;
    prevStick = { x: st.Gamepad.sThumbLX, y: st.Gamepad.sThumbLY };
    holdDir = null;
    ignoreUntil = Math.max(ignoreUntil, now + 600);
    if (cb.onConnected) cb.onConnected(true);
  }

  const b = st.Gamepad.wButtons;
  const stick = { x: st.Gamepad.sThumbLX, y: st.Gamepad.sThumbLY };

  // 关键：应用在后台时 Windows 会节流 setInterval（间隔可能拉到 1s+），
  // 这期间"按下又松开"会被完全漏掉。游戏全屏时按 A 退出，回到启动器后第一次轮询
  // 看到 A 仍按着 + prevButtons 还是旧值(0) → 误判成新按下 → 自动启动别的游戏。
  // 因此间隔过大时直接以当前状态为基线，并跳过本次边沿判断。
  const gap = lastPollAt ? now - lastPollAt : 0;
  lastPollAt = now;
  if (gap > GAP_RESYNC) {
    prevButtons = b;
    prevStick = stick;
    holdDir = null;
    return;
  }

  const muted = now < ignoreUntil;

  // 边沿触发：A / B / START
  const pressed = (btn) => (b & btn) && !(prevButtons & btn);
  if (!muted) {
    if (pressed(BTN.A) && cb.onA) cb.onA();
    if (pressed(BTN.B) && cb.onB) cb.onB();
    if (pressed(BTN.START) && cb.onStart) cb.onStart();
    // 肩键翻页（可选增强）
    if (pressed(BTN.RB) && cb.onNavigate) cb.onNavigate(6, 0);
    if (pressed(BTN.LB) && cb.onNavigate) cb.onNavigate(-6, 0);
  }

  // 方向：边沿立即触发一次
  let dir = navFromButtons(b);
  if (dir.dx === 0 && dir.dy === 0) {
    const s = navFromStick(stick);
    if (s.dx !== 0 || s.dy !== 0) dir = s;
  }
  const dirChanged = !(dir.dx === 0 && dir.dy === 0);
  if (muted) {
    holdDir = null;
  } else if (dirChanged) {
    if (!holdDir || holdDir.dx !== dir.dx || holdDir.dy !== dir.dy) {
      // 新方向：立即触发一次，记录连发起点
      holdDir = dir;
      holdStart = now;
      lastRepeat = now;
      fire(dir);
    } else {
      // 持续按住：首延迟 350ms 后每 130ms 连发
      if (now - holdStart > 350 && now - lastRepeat > 130) {
        lastRepeat = now;
        fire(dir);
      }
    }
  } else {
    holdDir = null;
  }

  prevButtons = b;
  prevStick = stick;
}

function start() {
  if (enabled || !XInputGetState) return enabled;
  enabled = true;
  pollTimer = setInterval(poll, 16);
  return true;
}

function stop() {
  enabled = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

module.exports = {
  start: start, stop: stop,
  available: !!XInputGetState,
  isConnected: function () { return connected; },
  // 抑制指定时长的手柄输入（窗口从最小化恢复、游戏退出等场景防误触）
  suppress: function (ms) { ignoreUntil = Math.max(ignoreUntil, Date.now() + (ms || 600)); },
  cb: cb
};
