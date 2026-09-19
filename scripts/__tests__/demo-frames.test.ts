import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  decodeIconIndex,
  extractRerollLabelCrop,
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
