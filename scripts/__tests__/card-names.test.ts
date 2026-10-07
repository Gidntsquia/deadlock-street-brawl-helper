import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { matchItemName, nameList } from '../../src/brawl/names';
import { readCardName, terminateOCR } from '../../src/brawl/ocr';
import { cardNameCrop, cardSquares, decodeIconIndex, draftRegions, readDraftScreen } from '../../src/brawl/recognise';
import type { Item } from '../../src/types';

// Real OCR (the bundled Tesseract) of the item name printed under each card, on every tracked draft frame, with every
// pixel outside draftRegions blacked out as in the worker: the name must name the same item the icon search finds
// (those icon reads are pinned in frame-reads.test.ts).
vi.setConfig({ testTimeout: 60_000 });
afterAll(() => terminateOCR());

const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
const list = nameList(index.ids, Object.fromEntries(items.map((i) => [i.id, i.name])));
const tierOf = (id: number) => items.find((i) => i.id === id)?.item_tier ?? 0;

describe('card name OCR', () => {
  it.each([
    'public/demo/choice1.png',
    'public/demo/choice2.png',
    'public/demo/draft-r1c2.png',
    'public/demo/draft-r2c1.png',
    'public/demo/draft-r2c3-reroll.png',
    'scripts/win/frames/live/draft-r1c2.png',
    'scripts/win/frames/live/draft-r2c1.png',
  ])('%s: each card name names the item its icon shows', async (file) => {
    const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const kept = Buffer.alloc(data.length);
    for (const r of draftRegions(info.width, info.height))
      for (let y = r.y; y < r.y + r.height; y++)
        data.copy(kept, (y * info.width + r.x) * 3, (y * info.width + r.x) * 3, (y * info.width + r.x + r.width) * 3);
    const img = { width: info.width, height: info.height, data: kept, channels: 3 as const };
    const reads = readDraftScreen(img, index, tierOf);
    expect(reads.filter((r) => r.present)).toHaveLength(3);
    for (const r of reads) {
      const crop = cardNameCrop(img, { ...r.match, ...cardSquares(info.width, info.height)[reads.indexOf(r)]! })!;
      const text = await readCardName(crop);
      expect({ text, id: matchItemName(text, list)?.itemId }).toEqual({ text, id: r.itemId });
    }
  });
});

describe('the draft name list', () => {
  it('matches every item name in it exactly, including one the index holds under two ids', () => {
    // Silencer has a disabled twin among the index's extras: a tie used to make an exact "Silencer" match nothing.
    expect(matchItemName('Silencer', list)?.itemId).toBe(1113837674);
    for (const { id } of list) expect(matchItemName(items.find((i) => i.id === id)!.name, list)?.itemId).toBe(id);
  });
});
