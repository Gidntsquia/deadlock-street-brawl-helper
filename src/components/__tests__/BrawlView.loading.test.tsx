// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Ability, Hero, Item } from '../../types';
import type { WorkerIn, WorkerOut } from '../../brawl/worker';
import { useAutoHero } from '../../hooks/useAutoHero';

const readJson = (rel: string) =>
  JSON.parse(readFileSync(path.resolve(__dirname, '../../../public/data', rel), 'utf8'));
vi.mock('../../data/load', () => ({
  j: (rel: string) => Promise.resolve(rel === 'brawl-icons.json' ? {} : readJson(rel)),
  img: (value?: string) => value,
}));
let loading: ((crop: { width: number; height: number; buffer: ArrayBuffer }) => void) | undefined;
const messages: WorkerIn[] = [];
const listeners = new Set<(event: MessageEvent<WorkerOut>) => void>();
(window as unknown as { brawlAPI: unknown }).brawlAPI = {
  getGameRect: () => Promise.resolve(null),
  onGameRect: () => () => {},
  getCaptureState: () => Promise.resolve({ wanted: false, probe: true }),
  onCaptureState: () => () => {},
  onLoadingName: (callback: typeof loading) => {
    loading = callback;
    return () => {
      loading = undefined;
    };
  },
  onCaptureDenied: () => () => {},
  onTestMode: () => () => {},
  getTestMode: () => Promise.resolve({ on: false, frame: '', frames: [], message: null }),
  getPlatformWarning: () => Promise.resolve(null),
  sendOverlayState: () => {},
};
(globalThis as unknown as { Worker: unknown }).Worker = class {
  postMessage(message: WorkerIn) {
    messages.push(message);
  }
  terminate() {}
  addEventListener(_: string, callback: (event: MessageEvent<WorkerOut>) => void) {
    listeners.add(callback);
  }
  removeEventListener(_: string, callback: (event: MessageEvent<WorkerOut>) => void) {
    listeners.delete(callback);
  }
};
const { BrawlView } = await import('../BrawlView');
afterEach(() => {
  cleanup();
  messages.length = 0;
  listeners.clear();
  localStorage.clear();
});

it('reads loading names through the warmed worker while capture is off, ignores obsolete jobs, and retains a manual override until Auto', async () => {
  const heroes = readJson('heroes.json') as Hero[],
    items = readJson('items.json') as Item[],
    abilities = readJson('abilities.json') as Ability[];
  localStorage.setItem('brawl.firstRunDone', 'true');
  const capture = vi.fn();
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = { getDisplayMedia: capture };
  function Harness() {
    const [id, setId] = useState(1);
    const auto = useAutoHero(setId);
    return (
      <>
        <output aria-label="Observed hero">{id}</output>
        <button onClick={() => auto.choose(76)}>Manual hero</button>
        <button onClick={auto.resumeAuto}>Resume automatic hero</button>
        <BrawlView
          hero={heroes.find((hero) => hero.id === id)!}
          heroes={heroes}
          items={items}
          abilities={abilities}
          onHero={auto.choose}
          pinned={auto.pinned}
          onNewMatch={auto.newMatch}
        />
      </>
    );
  }
  render(<Harness />);
  await waitFor(() => expect(loading).toBeTypeOf('function'));
  const crop = () => ({ width: 2, height: 2, buffer: new ArrayBuffer(16) });
  act(() => loading!(crop()));
  await waitFor(() => expect(messages.filter((message) => message.type === 'loadingName')).toHaveLength(1));
  const first = messages.find(
    (message): message is Extract<WorkerIn, { type: 'loadingName' }> => message.type === 'loadingName',
  )!;
  expect(first.names[67]).toBe(heroes.find((hero) => hero.id === 67)!.name);
  act(() => loading!(crop()));
  await waitFor(() => expect(messages.filter((message) => message.type === 'loadingName')).toHaveLength(2));
  const second = messages
    .filter((message): message is Extract<WorkerIn, { type: 'loadingName' }> => message.type === 'loadingName')
    .at(-1)!;
  const reply = (requestId: number, heroId: number) =>
    act(() =>
      listeners.forEach((listener) =>
        listener({ data: { type: 'loadingHero', requestId, heroId, text: 'hero' } } as MessageEvent<WorkerOut>),
      ),
    );
  reply(first.requestId, 67);
  expect(screen.getByLabelText('Observed hero').textContent).toBe('1');
  fireEvent.click(screen.getByRole('button', { name: 'Manual hero' }));
  reply(second.requestId, 64);
  expect(screen.getByLabelText('Observed hero').textContent).toBe('76');
  fireEvent.click(screen.getByRole('button', { name: 'Resume automatic hero' }));
  expect(screen.getByLabelText('Observed hero').textContent).toBe('64');
  expect(capture).not.toHaveBeenCalled();
});
