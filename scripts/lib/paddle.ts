// PaddleOCR PP-OCRv5 English recognition, text-line only: a crop goes in, a string comes out. The ONNX session is
// supplied by the caller (onnxruntime-web in a worker, onnxruntime-node in main or scripts), so this file holds only the
// pre- and post-processing, which are the same for both.
export interface RecInput {
  data: Uint8Array;
  width: number;
  height: number;
  /** 4 for RGBA crops (the app's), 3 for RGB */
  channels?: 3 | 4;
}

export const REC_H = 48;
export const REC_MAX_W = 640;

/** Planar float32 [3, 48, w] scaled to (x/255 - 0.5)/0.5, the line resized (bilinear) to the model height. */
export function recTensor(img: RecInput): { data: Float32Array; width: number } {
  const ch = img.channels ?? 4;
  const w = Math.max(16, Math.min(REC_MAX_W, Math.ceil((img.width * REC_H) / img.height / 4) * 4));
  const out = new Float32Array(3 * REC_H * w);
  const sx = img.width / w,
    sy = img.height / REC_H;
  const plane = REC_H * w;
  for (let y = 0; y < REC_H; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.min(img.height - 2, Math.floor(fy)),
      ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.min(img.width - 2, Math.floor(fx)),
        tx = fx - x0;
      const i00 = (y0 * img.width + x0) * ch,
        i10 = i00 + ch,
        i01 = i00 + img.width * ch,
        i11 = i01 + ch;
      for (let c = 0; c < 3; c++) {
        const top = img.data[i00 + c]! * (1 - tx) + img.data[i10 + c]! * tx;
        const bot = img.data[i01 + c]! * (1 - tx) + img.data[i11 + c]! * tx;
        out[c * plane + y * w + x] = ((top * (1 - ty) + bot * ty) / 255 - 0.5) / 0.5;
      }
    }
  }
  return { data: out, width: w };
}

/** CTC greedy decode: index 0 is blank, 1..n the dictionary, n+1 the space. Score is the mean probability of kept steps. */
export function ctcDecode(
  logits: Float32Array,
  steps: number,
  classes: number,
  dict: string[],
): { text: string; score: number } {
  let text = '',
    sum = 0,
    n = 0,
    last = -1;
  for (let t = 0; t < steps; t++) {
    let best = 0,
      bv = -Infinity;
    for (let c = 0; c < classes; c++) {
      const v = logits[t * classes + c]!;
      if (v > bv) {
        bv = v;
        best = c;
      }
    }
    if (best !== 0 && best !== last) {
      text += best <= dict.length ? dict[best - 1]! : ' ';
      sum += bv;
      n++;
    }
    last = best;
  }
  return { text, score: n ? sum / n : 0 };
}

export const parseDict = (txt: string): string[] => txt.split('\n').filter((l) => l.length > 0);

/** The crop cut to its dark ink (the name crops are black on white with a wide white margin; the model reads a tight
 *  line far better than one with big empty sides) plus `pad` white px, as a new RGBA image. */
export function trimInk(img: RecInput, pad = 6): RecInput {
  const ch = img.channels ?? 4;
  let x0 = img.width,
    x1 = -1,
    y0 = img.height,
    y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * ch]! < 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return img;
  const w = x1 - x0 + 1 + 2 * pad,
    h = y1 - y0 + 1 + 2 * pad;
  const out = new Uint8Array(w * h * 4).fill(255);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const s = (y * img.width + x) * ch,
        d = ((y - y0 + pad) * w + x - x0 + pad) * 4;
      out[d] = img.data[s]!;
      out[d + 1] = img.data[s + 1]!;
      out[d + 2] = img.data[s + 2]!;
    }
  return { data: out, width: w, height: h, channels: 4 };
}
