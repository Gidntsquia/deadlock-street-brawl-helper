// Win32 window lookup for the Deadlock game window: rect tracking the browser sandbox can't do.
// Uses koffi (prebuilt FFI, no node-gyp) per docs/electron-overlay-plan.md phase 3.
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

function loadUser32(koffi: typeof import('koffi')) {
  const lib = koffi.load('user32.dll');
  return {
    FindWindowW: lib.func('__stdcall', 'FindWindowW', 'void *', ['str16', 'str16']),
    IsIconic: lib.func('__stdcall', 'IsIconic', 'bool', ['void *']),
    IsWindow: lib.func('__stdcall', 'IsWindow', 'bool', ['void *']),
    EnumWindows: lib.func('__stdcall', 'EnumWindows', 'bool', ['void *', 'intptr_t']),
    GetWindowTextW: lib.func('__stdcall', 'GetWindowTextW', 'int', ['void *', 'void *', 'int']),
    IsWindowVisible: lib.func('__stdcall', 'IsWindowVisible', 'bool', ['void *']),
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
    let handle: unknown = null;
    const buf = Buffer.alloc(512);
    user32.EnumWindows(
      koffi.register((hwnd: unknown) => {
        if (exclude?.has(BigInt(koffi.address(hwnd)))) return true;
        if (!user32!.IsWindowVisible(hwnd)) return true;
        const len = user32!.GetWindowTextW(hwnd, buf, 256);
        if (len > 0 && isGameWindowTitle(buf.toString('utf16le', 0, len * 2), title)) {
          handle = hwnd;
          return false;
        }
        return true;
      }, koffi.pointer('void *')),
      0,
    );
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
