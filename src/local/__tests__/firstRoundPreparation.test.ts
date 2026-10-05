import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { FirstRoundPreparation, hasRoundCountdown, roundCountdownRegion } from '../firstRoundPreparation';
import type { RGBImage } from '../../brawl/recognise';
import { readFileSync } from 'node:fs';

const fixture = 'src/local/__tests__/assets/round-countdown.png';
async function captionFrame(width = 3439, height = 1439, dx = 0, dy = 0): Promise<RGBImage> {
  const s = height / 1439;
  const { data, info } = await sharp(fixture)
    .resize(Math.round(420 * s), Math.round(70 * s))
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    channels: info.channels as 4,
    data,
    origin: { x: Math.round(width - 439 * s) + dx, y: Math.round(365 * s) + dy, fullWidth: width, fullHeight: height },
  };
}

describe('fixed round preparation caption', () => {
  it('reads both actual first-round draft caption positions before all picks are complete', async () => {
    for (const name of ['choice1', 'choice3']) {
      const file = `src/local/__tests__/assets/round-countdown-draft-${name}`;
      const origin = JSON.parse(readFileSync(`${file}.json`, 'utf8'));
      const { data, info } = await sharp(`${file}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(hasRoundCountdown({ data, width: info.width, height: info.height, channels: 4, origin })).toBe(true);
    }
  });
  it('reads the real non-shop screenshot at ultrawide, 16:9 and height-scaled resolutions', async () => {
    for (const [w, h] of [
      [3439, 1439],
      [2560, 1440],
      [1920, 1080],
      [1600, 900],
      [3840, 2160],
    ])
      expect(hasRoundCountdown(await captionFrame(w, h)), `${w}x${h}`).toBe(true);
  });
  it('tolerates capture pixel offsets while staying anchored to the right edge', async () => {
    expect(hasRoundCountdown(await captionFrame(3439, 1439, 1, -1))).toBe(true);
    expect(hasRoundCountdown(await captionFrame(3439, 1439, -200))).toBe(false);
    const ultra = roundCountdownRegion(3439, 1439);
    const normal = roundCountdownRegion(2560, 1439);
    expect(ultra.x - normal.x).toBe(879);
    expect(ultra.width).toBe(normal.width);
  });
  it('reads a fixed caption shifted to the screen right edge without clipping its final letters', async () => {
    expect(hasRoundCountdown(await captionFrame(3439, 1439, 40))).toBe(true);
    for (const [width, height] of [
      [3439, 1439],
      [1920, 1080],
      [3840, 2160],
    ]) {
      const region = roundCountdownRegion(width!, height!);
      expect(region.x + region.width).toBe(width);
    }
  });
  it('rejects blank, solid tooltip ink, and the changing green seconds without the phrase', async () => {
    const image = await captionFrame();
    expect(hasRoundCountdown({ ...image, data: new Uint8Array(image.data.length) })).toBe(false);
    const cream = new Uint8Array(image.data.length);
    for (let i = 0; i < cream.length; i += 4) cream.set([210, 200, 175, 255], i);
    expect(hasRoundCountdown({ ...image, data: cream })).toBe(false);
    const seconds = Uint8Array.from(image.data);
    for (let i = 0; i < seconds.length; i += 4) if (seconds[i]! >= seconds[i + 1]!) seconds.fill(0, i, i + 3);
    expect(hasRoundCountdown({ ...image, data: seconds })).toBe(false);
  });
  it('accepts actual first drafts with the caption and rejects frames without it', async () => {
    for (const name of ['choice1', 'choice2', 'gameplay', 'inround-r3']) {
      const { data, info } = await sharp(`public/demo/${name}.png`).raw().toBuffer({ resolveWithObject: true });
      expect(
        hasRoundCountdown({ data, width: info.width, height: info.height, channels: info.channels as 4 }),
        name,
      ).toBe(name === 'choice1' || name === 'choice2');
    }
  });
});

describe('first round preparation lifetime', () => {
  const draft = { shop: true, round: 1, countdown: false };
  const countdown = { shop: false, round: 1, countdown: true };
  const absent = { shop: false, round: 0, countdown: false };
  it('keeps team evidence through completed picks and hides after countdown disappears', () => {
    const phase = new FirstRoundPreparation();
    expect(phase.observe(draft, 0)).toBe(true);
    expect(phase.observe(countdown, 11000)).toBe(true);
    expect(phase.observe(absent, 11300)).toBe(true);
    expect(phase.observe(absent, 11600)).toBe(true);
    expect(phase.observe(absent, 12300)).toBe(false);
    expect(phase.observe(countdown, 12400)).toBe(true);
  });
  it('tolerates a brief tooltip/dropout, then ends on sustained blank or gameplay', () => {
    const phase = new FirstRoundPreparation();
    phase.observe(draft, 0);
    expect(phase.observe(absent, 100)).toBe(true);
    expect(phase.observe(draft, 250)).toBe(true);
    expect(phase.observe(countdown, 600)).toBe(true);
    expect(phase.observe(absent, 900)).toBe(true);
    expect(phase.observe(countdown, 1000)).toBe(true);
    expect(phase.observe(absent, 1600)).toBe(true);
    expect(phase.observe(absent, 1900)).toBe(true);
    expect(phase.observe(absent, 2600)).toBe(false);
  });
  it('recovers from a sustained cue dropout only with fresh first-round screen evidence', () => {
    const phase = new FirstRoundPreparation();
    phase.observe(countdown, 0);
    expect(phase.observe(absent, 600)).toBe(true);
    expect(phase.observe(absent, 900)).toBe(true);
    expect(phase.observe(absent, 1600)).toBe(false);
    expect(phase.needsFullFrame(900)).toBe(true);
    expect(phase.observe(draft, 2000)).toBe(false); // uncommitted raw shop labels are insufficient to recover
    expect(phase.observe({ ...countdown, round: 0 }, 2100)).toBe(false);
    expect(phase.observe(countdown, 2200)).toBe(true);
    expect(phase.observe(absent, 2800)).toBe(true);
    expect(phase.observe(absent, 3100)).toBe(true);
    expect(phase.observe(absent, 3800)).toBe(false);
    expect(phase.needsFullFrame(6199)).toBe(true);
    expect(phase.needsFullFrame(6200)).toBe(false);
    expect(phase.observe({ ...draft, confirmedRound: true }, 6300)).toBe(true);
    phase.observe({ ...draft, round: 2, confirmedRound: true }, 6400);
    expect(phase.needsFullFrame(6401)).toBe(false);
    expect(phase.observe(countdown, 6500)).toBe(false);
  });
  it('suppresses later rounds and naked countdown, and resets for capture stop/new match', () => {
    const phase = new FirstRoundPreparation();
    expect(phase.observe({ ...countdown, round: 0 }, 0)).toBe(false);
    expect(phase.observe(countdown, 10)).toBe(true); // F8 during preparation: real ROUND 1 and caption
    expect(phase.observe({ shop: true, round: 2, countdown: false, confirmedRound: true }, 20)).toBe(false);
    expect(phase.observe(draft, 30)).toBe(false);
    phase.reset();
    expect(phase.visible).toBe(false);
    expect(phase.observe(draft, 40)).toBe(true);
  });
  it('recovers from one contradictory raw ROUND glyph and ends only after two distinct consistent later-round samples', () => {
    const phase = new FirstRoundPreparation();
    expect(phase.observe({ ...countdown, sample: 1 }, 0)).toBe(true);
    expect(phase.observe({ ...countdown, round: 2, sample: 2 }, 100)).toBe(true);
    expect(phase.observe({ ...countdown, sample: 3 }, 200)).toBe(true);
    expect(phase.observe({ ...countdown, round: 2, sample: 4 }, 300)).toBe(true);
    expect(phase.observe({ ...countdown, round: 2, sample: 4 }, 400)).toBe(true); // duplicate delivery is not fresh evidence
    expect(phase.observe({ ...countdown, round: 2, sample: 5 }, 500)).toBe(false);
    expect(phase.observe({ ...countdown, sample: 6 }, 600)).toBe(false);
  });
  it('keeps checking preparation after probe gaps and requires fresh covered samples to hide or refresh it', () => {
    const phase = new FirstRoundPreparation();
    expect(phase.observe({ ...countdown, sample: 1 }, 0)).toBe(true);
    expect(phase.observe({ ...absent, cueCovered: false, sample: 1 }, 5000)).toBe(true);
    expect(phase.observe({ ...absent, round: 2, cueCovered: false, sample: 2 }, 5001)).toBe(true);
    expect(phase.observe({ ...absent, round: 2, cueCovered: false, sample: 3 }, 5002)).toBe(true);
    expect(phase.needsFullFrame(5000)).toBe(true);
    expect(phase.observe({ ...absent, sample: 2 }, 5100)).toBe(true);
    expect(phase.observe({ ...absent, sample: 2 }, 7000)).toBe(true);
    expect(phase.observe({ ...absent, sample: 3 }, 7100)).toBe(true);
    expect(phase.observe({ ...absent, sample: 4 }, 7200)).toBe(false);
    expect(phase.observe({ ...countdown, sample: 5 }, 10000)).toBe(true);
    expect(phase.observe({ ...countdown, sample: 5 }, 14000)).toBe(true);
    expect(phase.observe({ ...absent, sample: 6 }, 15000)).toBe(true);
    expect(phase.observe({ ...absent, sample: 7 }, 16000)).toBe(true);
    expect(phase.observe({ ...absent, sample: 8 }, 16100)).toBe(false);
    expect(phase.needsFullFrame(16101)).toBe(false); // A duplicate caption never refreshed lastSeen.
  });
  it('preserves confirmed preparation across F8 without carrying old capture misses into the new stream', () => {
    const phase = new FirstRoundPreparation();
    phase.observe({ ...countdown, sample: 1 }, 0);
    phase.observe({ ...absent, sample: 2 }, 500);
    phase.observe({ ...absent, sample: 3 }, 1000);
    phase.reacquire();
    expect(phase.visible).toBe(true);
    expect(phase.observe({ ...absent, sample: 1 }, 2000)).toBe(true);
    expect(phase.observe({ ...countdown, sample: 2 }, 2200)).toBe(true);
    phase.observe({ ...draft, round: 2, confirmedRound: true }, 2300);
    phase.reacquire();
    expect(phase.observe({ ...countdown, sample: 1 }, 2500)).toBe(false);
  });
});
