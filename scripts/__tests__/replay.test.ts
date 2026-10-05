import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SessionStore, type RegionShot } from '../../electron/sessionStore';
import { draftRegions } from '../../src/brawl/recognise';
import { existsSync } from 'node:fs';
import { makeFixtures } from '../session-fixture';
import { describeDraft, replaySession } from '../replay';
import type { Item } from '../../src/types';

vi.setConfig({ testTimeout: 180_000 });
const dir = mkdtempSync(path.join(os.tmpdir(), 'brawl-replay-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const W = 2000,
  H = 1125;
const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
const name = (id: number) => items.find((i) => i.id === id)?.name ?? `#${id}`;

async function crops(frame: string) {
  const { data } = await sharp(`public/demo/${frame}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return draftRegions(W, H).map((r, index): RegionShot => {
    const b = new Uint8Array(r.width * r.height * 4);
    for (let y = 0; y < r.height; y++)
      b.set(data.subarray(((r.y + y) * W + r.x) * 4, ((r.y + y) * W + r.x + r.width) * 4), y * r.width * 4);
    return { index, x: r.x, y: r.y, width: r.width, height: r.height, rgba: b };
  });
}

describe('brawl:replay', () => {
  it('re-runs a recorded test-mode draft and prints its items, ? count, changes, drop-outs and advice time', async () => {
    const store = new SessionStore(dir, (r) =>
      sharp(Buffer.from(r.rgba), { raw: { width: r.width, height: r.height, channels: 4 } })
        .png()
        .toBuffer(),
    );
    store.enabled = true;
    const regions = await crops('choice1');
    for (let t = 0; t <= 2000; t += 100) store.addFrame({ t, regions });
    await store.finishDraft({
      round: 1,
      choice: 1,
      startedAt: Date.now(),
      frameW: W,
      frameH: H,
      items: [],
      unsure: 0,
      hero: { id: 0, source: 'none' },
      shown: { plates: [], takeId: null, reroll: false },
      adviceMs: null,
      changes: 0,
      dropouts: 0,
      fallback: false,
    });
    const [id] = await store.ids();
    const out = await replaySession(path.join(dir, id!), { waitNames: true });
    expect(out.length).toBe(1);
    const d = out[0]!;
    expect(d.stats.items.filter(Boolean).length).toBe(3);
    expect(d.stats.unsure).toBe(0);
    expect(d.stats.changes).toBe(0);
    expect(d.stats.dropouts).toBe(0);
    expect(d.stats.adviceMs).not.toBeNull();
    expect(d.stats.adviceMs!).toBeLessThan(2500);
    const line = describeDraft(d, name);
    expect(line).toMatch(
      /^R1 C1 \| items: .+ \| \? 0 \| changes 0 \| dropouts 0 \| advice \d+ ms \| differs from live: /,
    );
  });

  it('turns a draft marked wrong into a fixture with an expectation file', async () => {
    const store = new SessionStore(dir, async () => Buffer.from([]));
    const [id] = await store.ids();
    await store.mark(id!, 1, true);
    const root = path.join(dir, 'fixtures');
    const made = makeFixtures(path.join(dir, id!), { d001: ['A', 'B', 'C'] }, root);
    expect(made.length).toBe(1);
    expect(existsSync(path.join(made[0]!, 'expect.json'))).toBe(true);
    const want = JSON.parse(readFileSync(path.join(made[0]!, 'expect.json'), 'utf8'));
    expect(want.reason).toContain('marked wrong');
    expect(want.items).toEqual(['A', 'B', 'C']);
    expect(existsSync(path.join(made[0]!, 'frames.json'))).toBe(true);
  });
});
