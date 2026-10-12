// Fingerprint of a card's name line (cardNameCrop output, black text on white): ink share in a coarse grid over the
// text area. Pure; shared by the worker and scripts/last-card.ts so both use one ink test.
import type { NameCrop } from './ocr';

const SIG_COLS = 32,
  SIG_ROWS = 4,
  CROP_PAD = 12; // cardNameCrop's white margin
export const nameSig = (c: NameCrop): Uint8Array => {
  const out = new Uint8Array(SIG_COLS * SIG_ROWS);
  const w = c.width - 2 * CROP_PAD,
    h = c.height - 2 * CROP_PAD;
  const counts = new Uint32Array(out.length),
    totals = new Uint32Array(out.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k =
        Math.min(SIG_ROWS - 1, Math.floor((y * SIG_ROWS) / h)) * SIG_COLS +
        Math.min(SIG_COLS - 1, Math.floor((x * SIG_COLS) / w));
      totals[k]++;
      if (c.data[((y + CROP_PAD) * c.width + x + CROP_PAD) * 4] === 0) counts[k]++;
    }
  for (let k = 0; k < out.length; k++) out[k] = totals[k] ? Math.round((255 * counts[k]!) / totals[k]!) : 0;
  return out;
};
/** A line with almost no ink shows no name (hidden, or the screen is mid-swap): nothing to read. */
export const hasInk = (s: Uint8Array) => s.reduce((n, v) => n + v, 0) > 255 * 2;
