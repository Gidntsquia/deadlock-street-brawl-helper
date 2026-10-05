import { createWorker, PSM, type Worker as TesseractWorker } from 'tesseract.js';
import { extractRerollLabelCrop, rerollGlyphIsOne, type cardNameCrop, type RGBImage } from './recognise';

// All assets (worker script, wasm core, eng.traineddata.gz) are bundled under public/ocr/ so this reads
// real digits via OCR without any network access at runtime -- required for an offline desktop app, and
// the same bundle serves both the browser/worker build and the Node fixtures/CLI build below.
const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';

// The label crop is only ~47x37px at reference resolution: Tesseract needs real size to read it (a tiny,
// unscaled crop reads as empty text with 0 confidence -- verified against screenshots/brawl/reroll-choice*.png).
const UPSCALE = 8;

// A second engine for the item names under the cards: the digit engine's whitelist and page mode are set once, and
// switching them per call would race the two kinds of read.
// One engine per card slot: the three name lines are read at the same time instead of queueing behind one engine,
// which is what held the first advice back on a slow PC. Slot 0 also serves the loading-screen hero name.
// On a 2 to 4 thread machine three engines (each a wasm model in memory) compete with the game: one engine reads the
// names one after another instead.
const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 8;
const NAME_ENGINES = cores <= 4 ? 1 : 2;
interface NameEngine {
  ready: Promise<TesseractWorker>;
  instance: TesseractWorker | null;
  disposed: boolean;
  queue: Promise<unknown>;
}
const nameEngines: (NameEngine | null)[] = Array(NAME_ENGINES).fill(null);
let nameGeneration = 0;
let nameCancellation = new AbortController();
export const CARD_NAME_OCR_TIMEOUT_MS = 10_000;
const disposeName = (engine: NameEngine) => {
  if (engine.disposed) return;
  engine.disposed = true;
  if (engine.instance) void engine.instance.terminate().catch(() => {});
};
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

function getNameEngine(slot = 0): NameEngine {
  const k = slot % NAME_ENGINES;
  if (!nameEngines[k]) {
    const engine: NameEngine = {
      ready: null as unknown as Promise<TesseractWorker>,
      instance: null,
      disposed: false,
      queue: Promise.resolve(),
    };
    nameEngines[k] = engine;
    engine.ready = (async () => {
      const opts = isNode ? { langPath: await nodeOcrDir(), gzip: true } : browserOcrOpts();
      const worker = await createWorker('eng', 1, opts);
      engine.instance = worker;
      if (engine.disposed) {
        void worker.terminate().catch(() => {});
        throw new Error('Name OCR stopped');
      }
      await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -'&",
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
        user_defined_dpi: '300',
      });
      if (engine.disposed) throw new Error('Name OCR stopped');
      return worker;
    })().catch((error) => {
      if (nameEngines[k] === engine) nameEngines[k] = null;
      disposeName(engine);
      throw error;
    });
  }
  void nameEngines[k]!.ready.catch(() => {});
  return nameEngines[k]!;
}

type OcrProfile = 'item-name' | 'hero-name' | 'digits' | 'caption';
function readName(
  png: () => Promise<Uint8Array>,
  slot = 0,
  profile: OcrProfile = 'item-name',
  current?: () => boolean,
): Promise<string> {
  const generation = nameGeneration;
  const signal = nameCancellation.signal;
  const k = slot % NAME_ENGINES;
  const engine = getNameEngine(slot);
  const assertCurrent = () => {
    if (generation !== nameGeneration || engine.disposed || (current && !current()))
      throw new Error('Name OCR stopped');
  };
  const operation = engine.queue
    .catch(() => {})
    .then(async () => {
      assertCurrent();
      const pixels = await png();
      assertCurrent();
      const worker = await engine.ready;
      assertCurrent();
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
        tessedit_char_whitelist:
          profile === 'digits' ? '0123456789' : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -'&",
      });
      assertCurrent();
      const result = await worker.recognize(pixels as unknown as Buffer);
      assertCurrent();
      return result.data.text.trim();
    });
  let timer: ReturnType<typeof setTimeout>;
  let onStop: () => void;
  const bounded = new Promise<string>((resolve, reject) => {
    onStop = () => reject(new Error('Name OCR stopped'));
    signal.addEventListener('abort', onStop, { once: true });
    timer = setTimeout(() => {
      reject(new Error('Name OCR timed out'));
      if (nameEngines[k] === engine) nameEngines[k] = null;
      disposeName(engine);
    }, CARD_NAME_OCR_TIMEOUT_MS);
    operation.then(resolve, reject);
  }).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onStop);
  });
  engine.queue = bounded.then(
    () => {},
    () => {},
  );
  return bounded;
}

/** Upscales the raw RGBA crop with smooth (Lanczos-equivalent) resampling and encodes it as PNG for
 *  Tesseract -- plain nearest-neighbor/binarized upscaling reads as empty text; smooth resampling is what
 *  actually let Tesseract read the real "1" in screenshots/brawl/reroll-choice*.png. */
async function upscaledPng(data: Uint8Array, width: number, height: number, scale = UPSCALE): Promise<Uint8Array> {
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
  for (let k = 0; k < NAME_ENGINES; k++) void getNameEngine(k).ready.catch(() => {});
}

/** A card's name line (cardNameCrop), already copied out of the frame: the worker reuses its frame buffer for the
 *  next frame while the OCR read is still running. */
export type NameCrop = NonNullable<ReturnType<typeof cardNameCrop>>;

/** OCR of a card's item name line; the raw text, '' when nothing reads. */
export async function readCardName(crop: NameCrop, slot = 0, current?: () => boolean): Promise<string> {
  const scale = Math.max(1, NAME_PX / crop.line);
  return readName(() => upscaledPng(crop.data, crop.width, crop.height, scale), slot, 'item-name', current);
}

/** OCR of the loading screen's big hero name (loadingNameRect crop); the raw text, '' when nothing reads. The name
 *  is capital letters about a fifth of the crop tall, scaled to the same text height as a card name. */
export async function readHeroName(crop: RGBImage): Promise<string> {
  const scale = Math.min(1, 160 / crop.height);
  // Loading reads own their pixels even if the caller reuses its transferred buffer.
  const pixels = new Uint8Array(crop.data).slice();
  return readName(() => upscaledPng(pixels, crop.width, crop.height, scale), 0, 'hero-name');
}

export async function readRerollsRemaining(img: RGBImage): Promise<number> {
  const crop = extractRerollLabelCrop(img);
  if (!crop) return 0;
  const text = await readName(() => upscaledPng(crop.data, crop.width, crop.height), 0, 'digits');
  // Street Brawl gives 0 or 1 re-roll (brawl-config: 1 per round), so only 0/1 are believable reads. Anything
  // else (a "0" read as a letter, a "1" read as 7) falls back to the glyph's shape: a thin upright bar is a 1,
  // other glyphs remain unread. The round-scoped reader retains a confirmed count across covered labels.
  const digits = text.trim().match(/^[01]$/);
  if (digits) return Number(digits[0]);
  return rerollGlyphIsOne(img) ? 1 : -1;
}

/** Releases the OCR worker (and its wasm/model memory). Call on app/window teardown; a new call to
 *  readRerollsRemaining after this spins up a fresh worker on demand. */
export async function terminateOCR(): Promise<void> {
  nameGeneration++;
  nameCancellation.abort();
  nameCancellation = new AbortController();
  for (const engine of nameEngines) if (engine) disposeName(engine);
  nameEngines.fill(null);
}

/** Shared primary executor: profile changes and recognize are serialized atomically per engine. */
export async function readHudText(
  crop: { data: Uint8Array; width: number; height: number; scale?: number },
  profile: 'digits' | 'caption',
  current?: () => boolean,
) {
  const pixels = crop.data.slice();
  const text = await readName(
    () => upscaledPng(pixels, crop.width, crop.height, crop.scale ?? Math.max(1, 64 / crop.height)),
    0,
    profile,
    current,
  );
  return { text, confidence: NaN };
}
