import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { probeRound } from '../../electron/shopProbe';

// The round banner probe reads the ROUND digit at the top centre through the same kind of screen grab as the CHOICE
// probe. `grabFrom` serves a frame the way grabScreenRegion would (BGRA bytes of one rectangle).
async function grabFrom(file: string, w: number) {
  const h = Math.round((w * 9) / 16);
  const { data } = await sharp(file)
    .resize(w, h, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    game: { x: 0, y: 0, width: w, height: h },
    grab: (x: number, y: number, rw: number, rh: number) => {
      const out = new Uint8Array(rw * rh * 4);
      for (let j = 0; j < rh; j++)
        for (let i = 0; i < rw; i++) {
          const p = ((y + j) * w + x + i) * 4,
            q = (j * rw + i) * 4;
          out[q] = data[p + 2]!;
          out[q + 1] = data[p + 1]!;
          out[q + 2] = data[p]!;
          out[q + 3] = 255;
        }
      return out;
    },
  };
}

describe('round banner probe', () => {
  it.each([1600, 1920, 2560])('reads ROUND 1 on the pre-draft frame at %i px wide', async (w) => {
    const { game, grab } = await grabFrom('scripts/fixtures/round-banner/round1-banner.png', w);
    expect(probeRound(game, grab)).toBe(1);
  });
  it('reads the round of a draft frame and nothing on the in-round frame', async () => {
    const draft = await grabFrom('public/demo/draft-r2c1.png', 1920);
    expect(probeRound(draft.game, draft.grab)).toBe(2);
    const play = await grabFrom('public/demo/gameplay.png', 1920);
    expect(probeRound(play.game, play.grab)).toBe(0);
  });
});
