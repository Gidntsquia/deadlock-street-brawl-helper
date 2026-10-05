import { readdirSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { loadingNameRect, looksLikeLoadingName } from '../../src/brawl/recognise';

async function nameBox(file: string) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const r = loadingNameRect(info.width, info.height);
  const out = Buffer.alloc(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++)
    data.copy(out, y * r.width * 4, ((r.y + y) * info.width + r.x) * 4, ((r.y + y) * info.width + r.x + r.width) * 4);
  return { width: r.width, height: r.height, data: out, channels: 4 as const };
}

describe('loading screen name box', () => {
  it('is recognised on the Joining the fight as frame', async () => {
    expect(looksLikeLoadingName(await nameBox('scripts/fixtures/loading/infernus.png'))).toBe(true);
  });
  it.each(readdirSync('public/demo').filter((f) => f.endsWith('.png')))('not on %s', async (f) => {
    expect(looksLikeLoadingName(await nameBox(`public/demo/${f}`))).toBe(false);
  });
});

describe('loading screen hero name', () => {
  it('reads Infernus', async () => {
    const { readHeroName, terminateOCR } = await import('../../src/brawl/ocr');
    const { matchItemName, nameList } = await import('../../src/brawl/names');
    const heroes = JSON.parse((await import('node:fs')).readFileSync('public/data/heroes.json', 'utf8')) as {
      id: number;
      name: string;
    }[];
    const names = Object.fromEntries(heroes.map((h) => [h.id, h.name]));
    const text = await readHeroName(await nameBox('scripts/fixtures/loading/infernus.png'));
    await terminateOCR();
    expect(
      matchItemName(
        text,
        nameList(
          heroes.map((h) => h.id),
          names,
        ),
      )?.itemId,
    ).toBe(1);
  }, 60_000);
});
