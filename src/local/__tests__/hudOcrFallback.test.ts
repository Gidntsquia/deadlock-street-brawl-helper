import { describe, it, expect, vi } from 'vitest';
import { strictHudValue, HudOcrFallback, readHudFallback, HudTextJobs } from '../hudOcrFallback';
import type { RGBImage } from '../../brawl/recognise';
describe('bounded HUD fallback', () => {
  it.each(['', '65', '100', '-1', '1 points', '01x', '∞'])('keeps points %j unknown', (text) =>
    expect(strictHudValue(text, 'points')).toBeNull(),
  );
  it('accepts only whole field numbers and the full fixed caption', () => {
    expect(strictHudValue('0', 'points')).toBe(0);
    expect(strictHudValue('64', 'points')).toBe(64);
    expect(strictHudValue('5', 'round')).toBe(5);
    expect(strictHudValue('ROUND 1', 'round')).toBeNull();
    expect(strictHudValue('ROUND begins in...', 'caption')).toBe(true);
    expect(strictHudValue('ROUND BEGINS IN 7', 'caption')).toBeNull();
    expect(strictHudValue('begins in', 'caption')).toBeNull();
  });
  it('tries primary then our binary then one nearest pass, accepting confidence zero', async () => {
    const crop = { data: new Uint8Array([200, 200, 200, 255]), width: 1, height: 1 };
    const primary = vi.fn(async () => ({ text: 'ROUND 1', confidence: 99 }));
    const fallback = vi
      .fn()
      .mockResolvedValueOnce({ text: '', confidence: 99 })
      .mockResolvedValueOnce({ text: '1', confidence: 0 });
    expect(await readHudFallback(crop, 'round', () => true, primary, fallback)).toMatchObject({ text: '1' });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(fallback.mock.calls[1]![0]).toMatchObject({ scale: 4, interpolation: 'nearest' });
  });
  it('requires two fresh misses and two fresh observations after completion, discarding late resets', async () => {
    const img: RGBImage = { width: 1, height: 1, channels: 4, data: new Uint8Array([200, 200, 200, 255]) };
    const region = { x: 0, y: 0, width: 1, height: 1 };
    let finish!: (v: { text: string; confidence: number }) => void;
    const read = vi.fn(() => new Promise<{ text: string; confidence: number }>((resolve) => (finish = resolve)));
    const field = new HudOcrFallback('round', read);
    expect(field.observe(img, region, 1, 0)).toBeNull();
    field.observe(img, region, 1, 500);
    expect(read).not.toHaveBeenCalled();
    field.observe(img, region, 2, 300);
    expect(read).toHaveBeenCalledTimes(1);
    finish({ text: '1', confidence: 0 });
    await Promise.resolve();
    expect(field.observe(img, region, 3, 400)).toBeNull();
    expect(field.observe(img, region, 4, 500)).toBe(1);
    field.reset();
    field.observe(img, region, 5, 600);
    field.observe(img, region, 6, 900);
    field.reset();
    finish({ text: '5', confidence: 99 });
    await Promise.resolve();
    expect(field.observe(img, region, 7, 1000)).toBeNull();
  });
  it('qualifies a stable glyph despite changing dark scene pixels and invalidates actual changed ink', async () => {
    const img: RGBImage = {
      width: 2,
      height: 1,
      channels: 4,
      data: new Uint8Array([200, 200, 200, 255, 0, 0, 0, 255]),
    };
    const region = { x: 0, y: 0, width: 2, height: 1 };
    let finish!: (v: { text: string; confidence: number }) => void;
    const read = vi.fn(() => new Promise<{ text: string; confidence: number }>((resolve) => (finish = resolve)));
    const field = new HudOcrFallback('round', read);
    for (let sample = 1; sample <= 10; sample++) {
      img.data[4] = sample % 2;
      field.observe(img, region, sample, sample * 300);
    }
    expect(read).toHaveBeenCalledTimes(1);
    img.data[0] = img.data[1] = img.data[2] = 0;
    img.data[4] = img.data[5] = img.data[6] = 200;
    field.observe(img, region, 11, 3300);
    finish({ text: '1', confidence: 99 });
    await Promise.resolve();
    expect(field.observe(img, region, 12, 3600)).toBeNull();
  });
  it('shares one field ladder across repeated requests and caches completed negative evidence', async () => {
    const crop = { data: new Uint8Array([200, 200, 200, 255]), width: 1, height: 1 };
    let finish!: (v: null) => void;
    const read = vi.fn(() => new Promise<null>((resolve) => (finish = resolve)));
    const jobs = new HudTextJobs(read);
    const pending = jobs.request(crop, 'points', 'same');
    for (let i = 0; i < 40; i++) jobs.request(crop, 'points', 'same');
    expect(read).toHaveBeenCalledTimes(1);
    finish(null);
    await pending;
    expect(await jobs.request(crop, 'points', 'same')).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    jobs.reset();
    jobs.request(crop, 'points', 'same');
    expect(read).toHaveBeenCalledTimes(2);
    finish(null);
  });
});
