import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { readRerollsRemaining } from '../../src/brawl/ocr';
import {
  decodeIconIndex,
  extractRerollLabelCrop,
  findRerollButton,
  REROLL_SEARCH,
  readDraftScreen,
  readRoundChoice,
  type RGBImage,
} from '../../src/brawl';

// The Test-mode screenshots (public/demo) as the dummy window shows them: stretched to 1920x1080.
const load = async (name: string): Promise<RGBImage> => {
  const { data } = await sharp(`public/demo/${name}.png`)
    .resize(1920, 1080, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: 1920, height: 1080, data, channels: 3 };
};

describe('Test-mode draft screenshots', () => {
  it('read the frame own round and choice, and the re-roll caption', async () => {
    const want = { 'draft-r1c2': [1, 2, true], 'draft-r2c1': [2, 1, true], 'draft-r2c3-reroll': [2, 3, true] } as const;
    for (const [name, [round, choice, caption]] of Object.entries(want)) {
      const img = await load(name);
      expect(readRoundChoice(img), name).toEqual({ round, choice });
      expect(!!extractRerollLabelCrop(img), name).toBe(caption);
    }
  }, 20_000);

  it('reads Spirit Lifesteal as ENHANCED on draft-r1c2', async () => {
    const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
    const reads = readDraftScreen(await load('draft-r1c2'), index, () => 0);
    expect(reads.map((r) => r.enhanced)).toEqual([false, false, true]);
  }, 20_000);
});

// What the app really receives: the dummy window's frames as captured (region-only, black elsewhere) in the live
// Electron run -- softer and dimmer than a sharp-resized PNG, which is why the tests above passed while the app failed.
describe('Test-mode frames as the app captures them', () => {
  const loadLive = async (name: string): Promise<RGBImage> => {
    const { data } = await sharp(`scripts/win/frames/live/${name}.png`)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { width: 1920, height: 1080, data: new Uint8ClampedArray(data), channels: 4 };
  };
  it('r1c2: Spirit Lifesteal ENHANCED, round 1, one re-roll', async () => {
    const img = await loadLive('draft-r1c2');
    const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
    expect(readDraftScreen(img, index, () => 0).map((r) => r.enhanced)).toEqual([false, false, true]);
    expect(readRoundChoice(img)).toEqual({ round: 1, choice: 2 });
    expect(await readRerollsRemaining(img)).toBe(1);
  }, 30_000);
  it('r2c1: round 2 and one re-roll (OCR cannot read this "1"; the shape fallback does)', async () => {
    const img = await loadLive('draft-r2c1');
    expect(readRoundChoice(img)).toEqual({ round: 2, choice: 1 });
    expect(await readRerollsRemaining(img)).toBe(1);
  }, 30_000);
});

describe('re-roll button outline', () => {
  it('is found on the frame itself (r2c1 sits lower than the nominal rect)', async () => {
    const want = { 'draft-r2c1': [930, 1021], 'draft-r1c2': [917, 1009] } as const;
    for (const [name, [y0, y1]] of Object.entries(want)) {
      const img = await load(name);
      const s = 0.75;
      const x = Math.round(REROLL_SEARCH.x0 * s),
        y = Math.round(REROLL_SEARCH.y0 * s),
        w = Math.round((REROLL_SEARCH.x1 - REROLL_SEARCH.x0) * s),
        h = Math.round((REROLL_SEARCH.y1 - REROLL_SEARCH.y0) * s);
      const rgba = new Uint8Array(w * h * 4);
      for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++)
          for (let c = 0; c < 3; c++) rgba[(j * w + i) * 4 + c] = img.data[((y + j) * 1920 + x + i) * 3 + c]!;
      const r = findRerollButton(rgba, w, h, x, y, 1920)!;
      expect(r, name).not.toBeNull();
      expect(Math.abs(r.y0 / s - y0), name).toBeLessThan(4);
      expect(Math.abs(r.y1 / s - y1), name).toBeLessThan(4);
      expect(Math.abs(r.x0 / s - 1139), name).toBeLessThan(4);
      expect(Math.abs(r.x1 / s - 1424), name).toBeLessThan(4);
    }
  });
});
