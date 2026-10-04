// The player's own hero (the square-topped portrait) on every saved draft screen. s18 is a real 2560x1440 frame
// with the player in slot 3, whose tile leaked weak scores into both neighbours and was once rejected as the
// "round starting" banner (where every slot is a tile), so the app never switched to the player's hero.
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { decodeIconIndex, readDraftMeta } from '../../src/brawl';

vi.setConfig({ testTimeout: 20_000 });

const DIR = 'scripts/fixtures/brawl-screens';
const labels: Record<string, { self?: number }> = JSON.parse(readFileSync(`${DIR}/labels.json`, 'utf8'));
const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
const withSelf = Object.entries(labels).filter(([, l]) => l.self);

describe('own hero on saved draft screens', () => {
  it('has the real slot-3 frame', () => expect(labels.s18?.self).toBeTruthy());
  it.each(withSelf)('%s', async (name, l) => {
    const { data, info } = await sharp(`${DIR}/${name}.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const meta = readDraftMeta({ width: info.width, height: info.height, data, channels: 3 }, index, undefined, true);
    expect(meta.self).toBe(l.self);
  });
});
