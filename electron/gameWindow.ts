// Win32 window lookup for the Deadlock game window: rect tracking the browser sandbox can't do.
// Uses koffi (prebuilt FFI, no node-gyp).
import koffi from 'koffi';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

let user32: ReturnType<typeof loadUser32> | null = null;
let dwmapi: ReturnType<typeof loadDwmapi> | null = null;
let cached: { title: string; handle: unknown } | null = null; // last found game window

// EnumWindows needs a real callback prototype (not a bare 'void *') so koffi can build a native
// trampoline for it; without this it silently enumerates zero windows instead of throwing, which is
// why findGameWindow used to return null even with a matching window on screen.
const WndEnumProc = koffi.proto('bool __stdcall WndEnumProc(void *hwnd, intptr_t lParam)');

// Registered once and reused across every findGameWindow() call (polled at 4 Hz for the app's whole
// lifetime) instead of via koffi.register() per call: koffi.register() allocates a native callback
// trampoline that is never garbage-collected and must be freed explicitly with koffi.unregister() --
// registering fresh on every poll leaked one permanently-held native callback per tick, growing without
// bound for as long as the app ran. Per-call state (title/exclude/result) is threaded through
// `enumState` instead of being closed over.
let enumState: {
  title: string;
  exclude: Set<bigint> | undefined;
  user32: ReturnType<typeof loadUser32>;
  buf: Buffer;
  handle: unknown;
} | null = null;
const enumCallback = koffi.register((hwnd: unknown) => {
  const s = enumState!;
  if (s.exclude?.has(BigInt(koffi.address(hwnd)))) return true;
  if (!s.user32.IsWindowVisible(hwnd)) return true;
  const len = s.user32.GetWindowTextW(hwnd, s.buf, 256);
  if (len > 0 && isGameWindowTitle(s.buf.toString('utf16le', 0, len * 2), s.title)) {
    s.handle = hwnd;
    return false;
  }
  return true;
}, koffi.pointer(WndEnumProc));

function loadUser32(koffi: typeof import('koffi')) {
  const lib = koffi.load('user32.dll');
  return {
    FindWindowW: lib.func('__stdcall', 'FindWindowW', 'void *', ['str16', 'str16']),
    IsIconic: lib.func('__stdcall', 'IsIconic', 'bool', ['void *']),
    IsWindow: lib.func('__stdcall', 'IsWindow', 'bool', ['void *']),
    EnumWindows: lib.func('__stdcall', 'EnumWindows', 'bool', [koffi.pointer(WndEnumProc), 'intptr_t']),
    GetWindowTextW: lib.func('__stdcall', 'GetWindowTextW', 'int', ['void *', 'void *', 'int']),
    IsWindowVisible: lib.func('__stdcall', 'IsWindowVisible', 'bool', ['void *']),
    GetForegroundWindow: lib.func('__stdcall', 'GetForegroundWindow', 'void *', []),
    GetDC: lib.func('__stdcall', 'GetDC', 'void *', ['void *']),
    ReleaseDC: lib.func('__stdcall', 'ReleaseDC', 'int', ['void *', 'void *']),
    SetWindowPos: lib.func('__stdcall', 'SetWindowPos', 'bool', [
      'void *',
      'intptr_t',
      'int',
      'int',
      'int',
      'int',
      'uint32',
    ]),
  };
}

function loadDwmapi(koffi: typeof import('koffi')) {
  const lib = koffi.load('dwmapi.dll');
  const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  return {
    RECT,
    DwmGetWindowAttribute: lib.func('__stdcall', 'DwmGetWindowAttribute', 'long', [
      'void *',
      'uint32',
      koffi.out(koffi.pointer(RECT)),
      'uint32',
    ]),
  };
}

/** Exact match (trimmed, case-insensitive) so the game's window ('Deadlock') is never confused with the
 *  app's own control window ('Deadlock Street Brawl Helper'), which contains it as a substring. */
export function isGameWindowTitle(title: string, needle: string): boolean {
  return title.trim().toLowerCase() === needle.trim().toLowerCase();
}

/** Finds a top-level window whose title exactly matches `title` (case-insensitive, trimmed), minimised or not.
 *  `exclude` skips handles known to belong to this app's own windows even if they somehow matched. */
export function findGameWindow(title: string, exclude?: Set<bigint>): Rect | null {
  if (process.platform !== 'win32') return null; // dev/build only ever runs the real lookup on Windows
  try {
    user32 ??= loadUser32(koffi);
    dwmapi ??= loadDwmapi(koffi);
    const buf = Buffer.alloc(512);
    // Enumerating every top-level window is the expensive part: once the game window is known, just re-check that
    // same handle (still a window, visible, same exact title) and only enumerate again when it is gone.
    let handle: unknown = null;
    if (
      cached &&
      cached.title === title &&
      !exclude?.has(BigInt(koffi.address(cached.handle))) &&
      user32.IsWindow(cached.handle) &&
      user32.IsWindowVisible(cached.handle)
    ) {
      const len = user32.GetWindowTextW(cached.handle, buf, 256);
      if (len > 0 && isGameWindowTitle(buf.toString('utf16le', 0, len * 2), title)) handle = cached.handle;
    }
    if (!handle) {
      enumState = { title, exclude, user32, buf, handle: null };
      user32.EnumWindows(enumCallback, 0);
      handle = enumState.handle;
      enumState = null;
      cached = handle ? { title, handle } : null;
    }
    if (!handle || user32.IsIconic(handle)) return null;
    const rect = {};
    const hr = dwmapi.DwmGetWindowAttribute(handle, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16);
    if (hr !== 0) return null;
    const r = rect as { left: number; top: number; right: number; bottom: number };
    return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
  } catch {
    return null; // koffi missing, DLL call failed, or window closed mid-call
  }
}

/** Resizes a native window to `width` x `height` *physical* px, keeping its position and z-order. Electron clamps
 *  a new window to the display's work area; on a small display (a remote session, a 1024x768 fallback mode) that
 *  would leave Test mode's dummy short of the ~1080p the recogniser needs and not 16:9. Windows itself lets a
 *  window be larger than the screen. */
export function resizeWindowPhysical(handle: Buffer, width: number, height: number): boolean {
  if (process.platform !== 'win32') return false;
  try {
    user32 ??= loadUser32(koffi);
    const SWP_NOMOVE = 0x2,
      SWP_NOZORDER = 0x4,
      SWP_NOACTIVATE = 0x10;
    const hwnd = koffi.decode(handle, 'void *');
    return user32.SetWindowPos(hwnd, 0, 0, 0, width, height, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  } catch {
    return false;
  }
}

/** Puts a native window (an `Electron.BrowserWindow#getNativeWindowHandle()` buffer) at the bottom of the
 *  z-order without moving, resizing or activating it. Used by the e2e/demo harness so its dummy game window
 *  never covers what the person is working on (window capture still reads its pixels). */
export function sendWindowToBottom(handle: Buffer): boolean {
  if (process.platform !== 'win32') return false;
  try {
    user32 ??= loadUser32(koffi);
    const HWND_BOTTOM = 1;
    const SWP_NOSIZE = 0x1,
      SWP_NOMOVE = 0x2,
      SWP_NOACTIVATE = 0x10;
    const hwnd = koffi.decode(handle, 'void *');
    return user32.SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
  } catch {
    return false;
  }
}

function loadGdi32() {
  const lib = koffi.load('gdi32.dll');
  return {
    CreateCompatibleDC: lib.func('__stdcall', 'CreateCompatibleDC', 'void *', ['void *']),
    CreateCompatibleBitmap: lib.func('__stdcall', 'CreateCompatibleBitmap', 'void *', ['void *', 'int', 'int']),
    SelectObject: lib.func('__stdcall', 'SelectObject', 'void *', ['void *', 'void *']),
    BitBlt: lib.func('__stdcall', 'BitBlt', 'bool', [
      'void *',
      'int',
      'int',
      'int',
      'int',
      'void *',
      'int',
      'int',
      'uint32',
    ]),
    GetDIBits: lib.func('__stdcall', 'GetDIBits', 'int', [
      'void *',
      'void *',
      'uint32',
      'uint32',
      'void *',
      'void *',
      'uint32',
    ]),
    DeleteObject: lib.func('__stdcall', 'DeleteObject', 'bool', ['void *']),
    DeleteDC: lib.func('__stdcall', 'DeleteDC', 'bool', ['void *']),
  };
}
let gdi32: ReturnType<typeof loadGdi32> | null = null;

/** True while the game window found by `findGameWindow` is the foreground window. The draft probe only reads the
 *  screen then, so it never samples pixels belonging to some other window that happens to cover the game. */
export function isGameForeground(): boolean {
  if (process.platform !== 'win32' || !cached) return false;
  try {
    user32 ??= loadUser32(koffi);
    const fg = user32.GetForegroundWindow();
    return !!fg && koffi.address(fg) === koffi.address(cached.handle);
  } catch {
    return false;
  }
}

/** Copies a small screen rectangle (physical px) as top-down BGRA bytes with one BitBlt from the screen DC: a few
 *  hundred pixels, no window capture. Null when the read fails or it is off-screen. */
export function grabScreenRegion(x: number, y: number, width: number, height: number): Uint8Array | null {
  if (process.platform !== 'win32' || width <= 0 || height <= 0) return null;
  let screenDc: unknown = null,
    memDc: unknown = null,
    bmp: unknown = null,
    old: unknown = null;
  try {
    user32 ??= loadUser32(koffi);
    gdi32 ??= loadGdi32();
    screenDc = user32.GetDC(null);
    if (!screenDc) return null;
    memDc = gdi32.CreateCompatibleDC(screenDc);
    bmp = gdi32.CreateCompatibleBitmap(screenDc, width, height);
    if (!memDc || !bmp) return null;
    old = gdi32.SelectObject(memDc, bmp);
    const SRCCOPY = 0x00cc0020;
    if (!gdi32.BitBlt(memDc, 0, 0, width, height, screenDc, x, y, SRCCOPY)) return null;
    // BITMAPINFOHEADER: 40 bytes, 32 bpp, negative height = top-down rows.
    const bmi = Buffer.alloc(40);
    bmi.writeUInt32LE(40, 0);
    bmi.writeInt32LE(width, 4);
    bmi.writeInt32LE(-height, 8);
    bmi.writeUInt16LE(1, 12);
    bmi.writeUInt16LE(32, 14);
    const out = Buffer.alloc(width * height * 4);
    const DIB_RGB_COLORS = 0;
    const lines = gdi32.GetDIBits(memDc, bmp, 0, height, out, bmi, DIB_RGB_COLORS);
    return lines === height ? out : null;
  } catch {
    return null;
  } finally {
    try {
      if (old && memDc) gdi32?.SelectObject(memDc, old);
      if (bmp) gdi32?.DeleteObject(bmp);
      if (memDc) gdi32?.DeleteDC(memDc);
      if (screenDc) user32?.ReleaseDC(null, screenDc);
    } catch {
      /* nothing left to free */
    }
  }
}
