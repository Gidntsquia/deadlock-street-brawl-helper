import { describe, it, expect, vi } from 'vitest';
import { DraftCardRecognition } from '../draftCardRecognition';
import { cardAnchors } from '../../brawl/recognise';
import type { DecodedIndex, RGBImage, CardRead } from '../../brawl/recognise';
import { cardNameRegions } from '../cardNames';
const names = { 1: 'Tankbuster', 2: 'Superior Duration', 3: 'Kevlar' };
const image = () => {
  const img: RGBImage = { width: 2560, height: 1440, channels: 4, data: new Uint8ClampedArray(2560 * 1440 * 4) };
  for (const region of cardNameRegions(img.width, img.height, cardAnchors(img.width, img.height)))
    img.data.set([220, 220, 220, 255], (region.y * img.width + region.x) * 4);
  return img;
};
const visual = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
const index = {} as DecodedIndex;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const invoke = (reader: DraftCardRecognition, img = image(), candidate = 'capture1:offer1') =>
  reader.read(img, index, names, {}, candidate, visual);
const textImage = () => {
  const img = image();
  for (const region of cardNameRegions(img.width, img.height, cardAnchors(img.width, img.height)))
    for (let y = 20; y < 40; y++)
      for (let x = 200; x < 210; x++)
        if (x < 203 || y < 23 || y >= 37)
          img.data.set([220, 220, 220, 255], ((region.y + y) * img.width + region.x + x) * 4);
  return img;
};
const wordBounds = (crop: import('../../brawl/ocr').NameCrop, text: string) => {
  let x0 = crop.width,
    y0 = crop.height,
    x1 = 0,
    y1 = 0;
  for (let y = 0; y < crop.height; y++)
    for (let x = 0; x < crop.width; x++)
      if (crop.data[(y * crop.width + x) * 4] === 0) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
  crop.onWords?.([{ text, bbox: { x0, y0, x1, y1 } }], 1, 1);
};
describe('upstream OCR is the live primary', () => {
  it.each(['7', 'A'])('excludes corrected OCR insertion %s from the matched name geometry', async (noise) => {
    const primary = vi.fn(async (crop: import('../../brawl/ocr').NameCrop, slot = 0) => {
      const capture = crop.onWords;
      crop.onWords = (words, sx, sy) => {
        const b = words[0]!.bbox;
        capture?.(
          [...words, { text: noise, bbox: { x0: b.x0 - 150, x1: b.x0 - 142, y0: b.y0 - 20, y1: b.y0 - 12 } }],
          sx,
          sy,
        );
      };
      wordBounds(crop, Object.values(names)[slot]!);
      return `${Object.values(names)[slot]} ${noise}`;
    });
    const reader = new DraftCardRecognition(primary, vi.fn(), vi.fn());
    const original = textImage();
    invoke(reader, original);
    await flush();
    const moving = { ...original, data: original.data.slice() };
    for (const r of cardNameRegions(original.width, original.height, cardAnchors(original.width, original.height)))
      for (let y = 0; y < 8; y++)
        for (let x = 50; x < 58; x++) moving.data.set([230, 230, 230, 255], ((r.y + y) * moving.width + r.x + x) * 4);
    expect(invoke(reader, moving).reads.map((r) => r.itemId)).toEqual([1, 2, 3]);
    expect(primary).toHaveBeenCalledTimes(3);
  });
  it('finishes an obsolete soft-source read but never publishes it after the actual name changed', async () => {
    const finish: ((text: string) => void)[] = [];
    const primary = vi.fn((crop: import('../../brawl/ocr').NameCrop, slot = 0) => {
      wordBounds(crop, Object.values(names)[slot]!);
      return new Promise<string>((resolve) => finish.push(resolve));
    });
    const reader = new DraftCardRecognition(primary, vi.fn(), vi.fn());
    const original = textImage();
    invoke(reader, original);
    const changed = { ...original, data: original.data.slice() };
    const r = cardNameRegions(original.width, original.height, cardAnchors(original.width, original.height))[0]!;
    for (let y = 23; y < 37; y++)
      for (let x = 200; x < 203; x++) changed.data.set([0, 0, 0, 255], ((r.y + y) * changed.width + r.x + x) * 4);
    invoke(reader, changed);
    finish.forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
    expect(invoke(reader, changed).reads.map((read) => read.itemId)).toEqual([0, 2, 3]);
    expect(primary).toHaveBeenCalledTimes(4);
    finish[3]?.('Superior Duration');
    await flush();
  });
  it('uses successful local fallback geometry and caches it through moving bright backgrounds', async () => {
    const primary = vi.fn(async (crop: import('../../brawl/ocr').NameCrop) => {
      crop.onWords?.([{ text: 'partial', bbox: { x0: 12, y0: 12, x1: 20, y1: 20 } }], 1, 1);
      return 'partial';
    });
    let slot = 0;
    const fallback = vi.fn(async (crop: import('../cardNameOcr').ItemNameOcrCrop) => {
      const text = Object.values(names)[slot++ % 3]!;
      crop.onWords?.([{ text, bbox: { x0: 208, y0: 28, x1: 218, y1: 48 } }], 1, 1);
      return { text, confidence: 0 };
    });
    const reader = new DraftCardRecognition(primary, fallback, vi.fn());
    const original = textImage();
    invoke(reader, original);
    await flush();
    expect(invoke(reader, original).reads.map((r) => r.itemId)).toEqual([1, 2, 3]);
    const regions = cardNameRegions(original.width, original.height, cardAnchors(original.width, original.height));
    for (let frame = 1; frame <= 12; frame++) {
      const moving = { ...original, data: original.data.slice() };
      for (const r of regions)
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++)
            moving.data.set([230, 230, 230, 255], ((r.y + y) * moving.width + r.x + 20 + frame * 11 + x) * 4);
      expect(invoke(reader, moving).complete).toBe(true);
    }
    expect(primary).toHaveBeenCalledTimes(3);
    expect(fallback).toHaveBeenCalledTimes(3);
    const changed = { ...original, data: original.data.slice() };
    for (let y = 23; y < 37; y++)
      changed.data.set([220, 220, 220, 255], ((regions[0]!.y + y) * changed.width + regions[0]!.x + 208) * 4);
    expect(invoke(reader, changed).reads[0]!.itemId).toBe(0); // failed primary's partial box cannot authorize this suffix
    await flush();
  });
  it('ignores moving small art for a catalogue extension family but rereads a full added word', async () => {
    const catalog = { ...names, 4: 'Tankbuster Extra' };
    const primary = vi.fn(async (crop: import('../../brawl/ocr').NameCrop, slot = 0) => {
      wordBounds(crop, Object.values(names)[slot]!);
      return Object.values(names)[slot]!;
    });
    const reader = new DraftCardRecognition(primary, vi.fn(), vi.fn());
    const original = textImage();
    const read = (img: RGBImage) => reader.read(img, index, catalog, {}, 'capture1', visual);
    read(original);
    await flush();
    const regions = cardNameRegions(original.width, original.height, cardAnchors(original.width, original.height));
    for (let frame = 1; frame <= 10; frame++) {
      const moving = { ...original, data: original.data.slice() };
      for (const r of regions)
        for (let y = 20; y < 28; y++)
          for (let x = 0; x < 8; x++)
            moving.data.set([230, 230, 230, 255], ((r.y + y) * moving.width + r.x + 300 + frame * 11 + x) * 4);
      expect(read(moving).complete).toBe(true);
    }
    expect(primary).toHaveBeenCalledTimes(3);
    const extension = { ...original, data: original.data.slice() };
    for (let y = 20; y < 40; y++)
      for (let x = 300; x < 310; x++)
        extension.data.set([220, 220, 220, 255], ((regions[0]!.y + y) * extension.width + regions[0]!.x + x) * 4);
    expect(read(extension).reads.map((r) => r.itemId)).toEqual([0, 2, 3]);
    expect(primary).toHaveBeenCalledTimes(4);
    await flush();
  });
  it('finishes immutable jobs and caches their matched text while bright decorations move outside the words', async () => {
    const finish: ((text: string) => void)[] = [];
    const primary = vi.fn((crop: import('../../brawl/ocr').NameCrop, slot = 0) => {
      wordBounds(crop, Object.values(names)[slot]!);
      return new Promise<string>((resolve) => finish.push(resolve));
    });
    const reader = new DraftCardRecognition(primary, vi.fn(), vi.fn());
    const original = textImage();
    const regions = cardNameRegions(original.width, original.height, cardAnchors(original.width, original.height));
    const moving = (frame: number) => {
      const img = { ...original, data: original.data.slice() };
      for (const region of regions)
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++)
            img.data.set([230, 230, 230, 255], ((region.y + y) * img.width + region.x + 30 + frame * 11 + x) * 4);
      return img;
    };
    invoke(reader, original);
    for (let frame = 1; frame <= 8; frame++) expect(invoke(reader, moving(frame)).complete).toBe(false);
    finish.forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
    for (let frame = 9; frame <= 40; frame++)
      expect(invoke(reader, moving(frame)).reads.map((r) => r.itemId)).toEqual([1, 2, 3]);
    expect(primary).toHaveBeenCalledTimes(3);
  });
  it('vetoes old completed text when the current word loses or gains significant strokes', async () => {
    const primary = vi.fn(async (crop: import('../../brawl/ocr').NameCrop, slot = 0) => {
      wordBounds(crop, Object.values(names)[slot]!);
      return Object.values(names)[slot]!;
    });
    const reader = new DraftCardRecognition(primary, vi.fn(), vi.fn());
    const original = textImage();
    invoke(reader, original);
    await flush();
    expect(invoke(reader, original).complete).toBe(true);
    const changed = { ...original, data: original.data.slice() };
    const region = cardNameRegions(original.width, original.height, cardAnchors(original.width, original.height))[0]!;
    for (let y = 23; y < 37; y++)
      for (let x = 203; x < 210; x++)
        changed.data.set([220, 220, 220, 255], ((region.y + y) * changed.width + region.x + x) * 4);
    expect(invoke(reader, changed).reads.map((r) => r.itemId)).toEqual([0, 2, 3]);
    expect(primary).toHaveBeenCalledTimes(4);
    await flush();
  });
  it('finishes slow reads while live icon and text luminance shimmer within the same immutable source', async () => {
    const finish: ((text: string) => void)[] = [];
    const primary = vi.fn(
      (_crop: import('../../brawl/ocr').NameCrop) => new Promise<string>((resolve) => finish.push(resolve)),
    );
    const reader = new DraftCardRecognition(primary, vi.fn(), vi.fn());
    const original = image();
    invoke(reader, original);
    const regions = cardNameRegions(original.width, original.height, cardAnchors(original.width, original.height));
    for (let frame = 1; frame <= 8; frame++) {
      const live = { ...original, data: original.data.slice() };
      for (const region of regions) {
        const p = (region.y * live.width + region.x) * 4;
        live.data.set([220 + frame, 220 + frame, 220 + frame, 255], p);
        live.data.set([frame, frame, frame, 255], p + 4); // moving dark scene behind text
      }
      reader.read(
        live,
        index,
        names,
        {},
        'capture1:offer1',
        visual.map((v) => v.map((x) => x + frame)),
      );
    }
    finish.forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
    expect(invoke(reader, original).reads.map((r) => r.itemId)).toEqual([1, 2, 3]);
    expect(primary).toHaveBeenCalledTimes(3);
  });
  it('ignores smooth dark and neutral threshold crossings during an outstanding read', async () => {
    const finish: ((text: string) => void)[] = [];
    const primary = vi.fn(
      (_crop: import('../../brawl/ocr').NameCrop) => new Promise<string>((resolve) => finish.push(resolve)),
    );
    const reader = new DraftCardRecognition(primary, vi.fn(), vi.fn());
    const original = image();
    const regions = cardNameRegions(original.width, original.height, cardAnchors(original.width, original.height));
    for (const r of regions) {
      original.data.set([89, 89, 89, 255], (r.y * original.width + r.x + 1) * 4);
      original.data.set([170, 170, 254, 255], (r.y * original.width + r.x + 2) * 4);
    }
    invoke(reader, original);
    const live = { ...original, data: original.data.slice() };
    for (const r of regions) {
      live.data.set([91, 91, 91, 255], (r.y * live.width + r.x + 1) * 4);
      live.data.set([170, 170, 255, 255], (r.y * live.width + r.x + 2) * 4);
    }
    invoke(reader, live);
    finish.forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
    expect(invoke(reader, live).complete).toBe(true);
    expect(primary).toHaveBeenCalledTimes(3);
  });
  it.each(['added', 'removed'])(
    'invalidates a %s character stroke even in a long name with an unchanged icon',
    async (direction) => {
      const primary = vi.fn(async (_crop, slot = 0) => Object.values(names)[slot]!);
      const reader = new DraftCardRecognition(primary, vi.fn(), vi.fn());
      const original = image();
      const region = cardNameRegions(original.width, original.height, cardAnchors(original.width, original.height))[0]!;
      for (let y = 4; y < 24; y++)
        for (let x = 20; x < 420; x += 10)
          original.data.set([220, 220, 220, 255], ((region.y + y) * original.width + region.x + x) * 4);
      invoke(reader, original);
      await flush();
      expect(invoke(reader, original).complete).toBe(true);
      const changed = { ...original, data: original.data.slice() };
      for (let y = 4; y < 24; y++)
        changed.data.set(
          direction === 'added' ? [220, 220, 220, 255] : [0, 0, 0, 255],
          ((region.y + y) * changed.width + region.x + (direction === 'added' ? 430 : 410)) * 4,
        );
      expect(invoke(reader, changed).reads.map((r) => r.itemId)).toEqual([0, 2, 3]);
      expect(primary).toHaveBeenCalledTimes(4);
      await flush();
    },
  );
  it('rejects cumulative drift against the original source instead of following each small step', async () => {
    const finish: ((text: string) => void)[] = [];
    const primary = vi.fn(
      (_crop: import('../../brawl/ocr').NameCrop) => new Promise<string>((resolve) => finish.push(resolve)),
    );
    const reader = new DraftCardRecognition(primary, vi.fn(), vi.fn());
    const original = image();
    invoke(reader, original);
    const regions = cardNameRegions(original.width, original.height, cardAnchors(original.width, original.height));
    for (const value of [210, 200, 190]) {
      const live = { ...original, data: original.data.slice() };
      for (const r of regions) live.data.set([value, value, value, 255], (r.y * live.width + r.x) * 4);
      invoke(reader, live);
    }
    finish.forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
    const drifted = { ...original, data: original.data.slice() };
    for (const r of regions) drifted.data.set([190, 190, 190, 255], (r.y * drifted.width + r.x) * 4);
    expect(invoke(reader, drifted).complete).toBe(false);
    expect(primary).toHaveBeenCalledTimes(6);
    finish.slice(3).forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
  });
  it('anchors a delayed replacement job to the frame actually OCRed, not a waiting placeholder', async () => {
    const finish: ((text: string) => void)[] = [];
    const primary = vi.fn(
      (_crop: import('../../brawl/ocr').NameCrop) => new Promise<string>((resolve) => finish.push(resolve)),
    );
    const reader = new DraftCardRecognition(primary, vi.fn(), vi.fn());
    const original = image();
    const regions = cardNameRegions(original.width, original.height, cardAnchors(original.width, original.height));
    const atBrightness = (value: number) => {
      const frame = { ...original, data: original.data.slice() };
      for (const r of regions) frame.data.set([value, value, value, 255], (r.y * frame.width + r.x) * 4);
      return frame;
    };
    invoke(reader, atBrightness(240));
    invoke(reader, atBrightness(180)); // replacement placeholder while the old job is physically busy
    invoke(reader, atBrightness(200)); // within the placeholder's tolerance
    finish.forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
    invoke(reader, atBrightness(200)); // replacement actually reads this frame
    invoke(reader, atBrightness(160)); // within 24 of placeholder, outside 24 of actual job source
    finish.slice(3).forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
    expect(invoke(reader, atBrightness(160)).complete).toBe(false);
    expect(primary).toHaveBeenCalledTimes(9);
    finish.slice(6).forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
  });
  it('invalidates an outstanding source when its name vanishes, even if the original pixels return', async () => {
    const finish: ((text: string) => void)[] = [];
    const primary = vi.fn(
      (_crop: import('../../brawl/ocr').NameCrop) => new Promise<string>((resolve) => finish.push(resolve)),
    );
    const reader = new DraftCardRecognition(primary, vi.fn(), vi.fn());
    const original = image();
    invoke(reader, original);
    invoke(reader, { ...original, data: new Uint8ClampedArray(original.data.length) });
    invoke(reader, original);
    finish.forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
    expect(invoke(reader, original).complete).toBe(false);
    expect(primary).toHaveBeenCalledTimes(6);
    finish.slice(3).forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
  });
  it('rejects old text after a material icon change and does not transfer proof across capture candidates', async () => {
    const finish: ((text: string) => void)[] = [];
    const primary = vi.fn(
      (_crop: import('../../brawl/ocr').NameCrop) => new Promise<string>((resolve) => finish.push(resolve)),
    );
    const reader = new DraftCardRecognition(primary, vi.fn(), vi.fn());
    const img = image();
    const original = Array.from({ length: 3 }, () => new Uint8Array(48).fill(80));
    const replacement = Array.from({ length: 3 }, () => new Uint8Array(48).fill(160));
    reader.read(img, index, names, {}, 'capture1', original);
    reader.read(img, index, names, {}, 'capture1', replacement);
    finish.forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
    expect(reader.read(img, index, names, {}, 'capture1', replacement).complete).toBe(false);
    reader.read(img, index, names, {}, 'capture2', replacement);
    finish.slice(3).forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
    expect(reader.read(img, index, names, {}, 'capture2', replacement).complete).toBe(false);
    expect(primary).toHaveBeenCalledTimes(9);
    finish.slice(6).forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
  });
  it('reads every slot and never searches icons for exact names absent from the icon index', async () => {
    const primary = vi.fn(async (_crop, slot = 0) => Object.values(names)[slot]!);
    const fallback = vi.fn();
    const icon = vi.fn();
    const reader = new DraftCardRecognition(primary, fallback, icon);
    expect(invoke(reader).pending).toBe(true);
    await flush();
    expect(invoke(reader).reads.map((r) => r.itemId)).toEqual([1, 2, 3]);
    expect(primary).toHaveBeenCalledTimes(3);
    expect(fallback).not.toHaveBeenCalled();
    expect(icon).not.toHaveBeenCalled();
    invoke(reader);
    expect(primary).toHaveBeenCalledTimes(3);
  });
  it('accepts complete distinctive typos without confidence and falls through only the unresolved slot', async () => {
    const primary = vi.fn(async (_crop, slot = 0) => ['Tankbuzter', 'Superior Duration', ''][slot]!);
    const fallback = vi.fn(async () => ({ text: 'Kevlar', confidence: 0 }));
    const icon = vi.fn();
    const reader = new DraftCardRecognition(primary, fallback, icon);
    invoke(reader);
    await flush();
    expect(invoke(reader).reads.map((r) => r.itemId)).toEqual([1, 2, 3]);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(icon).not.toHaveBeenCalled();
  });
  it('uses one binary and one nearest alternate, then caches selective strong icon proof', async () => {
    const primary = vi.fn(async (_crop, slot = 0) => Object.values(names)[slot === 1 ? 0 : slot]!);
    primary.mockImplementation(async (_crop, slot) => (slot === 1 ? '' : Object.values(names)[slot]!));
    const fallback = vi.fn(async () => ({ text: 'not a catalog name', confidence: 99 }));
    const raw = {
      itemId: 2,
      present: true,
      match: { itemId: 2, score: 0.9, margin: 0.2, x: 25, y: 30, edge: 20 },
      rare: false,
      enhanced: false,
    } as CardRead;
    const icon = vi.fn((..._args: Parameters<typeof import('../../brawl/recognise').readDraftSlot>) => raw);
    const reader = new DraftCardRecognition(primary, fallback, icon);
    invoke(reader);
    await flush();
    const result = invoke(reader);
    expect(result.complete).toBe(true);
    expect(fallback.mock.calls.length).toBeLessThanOrEqual(2);
    expect(icon).toHaveBeenCalledTimes(1);
    expect(icon.mock.calls[0]![3]).toBe(1);
    expect(result.reads[1]!.match).toBe(raw.match);
    invoke(reader);
    expect(icon).toHaveBeenCalledTimes(1);
  });
  it('copies all crop pixels before awaiting and ignores late old source or reset jobs', async () => {
    const finish: ((text: string) => void)[] = [];
    const primary = vi.fn(
      (_crop: import('../../brawl/ocr').NameCrop) => new Promise<string>((resolve) => finish.push(resolve)),
    );
    const fallback = vi.fn();
    const icon = vi.fn();
    const reader = new DraftCardRecognition(primary, fallback, icon);
    const img = image();
    invoke(reader, img);
    const copied = primary.mock.calls[0]![0].data.slice();
    img.data.fill(0);
    finish.forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
    expect(primary.mock.calls[0]![0].data).toEqual(copied);
    expect(invoke(reader, img).complete).toBe(false);
    reader.reset();
    const newer = invoke(reader, image(), 'capture2');
    expect(newer.pending).toBe(true);
    reader.reset();
    finish.slice(3).forEach((done) => done('garbled'));
    await flush();
    expect(fallback).not.toHaveBeenCalled();
  });
  it('never lets an old reset job clean up the new same-source owner', async () => {
    const finish: ((value: string) => void)[] = [];
    const primary = vi.fn(
      (_crop: import('../../brawl/ocr').NameCrop) => new Promise<string>((resolve) => finish.push(resolve)),
    );
    const reader = new DraftCardRecognition(primary, vi.fn(), vi.fn());
    const img = image();
    invoke(reader, img);
    reader.reset();
    invoke(reader, img);
    finish.slice(0, 3).forEach((done) => done('old screenshot'));
    await flush();
    expect(invoke(reader, img).pending).toBe(true);
    expect(primary).toHaveBeenCalledTimes(6);
    finish.slice(3).forEach((done, slot) => done(Object.values(names)[slot]!));
    await flush();
    expect(invoke(reader, img).reads.map((r) => r.itemId)).toEqual([1, 2, 3]);
    expect(primary).toHaveBeenCalledTimes(6);
  });
  it('does not let an ambiguous or partial primary text form a tuple even with high confidence fallback', async () => {
    const primary = vi.fn(async () => 'Superior');
    const fallback = vi.fn(async () => ({ text: 'Superior', confidence: 99 }));
    const icon = vi.fn(() => ({ present: false, match: { score: 0 } }) as CardRead);
    const reader = new DraftCardRecognition(primary, fallback, icon);
    invoke(reader);
    await flush();
    const result = invoke(reader);
    expect(result.complete).toBe(false);
    expect(result.reads.every((r) => !r.itemId)).toBe(true);
    invoke(reader);
    expect(primary).toHaveBeenCalledTimes(3);
    expect(icon).toHaveBeenCalledTimes(3);
  });
});
