// The old Tesseract name read (src/brawl/ocr.ts before the Windows OCR reader), kept only for
// `npm run names:compare -- --engine tesseract`. tesseract.js is no longer a dependency: install it for the run with
// `npm i --no-save tesseract.js@7` (it fetches its English model on first use), then remove it again.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NameCrop } from './nameFrames';

/** The name crop is scaled so its text line is about this tall before OCR (as the app did). */
const NAME_PX = 64;

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

export interface TesseractNameReader {
  read(crop: NameCrop): Promise<string>;
  close(): Promise<void>;
}

export async function tesseractNameReader(): Promise<TesseractNameReader> {
  const mod = 'tesseract.js';
  let t: any;
  try {
    t = await import(/* @vite-ignore */ mod);
  } catch {
    throw new Error('tesseract.js is not installed: run `npm i --no-save tesseract.js@7` for this comparison');
  }
  // the app's own bundled model while it existed (public/ocr), else tesseract.js fetches the same English model
  const local = existsSync('public/ocr/eng.traineddata.gz');
  const worker = await t.createWorker('eng', 1, local ? { langPath: resolve('public/ocr'), gzip: true } : {});
  await worker.setParameters({
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -'",
    tessedit_pageseg_mode: t.PSM.SINGLE_LINE,
    user_defined_dpi: '300',
  });
  return {
    async read(crop) {
      const bmp = upscaledBmp(crop.data, crop.width, crop.height, Math.max(1, NAME_PX / crop.line));
      const r = await worker.recognize(Buffer.from(bmp));
      return String(r.data.text).trim();
    },
    close: () => worker.terminate(),
  };
}
