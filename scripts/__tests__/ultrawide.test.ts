import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  cardNameCrop,
  cardSquares,
  decodeIconIndex,
  draftRegions,
  extractRerollLabelCrop,
  findRerollButton,
  inventorySig,
  isShopScreen,
  readDraftMeta,
  readDraftScreen,
  readInventory,
  readRoundChoice,
  readRoundDigit,
  rerollGlyphIsOne,
  roundProbeRect,
  REROLL_SEARCH,
  shopProbeRect,
  type RGBImage,
  type Region,
} from '../../src/brawl/recognise';
import { hudLayout } from '../../src/brawl/hudLayout';

vi.setConfig({ testTimeout: 40_000 });
const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));

const load = async (file: string, width: number, height: number): Promise<RGBImage> => {
  const data = await sharp(file).resize(width, height).ensureAlpha().raw().toBuffer();
  return { width, height, data, channels: 4 };
};

/** Extend a real 16:9 frame at both sides without changing any HUD pixels. No generated fixture is stored. */
const pad = (img: RGBImage, width: number): RGBImage => {
  const data = new Uint8Array(width * img.height * 4);
  const left = (width - img.width) / 2;
  for (let y = 0; y < img.height; y++)
    data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), (y * width + left) * 4);
  return { ...img, width, data };
};

const crop = (img: RGBImage, r: Region): RGBImage => {
  const data = new Uint8Array(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++)
    data.set(
      img.data.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.width) * 4),
      y * r.width * 4,
    );
  return { ...r, data, channels: 4, origin: { ...r, fullWidth: img.width, fullHeight: img.height } };
};

const mask = (img: RGBImage): RGBImage => {
  const data = new Uint8Array(img.data.length);
  for (const r of draftRegions(img.width, img.height))
    for (let y = r.y; y < r.y + r.height; y++) {
      const start = (y * img.width + r.x) * 4;
      data.set(img.data.subarray(start, start + r.width * 4), start);
    }
  return { ...img, data };
};

const contents = (img: RGBImage) => {
  const reads = readDraftScreen(img, index, () => 0);
  return {
    cards: reads.map(({ itemId, present, enhanced, rare }) => ({ itemId, present, enhanced, rare })),
    meta: readDraftMeta(img, index),
    names: cardSquares(img.width, img.height).map((sq) => cardNameCrop(img, { ...sq, itemId: 0, score: 0, margin: 0 })),
    caption: extractRerollLabelCrop(img),
    one: rerollGlyphIsOne(img),
    inventory: readInventory(img, index),
    inventorySig: inventorySig(img),
  };
};

describe('the 0.2.0 ultrawide coordinate fix', () => {
  it.each([
    [2000, 1125, 2688],
    [2560, 1440, 3440],
  ])('preserves all reads and OCR crops at %ix%i extended to %i', async (w, h, wideW) => {
    const img = await load('public/demo/choice1.png', w, h);
    const wide = pad(img, wideW);
    const original = contents(img);
    expect(original.cards.map((c) => c.itemId)).toEqual([1548066885, 2829638276, 3633614685]);
    expect(original.meta.round).toBe(1);
    expect(original.meta.choice).toBe(1);
    expect(contents(wide)).toEqual(original);
    // The page sends only draftRegions, rather than the full image, to both portrait and draft readers.
    expect(contents(mask(wide))).toEqual(original);
  });

  it.each([
    [1920, 1080, 2560],
    [2560, 1440, 3440],
  ])('finds the idle and round probes at %ix%i extended to %i', async (w, h, wideW) => {
    const img = pad(await load('public/demo/choice1.png', w, h), wideW);
    expect(isShopScreen(img)).toBe(true);
    expect(isShopScreen(crop(img, shopProbeRect(wideW, h)))).toBe(true);
    expect(readRoundChoice(img)).toEqual({ round: 1, choice: 1 });
    expect(readRoundDigit(crop(img, roundProbeRect(wideW, h)))).toBe(1);
    const gameplay = pad(await load('public/demo/gameplay.png', w, h), wideW);
    expect(isShopScreen(gameplay)).toBe(false);
    expect(isShopScreen(crop(gameplay, shopProbeRect(wideW, h)))).toBe(false);
  });

  it('keeps the detected re-roll outline on the same button at 3440x1440', async () => {
    const img = await load('public/demo/choice1.png', 2560, 1440);
    const find = (frame: RGBImage) => {
      const { sx, sy, offsetX } = hudLayout(frame.width, frame.height);
      const r = {
        x: Math.round(offsetX + REROLL_SEARCH.x0 * sx),
        y: Math.round(REROLL_SEARCH.y0 * sy),
        width: Math.round((REROLL_SEARCH.x1 - REROLL_SEARCH.x0) * sx),
        height: Math.round((REROLL_SEARCH.y1 - REROLL_SEARCH.y0) * sy),
      };
      return findRerollButton(crop(frame, r).data, r.width, r.height, r.x, r.y, frame.width, frame.height);
    };
    const rect = find(img);
    expect(rect).not.toBeNull();
    expect(find(pad(img, 3440))).toEqual({ ...rect, x0: rect!.x0 + 440, x1: rect!.x1 + 440 });
  });

  it('retains independent scaling for the slightly stretched 16:9 captures accepted by 0.2.0', async () => {
    const img = await load('public/demo/choice1.png', 2000, 1125);
    const stretched = await load('public/demo/choice1.png', 2040, 1125);
    expect(isShopScreen(stretched)).toBe(true);
    expect(readRoundChoice(stretched)).toEqual(readRoundChoice(img));
    expect(cardSquares(2040, 1125)[1]!.x + cardSquares(2040, 1125)[1]!.edge / 2).toBe(1020);
  });
});
