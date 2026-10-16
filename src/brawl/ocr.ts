import { extractRerollLabelCrop, rerollGlyphIsOne, textRun, type cardNameCrop, type RGBImage } from './recognise';

// The three fixed text crops (a card's name line, the loading screen's hero name, the re-roll caption) are read by
// Windows.Media.Ocr in a hidden helper the Electron main process runs (electron/nameReader.ts). This file prepares each
// crop the same way everywhere (pure JS, so a recorded answer keyed by the prepared pixels matches on any machine) and
// hands it to the installed reader: in the app the worker relays it to the page, the page to main over IPC; Node tools
// and tests install a recorded or live reader (scripts/lib/textReader.ts). Matching the text stays in names.ts.

export type TextKind = 'name' | 'hero' | 'caption';
/** A prepared crop: RGBA, black text on white for names and the caption, the game's own colours for the hero name. */
export interface TextImage {
  width: number;
  height: number;
  data: Uint8Array;
}
export interface TextRead {
  text: string;
  /** The helper's own time for the read (ms), not counting the trip to it. */
  ms: number;
}
export type TextReader = (img: TextImage, kind: TextKind) => Promise<TextRead>;

/** The reader is not running (failed to start, exited twice, not on Windows) or did not answer in time. */
export class ReaderDownError extends Error {
  constructor(why = 'reader-down') {
    super(why);
    this.name = 'ReaderDownError';
  }
}

let reader: TextReader | null = null;
let down = false;

/** Installs the reader every read below goes to (one per context: the worker, the page, a Node tool). */
export function setTextReader(r: TextReader | null): void {
  reader = r;
}
export const hasTextReader = () => reader !== null;
/** Marks the reader down (true) or back up: while down every read fails at once with ReaderDownError. */
export function setReaderDown(v: boolean): void {
  down = v;
}
/** True when reads cannot be made: no reader installed, or main said the helper is not running. */
export const readerDown = () => down || reader === null;

function read(img: TextImage, kind: TextKind): Promise<TextRead> {
  if (readerDown()) return Promise.reject(new ReaderDownError());
  return reader!(img, kind);
}

/** A card's name line (cardNameCrop), already copied out of the frame: the worker reuses its frame buffer for the
 *  next frame while the read is still running. */
export type NameCrop = NonNullable<ReturnType<typeof cardNameCrop>>;

/** The name line trimmed to its text plus a 20 px white margin, then scaled up so it is at least 90 px tall: the shape
 *  Windows OCR read best in the feasibility run (plans/FEASIBILITY.md). The text is the widest-inked run of columns
 *  whose gaps stay under a third of the line height (a word space is far less): stray light marks beside the name (the
 *  RARE sparkle, a ring's glint) are left out, since a crop stretched by them made the reader return nothing. */
export function prepareName(crop: {
  data: Uint8Array;
  width: number;
  height: number;
  line?: number;
}): TextImage | null {
  const { data, width } = crop;
  const run = textRun(crop, crop.line ?? crop.height * 0.6);
  if (!run) return null;
  const [x0, x1] = run;
  let y0 = crop.height,
    y1 = -1;
  for (let y = 0; y < crop.height; y++)
    for (let x = x0; x <= x1; x++)
      if (data[(y * width + x) * 4]! < 128) {
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        break;
      }
  const pad = 20,
    w = x1 - x0 + 1 + 2 * pad,
    h = y1 - y0 + 1 + 2 * pad;
  const grey = new Uint8Array(w * h).fill(255);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) grey[(y - y0 + pad) * w + x - x0 + pad] = data[(y * width + x) * 4]!;
  return toRGBA(scaleGrey(grey, w, h, Math.max(1, 90 / h)));
}

/** Letter height (px) the loading-screen name is scaled to. Windows OCR read the raw colour box as nothing at some
 *  sizes (1920x1080 among them); this clean copy read every one of 5 frames at 7 widths (1280 to 3840). */
const HERO_TEXT_PX = 60;

/** The loading screen's hero name box (`loadingNameRect` crop, cream capitals on dark) as dark lettering on white:
 *  trimmed to its ink, scaled to `HERO_TEXT_PX` tall (nearest pixel) and padded 20 px. Null when no lettering. */
export function prepareHero(crop: RGBImage): TextImage | null {
  const { width: w, height: h, channels: ch, data } = crop;
  const g = new Uint8Array(w * h);
  let x0 = w,
    x1 = -1,
    y0 = h,
    y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      const m = Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
      const v = 255 - Math.max(0, Math.min(255, (m - 60) * 2));
      g[y * w + x] = v;
      if (v < 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  if (x1 < 0) return null;
  const s = HERO_TEXT_PX / (y1 - y0 + 1),
    pad = 20;
  const iw = Math.round((x1 - x0 + 1) * s),
    ih = Math.round((y1 - y0 + 1) * s);
  const W = iw + 2 * pad,
    H = ih + 2 * pad;
  const out = new Uint8Array(W * H * 4).fill(255);
  for (let y = 0; y < ih; y++)
    for (let x = 0; x < iw; x++) {
      const v = g[(y0 + Math.min(y1 - y0, Math.floor(y / s))) * w + x0 + Math.min(x1 - x0, Math.floor(x / s))]!;
      const o = ((y + pad) * W + x + pad) * 4;
      out[o] = out[o + 1] = out[o + 2] = v;
    }
  return { width: W, height: H, data: out };
}

/** The re-roll caption's "N Re-Roll" crop (extractRerollLabelCrop: dark text, contrast stretched) scaled 4x. */
export function prepareCaption(img: RGBImage): TextImage | null {
  const crop = extractRerollLabelCrop(img);
  if (!crop) return null;
  const grey = new Uint8Array(crop.width * crop.height);
  for (let i = 0; i < grey.length; i++) grey[i] = crop.data[i * 4]!;
  return toRGBA(scaleGrey(grey, crop.width, crop.height, 4));
}

/** Bilinear scale of a grey picture (scale >= 1). */
function scaleGrey(src: Uint8Array, width: number, height: number, scale: number) {
  const outW = Math.round(width * scale),
    outH = Math.round(height * scale);
  if (outW === width && outH === height) return { data: src, width, height };
  const out = new Uint8Array(outW * outH);
  const xs = new Int32Array(outW),
    xf = new Float32Array(outW);
  for (let x = 0; x < outW; x++) {
    const sx = Math.min(width - 1, Math.max(0, (x + 0.5) / scale - 0.5));
    xs[x] = Math.min(Math.max(0, width - 2), Math.floor(sx));
    xf[x] = width > 1 ? sx - xs[x]! : 0;
  }
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const y0 = Math.min(Math.max(0, height - 2), Math.floor(sy)),
      fy = height > 1 ? sy - y0 : 0,
      r0 = y0 * width,
      r1 = height > 1 ? r0 + width : r0;
    for (let x = 0; x < outW; x++) {
      const i = xs[x]!,
        j = width > 1 ? i + 1 : i,
        fx = xf[x]!;
      const top = src[r0 + i]! * (1 - fx) + src[r0 + j]! * fx;
      const bot = src[r1 + i]! * (1 - fx) + src[r1 + j]! * fx;
      out[y * outW + x] = Math.round(top * (1 - fy) + bot * fy);
    }
  }
  return { data: out, width: outW, height: outH };
}

function toRGBA(g: { data: Uint8Array; width: number; height: number }): TextImage {
  const out = new Uint8Array(g.width * g.height * 4);
  for (let i = 0; i < g.data.length; i++) {
    const o = i * 4;
    out[o] = out[o + 1] = out[o + 2] = g.data[i]!;
    out[o + 3] = 255;
  }
  return { width: g.width, height: g.height, data: out };
}

/** A card's item name line read by the name reader; the raw text, '' when nothing reads. Rejects with ReaderDownError
 *  when the reader is not running. */
export async function readCardName(crop: NameCrop, _slot = 0): Promise<string> {
  return (await readCardNameTimed(crop)).text;
}

/** readCardName with the helper's own time for the read (the worker logs it on `card.name`). */
export async function readCardNameTimed(crop: NameCrop): Promise<TextRead> {
  const img = prepareName(crop);
  if (!img) return { text: '', ms: 0 };
  const r = await read(img, 'name');
  return { text: r.text.trim(), ms: r.ms };
}

/** The loading screen's big hero name (loadingNameRect crop); the raw text, '' when nothing reads. */
export async function readHeroName(crop: RGBImage): Promise<string> {
  const img = prepareHero(crop);
  if (!img) return '';
  const r = await read(img, 'hero');
  return r.text.trim();
}

/** The "N Re-Roll Remaining" caption's count: 0 when the caption shows no glyph (no re-rolls left, or it is hidden),
 *  else the digit the reader finds. Street Brawl gives 0 or 1 re-roll, so only a lone 0 or 1 at the start of the text
 *  is believed; any other read, and every read while the reader is down, falls back to the glyph's shape (a thin
 *  upright bar is a 1, any other glyph a 0). */
export async function readRerollsRemaining(img: RGBImage): Promise<number> {
  const crop = prepareCaption(img);
  if (!crop) return 0;
  let text = '';
  try {
    text = (await read(crop, 'caption')).text;
  } catch {
    // reader down: the shape rule alone
  }
  const digit = text.trim().match(/^([01])(?![0-9])/);
  if (digit) return Number(digit[1]);
  return rerollGlyphIsOne(img) ? 1 : 0;
}
