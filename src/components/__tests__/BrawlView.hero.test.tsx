// @vitest-environment jsdom
// The hero guess (R2): a match whose hero comes from the scoreboard portraits only (no loading-screen name) says so in
// the status line, tells App (the `guessed` badge) and puts `Hero guessed: <name>` on the overlay; a loading-screen read
// or a hand-picked hero clears all three.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Ability, Hero, Item } from '../../types';
import type { OverlayState } from '../../brawl/draw';

const root = path.resolve(__dirname, '../../../public/data/');
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

vi.mock('../../data/load', () => ({
  j: (rel: string) => Promise.resolve(rel === 'brawl-icons.json' ? {} : readJson(rel)),
  img: (p?: string) => p,
}));

let onLoadingCb: ((crop: { width: number; height: number; buffer: ArrayBuffer }) => void) | undefined;
const sent: OverlayState[] = [];
let readTextAnswer = 'INFERNUS';
(window as unknown as { brawlAPI: unknown }).brawlAPI = {
  isElectron: true,
  getGameRect: () => Promise.resolve({ x: 0, y: 0, width: 1920, height: 1080 }),
  onGameRect: () => () => {},
  getCaptureState: () => Promise.resolve({ wanted: true, probe: true }),
  onCaptureState: () => () => {},
  onLoadingName: (cb: typeof onLoadingCb) => {
    onLoadingCb = cb;
    return () => {
      onLoadingCb = undefined;
    };
  },
  captureIdle: () => {},
  captureResult: () => {},
  sendOverlayState: (s: OverlayState) => sent.push(s),
  onOverlayState: () => () => {},
  onCaptureDenied: () => () => {},
  onTestMode: () => () => {},
  getTestMode: () => Promise.resolve({ on: false, frame: '', frames: [], message: null }),
  getPlatformWarning: () => Promise.resolve(null),
  getProblem: () => Promise.resolve(null),
  onProblem: () => () => {},
  readText: () => Promise.resolve({ text: readTextAnswer, ms: 1 }),
  getReaderState: () => Promise.resolve('ready'),
  onReaderState: () => () => {},
};

const listeners: ((e: MessageEvent) => void)[] = [];
const posted: { type: string; round?: number }[] = [];
(globalThis as unknown as { Worker: unknown }).Worker = class {
  postMessage(m: { type: string; round?: number }) {
    posted.push(m);
  }
  terminate() {}
  addEventListener(_t: string, cb: (e: MessageEvent) => void) {
    listeners.push(cb);
  }
  removeEventListener(_t: string, cb: (e: MessageEvent) => void) {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  }
};
HTMLMediaElement.prototype.play = () => Promise.resolve();
(navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
  getDisplayMedia: () =>
    Promise.resolve({
      getTracks: () => [],
      getVideoTracks: () => [{ addEventListener() {}, stop() {}, applyConstraints: () => Promise.resolve() }],
    }),
};

const { BrawlView, heroGuessText, heroNoteText } = await import('../BrawlView');
afterEach(cleanup);

const heroes = readJson('heroes.json') as Hero[];
const items = readJson('items.json') as Item[];
const abilities = readJson('abilities.json') as Ability[];
const cardIds = items.filter((i) => i.item_tier >= 1 && !i.disabled).slice(0, 3);
const INFERNUS = heroes.find((h) => h.id === 1)!;

const read = (id: number) => ({
  card: 'c',
  match: { score: 1 },
  present: true,
  itemId: id,
  tier: 1,
  rare: false,
  enhanced: false,
});
const send = (data: object) => act(() => listeners.forEach((l) => l({ data } as MessageEvent)));
const accept = (round: number, choice: number, self: number) =>
  send({
    type: 'result',
    shop: true,
    round,
    choice,
    reads: cardIds.map((c) => read(c.id)),
    key: `${round}${choice}:` + cardIds.map((c) => c.id).join(','),
    accepted: true,
    live: true,
    picked: null,
    spent: false,
    meta: { round, choice, bar: { left: [], right: [] }, self, rerollsRemaining: 0 },
    inventory: null,
    ms: 5,
  });
// a loading-screen name box: the pixels do not matter, readText answers for them
const loadingCrop = () => {
  const width = 300,
    height = 40;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const x = (i / 4) % width;
    const v = x > 40 && x < 260 && x % 7 < 4 ? 230 : 20;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width, height, buffer: data.buffer };
};

async function start(props: { pinned?: boolean; onGuessed?: (g: boolean) => void } = {}) {
  listeners.length = 0;
  sent.length = 0;
  const view = (p: typeof props) => (
    <BrawlView hero={INFERNUS} heroes={heroes} items={items} abilities={abilities} onHero={() => {}} {...p} />
  );
  const r = render(view(props));
  await waitFor(() => expect(listeners.length).toBeGreaterThanOrEqual(2));
  return { rerender: (p: typeof props) => r.rerender(view(p)) };
}
const status = () => screen.getByRole('status').textContent;
const lastNote = () => [...sent].reverse().find((s) => s.draft)?.heroNote ?? null;

describe('BrawlView hero guess', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('brawl.firstRunDone', 'true');
    readTextAnswer = 'INFERNUS';
  });

  it('a portrait-only match shows the guess in the status line, the badge flag and the overlay note', async () => {
    const onGuessed = vi.fn();
    await start({ onGuessed });
    accept(3, 1, INFERNUS.id);
    await waitFor(() => expect(status()).toBe(heroGuessText(INFERNUS.name)));
    expect(status()).toBe(`Hero guessed from portraits: ${INFERNUS.name}. Pick the hero to correct.`);
    expect(onGuessed).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(lastNote()).toBe(heroNoteText(INFERNUS.name)));
    expect(lastNote()).toBe(`Hero guessed: ${INFERNUS.name}`);
  });

  it('a loading-screen read clears the guess', async () => {
    const onGuessed = vi.fn();
    await start({ onGuessed });
    accept(3, 1, INFERNUS.id);
    await waitFor(() => expect(status()).toBe(heroGuessText(INFERNUS.name)));
    await waitFor(() => expect(onLoadingCb).toBeTypeOf('function'));
    act(() => onLoadingCb!(loadingCrop()));
    await waitFor(() => expect(onGuessed).toHaveBeenLastCalledWith(false));
    expect(status()).not.toMatch(/guessed/);
    const before = sent.length;
    accept(1, 1, INFERNUS.id); // the next draft: the loading name holds, no note
    await waitFor(() => expect(sent.slice(before).some((s) => s.draft)).toBe(true));
    expect(lastNote()).toBeNull();
  });

  it('a loading read before the first draft: no guess at all', async () => {
    const onGuessed = vi.fn();
    await start({ onGuessed });
    await waitFor(() => expect(onLoadingCb).toBeTypeOf('function'));
    act(() => onLoadingCb!(loadingCrop()));
    await new Promise((r) => setTimeout(r, 50));
    accept(1, 1, 35); // a portrait read of another hero (Viscous) does not change it
    await waitFor(() => expect(sent.some((s) => s.draft)).toBe(true));
    expect(status()).not.toMatch(/guessed/);
    expect(onGuessed).not.toHaveBeenCalledWith(true);
    expect(lastNote()).toBeNull();
  });

  it('a loading read warms the draft reader once per loading screen, as a round 1 start', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((l: unknown) => void logs.push(String(l)));
    await start();
    await waitFor(() => expect(onLoadingCb).toBeTypeOf('function'));
    posted.length = 0;
    act(() => onLoadingCb!(loadingCrop()));
    await waitFor(() => expect(posted.filter((m) => m.type === 'roundStart')).toHaveLength(1));
    expect(posted.find((m) => m.type === 'roundStart')!.round).toBe(1);
    const iLoad = logs.findIndex((l) => l.includes('"hero.loading"'));
    const iWarm = logs.findIndex((l) => l.includes('"draft.warm"'));
    expect(iLoad).toBeGreaterThanOrEqual(0);
    expect(iWarm).toBeGreaterThan(iLoad);
    await new Promise((r) => setTimeout(r, 20));
    act(() => onLoadingCb!(loadingCrop())); // the same screen sent again: no second warm-up
    await new Promise((r) => setTimeout(r, 50));
    expect(posted.filter((m) => m.type === 'roundStart')).toHaveLength(1);
    spy.mockRestore();
  });

  it('a hand-picked hero clears the guess', async () => {
    const onGuessed = vi.fn();
    const { rerender } = await start({ onGuessed });
    accept(3, 1, INFERNUS.id);
    await waitFor(() => expect(status()).toBe(heroGuessText(INFERNUS.name)));
    rerender({ onGuessed, pinned: true });
    await waitFor(() => expect(onGuessed).toHaveBeenLastCalledWith(false));
    expect(status()).not.toMatch(/guessed/);
  });
});
