import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { probeShopScreen, type GrabRegion } from '../shopProbe';

/** A fake screen: `file` scaled to 1920x1080 and placed at (100, 50), served as BGRA the way GDI returns it. */
async function screenWith(file: string) {
  const { data, info } = await sharp(file).resize(1920, 1080).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const game = { x: 100, y: 50, width: info.width, height: info.height };
  const grab: GrabRegion = (x, y, w, h) => {
    const out = new Uint8Array(w * h * 4);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const s = ((y - game.y + j) * info.width + (x - game.x + i)) * 4;
        const d = (j * w + i) * 4;
        out[d] = data[s + 2]!; // B
        out[d + 1] = data[s + 1]!;
        out[d + 2] = data[s]!; // R
        out[d + 3] = 255;
      }
    return out;
  };
  return { game, grab };
}

describe('probeShopScreen', () => {
  it('sees the draft screen from just the CHOICE glyph region, wherever the window sits on screen', async () => {
    for (const f of ['public/demo/choice1.png', 'public/demo/choice2.png']) {
      const { game, grab } = await screenWith(f);
      expect(probeShopScreen(game, grab)).toBe(true);
    }
  });

  it('does not fire on gameplay', async () => {
    const { game, grab } = await screenWith('public/demo/gameplay.png');
    expect(probeShopScreen(game, grab)).toBe(false);
  });

  it('reads only a small region and is false when the grab fails', async () => {
    const { game, grab } = await screenWith('public/demo/choice1.png');
    let px = 0;
    probeShopScreen(game, (x, y, w, h) => {
      px = w * h;
      return grab(x, y, w, h);
    });
    expect(px).toBeGreaterThan(0);
    expect(px / (game.width * game.height)).toBeLessThan(0.01);
    expect(probeShopScreen(game, () => null)).toBe(false);
  });
});
