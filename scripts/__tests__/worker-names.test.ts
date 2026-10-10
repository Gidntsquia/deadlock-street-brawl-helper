import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { draftRegions } from '../../src/brawl/recognise';
import type { WorkerIn, WorkerOut } from '../../src/brawl/worker';
import type { IconIndex } from '../../src/brawl/types';
import type { Item } from '../../src/types';

// The real worker, fed the real choice1 demo frame, with one card's reference art replaced in the icon index: the icon
// search can only guess that card wrong (as it did for Spellbreaker, whose in-game art differs from the shop art). The name
// printed under the card, read by real OCR, must put the right item in the accepted set, and no set with the wrong
// item may be accepted first.
vi.setConfig({ testTimeout: 60_000 });

type Out = Extract<WorkerOut, { type: 'result' }>;
const posted: WorkerOut[] = [];
let clock = 0;
let send: (m: WorkerIn) => void;
const W = 2000,
  H = 1125;
const HIDDEN = 2829638276; // choice1's top card
const CHOICE1 = [1548066885, HIDDEN, 3633614685];
let msgRegions: { x: number; y: number; width: number; height: number; buffer: ArrayBuffer }[] = [];

beforeAll(async () => {
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  let handler: (ev: { data: WorkerIn }) => void = () => {};
  (globalThis as unknown as { self: unknown }).self = {
    addEventListener: (_: string, h: typeof handler) => (handler = h),
    postMessage: (m: WorkerOut) => posted.push(m),
  };
  await import('../../src/brawl/worker');
  send = (m) => handler({ data: m });
  const { data } = await sharp('public/demo/choice1.png').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  msgRegions = draftRegions(W, H).map((r) => {
    const b = new Uint8ClampedArray(r.width * r.height * 4);
    for (let y = 0; y < r.height; y++)
      b.set(data.subarray(((r.y + y) * W + r.x) * 4, ((r.y + y) * W + r.x + r.width) * 4), y * r.width * 4);
    return { ...r, buffer: b.buffer };
  });
  const index: IconIndex = JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8'));
  // its reference art becomes a flat grey square: still in the draft pool, but its icon can no longer match
  index.icons[HIDDEN] = Buffer.alloc(index.size * index.size * 3, 128).toString('base64');
  index.extras = (index.extras ?? []).filter(([id]) => id !== HIDDEN);
  const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
  send({
    type: 'init',
    index,
    tiers: Object.fromEntries(items.map((i) => [i.id, i.item_tier])),
    names: Object.fromEntries(items.map((i) => [i.id, i.name])),
    intervalMs: 250,
  });
});
afterAll(() => send({ type: 'stop' }));

describe('worker: the name under a card overrides a wrong icon guess', () => {
  it('accepts the set with the named item, never the icon guess', async () => {
    const results: Out[] = [];
    const names: Extract<WorkerOut, { type: 'name' }>[] = [];
    for (let i = 0; i < 400 && !results.some((r) => r.accepted); i++) {
      posted.length = 0;
      send({ type: 'frame', width: W, height: H, regions: msgRegions, prefer: [] });
      // the virtual clock holds until the unguessable card's name read has landed (OCR is real time, the fallback timer is
      // not); the other two cards are named by their icons at once and confirmed by their names after the advice
      if (names.some((n) => n.slot === 1)) clock += 70;
      results.push(...posted.filter((m): m is Out => m.type === 'result'));
      await new Promise((r) => setTimeout(r, 30)); // real time for the OCR reads to land
      names.push(...posted.filter((m): m is Extract<WorkerOut, { type: 'name' }> => m.type === 'name'));
    }
    const top = names.find((n) => n.slot === 1)!;
    expect(top.icon).not.toBe(HIDDEN); // the icon search really guessed wrong
    expect(top.itemId).toBe(HIDDEN);
    const accepted = results.filter((r) => r.accepted);
    expect(accepted.map((r) => r.key)).toEqual([CHOICE1.join(',')]);
    // no frame offered the gate a full set holding the wrong guess
    expect(results.filter((r) => r.key && r.key !== CHOICE1.join(','))).toEqual([]);
  });
});
