import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cardSquares, draftRegions } from '../../src/brawl/recognise';
import type { WorkerIn, WorkerOut } from '../../src/brawl/worker';
import type { Item } from '../../src/types';

// The real worker on real demo frames: what it reports from the first sight of a draft, and what it does when one card
// cannot be read. Virtual clock, 70 ms per frame.
vi.setConfig({ testTimeout: 120_000 });

type Out = Extract<WorkerOut, { type: 'result' }>;
const posted: WorkerOut[] = [];
let clock = 0;
let send: (m: WorkerIn) => void;
const W = 2000,
  H = 1125;
const regions = draftRegions(W, H);
const frames: Record<string, Buffer> = {};
const nameKeys = [...regions.keys()].slice(-6);

async function load(name: string) {
  const { data } = await sharp(`public/demo/${name}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data;
}
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
const run = async (name: string, n: number) => {
  const outs: Out[] = [];
  for (let i = 0; i < n; i++) outs.push(await frame(name));
  return outs;
};
/** Frame with card slot `k` made unreadable: art and name line replaced by flat grey. */
function blank(base: Buffer, k: number) {
  const out = Buffer.from(base);
  for (const j of [k, nameKeys[k]!, nameKeys[k + 3]!]) {
    const r = regions[j]!;
    // only the name boxes that belong to this card (the list holds ends of the three lines twice over)
    if (j !== k && j !== nameKeys[k]) continue;
    for (let y = r.y; y < r.y + r.height; y++) out.fill(70, (y * W + r.x) * 4, (y * W + r.x + r.width) * 4);
  }
  return out;
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
  frames.c1 = await load('choice1');
  frames.bad = blank(frames.c1, 0);
  frames.enh = (await sharp('scripts/__tests__/data/enhanced-middle.png').ensureAlpha().raw().toBuffer()) as Buffer; // a real frame: Reactive Barrier enhanced, middle card
  // the same frame before the ENHANCED label has drawn: the box under the middle card's name painted flat grey
  frames.noLabel = Buffer.from(frames.enh);
  const sq = cardSquares(W, H)[1]!,
    u = sq.edge / 185;
  for (let y = Math.round(sq.y + sq.edge + 80 * u); y < sq.y + sq.edge + 126 * u; y++)
    frames.noLabel.fill(
      70,
      (y * W + Math.round(sq.x + sq.edge / 2 - 110 * u)) * 4,
      (y * W + Math.round(sq.x + sq.edge / 2 + 110 * u)) * 4,
    );
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

const frozen = (o: Out) => JSON.stringify([o.key, o.reads]);

describe('worker: a set stays unchanged once shown', () => {
  it('shows nothing until sure, then the same reads on every frame, through hovers', async () => {
    send({ type: 'reset' });
    // OCR runs in real time, so under load it needs more frames: run until the set is accepted
    const outs: Out[] = [];
    for (let n = 0; n < 120 && !outs.some((o) => o.accepted); n++) outs.push(await frame('c1'));
    const i = outs.findIndex((o) => o.accepted);
    expect(i).toBeGreaterThan(0);
    for (const o of outs.slice(0, i)) expect(o.live).toBe(false); // the page shows `Reading` for these
    const first = frozen(outs[i]!);
    const later = [...outs.slice(i + 1)];
    for (let k = 0; k < 3; k++) for (const f of ['c1']) later.push(...(await run(f, 3)));
    expect(later.every((o) => o.live && !o.accepted)).toBe(true);
    // the reads the page draws from are identical (same ids, tiers, squares) on every later frame
    expect(later.filter((o) => o.key).every((o) => frozen(o).replace(/\+/g, '') === first.replace(/\+/g, ''))).toBe(
      true,
    );
  });
});

describe('worker: the 2.5 s fallback', () => {
  beforeAll(() => send({ type: 'reset' }));
  it('turns one unreadable card into a question mark and keeps the others', async () => {
    const outs = await run('bad', 50); // 3.5 s
    const acc = outs.filter((o) => o.accepted);
    expect(acc.length).toBe(1);
    const first = acc[0]!;
    const at = outs.indexOf(first) * 70;
    expect(at).toBeGreaterThanOrEqual(2500);
    expect(at).toBeLessThan(3200);
    expect(first.reads[0]!.unsure).toBe(true);
    expect(first.reads[0]!.itemId).toBe(0);
    expect(first.reads[1]!.unsure).toBeFalsy();
    expect(first.reads[2]!.unsure).toBeFalsy();
    // nothing earlier showed a card at all, and the set then stays unchanged
    for (const o of outs.slice(0, outs.indexOf(first))) expect(o.live).toBe(false);
    for (const o of outs.slice(outs.indexOf(first) + 1)) expect(o.live).toBe(true);
  });
});

describe('worker: the ENHANCED mark', () => {
  it('is kept when the label draws after the card, and shows on the accepted set', async () => {
    send({ type: 'reset' });
    const outs = [...(await run('noLabel', 2))];
    for (let n = 0; n < 120 && !outs.some((o) => o.accepted); n++) outs.push(await frame('enh'));
    const acc = outs.find((o) => o.accepted)!;
    expect(acc.reads[1]!.enhanced).toBe(true);
    expect(outs.filter((o) => o.live).every((o) => o.reads[1]!.enhanced)).toBe(true);
  });
});
