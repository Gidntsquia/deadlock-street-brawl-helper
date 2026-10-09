import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { draftRegions } from '../../src/brawl/recognise';
import type { WorkerIn, WorkerOut } from '../../src/brawl/worker';
import type { TrackSummary } from '../../src/brawl/tracker';
import type { Item } from '../../src/types';

// The state machine inside the real worker (src/brawl/worker.ts), fed real demo frames the way the page feeds it.
// (Same harness as worker-transitions.test.ts.) Originally: through a pick: choice1
// (ROUND 1, CHOICE 1) -> choice2 (CHOICE 2, the picked card now in the inventory grid), with the in-between states the
// game shows while it swaps screens built from those two frames' own pixels: the old cards under the new label and
// grid, the new cards under the old label, and a half-swapped set. Time is a virtual clock (70 ms per frame).
vi.setConfig({ testTimeout: 60_000 });

type Out = Extract<WorkerOut, { type: 'result' }>;
const posted: WorkerOut[] = [];
let clock = 0;
let send: (m: WorkerIn) => void;

const W = 2000,
  H = 1125;
const regions = draftRegions(W, H); // 0-2 cards, 3 hero bar (with the ROUND label), 4 CHOICE label, 5 re-rolls, 6+ grid
const frames: Record<string, Buffer> = {};
async function load(name: string) {
  const { data, info } = await sharp(`public/demo/${name}.png`)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect([info.width, info.height]).toEqual([W, H]);
  return data;
}
/** One frame through the worker, then a little real time for its OCR reads (names, re-roll caption) to land. */
async function frame(name: string): Promise<Out> {
  const img = frames[name]!;
  const msgRegions = regions.map((r) => {
    const b = new Uint8ClampedArray(r.width * r.height * 4);
    for (let y = 0; y < r.height; y++)
      b.set(img.subarray(((r.y + y) * W + r.x) * 4, ((r.y + y) * W + r.x + r.width) * 4), y * r.width * 4);
    return { ...r, buffer: b.buffer };
  });
  posted.length = 0;
  send({ type: 'frame', width: W, height: H, regions: msgRegions, prefer: [] });
  clock += 70;
  const out = posted.find((m): m is Out => m.type === 'result')!;
  await new Promise((r) => setTimeout(r, 40));
  return out;
}
let track: TrackSummary | null = null;
const logs: string[] = [];
const take = (m: WorkerOut | undefined) => {
  const t = m?.type === 'track' ? m : m && 'track' in m ? m.track : undefined;
  if (!t) return;
  track = t.summary;
  logs.push(...t.logs.map((l) => l.name));
};
/** Frames until the machine has all three names (the first OCR read of a run loads the engine: seconds, not frames). */
async function runUntilLocked(name: string, max = 200) {
  for (let i = 0; i < max && !track?.locked; i++) await runTrack(name, 1);
}
/** Frames in a row, collecting what the machine reports (async name reads land between frames). */
async function runTrack(name: string, n: number) {
  for (let i = 0; i < n; i++) {
    await frame(name);
    for (const m of posted) take(m);
  }
}

beforeAll(async () => {
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  let handler: (ev: { data: WorkerIn }) => void = () => {};
  (globalThis as unknown as { self: unknown }).self = {
    addEventListener: (_: string, h: typeof handler) => (handler = h),
    postMessage: (m: WorkerOut) => {
      posted.push(m);
    },
  };
  await import('../../src/brawl/worker');
  send = (m) => handler({ data: m });
  const c1 = await load('choice1'),
    c2 = await load('choice2');
  frames.c1 = c1;
  frames.c2 = c2;
  const nameEnds = [...regions.keys()].slice(-6);
  frames.faded = Buffer.from(c1);
  for (const k of [0, 1, 2, ...nameEnds]) {
    const r = regions[k]!;
    for (let y = r.y; y < r.y + r.height; y++)
      for (let x = r.x; x < r.x + r.width; x++) frames.faded.fill(20, (y * W + x) * 4, (y * W + x) * 4 + 3);
  }
  const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
  send({
    type: 'init',
    index: JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')),
    tiers: Object.fromEntries(items.map((i) => [i.id, i.item_tier])),
    names: Object.fromEntries(items.map((i) => [i.id, i.name])),
    intervalMs: 250,
  });
});
afterAll(() => {
  send({ type: 'stop' });
  vi.restoreAllMocks();
});

describe('state machine in the worker', () => {
  it('a round start from the probe logs round.start and starts a match', () => {
    posted.length = 0;
    send({ type: 'roundStart', round: 1 });
    for (const m of posted) take(m);
    expect(logs).toContain('round.start');
    expect(track).toMatchObject({ round: 1, choice: 1, phase: 'round-start' });
  });
  it('each slot is read once and a locked set is not read again over 2 s', async () => {
    await runUntilLocked('c1');
    expect(track!.locked).toBe(true);
    expect(track!.reads).toEqual([1, 1, 1]);
    const readsAt = track!.reads.join();
    await runTrack('c1', 30); // 2.1 s of virtual time on the same screen
    expect(track!.reads.join()).toBe(readsAt);
    expect(logs.filter((l) => l === 'card.name')).toHaveLength(3);
    expect(track!.resyncs).toBe(0);
  });
  it('the cards vanishing under the same label is one re-roll, once the pick wait has passed', async () => {
    await runTrack('faded', 8); // 560 ms, past the 400 ms pick wait
    expect(logs.filter((l) => l === 'reroll.seen')).toHaveLength(1);
    expect(track!.rerollUsedThisRound).toBe(true);
    expect(track!.closed.at(-1)).toMatchObject({ round: 1, choice: 1, rerolled: true, reads: [1, 1, 1] });
  });
  it('a pick closes the set with a source and the next label is not a resync', async () => {
    await runUntilLocked('c1'); // the re-dealt cards
    expect(track!.locked).toBe(true);
    send({ type: 'advised', itemId: 123 });
    await runTrack('c2', 12);
    const last = track!.closed.find((c) => c.choice === 1 && !c.rerolled)!;
    expect(last).toMatchObject({ round: 1, choice: 1 });
    expect(last.reads.every((n) => n <= 1)).toBe(true); // the re-dealt cards were the same names: locked without a read
    expect(['read', 'assumed']).toContain(last.pickSource);
    expect(track).toMatchObject({ round: 1, resyncs: 0 });
  });
  it('a label that jumps resyncs and says which', async () => {
    const before = track!.statusSeq;
    await runTrack('c1', 3); // the label goes back from choice 2 to choice 1
    expect(track!.resyncs).toBe(1);
    expect(track!.statusSeq).toBeGreaterThan(before);
    expect(track!.status).toMatch(/^Resynced to round \d choice \d$/);
    expect(logs).toContain('resync');
  });
  it('F8 forces a resync on the next frame', async () => {
    send({ type: 'forceResync' });
    await runTrack('c1', 2);
    expect(track!.resyncs).toBe(2);
    expect(track!.status).toBe(`Resynced to round ${track!.round} choice ${track!.choice}`);
  });
});
