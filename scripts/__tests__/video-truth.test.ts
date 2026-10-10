// The truth set: stretches of a real gameplay video (scripts/fixtures/video-truth, made by `scripts/video-truth.ts` from
// hand labels) replayed through the real worker. Fades, hover tooltips, the scoreboard, re-rolls and the helper's own
// plates are all in these frames, which the clean fixtures lack.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { scoreStretch } from '../lib/videoTruth';

vi.setConfig({ testTimeout: 180_000 });
const root = path.join('scripts', 'fixtures', 'video-truth');
const dirs = existsSync(root)
  ? readdirSync(root)
      .filter((n) => /^s\d+$/.test(n))
      .sort()
  : [];

describe('video truth set', () => {
  it('has stretches', () => expect(dirs.length).toBe(10));
  it.each(dirs)('%s is advised correctly', async (d) => {
    const rep = await scoreStretch(path.join(root, d));
    expect(rep.violations).toEqual([]);
  });
});
