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
  // The OBS recording (1280x720): the player is Infernus in every match, in a square tile at left slot 1 or 4. Rat King's
  // ears and a teammate's teal highlight once read as the tile, so the advice used an enemy's hero (Burst Fire set, s7).
  const stretches = Array.from({ length: 10 }, (_, i) => `s${i}`);
  it.each(stretches)('video-truth %s: own hero is Infernus or unread, never another hero', async (st) => {
    const dir = `scripts/fixtures/video-truth/${st}`;
    const frames: { regions: { x: number; y: number; width: number; height: number; file: string }[] }[] = JSON.parse(
      readFileSync(`${dir}/frames.json`, 'utf8'),
    );
    const seen = new Set<number>();
    for (const f of frames.filter((_, i) => i % 8 === 0)) {
      const bar = f.regions.find((r) => r.y === 0 && r.width > 400);
      if (!bar) continue;
      const W = 1280,
        H = 720;
      const data = new Uint8Array(W * H * 3);
      const { data: px, info } = await sharp(`${dir}/${bar.file}`)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      for (let y = 0; y < info.height; y++)
        data.set(px.subarray(y * info.width * 3, (y + 1) * info.width * 3), ((bar.y + y) * W + bar.x) * 3);
      seen.add(readDraftMeta({ width: W, height: H, data, channels: 3 }, index, undefined, true).self);
    }
    expect([...seen].filter((h) => h !== 0 && h !== 1)).toEqual([]);
    expect(seen.has(1)).toBe(true);
  });
  it.each(withSelf)('%s', async (name, l) => {
    const { data, info } = await sharp(`${DIR}/${name}.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const meta = readDraftMeta({ width: info.width, height: info.height, data, channels: 3 }, index, undefined, true);
    expect(meta.self).toBe(l.self);
  });
});
