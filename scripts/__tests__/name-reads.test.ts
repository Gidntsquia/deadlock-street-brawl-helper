import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { matchHeroName, matchItemName, nameList } from '../../src/brawl/names';
import {
  prepareCaption,
  prepareHero,
  prepareName,
  readRerollsRemaining,
  type TextImage,
  type TextKind,
} from '../../src/brawl/ocr';
import { decodeIconIndex, loadingNameRect, type RGBImage } from '../../src/brawl/recognise';
import { cropsOf, DEMO_FRAMES, iconIds, itemName, loadFrame, LIVE_FRAMES } from '../lib/nameFrames';
import { installTextReader, nodeRead, readerMode, recordedRead, stopLiveReader } from '../lib/textReader';
import type { Hero, Item } from '../../src/types';

// Pins the name reader's raw text and the item/hero/count it resolves to on every fixed crop the app reads: the card name
// lines of the five demo frames at 1280/1920/2560, the loading screen's hero name, and the re-roll captions. The pins are
// the Windows OCR answers recorded in scripts/fixtures/ocr-recorded/ (BRAWL_OCR=record adds missing ones). With
// BRAWL_OCR=live (Windows or WSL through powershell.exe) every crop is read by the helper again and must give the
// recorded text. A crop with no recording is skipped with a message.
vi.setConfig({ testTimeout: 60_000 });
installTextReader();
afterAll(() => stopLiveReader());

const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
const heroes: Hero[] = JSON.parse(readFileSync('public/data/heroes.json', 'utf8'));
const idx = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
const list = nameList(idx.ids, Object.fromEntries(items.map((i) => [i.id, i.name])));
const NO_REC =
  'no recorded answer for this crop in scripts/fixtures/ocr-recorded/: run with BRAWL_OCR=record on Windows/WSL';

/** The recorded answer and, in live mode, the helper's fresh one: they must agree. */
async function pinned(img: TextImage, kind: TextKind, skip: (note: string) => void): Promise<string> {
  const rec = recordedRead(img, kind);
  if (!rec && readerMode() !== 'record') skip(NO_REC);
  const now = (await nodeRead(img, kind)).text;
  if (rec) expect(now, 'live read differs from the recording').toBe(rec.text);
  return now;
}

const SIZES = [1280, 1920, 2560] as const;
const labels = new Map<string, (string | null)[]>();
async function labelsOf(f: string) {
  if (!labels.has(f))
    labels.set(
      f,
      iconIds(await loadFrame(f)).map((id) => (id ? itemName(id) : null)),
    );
  return labels.get(f)!;
}

describe('card name lines', () => {
  const cases = DEMO_FRAMES.flatMap((f) => SIZES.map((w) => [f, w] as const));
  it.for(cases)('%s at %i px: every card resolves to the item its icon shows', async ([f, w], ctx) => {
    const lab = await labelsOf(f);
    const img = await loadFrame(f, [w, Math.round((w * 9) / 16)]);
    const got: (string | null)[] = [];
    for (const crop of cropsOf(img)) {
      const p = crop && prepareName(crop);
      if (!p) {
        got.push(null);
        continue;
      }
      const text = await pinned(p, 'name', (n) => ctx.skip(n));
      const m = matchItemName(text, list);
      got.push(m ? itemName(m.itemId) : null);
    }
    expect(got).toEqual(lab);
  });
  it.for(LIVE_FRAMES)('%s (live capture): every card resolves to its icon item', async (f, ctx) => {
    const lab = await labelsOf(f);
    const img = await loadFrame(f);
    const got: (string | null)[] = [];
    for (const crop of cropsOf(img)) {
      const text = await pinned(prepareName(crop!)!, 'name', (n) => ctx.skip(n));
      const m = matchItemName(text, list);
      got.push(m ? itemName(m.itemId) : null);
    }
    expect(got).toEqual(lab);
  });
});

describe('loading screen hero name', () => {
  it('reads INFERNUS and matches Infernus', async (ctx) => {
    const { data, info } = await sharp('scripts/fixtures/loading/infernus.png')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const r = loadingNameRect(info.width, info.height);
    const crop = Buffer.alloc(r.width * r.height * 3);
    for (let y = 0; y < r.height; y++)
      data.copy(
        crop,
        y * r.width * 3,
        ((r.y + y) * info.width + r.x) * 3,
        ((r.y + y) * info.width + r.x + r.width) * 3,
      );
    const img: RGBImage = { width: r.width, height: r.height, data: crop, channels: 3 };
    const text = await pinned(prepareHero(img), 'hero', (n) => ctx.skip(n));
    expect(text).toBe('INFERNUS');
    expect(
      matchHeroName(
        text,
        nameList(
          heroes.map((h) => h.id),
          Object.fromEntries(heroes.map((h) => [h.id, h.name])),
        ),
      )?.itemId,
    ).toBe(1);
  });
});

describe('re-roll caption', () => {
  // Windows OCR returns nothing on the caption's "N Re" crop of these frames; the count comes from the glyph shape
  // (rerollGlyphIsOne). Pinned so a reader change that starts reading a wrong digit shows up here.
  const CAPS: [string, number, number][] = [
    ['public/demo/choice1.png', 2000, 1],
    ['public/demo/choice2.png', 2000, 1],
    ['public/demo/draft-r1c2.png', 1920, 1],
    ['public/demo/draft-r2c1.png', 1920, 1],
    ['public/demo/draft-r2c3-reroll.png', 1920, 0],
    ['scripts/win/frames/live/draft-r1c2.png', 1920, 1],
    ['scripts/win/frames/live/draft-r2c1.png', 1920, 1],
  ];
  it.for(CAPS)('%s at %i px: %i re-roll left', async ([f, w, want], ctx) => {
    const { data } = await sharp(f)
      .resize(w, Math.round((w * 9) / 16), { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const img: RGBImage = { width: w, height: Math.round((w * 9) / 16), data, channels: 3 };
    const p = prepareCaption(img)!;
    expect(await pinned(p, 'caption', (n) => ctx.skip(n))).toBe('');
    expect(await readRerollsRemaining(img)).toBe(want);
  });
});
