/*
 * GameBox 3 — native.js
 * Win32 窗口 + GDI+ 渲染封装（koffi FFI，零运行时依赖）
 * 提供：窗口创建/子控件、双缓冲 GDI+ 绘制、消息泵、字体/图片缓存、消息框
 */
'use strict';

// koffi：打包版从临时目录加载（__KOFFI__），源码版从 node_modules 加载
const koffi = globalThis.__KOFFI__ || require('koffi');

/* ================= 库与结构 ================= */

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');
const gdiplus = koffi.load('gdiplus.dll');
const uxtheme = koffi.load('uxtheme.dll');
const shell32 = koffi.load('shell32.dll');
const ole32 = koffi.load('ole32.dll');
const shlwapi = koffi.load('shlwapi.dll');
const comdlg32 = koffi.load('comdlg32.dll');

function wc(s) {
  const b = Buffer.alloc((s.length + 1) * 2);
  for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2);
  return b;
}

/* ---------- 结构体（必须先于函数声明） ---------- */
const WndProcProto = koffi.proto('intptr_t __stdcall gb_wndproc(void *hwnd, uint32 msg, uintptr_t wparam, intptr_t lparam)');
const WNDCLASSEXW = koffi.struct('WNDCLASSEXW', {
  cbSize: 'uint32', style: 'uint32', lpfnWndProc: koffi.pointer(WndProcProto),
  cbClsExtra: 'int32', cbWndExtra: 'int32',
  hInstance: 'void *', hIcon: 'void *', hCursor: 'void *', hbrBackground: 'void *',
  lpszMenuName: 'void *', lpszClassName: 'void *', hIconSm: 'void *'
});
const MSG = koffi.struct('MSG', {
  hwnd: 'void *', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t',
  time: 'uint32', px: 'int32', py: 'int32'
});
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const PAINTSTRUCT = koffi.struct('PAINTSTRUCT', {
  hdc: 'void *', fErase: 'int32', rcPaint: RECT,
  fRestore: 'int32', fIncUpdate: 'int32', rgbReserved: koffi.array('uint8', 32)
});
const RectF = koffi.struct('RectF', { x: 'float', y: 'float', w: 'float', h: 'float' });
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
const TRACKMOUSEEVENT = koffi.struct('TRACKMOUSEEVENT', {
  cbSize: 'uint32', dwFlags: 'uint32', hwndTrack: 'void *', dwHoverTime: 'uint32'
});
const GdiplusStartupInput = koffi.struct('GdiplusStartupInput', {
  GdiplusVersion: 'uint32', DebugEventCallback: 'void *', DebugEventCallbackThread: 'void *',
  SuppressBackgroundThread: 'int32', SuppressExternalCodecs: 'int32'
});

const GpGraphics = koffi.opaque('GpGraphics');
const GpBitmap = koffi.opaque('GpBitmap');
const GpFont = koffi.opaque('GpFont');
const GpFontFamily = koffi.opaque('GpFontFamily');
const GpBrush = koffi.opaque('GpBrush');
const GpPen = koffi.opaque('GpPen');
const GpStringFormat = koffi.opaque('GpStringFormat');
const GpPath = koffi.opaque('GpPath');

/* ---------- 函数 ---------- */
// user32
const RegisterClassExW = user32.func('uint16 __stdcall RegisterClassExW(WNDCLASSEXW *lpwcx)');
const CreateWindowExW = user32.func('void * __stdcall CreateWindowExW(uint32 dwExStyle, void *lpClassName, void *lpWindowName, uint32 dwStyle, int x, int y, int nWidth, int nHeight, void *hWndParent, intptr_t hMenu, void *hInstance, void *lpParam)');
const DefWindowProcW = user32.func('intptr_t __stdcall DefWindowProcW(void *hWnd, uint32 Msg, uintptr_t wParam, intptr_t lParam)');
const ShowWindow = user32.func('int32 __stdcall ShowWindow(void *hWnd, int nCmdShow)');
const UpdateWindow = user32.func('int32 __stdcall UpdateWindow(void *hWnd)');
const DestroyWindow = user32.func('int32 __stdcall DestroyWindow(void *hWnd)');
const PostQuitMessage = user32.func('void __stdcall PostQuitMessage(int nExitCode)');
const PeekMessageW = user32.func('int32 __stdcall PeekMessageW(_Out_ MSG *lpMsg, void *hWnd, uint32 wMsgFilterMin, uint32 wMsgFilterMax, uint32 wRemoveMsg)');
const TranslateMessage = user32.func('int32 __stdcall TranslateMessage(MSG *lpMsg)');
const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(MSG *lpMsg)');
const GetDC = user32.func('void * __stdcall GetDC(void *hWnd)');
const ReleaseDC = user32.func('int32 __stdcall ReleaseDC(void *hWnd, void *hDC)');
const GetClientRect = user32.func('int32 __stdcall GetClientRect(void *hWnd, _Out_ RECT *lpRect)');
const GetWindowRect = user32.func('int32 __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)');
const InvalidateRect = user32.func('int32 __stdcall InvalidateRect(void *hWnd, RECT *lpRect, int32 bErase)');
const BeginPaint = user32.func('void * __stdcall BeginPaint(void *hWnd, PAINTSTRUCT *lpPaint)');
const EndPaint = user32.func('int32 __stdcall EndPaint(void *hWnd, PAINTSTRUCT *lpPaint)');
const SetWindowTextW = user32.func('int32 __stdcall SetWindowTextW(void *hWnd, const uint16 *lpString)');
const GetWindowTextW = user32.func('int32 __stdcall GetWindowTextW(void *hWnd, uint16 *lpString, int nMaxCount)');
const SendMessageW = user32.func('intptr_t __stdcall SendMessageW(void *hWnd, uint32 Msg, uintptr_t wParam, intptr_t lParam)');
const MessageBoxW = user32.func('int32 __stdcall MessageBoxW(void *hWnd, const uint16 *lpText, const uint16 *lpCaption, uint32 uType)');
const SetFocus = user32.func('void * __stdcall SetFocus(void *hWnd)');
const EnableWindow = user32.func('int32 __stdcall EnableWindow(void *hWnd, int32 bEnable)');
const GetParent = user32.func('void * __stdcall GetParent(void *hWnd)');
const GetMessageExtraInfo = user32.func('intptr_t __stdcall GetMessageExtraInfo()');
const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
const IsZoomed = user32.func('int32 __stdcall IsZoomed(void *hWnd)');
const SetForegroundWindow = user32.func('int32 __stdcall SetForegroundWindow(void *hWnd)');
const IsWindowVisible = user32.func('int32 __stdcall IsWindowVisible(void *hWnd)');
const IsIconic = user32.func('int32 __stdcall IsIconic(void *hWnd)');
const GetCursorPos = user32.func('int32 __stdcall GetCursorPos(_Out_ POINT *lpPoint)');
// 注意：ScreenToClient 是「读-改-写」语义，必须用 _Inout_。
// 实测坑：用 _Out_ 时 koffi 不会把 JS 对象的输入值 marshalling 进结构体
// （相当于传全 0 进去），结果永远是纯偏移量，坐标全错；
// 不加修饰则完全不写回。只有 _Inout_ 两者都对。
const ScreenToClient = user32.func('int32 __stdcall ScreenToClient(void *hWnd, _Inout_ POINT *lpPoint)');
const TrackMouseEvent = user32.func('int32 __stdcall TrackMouseEvent(TRACKMOUSEEVENT *lpEventTrack)');
const SetCapture = user32.func('void * __stdcall SetCapture(void *hWnd)');
const ReleaseCapture = user32.func('int32 __stdcall ReleaseCapture()');
const LoadCursorW = user32.func('void * __stdcall LoadCursorW(void *hInstance, void *lpCursorName)');
const GetKeyState = user32.func('int16 __stdcall GetKeyState(int nVirtKey)');
const SystemParametersInfoW = user32.func('int32 __stdcall SystemParametersInfoW(uint32 uiAction, uint32 uiParam, void *pvParam, uint32 fWinIni)');
const GetDpiForWindow = user32.func('uint32 __stdcall GetDpiForWindow(void *hWnd)');
const SetProcessDpiAwarenessContext = user32.func('int32 __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
const MoveWindow = user32.func('int32 __stdcall MoveWindow(void *hWnd, int X, int Y, int nWidth, int nHeight, int32 bRepaint)');

// gdi32（双缓冲）
const CreateCompatibleDC = gdi32.func('void * __stdcall CreateCompatibleDC(void *hdc)');
const CreateCompatibleBitmap = gdi32.func('void * __stdcall CreateCompatibleBitmap(void *hdc, int nWidth, int nHeight)');
const SelectObject = gdi32.func('void * __stdcall SelectObject(void *hdc, void *h)');
const DeleteObject = gdi32.func('int32 __stdcall DeleteObject(void *ho)');
const DeleteDC = gdi32.func('int32 __stdcall DeleteDC(void *hdc)');
const BitBlt = gdi32.func('int32 __stdcall BitBlt(void *hdcDest, int xDest, int yDest, int w, int h, void *hdcSrc, int xSrc, int ySrc, uint32 rop)');
const SetTextColor = gdi32.func('uint32 __stdcall SetTextColor(void *hdc, uint32 color)');
const SetBkColor = gdi32.func('int32 __stdcall SetBkColor(void *hdc, uint32 color)');
const SetBkMode = gdi32.func('int32 __stdcall SetBkMode(void *hdc, int mode)');

// gdiplus
const GdiplusStartup = gdiplus.func('int32 __stdcall GdiplusStartup(_Out_ void **token, GdiplusStartupInput *input, void *output)');
const GdipCreateFromHDC = gdiplus.func('int32 __stdcall GdipCreateFromHDC(void *hdc, _Out_ GpGraphics **graphics)');
const GdipDeleteGraphics = gdiplus.func('int32 __stdcall GdipDeleteGraphics(GpGraphics *graphics)');
const GdipGraphicsClear = gdiplus.func('int32 __stdcall GdipGraphicsClear(GpGraphics *graphics, uint32 color)');
const GdipSetSmoothingMode = gdiplus.func('int32 __stdcall GdipSetSmoothingMode(GpGraphics *graphics, int32 mode)');
const GdipSetTextRenderingHint = gdiplus.func('int32 __stdcall GdipSetTextRenderingHint(GpGraphics *graphics, int32 mode)');
const GdipSetPixelOffsetMode = gdiplus.func('int32 __stdcall GdipSetPixelOffsetMode(GpGraphics *graphics, int32 mode)');
const GdipCreateBitmapFromFileW = gdiplus.func('int32 __stdcall GdipCreateBitmapFromFile(const uint16 *filename, _Out_ GpBitmap **bitmap)');
// 用内存流解码：GdipCreateBitmapFromFile 会一直持有文件句柄（退出/替换封面时报"文件正在使用"）
const SHCreateMemStream = shlwapi.func('void * __stdcall SHCreateMemStream(const uint8 *pInit, uint32 cbInit)');
const GdipCreateBitmapFromStream = gdiplus.func('int32 __stdcall GdipCreateBitmapFromStream(void *stream, _Out_ GpBitmap **bitmap)');
const GdipDisposeImage = gdiplus.func('int32 __stdcall GdipDisposeImage(GpBitmap *image)');
const GdipGetImageWidth = gdiplus.func('int32 __stdcall GdipGetImageWidth(GpBitmap *image, _Out_ uint32 *width)');
const GdipGetImageHeight = gdiplus.func('int32 __stdcall GdipGetImageHeight(GpBitmap *image, _Out_ uint32 *height)');
// 注意：GdipDrawImage 只有 (x,y) 参数（按原始尺寸绘制）；缩放绘制必须用 GdipDrawImageRect
const GdipDrawImageRect = gdiplus.func('int32 __stdcall GdipDrawImageRect(GpGraphics *graphics, GpBitmap *image, float x, float y, float w, float h)');
// 整数版1:1 贴图：预缩放封面已是目标物理尺寸，走整数坐标 + SourceCopy 可跳过
// 浮点缩放与 alpha 混合，是高缩放档位下选卡卡顿的主要来源
const GdipDrawImageRectI = gdiplus.func('int32 __stdcall GdipDrawImageRectI(GpGraphics *graphics, GpBitmap *image, int32 x, int32 y, int32 w, int32 h)');
// CompositingMode：1 = SourceCopy（直接覆盖，不做 alpha 混合）
const GdipSetCompositingMode = gdiplus.func('int32 __stdcall GdipSetCompositingMode(GpGraphics *graphics, int32 mode)');
const GdipCreateFontFamilyFromName = gdiplus.func('int32 __stdcall GdipCreateFontFamilyFromName(const uint16 *name, void *fontCollection, _Out_ GpFontFamily **fontFamily)');
const GdipDeleteFontFamily = gdiplus.func('int32 __stdcall GdipDeleteFontFamily(GpFontFamily *fontFamily)');
const GdipCreateFont = gdiplus.func('int32 __stdcall GdipCreateFont(GpFontFamily *fontFamily, float emSize, int32 style, int32 unit, _Out_ GpFont **font)');
const GdipDeleteFont = gdiplus.func('int32 __stdcall GdipDeleteFont(GpFont *font)');
const GdipCreateSolidFill = gdiplus.func('int32 __stdcall GdipCreateSolidFill(uint32 color, _Out_ GpBrush **brush)');
const GdipDeleteBrush = gdiplus.func('int32 __stdcall GdipDeleteBrush(GpBrush *brush)');
const GdipCreatePen1 = gdiplus.func('int32 __stdcall GdipCreatePen1(uint32 color, float width, int32 unit, _Out_ GpPen **pen)');
const GdipDeletePen = gdiplus.func('int32 __stdcall GdipDeletePen(GpPen *pen)');
const GdipFillRectangle = gdiplus.func('int32 __stdcall GdipFillRectangle(GpGraphics *graphics, GpBrush *brush, float x, float y, float w, float h)');
const GdipDrawRectangle = gdiplus.func('int32 __stdcall GdipDrawRectangle(GpGraphics *graphics, GpPen *pen, float x, float y, float w, float h)');
const GdipDrawString = gdiplus.func('int32 __stdcall GdipDrawString(GpGraphics *graphics, const uint16 *str, int32 length, GpFont *font, RectF *rectf, GpStringFormat *stringFormat, GpBrush *brush)');
const GdipMeasureString = gdiplus.func('int32 __stdcall GdipMeasureString(GpGraphics *graphics, const uint16 *str, int32 length, GpFont *font, RectF *rectf, GpStringFormat *stringFormat, _Out_ RectF *boundingBox, _Out_ int32 *codepointsFitted, _Out_ int32 *linesFilled)');
const GdipStringFormatGetGenericDefault = gdiplus.func('int32 __stdcall GdipStringFormatGetGenericDefault(_Out_ GpStringFormat **format)');
// 注意：GetGenericDefault 返回共享对象，改它会污染所有复用者（三种对齐互相串味 → 文字对齐乱跳）
const GdipCreateStringFormat = gdiplus.func('int32 __stdcall GdipCreateStringFormat(int32 formatAttributes, uint16 language, _Out_ GpStringFormat **format)');
const GdipSetStringFormatAlign = gdiplus.func('int32 __stdcall GdipSetStringFormatAlign(GpStringFormat *format, int32 align)');
const GdipSetStringFormatLineAlign = gdiplus.func('int32 __stdcall GdipSetStringFormatLineAlign(GpStringFormat *format, int32 align)');
const GdipCreatePath = gdiplus.func('int32 __stdcall GdipCreatePath(int32 brushMode, _Out_ GpPath **path)');
const GdipAddPathLineI = gdiplus.func('int32 __stdcall GdipAddPathLineI(GpPath *path, int32 x1, int32 y1, int32 x2, int32 y2)');
const GdipAddPathArcI = gdiplus.func('int32 __stdcall GdipAddPathArcI(GpPath *path, int32 x, int32 y, int32 w, int32 h, float startAngle, float sweepAngle)');
const GdipClosePathFigure = gdiplus.func('int32 __stdcall GdipClosePathFigure(GpPath *path)');
// 注意：GDI+ 真实签名为 GdipFillPath(graphics, brush, path)、GdipDrawPath(graphics, pen, path) —— brush/pen 在 path 之前！
const GdipFillPath = gdiplus.func('int32 __stdcall GdipFillPath(GpGraphics *graphics, GpBrush *brush, GpPath *path)');
const GdipDrawPath = gdiplus.func('int32 __stdcall GdipDrawPath(GpGraphics *graphics, GpPen *pen, GpPath *path)');
const GdipDeletePath = gdiplus.func('int32 __stdcall GdipDeletePath(GpPath *path)');
const GdipSetClipPath = gdiplus.func('int32 __stdcall GdipSetClipPath(GpGraphics *graphics, GpPath *path, int32 combineMode)');
const GdipResetClip = gdiplus.func('int32 __stdcall GdipResetClip(GpGraphics *graphics)');
// 预缩放封面缓存用：离屏位图 + 其上下文 + 高质量插值
const GdipCreateBitmapFromGraphics = gdiplus.func('int32 __stdcall GdipCreateBitmapFromGraphics(int32 width, int32 height, GpGraphics *graphics, _Out_ GpBitmap **bitmap)');
// 注意：GdipGetImageGraphicsContext 首参在 GDI+ 里是 GpImage*，但本文件统一用 GpBitmap*
// （GdipDisposeImage 等既有绑定也是 GpBitmap*，指针层面等价，koffi 不校验基类）
const GdipGetImageGraphicsContext = gdiplus.func('int32 __stdcall GdipGetImageGraphicsContext(GpBitmap *image, _Out_ GpGraphics **graphics)');
const GdipSetInterpolationMode = gdiplus.func('int32 __stdcall GdipSetInterpolationMode(GpGraphics *graphics, int32 mode)');
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16',
  biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32', biClrImportant: 'uint32'
});
const GetDIBits = gdi32.func('int32 __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 cLines, void *lpbv, BITMAPINFOHEADER *lpbmi, uint32 usage)');
const GdipFillEllipse = gdiplus.func('int32 __stdcall GdipFillEllipse(GpGraphics *graphics, GpBrush *brush, float x, float y, float w, float h)');
const GdipDrawEllipse = gdiplus.func('int32 __stdcall GdipDrawEllipse(GpGraphics *graphics, GpPen *pen, float x, float y, float w, float h)');
const GdipDrawLineI = gdiplus.func('int32 __stdcall GdipDrawLineI(GpGraphics *graphics, GpPen *pen, int32 x1, int32 y1, int32 x2, int32 y2)');

// uxtheme（控件暗色化，失败也无妨）
const SetWindowTheme = uxtheme.func('int32 __stdcall SetWindowTheme(void *hwnd, const uint16 *pszSubAppName, const uint16 *pszSubIdList)');
const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(void *lpModuleName)');
const CreateSolidBrush = gdi32.func('void * __stdcall CreateSolidBrush(uint32 color)');
const CreateFontW = gdi32.func('void * __stdcall CreateFontW(int32 cHeight, int32 cWidth, int32 cEscapement, int32 cOrientation, int32 cWeight, uint32 bItalic, uint32 bUnderline, uint32 bStrikeOut, uint32 iCharSet, uint32 iOutPrecision, uint32 iClipPrecision, uint32 iQuality, uint32 iPitchAndFamily, const uint16 *pszFaceName)');
const CreateMutexW = kernel32.func('void * __stdcall CreateMutexW(void *lpMutexAttributes, int32 bInitialOwner, const uint16 *lpName)');
const GetLastError = kernel32.func('uint32 __stdcall GetLastError()');
const FindWindowW = user32.func('void * __stdcall FindWindowW(void *lpClassName, void *lpWindowName)');

/* ================= 全局状态 ================= */

let gpToken = [null];
let mainHwnd = null;
let hInst = null;
let wndprocPtr = null;
let memDC = null, memBmp = null, memOldBmp = null;
let bufW = 0, bufH = 0;
let dpiScale = 1;
let dirty = true;
let pumpRunning = false;
let quitFlag = false;

// 事件回调（由 app 注入）
const handlers = {
  onCommand: null, onMouseMove: null, onLButtonDown: null, onLButtonUp: null,
  onMouseWheel: null, onKeyDown: null, onChar: null, onClose: null, onResize: null,
  onSize: null, onSetCursor: null,
  onTouch: null   // 触屏：points[{id,x,y,phase,pressure}]（逻辑坐标）
};

// 资源缓存
const fontCache = new Map();   // key: size -> GpFont
const brushCache = new Map();  // argb -> GpBrush
const penCache = new Map();    // argb+width -> GpPen
const imageCache = new Map();  // absPath -> {bmp, w, h, mtime}
let fontFamily = null;
let emojiFamily = null;
let ctlFont = null;   // 原生子控件字体（按 DPI 创建一次）
let ctlBrush = null;

// 主题色（ARGB）
const C = {
  bg: 0xFF0D1117, panel: 0xFF131A24, card: 0xFF1A2333, cardHover: 0xFF222E44,
  border: 0xFF2A3648, borderSoft: 0xFF1E2836,
  text: 0xFFE9EEF7, text2: 0xFF93A0B4, text3: 0xFF5D6B82,
  accent: 0xFF5B8CFF, accent2: 0xFF9D5BFF, accentSoft: 0x225B8CFF,
  ok: 0xFF34D399, warn: 0xFFFBBF24, danger: 0xFFFF5B6A,
  shade: 0x99050810
};

// ARGB → GDI COLORREF(0x00BBGGRR)
function colorref(a) {
  return ((a & 0xFF) << 16) | (a & 0x00FF00) | ((a >>> 16) & 0xFF);
}

/* ================= 消息常量 ================= */
const WM_DESTROY = 0x0002, WM_SIZE = 0x0005, WM_PAINT = 0x000F, WM_CLOSE = 0x0010, WM_QUIT = 0x0012;
const WM_ERASEBKGND = 0x0014, WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102;
const WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_RBUTTONDOWN = 0x0204;
const WM_MOUSEWHEEL = 0x020A, WM_MOUSELEAVE = 0x02A3;
const WM_COMMAND = 0x0111, WM_CTLCOLOREDIT = 0x0133, WM_CTLCOLORSTATIC = 0x0138, WM_CTLCOLORLISTBOX = 0x0134, WM_CTLCOLORBTN = 0x0135;
const WM_SETCURSOR = 0x0020;
const EN_CHANGE = 0x0300, CBN_SELCHANGE = 1, BN_CLICKED = 0;
const VK_CONTROL = 0x11, VK_OEM_PLUS = 0xBB, VK_OEM_MINUS = 0xBD, VK_NUMPAD0 = 0x60, VK_F5 = 0x74;
const SW_SHOW = 5, SW_MINIMIZE = 6, SW_RESTORE = 9, SW_MAXIMIZE = 3;
const PM_REMOVE = 1, SRCCOPY = 0x00CC0020;

// ---- 触屏（WM_TOUCH）----
// 注意：收到 WM_TOUCH 后必须调用 CloseTouchInputHandle，否则系统不再投递该窗口的触摸消息。
const WM_TOUCH = 0x0240, WM_POINTERDOWN = 0x0246, WM_POINTERUP = 0x0247;
/* ---- 触屏（WM_TOUCH）----
 * 【血的教训】WM_TOUCH 的 lParam 是**不透明句柄 HTOUCHINPUT**，不是指向结构体的指针！
 * 数据必须调 GetTouchInputInfo(hTouchInput, cPoints, pInputs, cbSize) 取出，
 * 用完后必须 CloseTouchInputHandle(hTouchInput)，否则系统不再向本窗口投递触摸消息。
 *
 * 曾踩的坑：早期版本把 lParam 直接当 TOUCHINFOHEADER* 解引用
 * （koffi.decode(addr+20) + RtlMoveMemory(addr)），等于对内核句柄地址乱读：
 * cContacts 读到垃圾值，一旦 ≤64 就从句柄地址拷字节 → 访问违规 → 进程闪退。
 * 现象正是"在平板上一触界面就闪退"，且本地无触摸硬件完全测不到。
 *
 * TOUCHINPUT 结构（x64，48 字节，已用 koffi sizeof 核对）：
 *   LONG x(0) LONG y(4) HANDLE hSource(8) DWORD dwID(16) DWORD dwFlags(20)
 *   DWORD dwMask(24) DWORD dwTime(28) ULONG_PTR dwExtraInfo(32)
 *   DWORD cxContact(40) DWORD cyContact(44)
 * dwFlags 事件位：TOUCHEVENTF_MOVE/DOWN/UP/INRANGE/PRIMARY/PEN/PALM
 * 注意 x/y 单位是「百分之一物理像素」，必须先 /100 再 /dpiScale 转逻辑坐标。
 */
const TOUCHINPUT_SIZE = 48;
const TOUCH_MAX = 64;                       // 单次 WM_TOUCH 最多处理的触点数
// dwFlags 事件位
const TOUCHEVENTF_MOVE = 0x0001, TOUCHEVENTF_DOWN = 0x0002, TOUCHEVENTF_UP = 0x0004,
      TOUCHEVENTF_INRANGE = 0x0008, TOUCHEVENTF_PRIMARY = 0x0010,
      TOUCHEVENTF_PEN = 0x0040, TOUCHEVENTF_PALM = 0x0080;
// dwMask 位
const TOUCHINPUTMASKF_CONTACTAREA = 0x00000001, TOUCHINPUTMASKF_POINTERID = 0x00000008;
// RegisterTouchWindow 标志位（需降级尝试，见 enableTouch）
const TWF_FINE_POINTER = 0x0002, TWF_NOHTCLICK = 0x0008, TWF_WANTPALM = 0x0004;

const RegisterTouchWindow = user32.func('int32 __stdcall RegisterTouchWindow(void *hWnd, uint32 dwFlags)');
const GetTouchInputInfo = user32.func('int32 __stdcall GetTouchInputInfo(void *hTouchInput, uint32 cInputs, void *pInputs, int32 cbSize)');
const CloseTouchInputHandle = user32.func('int32 __stdcall CloseTouchInputHandle(void *hwnd, void *hInput)');
// 触摸坐标是「虚拟桌面」物理像素（多显示器时窗口不在主屏就会有偏移），
// 必须转成客户区坐标后才能与 UI 布局的逻辑坐标对齐。
// ScreenToClient / POINT 已在文件上方声明（第 97 行附近），这里直接复用。
const GetSystemMetricsU = user32.func('int32 __stdcall GetSystemMetrics(int32 nIndex)');
const SM_MOUSEPRESENT = 19, SM_DIGITIZER = 94, SM_MAXIMUMTOUCHES = 95;
const DIGITIZER_FLAG_PEN = 0x00000002, DIGITIZER_FLAG_TOUCH = 0x00000004;

/* ================= 初始化 ================= */

function init() {
  // 单实例检测（需同时确认互斥量已存在 + 已运行窗口存在，避免误判退出）
  try {
    CreateMutexW(null, 1, wc('GameBox3SingleInstanceMutex'));
    const exists = GetLastError() === 183; // ERROR_ALREADY_EXISTS
    if (exists) {
      const h = FindWindowW(wc('GameBox3Main'), null);
      if (h) {
        ShowWindow(h, SW_RESTORE);
        console.log('[GameBox] 已在运行，唤醒已有窗口');
        process.exit(0);
      }
    }
  } catch (e) {}
  // 高 DPI 感知（Win10 1703+）
  SetProcessDpiAwarenessContext(-4); // PER_MONITOR_AWARE_V2
  const st = GdiplusStartup(gpToken, {
    GdiplusVersion: 1, DebugEventCallback: null, DebugEventCallbackThread: null,
    SuppressBackgroundThread: 0, SuppressExternalCodecs: 0
  }, null);
  if (st !== 0) throw new Error('GDI+ 启动失败: ' + st);

  const fams = ['Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI', 'SimHei'];
  for (const f of fams) {
    const out = [null];
    if (GdipCreateFontFamilyFromName(wc(f), null, out) === 0 && out[0]) { fontFamily = out[0]; break; }
  }
  if (!fontFamily) {
    const out = [null];
    GdipCreateFontFamilyFromName(wc('Arial'), null, out);
    fontFamily = out[0];
  }
  // Emoji 字体（Segoe UI Emoji，Win10+ 支持彩色表情）
  const emojiOut = [null];
  if (GdipCreateFontFamilyFromName(wc('Segoe UI Emoji'), null, emojiOut) === 0 && emojiOut[0]) {
    emojiFamily = emojiOut[0];
  }

  hInst = GetModuleHandleW(null);
  return true;
}

/* ================= 窗口 ================= */

function registerClass() {
  const className = wc('GameBox3Main');
  wndprocPtr = koffi.register(wndProc, koffi.pointer(WndProcProto));
  const wcx = {
    cbSize: 80, style: 0x0003 /*CS_HREDRAW|CS_VREDRAW*/, lpfnWndProc: wndprocPtr,
    cbClsExtra: 0, cbWndExtra: 0,
    hInstance: hInst, hIcon: null, hCursor: LoadCursorW(null, 32512),
    hbrBackground: null, lpszMenuName: null, lpszClassName: className, hIconSm: null
  };
  const atom = RegisterClassExW(wcx);
  if (!atom) throw new Error('注册窗口类失败');
  return className;
}

function createMainWindow(title, w, h) {
  const className = registerClass();
  // WS_CLIPCHILDREN 必须加：否则父窗口每次 BitBlt 重绘都会把原生子控件（EDIT）的像素盖掉，
  // 表现为"输入框里的文字要点击一下才出现"
  mainHwnd = CreateWindowExW(0, className, wc(title), 0x00CF0000 /*WS_OVERLAPPEDWINDOW*/ | 0x02000000 /*WS_CLIPCHILDREN*/,
    -2147483648, -2147483648, w, h, null, 0, hInst, null);
  if (!mainHwnd) throw new Error('创建窗口失败');
  dpiScale = (GetDpiForWindow(mainHwnd) || 96) / 96;
  // 初始尺寸按逻辑像素设计：高 DPI 下放大窗口，保持期望的逻辑大小
  if (dpiScale !== 1) {
    const wr = {};
    GetWindowRect(mainHwnd, wr);
    MoveWindow(mainHwnd, wr.left, wr.top, Math.round(w * dpiScale), Math.round(h * dpiScale), 1);
  }
  ShowWindow(mainHwnd, SW_SHOW);
  UpdateWindow(mainHwnd);
  ShowWindow(mainHwnd, SW_MAXIMIZE); // 启动即最大化
  // 注册触屏（无触屏设备时返回 false，不影响鼠标路径）
  enableTouch();
  return mainHwnd;
}

function createChild(cls, text, style, x, y, w, h, id, exStyle) {
  const hwnd = CreateWindowExW(exStyle || 0, wc(cls), wc(text || ''), style,
    Math.round(x * dpiScale), Math.round(y * dpiScale), Math.round(w * dpiScale), Math.round(h * dpiScale), mainHwnd, id || 0, hInst, null);
  if (hwnd && (cls === 'EDIT' || cls === 'COMBOBOX')) {
    // 关闭视觉主题：带主题的 EDIT 会忽略 WM_CTLCOLOREDIT（永远是白底），
    // 传空串即禁用主题绘制，改由 WM_CTLCOLOREDIT 给出暗底浅字。
    SetWindowTheme(hwnd, wc(''), wc(''));
    // 原生控件字号同样要按 DPI 放大，否则 175% 下字很小
    if (!ctlFont) ctlFont = CreateFontW(-Math.round(13 * dpiScale), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, wc('Microsoft YaHei UI'));
    if (ctlFont) SendMessageW(hwnd, 0x0030 /*WM_SETFONT*/, ctlFont, 1);
  }
  return hwnd;
}

function show(visible, maximizeOnShow) {
  ShowWindow(mainHwnd, visible ? (maximizeOnShow ? SW_MAXIMIZE : SW_RESTORE) : SW_MINIMIZE);
  if (visible && maximizeOnShow) ShowWindow(mainHwnd, SW_MAXIMIZE); // 从最小化恢复时确保是最大化
}
function isMinimized() { return IsIconic(mainHwnd) !== 0; }
function invalidate() { dirty = true; }

/* ================= 消息循环 ================= */

// 鼠标坐标：lparam 是物理像素客户区坐标 → 转为逻辑坐标（与 UI 布局一致）
// 判断当前消息是否由 SendInput / 手柄映射工具注入（签名 0xFF515700）
function isInjectedInput() {
  try {
    const ei = Number(GetMessageExtraInfo());
    return ((ei & 0xFFFFFF00) >>> 0) === 0xFF515700;
  } catch (e) { return false; }
}

function mouseLogical(lparam) {
  const x = (lparam & 0xFFFF) / dpiScale;
  const y = ((lparam >> 16) & 0xFFFF) / dpiScale;
  return { x: x, y: y };
}

/* ================= 触屏支持 =================
 * 走 WM_TOUCH 而非 WM_GESTURE：后者只能拿到 pan/zoom 的聚合结果，
 * 无法区分「单击」与「按下滑动」，而卡片墙恰好需要这个区分
 *（点一下= 启动游戏，按住拖 = 滚动列表）。
 *
 * 关键点：
 *  1. lParam 是**不透明句柄 HTOUCHINPUT**，必须用 GetTouchInputInfo 取数据，
 *     绝不能把它当指针解引用（会访问违规 → 闪退）
 *  2. 用完必须 CloseTouchInputHandle，否则系统不再向本窗口投递触摸消息
 *  3. TOUCHINPUT.x/y 单位是「百分之一物理像素」，需 /100 再 /dpiScale 转逻辑坐标
 *  4. 调 RegisterTouchWindow 后，系统默认不再把触摸转成鼠标消息
 */
let touchRegistered = false;
let touchBuf = null;        // 复用的读缓冲（TOUCHINPUT 数组），避免每次 WM_TOUCH 都分配
let touchSupported = false; // 本机是否存在触摸设备
let touchFlags = 0;         // 实际生效的注册标志位（降级后可能不是完整能力集）

// 触摸设备探测：SM_DIGITIZER 带 TOUCH 位，或鼠标缺席时按触屏处理
function detectTouch() {
  try {
    const dz = GetSystemMetricsU(SM_DIGITIZER);
    if (dz & DIGITIZER_FLAG_TOUCH) return true;
    // 没有数字化器但也没有鼠标（常见于平板/一体机），也视为触屏设备
    if (dz === 0 && GetSystemMetricsU(SM_MOUSEPRESENT) === 0) return true;
  } catch (e) {}
  return false;
}
function maxTouchPoints() {
  try { return Math.max(1, GetSystemMetricsU(SM_MAXIMUMTOUCHES)); } catch (e) { return 10; }
}

// 注册触屏窗口（在窗口创建后调用）
// 标志位需降级尝试：实测 TWF_WANTPALM/TWF_NOHTCLICK 在部分环境（含无触屏数字化器的机器）
// 会让 RegisterTouchWindow 直接返回 0，只有 0x0000 / TWF_FINE_POINTER 能成功。
// 因此按「完整能力 → 细指针 → 无标志」依次降级，保证只要系统支持触摸就能注册上。
function enableTouch() {
  if (touchRegistered || !mainHwnd) return touchRegistered;
  const attempts = [
    TWF_FINE_POINTER | TWF_NOHTCLICK | TWF_WANTPALM,  // 完整能力（含 palm/双击抑制）
    TWF_FINE_POINTER,                                   // 仅细指针
    0                                                    // 最保守
  ];
  for (const flags of attempts) {
    try {
      if (RegisterTouchWindow(mainHwnd, flags) !== 0) {
        touchRegistered = true;
        touchSupported = true;
        touchFlags = flags;
        // 预分配读缓冲：最多 TOUCH_MAX 个 TOUCHINPUT
        touchBuf = Buffer.alloc(TOUCH_MAX * TOUCHINPUT_SIZE);
        return true;
      }
    } catch (e) { /* 试下一个 */ }
  }
  return false;
}

/* 把「虚拟桌面物理像素（百分之一单位）」转成 UI 使用的逻辑坐标。
 * 步骤：百分之一物理像素 → 物理像素 → ScreenToClient → /dpiScale → 逻辑像素 */
function toClientLogical(hwnd, hx, hy) {
  const pt = { x: Math.round(hx / 100), y: Math.round(hy / 100) };
  try { ScreenToClient(hwnd, pt); } catch (e) { /* 转换失败就退回原值 */ }
  return { x: pt.x / dpiScale, y: pt.y / dpiScale };
}

/* 解析 WM_TOUCH：用 GetTouchInputInfo 把触点数据取进 touchBuf，转成逻辑坐标数组。
 * hTouch 是 lParam（不透明句柄），count 是 wParam（本次触点数量）。
 * 返回 {time, points:[{id,x,y,phase,palm,cx,cy}]} 或 null；失败时也已关闭句柄。 */
function parseTouch(hwnd, hTouch, count) {
  // 无论成败都必须关闭输入句柄，否则系统不再投递 WM_TOUCH
  const DBG = process.env.GAMEBOX_TOUCH_DEBUG;
  function dbg(s) { if (DBG) { try { require('fs').appendFileSync(DBG, new Date().toISOString() + ' ' + s + '\n'); } catch (e) {} } }
  try {
    if (!touchBuf || !hTouch) { dbg('parseTouch bail: touchBuf=' + !!touchBuf + ' hTouch=' + String(hTouch)); return null; }
    const n = (count | 0);
    if (!n || n > TOUCH_MAX) { dbg('parseTouch bail: n=' + n); return null; }
    // cbSize 必须精确等于 sizeof(TOUCHINPUT)，否则 GetTouchInputInfo 直接失败
    const grc = GetTouchInputInfo(hTouch, n, koffi.address(touchBuf), TOUCHINPUT_SIZE);
    if (grc === 0) {
      const err = GetLastError();
      dbg('parseTouch FAIL: GetTouchInputInfo=0 n=' + n + ' GetLastError=' + err +
          ' (6=句柄无效 87=参数错 998=内存不可访问 122=缓冲不足)');
      return null;
    }
    const points = [];
    for (let i = 0; i < n; i++) {
      const b = i * TOUCHINPUT_SIZE;
      const rawFlags = touchBuf.readUInt32LE(b + 20);   // dwFlags
      const mask = touchBuf.readUInt32LE(b + 24);       // dwMask
      let phase = 0;
      if (rawFlags & TOUCHEVENTF_DOWN) phase = 0;        // DOWN
      else if (rawFlags & TOUCHEVENTF_UP) phase = 2;     // UP
      else if (rawFlags & TOUCHEVENTF_MOVE) phase = 1;   // UPDATE
      else phase = 1;                                    // INRANGE 等按 UPDATE 处理
      let cx = 0, cy = 0;
      if (mask & TOUCHINPUTMASKF_CONTACTAREA) {
        cx = touchBuf.readUInt32LE(b + 40);
        cy = touchBuf.readUInt32LE(b + 44);
      }
      const rawX = touchBuf.readInt32LE(b);
      const rawY = touchBuf.readInt32LE(b + 4);
      // TOUCHINPUT.x/y 是「虚拟桌面」上的百分之一物理像素。
      // 多显示器时窗口不在主屏，客户区原点并非虚拟桌面原点，
      // 必须先用 ScreenToClient 转成客户区物理像素，再 /dpiScale 得逻辑坐标。
      // （此前漏了这一步：鼠标 lParam 本就是客户区坐标所以鼠标一直正常，
      //   触摸却整体偏移，表现为"点封面完全没反应"）
      const lg = toClientLogical(hwnd, rawX, rawY);
      points.push({
        id: touchBuf.readUInt32LE(b + 16),              // dwID
        x: lg.x,
        y: lg.y,
        phase: phase,
        palm: (rawFlags & TOUCHEVENTF_PALM) !== 0,
        cx: cx, cy: cy
      });
    }
    if (DBG) {
      // 记录客户区原点偏移，便于判断坐标是否需要 ScreenToClient
      const o = { x: 0, y: 0 };
      try { ClientToScreen(hwnd, o); } catch (e) {}
      dbg('parseTouch OK n=' + n + ' dpi=' + dpiScale +
          ' clientOrigin=(' + o.x + ',' + o.y + ') pts=' +
        points.map(function (q) { return q.id + '@' + Math.round(q.x) + ',' + Math.round(q.y) + '/ph' + q.phase + (q.palm ? '/PALM' : ''); }).join(' | '));
    }
    return { time: 0, points: points };
  } catch (e) {
    dbg('parseTouch EXC: ' + (e && e.stack || e));
    return null;
  } finally {
    // 必须关闭：先于 return 之后执行，保证任何路径都关掉句柄
    try { CloseTouchInputHandle(hwnd, hTouch); } catch (e2) {}
  }
}

function wndProc(hwnd, msg, wparam, lparam) {
  switch (msg) {
    case WM_ERASEBKGND: return 1; // 自绘，防闪烁
    case WM_PAINT: {
      const ps = {};
      const hdc = BeginPaint(hwnd, ps);
      if (memDC && memBmp) {
        const rc = {};
        GetClientRect(hwnd, rc);
        BitBlt(hdc, 0, 0, rc.right, rc.bottom, memDC, 0, 0, SRCCOPY);
      }
      EndPaint(hwnd, ps);
      return 0;
    }
    case WM_SIZE: {
      // lparam 为物理像素；UI 层统一使用逻辑坐标（除以 dpiScale）
      if (handlers.onSize) handlers.onSize(wparam, (lparam & 0xFFFF) / dpiScale, ((lparam >> 16) & 0xFFFF) / dpiScale);
      return 0;
    }
    case WM_MOUSEMOVE: {
      const m = mouseLogical(lparam);
      if (handlers.onMouseMove) handlers.onMouseMove(m.x, m.y, wparam);
      return 0;
    }
    case WM_LBUTTONDOWN: {
      const m = mouseLogical(lparam);
      SetFocus(hwnd);
      if (handlers.onLButtonDown) handlers.onLButtonDown(m.x, m.y, wparam, isInjectedInput());
      return 0;
    }
    case WM_LBUTTONUP: {
      const m = mouseLogical(lparam);
      if (handlers.onLButtonUp) handlers.onLButtonUp(m.x, m.y, wparam);
      return 0;
    }
    case WM_RBUTTONDOWN: {
      const m = mouseLogical(lparam);
      if (handlers.onRButtonDown) handlers.onRButtonDown(m.x, m.y, wparam);
      return 0;
    }
    case WM_MOUSEWHEEL: {
      const delta = ((wparam >> 16) & 0xFFFF);
      const signed = delta > 32767 ? delta - 65536 : delta;
      const m = mouseLogical(lparam);
      if (handlers.onMouseWheel) handlers.onMouseWheel(signed, m.x, m.y);
      return 0;
    }
    case WM_TOUCH: {
      // wparam = 本次触点数量，lParam = 触摸输入句柄 HTOUCHINPUT（不透明！）
      // parseTouch 内部已负责关闭句柄（try/finally），这里绝不能再解引用 lParam
      if (process.env.GAMEBOX_TOUCH_DEBUG) {
        try {
          require('fs').appendFileSync(process.env.GAMEBOX_TOUCH_DEBUG,
            'WM_TOUCH wparam=' + (typeof wparam) + ':' + String(wparam) +
            ' lparam=' + (typeof lparam) + ':' + String(lparam) + '\n');
        } catch (e0) {}
      }
      const t = parseTouch(hwnd, lparam, wparam & 0xFFFF);
      if (t && handlers.onTouch) {
        try {
          t.n = wparam & 0xFFFF;
          handlers.onTouch(t);
        } catch (e) {
          // 手势回调抛异常时不能让异常穿透 koffi 回调边界：那会让进程直接 abort。
          // 落盘记录后安全返回，触屏不应把整个程序带走。
          try {
            const logFile = process.env.GAMEBOX_TRACE || (require('path').dirname(process.execPath) + '\\touch-err.log');
            require('fs').appendFileSync(logFile, new Date().toISOString() + ' onTouch: ' + (e && e.stack || e) + '\n');
          } catch (e4) {}
        }
      }
      return 0;
    }
    case WM_KEYDOWN: {
      if (handlers.onKeyDown) handlers.onKeyDown(wparam, lparam, isInjectedInput());
      return 0;
    }
    case WM_CHAR: {
      if (handlers.onChar) handlers.onChar(wparam, lparam);
      return 0;
    }
    case WM_COMMAND: {
      const id = wparam & 0xFFFF;
      const code = (wparam >> 16) & 0xFFFF;
      if (handlers.onCommand) handlers.onCommand(id, code, lparam);
      return 0;
    }
    case WM_CTLCOLOREDIT: case WM_CTLCOLORLISTBOX: case WM_CTLCOLORSTATIC: {
      // 暗色控件：GDI 的 COLORREF 是 0x00BBGGRR（不是 ARGB），必须转换
      const bgRef = colorref(C.panel), fgRef = colorref(C.text);
      if (!ctlBrush) ctlBrush = CreateSolidBrush(bgRef);
      SetTextColor(wparam, fgRef);
      SetBkColor(wparam, bgRef);
      SetBkMode(wparam, 1 /*TRANSPARENT*/);
      return ctlBrush;
    }
    case WM_SETCURSOR: {
      if (handlers.onSetCursor) {
        const r = handlers.onSetCursor((lparam & 0xFFFF), ((lparam >> 16) & 0xFFFF));
        if (r) return 1;
      }
      break;
    }
    case WM_CLOSE: {
      if (handlers.onClose) {
        if (!handlers.onClose()) return 0; // 阻止关闭
      }
      DestroyWindow(hwnd);
      return 0;
    }
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wparam, lparam);
}

// 消息泵：PeekMessage 非阻塞 + setImmediate 让出 Node 事件循环（网络/定时器不卡）
async function pump(onTick) {
  if (pumpRunning) return;
  pumpRunning = true;
  const msg = {};
  while (!quitFlag) {
    while (PeekMessageW(msg, null, 0, 0, PM_REMOVE)) {
      if (msg.message === WM_QUIT) { quitFlag = true; break; }
      TranslateMessage(msg);
      DispatchMessageW(msg);
    }
    if (onTick) onTick();
    await new Promise(r => setImmediate(r));
  }
  pumpRunning = false;
}

function quit() {
  quitFlag = true;
}

/* ================= 双缓冲渲染 ================= */

function ensureBuffer(w, h) {
  if (memDC && bufW === w && bufH === h) return;
  const hdc = GetDC(mainHwnd);
  if (memDC) {
    SelectObject(memDC, memOldBmp);
    DeleteObject(memBmp);
    DeleteDC(memDC);
  }
  memDC = CreateCompatibleDC(hdc);
  memBmp = CreateCompatibleBitmap(hdc, w, h);
  memOldBmp = SelectObject(memDC, memBmp);
  ReleaseDC(mainHwnd, hdc);
  bufW = w; bufH = h;
}

// 渲染一帧：drawFn(graphics, scale) 会被调用
function render(drawFn) {
  if (!mainHwnd) return;
  const rc = {};
  GetClientRect(mainHwnd, rc);
  const cw = Math.max(1, rc.right - rc.left);
  const ch = Math.max(1, rc.bottom - rc.top);
  // 进程为 PER_MONITOR_AWARE_V2：GetClientRect 已是物理像素，缓冲区直接取物理尺寸
  // （UI 布局为逻辑坐标，由绘制原语内部乘 dpiScale 映射到物理缓冲区）
  ensureBuffer(cw, ch);
  const outG = [null];
  if (GdipCreateFromHDC(memDC, outG) !== 0 || !outG[0]) return;
  const g = outG[0];
  GdipSetSmoothingMode(g, 4);        // AntiAlias
  GdipSetTextRenderingHint(g, 4);    // AntiAliasGridFit
  GdipSetPixelOffsetMode(g, 4);      // Half
  GdipGraphicsClear(g, C.bg);
  // UI 布局统一使用逻辑坐标（绘制原语内部再乘 dpiScale 映射到物理缓冲区）
  drawFn(g, dpiScale, cw / dpiScale, ch / dpiScale);
  GdipDeleteGraphics(g);
  // 呈现到窗口
  const hdc = GetDC(mainHwnd);
  BitBlt(hdc, 0, 0, cw, ch, memDC, 0, 0, SRCCOPY);
  ReleaseDC(mainHwnd, hdc);
  dirty = false;

  // 调试：将当前帧导出为 BMP（设置环境变量 GAMEBOX_DUMP_FRAME=<路径>）
  if (process.env.GAMEBOX_DUMP_FRAME && !dumped) {
    dumped = true;
    try { dumpFrame(process.env.GAMEBOX_DUMP_FRAME, cw, ch); } catch (e) {}
  }
}

let dumped = false;
function dumpFrame(file, pw, ph) {
  const bmi = { biSize: 40, biWidth: pw, biHeight: ph, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 };
  const px = Buffer.alloc(pw * ph * 4);
  if (GetDIBits(memDC, memBmp, 0, ph, px, bmi, 0) !== ph) return;
  const fh = Buffer.alloc(14); fh.write('BM', 0); fh.writeUInt32LE(54 + px.length, 2); fh.writeUInt32LE(54, 10);
  const ih = Buffer.alloc(40);
  ih.writeUInt32LE(40, 0); ih.writeInt32LE(pw, 4); ih.writeInt32LE(ph, 8);
  ih.writeUInt16LE(1, 12); ih.writeUInt16LE(32, 14); ih.writeUInt32LE(0, 16); ih.writeUInt32LE(px.length, 20);
  require('fs').writeFileSync(file, Buffer.concat([fh, ih, px]));
}

function presentIfDirty(drawFn) {
  if (!dirty) return;
  render(drawFn);
}

/* ================= 绘制原语 ================= */

function argb(a, r, g, b) { return ((a & 0xFF) << 24) | ((r & 0xFF) << 16) | ((g & 0xFF) << 8) | (b & 0xFF); }
function withAlpha(color, alpha) {
  const a = (color >>> 24) & 0xFF;
  const na = Math.round(a * alpha);
  return ((na & 0xFF) << 24) | (color & 0x00FFFFFF);
}

function getFont(px) {
  const key = Math.round(px * 10) / 10;
  let f = fontCache.get(key);
  if (!f) {
    const out = [null];
    // UnitPixel(2)：emSize 以设备像素计，配合 px*dpiScale 即为精确物理像素字号
    GdipCreateFont(fontFamily, key, 0, 2 /*UnitPixel*/, out);
    f = out[0];
    fontCache.set(key, f);
  }
  return f;
}
function getBrush(argb) {
  let b = brushCache.get(argb);
  if (!b) {
    const out = [null];
    GdipCreateSolidFill(argb, out);
    b = out[0];
    brushCache.set(argb, b);
  }
  return b;
}
function getPen(argb, width) {
  const key = argb + ':' + width;
  let p = penCache.get(key);
  if (!p) {
    const out = [null];
    // GDI+ 画笔单位：2 = UnitPixel。用 UnitPoint(3) 时描边会画不出来（GDI+ 静默丢弃）
    GdipCreatePen1(argb, width, 2, out);
    p = out[0];
    penCache.set(key, p);
  }
  return p;
}

const FMT_LEFT = [null], FMT_CENTER = [null], FMT_RIGHT = [null];
function fmt(align) {
  const arr = align === 1 ? FMT_CENTER : (align === 2 ? FMT_RIGHT : FMT_LEFT);
  if (!arr[0]) {
    const out = [null];
    // 独立创建 StringFormat（不要用 GetGenericDefault：那是共享对象，对齐设置会互相覆盖）
    if (GdipCreateStringFormat(0, 0, out) !== 0 || !out[0]) {
      GdipStringFormatGetGenericDefault(out);
    }
    if (out[0]) {
      GdipSetStringFormatAlign(out[0], align);
      GdipSetStringFormatLineAlign(out[0], 0); // Near（顶部）
    }
    arr[0] = out[0];
  }
  return arr[0];
}

// Emoji 文本（Segoe UI Emoji 字体；不可用时退回普通字体）
function emojiText(g, s, x, y, w, h, px, color, align) {
  if (!s) return;
  let font;
  if (emojiFamily) {
    const key = 'e' + (Math.round(px * dpiScale * 10) / 10);
    font = fontCache.get(key);
    if (!font) {
      const out = [null];
      GdipCreateFont(emojiFamily, px * dpiScale, 0, 2 /*UnitPixel*/, out);
      font = out[0];
      fontCache.set(key, font);
    }
  } else {
    font = getFont(px);
  }
  GdipDrawString(g, wc(String(s)), -1, font, { x: x * dpiScale, y: y * dpiScale, w: w * dpiScale, h: h * dpiScale }, fmt(align || 0), getBrush(color));
}

// 多边形填充（播放三角等）
function polygon(g, pts, fill, stroke, lw) {
  const s = dpiScale;
  const out = [null];
  if (GdipCreatePath(0, out) !== 0 || !out[0]) return;
  const p = out[0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    GdipAddPathLineI(p, Math.round(a[0] * s), Math.round(a[1] * s), Math.round(b[0] * s), Math.round(b[1] * s));
  }
  GdipClosePathFigure(p);
  if (fill != null) GdipFillPath(g, getBrush(fill), p);
  if (stroke != null) GdipDrawPath(g, getPen(stroke, (lw || 1) * dpiScale), p);
  GdipDeletePath(p);
}

function text(g, s, x, y, w, h, px, color, align) {
  if (!s) return;
  GdipDrawString(g, wc(String(s)), -1, getFont(px * dpiScale), { x: x * dpiScale, y: y * dpiScale, w: w * dpiScale, h: h * dpiScale }, fmt(align || 0), getBrush(color));
}

function measure(g, s, px, w, h) {
  const bb = {}, cf = [0], lf = [0];
  GdipMeasureString(g, wc(String(s || '')), -1, getFont(px * dpiScale), { x: 0, y: 0, w: w * dpiScale, h: h * dpiScale }, fmt(0), bb, cf, lf);
  return { w: (bb.w || 0) / dpiScale, h: (bb.h || 0) / dpiScale };
}

/* 文本测量缓存
 * GdipMeasureString 是一次跨 FFI 的调用，而wrapText 为了断行会对每个字符反复调用
 * （中文游戏名尤其明显：一屏 17 张卡≈ 每帧 200+ 次），是缩放后卡顿的主要来源。
 * 文本宽度只由「字符串 + 字号 + dpiScale」决定，与 graphics 无关，
 * 因此可以在此按这三者做记忆化，把每帧数百次 FFI 降到0 次。 */
const measureCache = new Map();
const MEASURE_CACHE_MAX = 4096;
function measureCached(g, s, px, w, h) {
  const str = String(s == null ? '' : s);
  // 字号四舍五入到 0.1，和 getFont 的键一致，避免浮点抖动造成缓存穿透
  const fpx = Math.round(px * 10) / 10;
  const key = fpx + '|' + w + '|' + h + '|' + str;
  const hit = measureCache.get(key);
  if (hit !== undefined) return hit;
  const r = measure(g, str, px, w, h);
  if (measureCache.size >= MEASURE_CACHE_MAX) {
    const oldest = measureCache.keys().next().value;
    if (oldest !== undefined) measureCache.delete(oldest);
  }
  measureCache.set(key, r);
  return r;
}

// 省略号截断
function ellipsis(g, s, px, maxW) {
  const full = measure(g, s, px, 10000, 100);
  if (full.w <= maxW) return String(s);
  let lo = 0, hi = String(s).length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const t = String(s).slice(0, mid) + '...';
    if (measure(g, t, px, 10000, 100).w <= maxW) lo = mid; else hi = mid - 1;
  }
  return String(s).slice(0, lo) + '...';
}

function rect(g, x, y, w, h, color) {
  GdipFillRectangle(g, getBrush(color), x * dpiScale, y * dpiScale, w * dpiScale, h * dpiScale);
}
function roundRectPath(x, y, w, h, r, scale) {
  const s = (scale == null) ? dpiScale : scale;
  const X = x * s, Y = y * s, W = w * s, H = h * s;
  const out = [null];
  if (GdipCreatePath(0, out) !== 0 || !out[0]) return null;
  const p = out[0];
  const rr = Math.min(r, w / 2, h / 2) * s;
  GdipAddPathLineI(p, Math.round(X + rr), Math.round(Y), Math.round(X + W - rr), Math.round(Y));
  GdipAddPathArcI(p, Math.round(X + W - rr * 2), Math.round(Y), Math.round(rr * 2), Math.round(rr * 2), -90, 90);
  GdipAddPathLineI(p, Math.round(X + W), Math.round(Y + rr), Math.round(X + W), Math.round(Y + H - rr));
  GdipAddPathArcI(p, Math.round(X + W - rr * 2), Math.round(Y + H - rr * 2), Math.round(rr * 2), Math.round(rr * 2), 0, 90);
  GdipAddPathLineI(p, Math.round(X + W - rr), Math.round(Y + H), Math.round(X + rr), Math.round(Y + H));
  GdipAddPathArcI(p, Math.round(X), Math.round(Y + H - rr * 2), Math.round(rr * 2), Math.round(rr * 2), 90, 90);
  GdipAddPathLineI(p, Math.round(X), Math.round(Y + H - rr), Math.round(X), Math.round(Y + rr));
  GdipAddPathArcI(p, Math.round(X), Math.round(Y), Math.round(rr * 2), Math.round(rr * 2), 180, 90);
  GdipClosePathFigure(p);
  return p;
}
const GP_DEBUG = !!process.env.GAMEBOX_GP_DEBUG;
function gpd(name, code) { if (GP_DEBUG && code !== 0) console.log('[gdi+]', name, '->', code); }
function rectStroke(g, x, y, w, h, color, lw) {
  gpd('DrawRectangle', GdipDrawRectangle(g, getPen(color, (lw || 1) * dpiScale), x * dpiScale, y * dpiScale, w * dpiScale, h * dpiScale));
}
function roundRect(g, x, y, w, h, r, fillColor, strokeColor, lw) {
  const p = roundRectPath(x, y, w, h, r);
  if (!p) { if (GP_DEBUG) console.log('[gdi+] roundRectPath null'); return; }
  if (fillColor != null) gpd('FillPath', GdipFillPath(g, getBrush(fillColor), p));
  if (strokeColor != null) gpd('DrawPath', GdipDrawPath(g, getPen(strokeColor, (lw || 1) * dpiScale), p));
  GdipDeletePath(p);
}

// 图片缓存（文件 mtime 变化自动重载）
// 注意：drawCover 每帧每卡都会调用本函数，若每次都 statSync 会产生大量系统调用；
// 因此对已缓存项做 STAT_TTL 节流：1 秒内直接复用，1 秒后才复查一次 mtime。
const STAT_TTL = 1000;
function getImage(absPath) {
  if (!absPath) return null;
  const cached = imageCache.get(absPath);
  const now = Date.now();
  if (cached && (now - (cached.checkedAt || 0)) < STAT_TTL) return cached;
  let ent;
  try { ent = require('fs').statSync(absPath); } catch (e) { return null; }
  if (cached && cached.mtime === ent.mtimeMs) { cached.checkedAt = now; return cached; }
  const out = [null];
  let buf = null;
  try { buf = require('fs').readFileSync(absPath); } catch (e) { return cached || null; }
  const stream = buf && buf.length ? SHCreateMemStream(buf, buf.length) : null;
  if (!stream || GdipCreateBitmapFromStream(stream, out) !== 0 || !out[0]) {
    // 兜底：回退到按文件加载（会持有句柄，但不至于显示不出封面）
    if (GdipCreateBitmapFromFileW(wc(absPath), out) !== 0 || !out[0]) return cached || null;
  }
  if (cached) GdipDisposeImage(cached.bmp);
  const w = [0], h = [0];
  GdipGetImageWidth(out[0], w);
  GdipGetImageHeight(out[0], h);
  const item = { bmp: out[0], w: w[0], h: h[0], mtime: ent.mtimeMs, checkedAt: now };
  imageCache.set(absPath, item);
  return item;
}

/* 预缩放封面缓存
 * 缩放界面（如 150%）后每张卡变很大，若每帧都用 GdipDrawImageRect 把原始大图
 * 重新缩放 + 重建圆角裁剪路径，绘制成本随缩放成倍上升，导致选择游戏发涩。
 * 这里把「已按目标尺寸缩放好、并裁好圆角」的封面缓存成离屏位图：
 * 每帧只需 1:1 贴图（GdipDrawImageRect 目标=原尺寸），不再做重采样。
 * 缓存 key 含 路径 + mtime + 物理宽高 + 圆角，缩放/换图自动失效重建。 */
const coverCache = new Map();   // key -> { bmp }
const COVER_CACHE_MAX = 96;     // 容量保护：超出后淘汰最旧（Map 按插入序）
function disposeCover(key) {
  const e = coverCache.get(key);
  if (e && e.bmp) { GdipDisposeImage(e.bmp); }
  coverCache.delete(key);
}
function clearCoverCache() {
  for (const k of Array.from(coverCache.keys())) disposeCover(k);
}
function getCoverScaled(g, absPath, img, Wp, Hp, rp, fallbackColor) {
  const key = absPath + '\u0000' + img.mtime + '\u0000' + Wp + 'x' + Hp + 'r' + rp + 'c' + fallbackColor;
  const hit = coverCache.get(key);
  if (hit) { coverCache.delete(key); coverCache.set(key, hit); return hit.bmp; } // LRU 触碰
  // 离屏位图尺寸 = 实际物理像素（已含 dpiScale）；其上下文使用像素坐标、无缩放变换
  const out = [null];
  if (GdipCreateBitmapFromGraphics(Wp, Hp, g, out) !== 0 || !out[0]) return null;
  const outG = [null];
  if (GdipGetImageGraphicsContext(out[0], outG) !== 0 || !outG[0]) { GdipDisposeImage(out[0]); return null; }
  GdipSetSmoothingMode(outG[0], 4);     // AntiAlias：圆角更顺滑
  GdipSetInterpolationMode(outG[0], 7); // HighQualityBicubic：仅重建时做一次高质量重采样
  // 先整张填卡片底色：圆角外区域 = 卡片色，因此最终贴图无需依赖透明混合，最稳
  GdipFillRectangle(outG[0], getBrush(fallbackColor), 0, 0, Wp, Hp);
  const scale = Math.max(Wp / img.w, Hp / img.h);   // object-fit: cover
  const dw = img.w * scale, dh = img.h * scale;
  const dx = (Wp - dw) / 2, dy = (Hp - dh) / 2;
  const p = roundRectPath(0, 0, Wp, Hp, rp, 1);      // 像素坐标路径（scale=1）
  if (p) { GdipSetClipPath(outG[0], p, 0); }         // CombineModeReplace
  GdipDrawImageRect(outG[0], img.bmp, dx, dy, dw, dh);
  if (p) { GdipResetClip(outG[0]); GdipDeletePath(p); }
  GdipDeleteGraphics(outG[0]);
  if (coverCache.size >= COVER_CACHE_MAX) {
    const oldest = coverCache.keys().next().value;
    if (oldest !== undefined) disposeCover(oldest);
  }
  coverCache.set(key, { bmp: out[0] });
  return out[0];
}

// 绘制封面（object-fit: cover 居中裁切 + 圆角裁剪）
function drawCover(g, absPath, x, y, w, h, radius, fallbackColor, initials) {
  const img = getImage(absPath);
  if (img && img.w && img.h) {
    const Wp = Math.max(1, Math.round(w * dpiScale));
    const Hp = Math.max(1, Math.round(h * dpiScale));
    const rp = Math.max(0, Math.round(radius * dpiScale));
    const off = getCoverScaled(g, absPath, img, Wp, Hp, rp, fallbackColor);
    if (off) { // 每帧仅 1:1 整数贴图，不再重采样、不再 alpha 混合
      GdipSetCompositingMode(g, 1); // SourceCopy：整块覆盖，避开逐像素混合
      GdipDrawImageRectI(g, off, Math.round(x * dpiScale), Math.round(y * dpiScale), Wp, Hp);
      GdipSetCompositingMode(g, 0); // 还原 SourceOver，避免影响后续绘制
      return;
    }
    // 离屏缓存不可用 → 落回下面的直接绘制，保证功能不退化
  }
  const p = roundRectPath(x, y, w, h, radius);
  if (!img || !img.w || !img.h) {
    if (p) { GdipFillPath(g, getBrush(fallbackColor), p); GdipDeletePath(p); }
    if (initials) {
      text(g, initials, x, y + h / 2 - Math.round(w * 0.16), w, Math.round(w * 0.32), Math.round(w * 0.32), 0x33FFFFFF, 1);
    }
    return;
  }
  const scale = Math.max(w / img.w, h / img.h);
  const dw = img.w * scale, dh = img.h * scale;
  const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
  if (p) {
    GdipSetClipPath(g, p, 0); // CombineModeReplace
    GdipFillRectangle(g, getBrush(fallbackColor), x * dpiScale, y * dpiScale, w * dpiScale, h * dpiScale);
    GdipDrawImageRect(g, img.bmp, dx * dpiScale, dy * dpiScale, dw * dpiScale, dh * dpiScale);
    GdipResetClip(g);
    GdipDeletePath(p);
  } else {
    GdipDrawImageRect(g, img.bmp, dx * dpiScale, dy * dpiScale, dw * dpiScale, dh * dpiScale);
  }
}

/* ================= 控件辅助 ================= */

function comboAddStr(hwnd, s) {
  SendMessageW(hwnd, 0x0143 /*CB_ADDSTRING*/, 0, wc(s));
}
function comboSelect(hwnd, idx) { SendMessageW(hwnd, 0x014E /*CB_SETCURSEL*/, idx, 0); }
function comboGetSelect(hwnd) { return SendMessageW(hwnd, 0x0147 /*CB_GETCURSEL*/, 0, 0); }
// 让原生子控件立即重绘（设置面板刚显示时，EDIT 有时只画底色不画文字，点一下才出现）
function redrawChild(h) {
  if (!h) return;
  try { InvalidateRect(h, null, 1); UpdateWindow(h); } catch (e) {}
}

/* ---------- 选择文件夹（系统原生对话框） ---------- */
const BROWSEINFOW = koffi.struct('BROWSEINFOW', {
  hwndOwner: 'void *',
  pidlRoot: 'void *',
  pszDisplayName: 'uint16 *',
  lpszTitle: 'uint16 *',
  ulFlags: 'uint32',
  lpfn: 'void *',
  lParam: 'intptr_t',
  iImage: 'int32'
});
const SHBrowseForFolderW = shell32.func('void * __stdcall SHBrowseForFolderW(BROWSEINFOW *lpbi)');
const SHGetPathFromIDListW = shell32.func('int32 __stdcall SHGetPathFromIDListW(void *pidl, uint16 *pszPath)');
const CoTaskMemFree = ole32.func('void __stdcall CoTaskMemFree(void *p)');

function readW(buf) {
  let s = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const c = buf.readUInt16LE(i);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// 返回选中的目录绝对路径；取消返回 null
function pickFolder(title) {
  try {
    const disp = Buffer.alloc(520 * 2);
    const info = {
      hwndOwner: mainHwnd, pidlRoot: null, pszDisplayName: disp,
      lpszTitle: wc(title || '选择游戏目录'),
      ulFlags: 0x1 | 0x10 | 0x40, // RETURNONLYFSDIRS | EDITBOX | NEWDIALOGSTYLE
      lpfn: null, lParam: 0, iImage: 0
    };
    const pidl = SHBrowseForFolderW(info);
    if (!pidl) return null;
    const out = Buffer.alloc(520 * 2);
    const ok = SHGetPathFromIDListW(pidl, out);
    try { CoTaskMemFree(pidl); } catch (e) {}
    if (!ok) return null;
    const p = readW(out).trim();
    return p || null;
  } catch (e) { return null; }
}

/* ---------- 选择文件（系统原生打开对话框） ----------
 * 用于「自定义启动文件」和「自定义封面图片」。
 * 所有宽字符串参数统一走 void* + Buffer（wc() 生成），
 * 输出路径直接预填进 lpstrFile 缓冲再由 C 侧改写，读 Buffer 即可——
 * 避免依赖 koffi 对字符串指针的写回语义。
 */
const OPENFILENAMEW = koffi.struct('OPENFILENAMEW', {
  lStructSize: 'uint32',
  hwndOwner: 'void *',
  hInstance: 'void *',
  lpstrFilter: 'void *',
  lpstrCustomFilter: 'void *',
  nMaxCustFilter: 'uint32',
  nFilterIndex: 'uint32',
  lpstrFile: 'void *',
  nMaxFile: 'uint32',
  lpstrFileTitle: 'void *',
  nMaxFileTitle: 'uint32',
  lpstrInitialDir: 'void *',
  lpstrTitle: 'void *',
  dwFlags: 'uint32',
  nFileOffset: 'uint16',
  nFileExtension: 'uint16',
  lpstrDefExt: 'void *',
  lCustData: 'intptr_t',
  lpfnHook: 'void *',
  lpTemplateName: 'void *',
  pvReserved: 'void *',
  dwReserved: 'uint32',
  FlagsEx: 'uint32'
});
const GetOpenFileNameW = comdlg32.func('int32 __stdcall GetOpenFileNameW(OPENFILENAMEW *lpofn)');
// EXPLORER | FILEMUSTEXIST | PATHMUSTEXIST
const OFN_FLAGS = 0x00080000 | 0x00001000 | 0x00000008;

// 把 [{desc, patterns:['*.exe','*.bat']}] 拼成 OPENFILENAME 需要的双 null 结尾宽字符串
function buildFilter(groups) {
  let s = '';
  for (const g of groups) s += g.desc + '\0' + (g.patterns.join(';')) + '\0';
  s += '\0';
  return wc(s);
}

/* 打开系统文件选择框，返回选中的文件绝对路径；取消/出错返回 null。
 * opts: { title, groups:[{desc,patterns}], defExt, initialDir, file } */
function pickFile(opts) {
  try {
    const o = opts || {};
    const fileBuf = Buffer.alloc(4096 * 2);
    // 预填初始文件名（对话框的"文件名"框会显示它）
    if (o.file) {
      const b = wc(String(o.file));
      b.copy(fileBuf, 0, 0, Math.min(b.length, fileBuf.length - 2));
    }
    const info = {
      lStructSize: OPENFILENAMEW.size,
      hwndOwner: mainHwnd,
      hInstance: null,
      lpstrFilter: buildFilter(o.groups || [{ desc: '所有文件', patterns: ['*.*'] }]),
      lpstrCustomFilter: null,
      nMaxCustFilter: 0,
      nFilterIndex: 1,
      lpstrFile: fileBuf,
      nMaxFile: 2048,               // 以字符计，必须小于缓冲区字符数(4096)
      lpstrFileTitle: null,
      nMaxFileTitle: 0,
      lpstrInitialDir: o.initialDir ? wc(String(o.initialDir)) : null,
      lpstrTitle: wc(o.title || '选择文件'),
      dwFlags: OFN_FLAGS,
      nFileOffset: 0, nFileExtension: 0,
      lpstrDefExt: o.defExt ? wc(String(o.defExt)) : null,
      lCustData: 0, lpfnHook: null, lpTemplateName: null,
      pvReserved: null, dwReserved: 0, FlagsEx: 0
    };
    if (!GetOpenFileNameW(info)) return null;   // 0 = 用户取消
    const p = readW(fileBuf).trim();
    return p || null;
  } catch (e) { return null; }
}

// 读控件文本：不能用 SendMessageW(WM_GETTEXT, buf) —— koffi 的 lParam 声明是 intptr_t（数字），
// 传 Buffer 会直接抛 "Unexpected Uint8Array value, expected number"。改用 GetWindowTextW。
function editGetText(hwnd) {
  if (!hwnd) return '';
  const buf = Buffer.alloc(8192); // 4096 个 UTF-16 字符，足够路径/地址
  const n = GetWindowTextW(hwnd, buf, 4096);
  if (!n || n < 0) return '';
  let s = '';
  for (let i = 0; i < n; i++) {
    const code = buf.readUInt16LE(i * 2);
    if (!code) break;
    s += String.fromCharCode(code);
  }
  return s;
}
function editSetText(hwnd, s) { SetWindowTextW(hwnd, wc(s)); }
function msgBox(text, caption, type) {
  return MessageBoxW(mainHwnd, wc(text), wc(caption || 'GameBox'), type || 0x04 /*MB_YESNO*/);
}

/* ================= 导出 ================= */

module.exports = {
  init: init,
  createMainWindow: createMainWindow,
  createChild: createChild,
  handlers: handlers,
  touch: {
    // 是否已成功注册触屏窗口（false = 该机器走纯鼠标路径）
    enabled: function () { return touchRegistered; },
    supported: function () { return touchSupported; },
    maxPoints: maxTouchPoints,
    enable: enableTouch,
    flags: function () { return touchFlags; },
    __parseTouchForTest: parseTouch
  },
  pump: pump,
  quit: quit,
  render: render,
  presentIfDirty: presentIfDirty,
  invalidate: invalidate,
  show: show,
  isMinimized: isMinimized,
  msgBox: msgBox,
  editGetText: editGetText, editSetText: editSetText,
  comboAdd: comboAddStr, comboSelect: comboSelect, comboGetSelect: comboGetSelect,
  setFocus: function (h) { SetFocus(h); },
  setFocusMain: function () { SetFocus(mainHwnd); },
  moveChild: function (h, x, y, w, hh) {
    // 逻辑坐标 → 物理像素（MoveWindow 需要物理尺寸）
    MoveWindow(h, Math.round(x * dpiScale), Math.round(y * dpiScale), Math.round(w * dpiScale), Math.round(hh * dpiScale), 1);
  },
  getMainHwnd: function () { return mainHwnd; },
  getDpiScale: function () { return dpiScale; },
  // 绘制原语
  C: C, text: text, measure: measure, ellipsis: ellipsis,
  rect: rect, rectStroke: rectStroke, roundRect: roundRect, drawCover: drawCover,
  clearCoverCache: clearCoverCache, measureCached: measureCached,
  ellipse: function (g, x, y, w, h, fill, stroke, lw) {
    if (fill != null) GdipFillEllipse(g, getBrush(fill), x * dpiScale, y * dpiScale, w * dpiScale, h * dpiScale);
    if (stroke != null) GdipDrawEllipse(g, getPen(stroke, (lw || 1) * dpiScale), x * dpiScale, y * dpiScale, w * dpiScale, h * dpiScale);
  },
  line: function (g, x1, y1, x2, y2, color, lw) {
    GdipDrawLineI(g, getPen(color, (lw || 1) * dpiScale), Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2));
  },
  argb: argb, withAlpha: withAlpha,
  emojiText: emojiText, polygon: polygon,
  showChild: function (h, visible) { ShowWindow(h, visible ? SW_SHOW : 0); },
  redrawChild: redrawChild,
  pickFolder: pickFolder,
  pickFile: pickFile,
  // 调试：子控件状态（是否可见 / 是否真父窗口 / 屏幕矩形）
  childInfo: function (h) {
    if (!h) return { hwnd: false };
    const rc = {};
    GetWindowRect(h, rc);
    return {
      hwnd: !!h, visible: IsWindowVisible(h) !== 0,
      isChild: GetParent(h) === mainHwnd,
      rect: (rc.right - rc.left) + 'x' + (rc.bottom - rc.top) + '@' + rc.left + ',' + rc.top
    };
  },
  isKeyDown: function (vk) { return (GetKeyState(vk) & 0x8000) !== 0; },
  // 窗口是否在前台且未最小化（手柄输入只在启动器处于前台时才接受）
  isForeground: function () { return !!mainHwnd && GetForegroundWindow() === mainHwnd && IsIconic(mainHwnd) === 0; },
  focus: function () { try { if (mainHwnd) SetForegroundWindow(mainHwnd); } catch (e) {} },
  debugState: function () {
    const rc = {};
    GetClientRect(mainHwnd, rc);
    return { dirty: dirty, client: (rc.right - rc.left) + 'x' + (rc.bottom - rc.top), buf: bufW + 'x' + bufH, dpi: dpiScale, memDC: !!memDC, hwnd: !!mainHwnd };
  },
  // 常量
  WM: { EN_CHANGE: EN_CHANGE, CBN_SELCHANGE: CBN_SELCHANGE, BN_CLICKED: BN_CLICKED, VK_CONTROL: VK_CONTROL, VK_OEM_PLUS: VK_OEM_PLUS, VK_OEM_MINUS: VK_OEM_MINUS, VK_NUMPAD0: VK_NUMPAD0, VK_F5: VK_F5 },
  maximize: function () { try { ShowWindow(mainHwnd, SW_MAXIMIZE); } catch (e) {} },
  isMaximized: function () { try { return !!mainHwnd && IsZoomed(mainHwnd) !== 0; } catch (e) { return false; } },
  SW: { SHOW: SW_SHOW, MINIMIZE: SW_MINIMIZE, RESTORE: SW_RESTORE, MAXIMIZE: SW_MAXIMIZE },
  MB_YESNO: 0x04, MB_YESNOCANCEL: 0x03, IDYES: 6, IDNO: 7, IDCANCEL: 2,
  _koffi: koffi, _user32: user32
};
