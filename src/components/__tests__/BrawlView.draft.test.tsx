// @vitest-environment jsdom
// Drives the page with worker results (a fake worker) to check what it does with an accepted draft: the hero line when
// the hero was not read, and the owned list at the start of a match.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Ability, Hero, Item } from '../../types';

const root = path.resolve(__dirname, '../../../public/data/');
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

vi.mock('../../data/load', () => ({
  j: (rel: string) => Promise.resolve(rel === 'brawl-icons.json' ? {} : readJson(rel)),
  img: (p?: string) => p,
}));

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
const cardIds = items.filter((i) => i.item_tier >= 1 && !i.disabled).slice(0, 3);

const read = (id: number) => ({
  card: 'c',
  match: { score: 1 },
  present: true,
  itemId: id,
  tier: 1,
  rare: false,
  enhanced: false,
});
const bar = { left: [], right: [] };
const send = (data: object) => act(() => listeners.forEach((l) => l({ data } as MessageEvent)));
const accept = (round: number, choice: number, self: number, inventory: number[] | null = null) =>
  send({
    type: 'result',
    shop: true,
    round,
    choice,
    reads: cardIds.map((c) => read(c.id)),
    key: cardIds.map((c) => c.id).join(','),
    accepted: true,
    transition: 'initial',
    live: true,
    picked: null,
    spent: false,
    meta: { round, choice, bar, self, rerollsRemaining: 0 },
    inventory,
    ms: 5,
  });

async function start() {
  render(
    <BrawlView
      hero={heroes.find((h) => h.id === 1)!}
      heroes={heroes}
      items={items}
      abilities={abilities}
      onHero={() => {}}
      debug
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /start capture/i }));
  await waitFor(() => expect(listeners.length).toBeGreaterThan(1));
}

describe('BrawlView with an accepted draft', () => {
  it('says Hero not read and names the selected hero when the portrait is not read', async () => {
    await start();
    accept(1, 1, 0);
    await waitFor(() => expect(screen.getByText(/^Hero not read\. Using /)).toBeTruthy());
    expect(screen.getByText(/^Hero not read\. Using /).textContent).toBe(
      `Hero not read. Using ${heroes.find((h) => h.id === 1)!.name}`,
    );
    accept(1, 2, 1);
    await waitFor(() => expect(screen.queryByText(/^Hero not read/)).toBeNull());
  });

  it('keeps match inventory through an unconfirmed round 1 label', async () => {
    await start();
    accept(2, 1, 1, [cardIds[0]!.id]);
    await waitFor(() => expect(screen.getByText(/^Owned \(1\)/)).toBeTruthy());
    accept(1, 1, 1);
    await waitFor(() => expect(screen.getByText(/^Owned \(1\)/)).toBeTruthy());
  });
});
