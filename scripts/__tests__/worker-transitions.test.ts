import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { draftRegions } from '../../src/brawl/recognise';
import type { WorkerIn, WorkerOut } from '../../src/brawl/worker';

// The real worker (src/brawl/worker.ts), fed real demo frames the way the page feeds it, through a pick: choice1
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
/** `base` with the given draftRegions rects copied from `from`. */
function mix(base: Buffer, from: Buffer, which: number[]) {
  const out = Buffer.from(base);
  for (const k of which) {
    const r = regions[k]!;
    for (let y = r.y; y < r.y + r.height; y++)
      from.copy(out, (y * W + r.x) * 4, (y * W + r.x) * 4, (y * W + r.x + r.width) * 4);
  }
  return out;
}
function frame(name: string): Out {
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
  return posted.find((m): m is Out => m.type === 'result')!;
}
const run = (name: string, n: number) => Array.from({ length: n }, () => frame(name));

beforeAll(async () => {
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  let handler: (ev: { data: WorkerIn }) => void = () => {};
  (globalThis as unknown as { self: unknown }).self = {
    addEventListener: (_: string, h: typeof handler) => (handler = h),
    postMessage: (m: WorkerOut) => posted.push(m),
  };
  await import('../../src/brawl/worker');
  send = (m) => handler({ data: m });
  const c1 = await load('choice1'),
    c2 = await load('choice2');
  const labelsAndGrid = [3, 4, ...regions.keys()].filter((k) => k === 3 || k === 4 || k >= 6);
  frames.c1 = c1;
  frames.c2 = c2;
  frames.oldCardsNewLabel = mix(c1, c2, labelsAndGrid); // picked: label and grid moved on, old cards still up
  frames.newCardsOldLabel = mix(c2, c1, [3, 4]); // the new cards in before the label
  frames.halfSwapped = mix(c2, c1, [1, 2]); // only the left card replaced so far
  send({
    type: 'init',
    index: JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')),
    tiers: {},
    intervalMs: 250,
  });
});
afterAll(() => {
  send({ type: 'stop' });
  vi.restoreAllMocks();
});

const accepts = (outs: Out[]) => outs.filter((o) => o.accepted).map((o) => [o.key, o.meta!.round, o.meta!.choice]);

describe('worker: the draft gate on real frames', () => {
  it('advises choice 1, spots the pick, never re-advises the old cards, then advises choice 2', () => {
    const first = run('c1', 8);
    expect(accepts(first)).toEqual([[first[0]!.key, 1, 1]]);
    expect(first.findIndex((o) => o.accepted) * 70).toBeGreaterThanOrEqual(300);
    const c1Key = first[0]!.key;

    // The pick: for over a second the old cards stay up while the label and inventory grid already show the next
    // choice. Before the gate this re-accepted the old cards as "choice 2".
    const linger = run('oldCardsNewLabel', 20);
    expect(accepts(linger)).toEqual([]);
    expect(linger.some((o) => o.picked === 1548066885)).toBe(true); // the card that landed in the grid
    expect(linger.at(-1)!.live).toBe(false);
    expect(linger.at(-1)!.spent).toBe(true);

    // A half-swapped set and the new cards under the stale label are passing states: never advised.
    const passing = [...run('halfSwapped', 3), ...run('newCardsOldLabel', 3)];
    expect(accepts(passing)).toEqual([]);
    expect(passing.every((o) => !o.live)).toBe(true);

    const second = run('c2', 8);
    const got = accepts(second);
    expect(got).toHaveLength(1);
    expect(got[0]![1]).toBe(1);
    expect(got[0]![2]).toBe(2);
    expect(got[0]![0]).not.toBe(c1Key);
    expect(second.at(-1)!.live).toBe(true);
  });
});
