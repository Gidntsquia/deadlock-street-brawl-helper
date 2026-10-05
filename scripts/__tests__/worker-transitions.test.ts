import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cardSquares, draftRegions } from '../../src/brawl/recognise';
import type { WorkerIn, WorkerOut } from '../../src/brawl/worker';
import type { Item } from '../../src/types';

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
async function run(name: string, n: number) {
  const outs: Out[] = [];
  for (let i = 0; i < n; i++) outs.push(await frame(name));
  return outs;
}

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
  // A re-roll: same labels and grid, three new cards with their names.
  frames.rerolled = mix(c1, c2, [0, 1, 2, ...[...regions.keys()].slice(-6)]);
  // Hover states on choice1's left card: a glow over the card, the icon nudged a few px (the search lands on another
  // step), and the icon covered by a dark tooltip.
  const [sq] = cardSquares(W, H);
  const edit = (fn: (x: number, y: number, p: number, out: Buffer) => void) => {
    const out = Buffer.from(c1);
    for (let y = Math.round(sq!.y); y < sq!.y + sq!.edge; y++)
      for (let x = Math.round(sq!.x); x < sq!.x + sq!.edge; x++) fn(x, y, (y * W + x) * 4, out);
    return out;
  };
  frames.glow = edit((_x, _y, p, o) => {
    for (let c = 0; c < 3; c++) o[p + c] = Math.min(255, o[p + c]! + 50);
  });
  frames.nudged = edit((x, y, p, o) => {
    const q = ((y - 6) * W + x - 6) * 4;
    c1.copy(o, p, q, q + 4);
  });
  frames.covered = edit((_x, _y, p, o) => o.fill(20, p, p + 3));
  const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
  send({
    type: 'init',
    index: JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')),
    tiers: Object.fromEntries(items.map((i) => [i.id, i.item_tier])),
    names: Object.fromEntries(items.map((i) => [i.id, i.name])), // the names under the cards decide each card
    intervalMs: 250,
  });
});
afterAll(() => {
  send({ type: 'stop' });
  vi.restoreAllMocks();
});

const accepts = (outs: Out[]) => outs.filter((o) => o.accepted).map((o) => [o.key, o.meta!.round, o.meta!.choice]);

describe('worker: the draft gate on real frames', () => {
  it('advises choice 1, spots the pick, never re-advises the old cards, then advises choice 2', async () => {
    // the first frames wait for the names under the cards (the OCR engine's first read is the slow one)
    // (OCR runs in real time, so under load it needs more frames: run until the set is accepted, then a few more)
    const first: Out[] = [];
    for (let i = 0; i < 120 && !first.some((o) => o.accepted); i++) first.push(await frame('c1'));
    first.push(...(await run('c1', 4)));
    const c1Key = '1548066885,2829638276,3633614685';
    expect(accepts(first)).toEqual([[c1Key, 1, 1]]);
    expect((first.findIndex((o) => o.accepted) - first.findIndex((o) => o.key)) * 70).toBeGreaterThanOrEqual(300);

    // The pick: for over a second the old cards stay up while the label and inventory grid already show the next
    // choice. Before the gate this re-accepted the old cards as "choice 2".
    const linger = await run('oldCardsNewLabel', 20);
    expect(accepts(linger)).toEqual([]);
    expect(linger.some((o) => o.picked === 1548066885)).toBe(true); // the card that landed in the grid
    expect(linger.at(-1)!.live).toBe(false);
    expect(linger.at(-1)!.spent).toBe(true);

    // A half-swapped set and the new cards under the stale label are passing states: never advised.
    const passing = [...(await run('halfSwapped', 3)), ...(await run('newCardsOldLabel', 3))];
    expect(accepts(passing)).toEqual([]);
    expect(passing.every((o) => !o.live)).toBe(true);

    const second = await run('c2', 8);
    const got = accepts(second);
    expect(got).toHaveLength(1);
    expect(got[0]![1]).toBe(1);
    expect(got[0]![2]).toBe(2);
    expect(got[0]![0]).not.toBe(c1Key);
    expect(second.at(-1)!.live).toBe(true);
  });

  it('keeps the advice and the circles still through hovers, and moves to re-rolled cards', async () => {
    send({ type: 'reset' });
    const c1Key = '1548066885,2829638276,3633614685';
    const first = await run('c1', 12);
    expect(accepts(first)).toEqual([[c1Key, 1, 1]]);
    // every state of a hover, a few times over: the accepted set never drops, never re-accepts, never moves
    const squares = cardSquares(W, H);
    const hover: Out[] = [];
    for (let i = 0; i < 4; i++) for (const f of ['glow', 'nudged', 'covered', 'c1']) hover.push(...(await run(f, 2)));
    expect(hover.every((o) => o.live && !o.accepted)).toBe(true);
    expect(hover.every((o) => !o.key || o.key.replace(/\+/g, '') === c1Key)).toBe(true);
    for (const o of hover)
      expect(o.reads.map((r) => [r.match.x, r.match.y, r.match.edge])).toEqual(squares.map((q) => [q.x, q.y, q.edge]));
    // A re-roll: the old advice goes at once, the new cards are advised under the same labels.
    const after = await run('rerolled', 16);
    expect(after.slice(0, 2).some((o) => !o.live)).toBe(true);
    const got = accepts(after);
    expect(got).toHaveLength(1);
    expect(got[0]![0]).toBe('4104549924,1144549437,1770441818');
    expect(got[0]!.slice(1)).toEqual([1, 1]);
  });
});
