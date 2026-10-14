// @vitest-environment jsdom
// A late ENHANCED mark (the box fades in after the name, so the worker re-accepts the same three items with the flag):
// the overlay must be sent the new ranking, not keep the plates it froze for the plain set. s2 d006 of the OBS recording
// (Ricochet / Healing Tempo / Transcendent Cooldown, Infernus round 5) stayed on Ricochet because the page sent the
// re-accepted set with the old ranking and then held it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { Ability, Hero, Item } from '../../types';
import type { OverlayState } from '../../brawl/draw';

const root = path.resolve(__dirname, '../../../public/data/');
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

vi.mock('../../data/load', () => ({
  j: (rel: string) => Promise.resolve(rel === 'brawl-icons.json' ? {} : readJson(rel)),
  img: (p?: string) => p,
}));

const sent: OverlayState[] = [];
(window as unknown as { brawlAPI: unknown }).brawlAPI = {
  isElectron: true,
  getGameRect: () => Promise.resolve({ x: 0, y: 0, width: 1920, height: 1080 }),
  onGameRect: () => () => {},
  getCaptureState: () => Promise.resolve({ wanted: true, probe: false }),
  onLoadingName: () => () => {},
  onCaptureState: () => () => {},
  captureIdle: () => {},
  sendOverlayState: (s: OverlayState) => sent.push(s),
  onOverlayState: () => () => {},
  onCaptureDenied: () => () => {},
  onTestMode: () => () => {},
  getTestMode: () => Promise.resolve({ on: false, frame: '', frames: [], message: null }),
  getPlatformWarning: () => Promise.resolve(null),
  getProblem: () => Promise.resolve(null),
  readText: () => Promise.resolve({ text: '', ms: 0 }),
  getReaderState: () => Promise.resolve('ready'),
  onReaderState: () => () => {},
  onProblem: () => () => {},
};

const listeners: ((e: MessageEvent) => void)[] = [];
(globalThis as unknown as { Worker: unknown }).Worker = class {
  postMessage() {}
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

const { BrawlView } = await import('../BrawlView');
afterEach(cleanup);

const heroes = readJson('heroes.json') as Hero[];
const items = readJson('items.json') as Item[];
const abilities = readJson('abilities.json') as Ability[];
const id = (name: string) => items.find((i) => i.name === name && !i.disabled)!.id;
const set = ['Ricochet', 'Healing Tempo', 'Transcendent Cooldown'].map(id);
const tc = id('Transcendent Cooldown');

const read = (itemId: number, enhanced: boolean) => ({
  card: 'c',
  match: { score: 1 },
  present: true,
  itemId,
  tier: 4,
  rare: false,
  enhanced,
});
const send = (data: object) => act(() => listeners.forEach((l) => l({ data } as MessageEvent)));
const accept = (enhancedTc: boolean) =>
  send({
    type: 'result',
    shop: true,
    round: 5,
    choice: 1,
    reads: set.map((i) => read(i, enhancedTc && i === tc)),
    key: set.map((i) => `${i}${enhancedTc && i === tc ? '+' : ''}`).join(','),
    accepted: true,
    live: true,
    picked: null,
    spent: false,
    meta: { round: 5, choice: 1, bar: { left: [], right: [] }, self: 1, rerollsRemaining: 1 },
    inventory: null,
    ms: 5,
  });
const lastDraft = () => [...sent].reverse().find((s) => s.draft && s.reads.length);

describe('BrawlView with a late ENHANCED mark', () => {
  it('sends the overlay the re-ranked set once the mark shows up after the accept', async () => {
    localStorage.setItem('brawl.firstRunDone', 'true');
    render(
      <BrawlView
        hero={heroes.find((h) => h.id === 1)!}
        heroes={heroes}
        items={items}
        abilities={abilities}
        onHero={() => {}}
      />,
    );
    await waitFor(() => expect(listeners.length).toBeGreaterThanOrEqual(2));
    accept(false);
    await waitFor(() => expect(lastDraft()?.bestId).toBe(id('Ricochet')));
    accept(true);
    await waitFor(() => expect(lastDraft()?.bestId).toBe(tc));
    const s = lastDraft()!;
    expect(s.advice?.ranked[0]).toMatchObject({ itemId: tc, enhanced: true });
    expect(s.reads.find((r) => r.itemId === tc)?.enhanced).toBe(true);
  });
});
