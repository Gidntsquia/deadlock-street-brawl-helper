import { createWorker, PSM, type Worker as TesseractWorker } from 'tesseract.js';
import { extractRerollLabelCrop, rerollGlyphIsOne, type cardNameCrop, type RGBImage } from './recognise';

// All assets (worker script, wasm core, eng.traineddata.gz) are bundled under public/ocr/ so this reads
// real digits via OCR without any network access at runtime -- required for an offline desktop app, and
// the same bundle serves both the browser/worker build and the Node fixtures/CLI build below.
const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';

// The label crop is only ~47x37px at reference resolution: Tesseract needs real size to read it (a tiny,
// unscaled crop reads as empty text with 0 confidence -- verified against screenshots/brawl/reroll-choice*.png).
const UPSCALE = 8;

let workerPromise: Promise<TesseractWorker> | null = null;
// A second engine for the item names under the cards: the digit engine's whitelist and page mode are set once, and
// switching them per call would race the two kinds of read.
// One engine per card slot: the three name lines are read at the same time instead of queueing behind one engine,
// which is what held the first advice back on a slow PC. Slot 0 also serves the loading-screen hero name.
// On a 2 to 4 thread machine three engines (each a wasm model in memory) compete with the game: one engine reads the
// names one after another instead.
const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 8;
const NAME_ENGINES = cores <= 4 ? 1 : cores <= 6 ? 2 : 3;
const nameWorkerPromises: (Promise<TesseractWorker> | null)[] = Array(NAME_ENGINES).fill(null);
// The loaded engines, so a read can hand its picture to one in the same turn it was asked for. The page's worker runs
// a whole frame as one synchronous task; an `await` before the hand-over held every name read back until that frame was
// done (about 120 ms), although the engines run on threads of their own.
const nameWorkersReady: (TesseractWorker | null)[] = Array(NAME_ENGINES).fill(null);
/** The name crop is scaled so its text line is about this tall before OCR (it is ~25 px tall in a 1280 px frame). */
const NAME_PX = 64;

async function nodeOcrDir(): Promise<string> {
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'ocr');
}

/** Absolute URLs into public/ocr. A root-relative '/ocr/...' is invalid under file:// (packaged app), where it
 *  resolves to file:///ocr/; the built worker lives in dist/assets/, so the bundle is at ../ocr there. */
function browserOcrOpts() {
  const dir = import.meta.env?.DEV
    ? new URL('/ocr/', self.location.href).href
    : new URL('../ocr/', self.location.href).href;
  const base = dir.replace(/\/$/, '');
  return { workerPath: `${base}/worker.min.js`, corePath: base, langPath: base, gzip: true };
}

/** The first recognise on a fresh engine costs ~0.5 s (wasm memory, the first PNG encode); the real first read of a draft
 *  must not pay it. One pass over a blank line with a few strokes in it, so the pass reaches the recogniser. */
async function warmRead(worker: TesseractWorker): Promise<void> {
  try {
    const w = 160,
      h = 40;
    const data = new Uint8Array(w * h * 4).fill(255);
    for (let x = 14; x < 140; x += 9)
      for (let y = 12; y < 28; y++)
        for (let dx = 0; dx < 3; dx++) data.fill(0, (y * w + x + dx) * 4, (y * w + x + dx) * 4 + 3);
    const png = await upscaledPng(data, w, h, NAME_PX / 16);
    await worker.recognize(png as unknown as Buffer);
  } catch {
    // a failed warm-up is only a slower first read
  }
}

async function getNameWorker(slot = 0): Promise<TesseractWorker> {
  const k = slot % NAME_ENGINES;
  if (!nameWorkerPromises[k]) {
    nameWorkerPromises[k] = (async () => {
      const opts = isNode ? { langPath: await nodeOcrDir(), gzip: true } : browserOcrOpts();
      const worker = await createWorker('eng', 1 /* OEM.LSTM_ONLY */, opts);
      await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -'",
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
        user_defined_dpi: '300', // the PNG carries none; without it Tesseract guesses and warns on every read
      });
      await warmRead(worker);
      nameWorkersReady[k] = worker;
      return worker;
    })();
  }
  return nameWorkerPromises[k]!;
}

async function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const opts = isNode ? { langPath: await nodeOcrDir(), gzip: true } : browserOcrOpts();
      const worker = await createWorker('eng', 1 /* OEM.LSTM_ONLY */, opts);
      // The crop always shows just "N Re-Roll..."; a digit whitelist means the rest of the caption's
      // letters are simply not in Tesseract's output alphabet, so they don't need to be cropped out.
      await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: PSM.SINGLE_LINE });
      return worker;
    })();
  }
  return workerPromise;
}

/** A bilinear upscale of a black-on-white RGBA crop, written as an uncompressed 8-bit grey BMP. Tesseract reads BMP, and
 *  this takes a few milliseconds in plain JS where the canvas resample plus PNG encode took 130 to 230 ms per name line.
 *  The name crops are already thresholded to black on white, so grey from the red channel loses nothing. */
function upscaledBmp(data: Uint8Array, width: number, height: number, scale: number): Uint8Array {
  const outW = Math.round(width * scale),
    outH = Math.round(height * scale);
  const stride = (outW + 3) & ~3;
  const head = 54 + 1024;
  const out = new Uint8Array(head + stride * outH);
  const v = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(2, out.length, true);
  v.setUint32(10, head, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, outW, true);
  v.setInt32(22, outH, true); // positive: rows run bottom to top
  v.setUint16(26, 1, true);
  v.setUint16(28, 8, true);
  v.setUint32(34, stride * outH, true);
  v.setInt32(38, 11811, true); // 300 dpi
  v.setInt32(42, 11811, true);
  v.setUint32(46, 256, true);
  for (let i = 0; i < 256; i++) {
    const o = 54 + i * 4;
    out[o] = out[o + 1] = out[o + 2] = i;
  }
  const xs = new Int32Array(outW),
    xf = new Float32Array(outW);
  for (let x = 0; x < outW; x++) {
    const sx = Math.min(width - 1, Math.max(0, (x + 0.5) / scale - 0.5));
    xs[x] = Math.min(width - 2, Math.floor(sx));
    xf[x] = sx - xs[x]!;
  }
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const y0 = Math.min(height - 2, Math.floor(sy)),
      fy = sy - y0;
    const r0 = y0 * width * 4,
      r1 = r0 + width * 4;
    let o = head + (outH - 1 - y) * stride;
    for (let x = 0; x < outW; x++) {
      const i = xs[x]! * 4,
        fx = xf[x]!;
      const top = data[r0 + i]! * (1 - fx) + data[r0 + i + 4]! * fx;
      const bot = data[r1 + i]! * (1 - fx) + data[r1 + i + 4]! * fx;
      out[o++] = top * (1 - fy) + bot * fy + 0.5;
    }
  }
  return out;
}

/** The name lines go in through the fast BMP path; other callers (the re-roll digit at 8x) keep the canvas resample. */
/** Upscales the raw RGBA crop with smooth (Lanczos-equivalent) resampling and encodes it as PNG for
 *  Tesseract -- plain nearest-neighbor/binarized upscaling reads as empty text; smooth resampling is what
 *  actually let Tesseract read the real "1" in screenshots/brawl/reroll-choice*.png. */
async function upscaledPng(
  data: Uint8Array,
  width: number,
  height: number,
  scale = UPSCALE,
  fast = false,
): Promise<Uint8Array> {
  if (fast && scale >= 1 && width > 1 && height > 1) return upscaledBmp(data, width, height, scale);
  const outW = Math.round(width * scale),
    outH = Math.round(height * scale);
  if (typeof OffscreenCanvas !== 'undefined') {
    const src = new OffscreenCanvas(width, height);
    const sctx = src.getContext('2d');
    if (!sctx) throw new Error('OffscreenCanvas 2d context unavailable');
    sctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    const big = new OffscreenCanvas(outW, outH);
    const bctx = big.getContext('2d');
    if (!bctx) throw new Error('OffscreenCanvas 2d context unavailable');
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(src, 0, 0, outW, outH);
    const blob = await big.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }
  const sharp = (await import('sharp')).default;
  return sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })
    .resize({ width: outW, height: outH, kernel: 'lanczos3' })
    .png()
    .toBuffer();
}

/** Real OCR read of the "N Re-Roll Remaining" caption's digit -- not a stored pixel-shape template, an
 *  actual text recognition pass over the on-screen label. Returns 0 when the caption shows no glyph at all
 *  (no re-rolls left, or the caption is hidden), the parsed digit when OCR reads exactly one, or -1 when
 *  OCR can't confidently produce a single digit (so a bad read never gets silently reported as 0). */
/** Starts loading the OCR engine now, so the first real read does not stall the frames that follow it. */
export function warmOCR(): void {
  void getWorker().catch(() => {
    workerPromise = null;
  });
  for (let k = 0; k < NAME_ENGINES; k++)
    void getNameWorker(k).catch(() => {
      nameWorkerPromises[k] = null;
    });
}

/** A card's name line (cardNameCrop), already copied out of the frame: the worker reuses its frame buffer for the
 *  next frame while the OCR read is still running. */
export type NameCrop = NonNullable<ReturnType<typeof cardNameCrop>>;

/** OCR of a card's item name line; the raw text, '' when nothing reads. */
export function readCardName(crop: NameCrop, slot = 0): Promise<string> {
  const scale = Math.max(1, NAME_PX / crop.line);
  const ready = nameWorkersReady[slot % NAME_ENGINES];
  if (ready && crop.width > 1 && crop.height > 1) {
    // Everything up to the engine's own thread is synchronous here.
    const bmp = upscaledBmp(crop.data, crop.width, crop.height, scale);
    return ready.recognize(bmp as unknown as Buffer).then(({ data: { text } }) => text.trim());
  }
  return readCardNameSlow(crop, slot, scale);
}

async function readCardNameSlow(crop: NameCrop, slot: number, scale: number): Promise<string> {
  const png = await upscaledPng(crop.data, crop.width, crop.height, scale, true);
  const worker = await getNameWorker(slot);
  const {
    data: { text },
  } = await worker.recognize(png as unknown as Buffer);
  return text.trim();
}

/** OCR of the loading screen's big hero name (loadingNameRect crop); the raw text, '' when nothing reads. The name
 *  is capital letters about a fifth of the crop tall, scaled to the same text height as a card name. */
export async function readHeroName(crop: RGBImage): Promise<string> {
  const scale = Math.min(1, 160 / crop.height);
  const png = await upscaledPng(
    crop.data instanceof Uint8Array ? crop.data : new Uint8Array(crop.data),
    crop.width,
    crop.height,
    scale,
  );
  const worker = await getNameWorker();
  const {
    data: { text },
  } = await worker.recognize(png as unknown as Buffer);
  return text.trim();
}

export async function readRerollsRemaining(img: RGBImage): Promise<number> {
  const crop = extractRerollLabelCrop(img);
  if (!crop) return 0;
  const png = await upscaledPng(crop.data, crop.width, crop.height);
  const worker = await getWorker();
  // tesseract.js's types only accept Buffer here, but both its Node and browser loadImage() ultimately just
  // do `new Uint8Array(data)` on whatever's passed -- a plain Uint8Array works identically at runtime.
  const {
    data: { text },
  } = await worker.recognize(png as unknown as Buffer);
  // Street Brawl gives 0 or 1 re-roll (brawl-config: 1 per round), so only 0/1 are believable reads. Anything
  // else (a "0" read as a letter, a "1" read as 7) falls back to the glyph's shape: a thin upright bar is a 1,
  // any other glyph is a 0. Returning -1 here left the previous count standing, so a spent re-roll never showed.
  const digits = text.trim().match(/^[01]$/);
  if (digits) return Number(digits[0]);
  return rerollGlyphIsOne(img) ? 1 : 0;
}

/** Releases the OCR worker (and its wasm/model memory). Call on app/window teardown; a new call to
 *  readRerollsRemaining after this spins up a fresh worker on demand. */
export async function terminateOCR(): Promise<void> {
  const pending = [workerPromise, ...nameWorkerPromises];
  workerPromise = null;
  nameWorkerPromises.fill(null);
  nameWorkersReady.fill(null);
  for (const p of pending) {
    if (!p) continue;
    try {
      await (await p).terminate();
    } catch {
      /* it never finished loading, or is already gone */
    }
  }
}
