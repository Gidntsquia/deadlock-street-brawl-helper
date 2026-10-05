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
describe('upstream OCR is the live primary', () => {
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
    expect(invoke(reader, original).complete).toBe(false);
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
