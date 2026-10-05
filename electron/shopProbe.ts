// The cheap "is the item draft screen up" check main.ts runs instead of capturing the game window: read only the
// "CHOICE n OF 3" glyph's few hundred pixels off the screen and hand them to the recogniser. Pure apart from the
// injected `grab`, so it is testable without Windows.
import { isShopScreen, loadingNameRect, looksLikeLoadingName, shopProbeRect } from '../src/brawl/recognise';
import type { Rect } from './gameWindow';

/** Reads a screen rectangle (physical px) as BGRA bytes, or null if it cannot. */
export type GrabRegion = (x: number, y: number, width: number, height: number) => Uint8Array | null;

export function probeShopScreen(game: Rect, grab: GrabRegion): boolean {
  const r = shopProbeRect(game.width, game.height);
  if (r.width <= 0 || r.height <= 0) return false;
  const bgra = grab(game.x + r.x, game.y + r.y, r.width, r.height);
  if (!bgra || bgra.length < r.width * r.height * 4) return false;
  const data = new Uint8ClampedArray(r.width * r.height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bgra[i + 2]!;
    data[i + 1] = bgra[i + 1]!;
    data[i + 2] = bgra[i]!;
    data[i + 3] = 255;
  }
  return isShopScreen({
    width: r.width,
    height: r.height,
    data,
    channels: 4,
    origin: { x: r.x, y: r.y, fullWidth: game.width, fullHeight: game.height },
  });
}

/** True when the probe region of the game window reads as solid black: what a capture of an exclusive fullscreen game
 *  returns. A black loading screen does the same for a moment, so the caller waits before it says anything. */
export function probeIsBlack(game: Rect, grab: GrabRegion): boolean {
  const r = shopProbeRect(game.width, game.height);
  if (r.width <= 0 || r.height <= 0) return false;
  const bgra = grab(game.x + r.x, game.y + r.y, r.width, r.height);
  if (!bgra || bgra.length < r.width * r.height * 4) return false;
  for (let i = 0; i < r.width * r.height * 4; i += 4)
    if (bgra[i]! > 8 || bgra[i + 1]! > 8 || bgra[i + 2]! > 8) return false;
  return true;
}

/** The loading screen's hero name box as RGBA bytes when the screen shows it, else null. Reads one small box. */
export function probeLoadingName(
  game: Rect,
  grab: GrabRegion,
): { width: number; height: number; buffer: ArrayBuffer } | null {
  const r = loadingNameRect(game.width, game.height);
  if (r.width <= 0 || r.height <= 0) return null;
  const bgra = grab(game.x + r.x, game.y + r.y, r.width, r.height);
  if (!bgra || bgra.length < r.width * r.height * 4) return null;
  const data = new Uint8ClampedArray(r.width * r.height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bgra[i + 2]!;
    data[i + 1] = bgra[i + 1]!;
    data[i + 2] = bgra[i]!;
    data[i + 3] = 255;
  }
  if (!looksLikeLoadingName({ width: r.width, height: r.height, data, channels: 4 })) return null;
  return { width: r.width, height: r.height, buffer: data.buffer };
}
