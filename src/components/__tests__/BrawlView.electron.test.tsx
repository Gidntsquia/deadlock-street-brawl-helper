// @vitest-environment jsdom
// Electron-only capture-denied path: BrawlView reads `window.brawlAPI`, so it must exist before the
// module under test is imported (isElectron is computed once at module scope).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Ability, Hero, Item } from '../../types';

const root = path.resolve(__dirname, '../../../public/data/');
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

vi.mock('../../data/load', () => ({
  j: (rel: string) => Promise.resolve(readJson(rel)),
  img: (p?: string) => p,
}));

let onCaptureDeniedCb: (() => void) | undefined;
let onGameRectCb: ((rect: { x: number; y: number; width: number; height: number } | null) => void) | undefined;

(window as unknown as { brawlAPI: unknown }).brawlAPI = {
  isElectron: true,
  getGameRect: () => Promise.resolve(null),
  onGameRect: (cb: typeof onGameRectCb) => {
    onGameRectCb = cb;
    return () => {
      onGameRectCb = undefined;
    };
  },
  sendOverlayState: () => {},
  onOverlayState: () => () => {},
  onCaptureDenied: (cb: () => void) => {
    onCaptureDeniedCb = cb;
    return () => {
      onCaptureDeniedCb = undefined;
    };
  },
  onOverlayDemoStart: () => () => {},
  onOverlayDemoStop: () => () => {},
  getPendingDemoFrame: () => Promise.resolve(null),
  getPlatformWarning: () => Promise.resolve(null),
};

// jsdom has no Worker; BrawlView only needs postMessage/terminate to exist for these tests.
(globalThis as unknown as { Worker: unknown }).Worker = class {
  postMessage() {}
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
};

const { BrawlView } = await import('../BrawlView');

afterEach(cleanup);

describe('BrawlView (Electron capture-denied)', () => {
  beforeEach(() => {
    onCaptureDeniedCb = undefined;
    onGameRectCb = undefined;
    let calls = 0;
    (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getDisplayMedia: vi.fn(() => {
        calls++;
        // main.ts sends the capture-denied IPC just before the renderer's getDisplayMedia() promise rejects
        onCaptureDeniedCb?.();
        const err = new DOMException('Error starting capture', 'AbortError');
        return Promise.reject(err);
      }),
    };
    (window as unknown as { __getDisplayMediaCalls: () => number }).__getDisplayMediaCalls = () => calls;
  });

  it('shows "Deadlock window not found" and does not clear it, and does not retry without a rect change', async () => {
    const heroes = readJson('heroes.json') as Hero[];
    const items = readJson('items.json') as Item[];
    const abilities = readJson('abilities.json') as Ability[];
    const hero = heroes.find((h) => h.id === 1)!;

    render(<BrawlView hero={hero} heroes={heroes} items={items} abilities={abilities} onHero={() => {}} />);

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Deadlock window not found'));

    const calls = () => (window as unknown as { __getDisplayMediaCalls: () => number }).__getDisplayMediaCalls();
    const after1 = calls();
    // simulate rect ticks that never actually find the game (null -> null): must not retry
    onGameRectCb?.(null);
    onGameRectCb?.(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls()).toBe(after1);
    expect(screen.getByRole('status').textContent).toContain('Deadlock window not found');
  });

  it('retries once the game window is found after a denial', async () => {
    const heroes = readJson('heroes.json') as Hero[];
    const items = readJson('items.json') as Item[];
    const abilities = readJson('abilities.json') as Ability[];
    const hero = heroes.find((h) => h.id === 1)!;

    render(<BrawlView hero={hero} heroes={heroes} items={items} abilities={abilities} onHero={() => {}} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Deadlock window not found'));

    const calls = () => (window as unknown as { __getDisplayMediaCalls: () => number }).__getDisplayMediaCalls();
    const before = calls();
    onGameRectCb?.({ x: 0, y: 0, width: 1280, height: 720 });
    await waitFor(() => expect(calls()).toBe(before + 1));
  });

  it('shows "capture failed: <message>" for an AbortError that is not accompanied by the capture-denied IPC', async () => {
    (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      // Same AbortError shape as a real denial, but main.ts never sent the capture-denied IPC for it —
      // must not be guessed as a denial from the error's name/message alone.
      getDisplayMedia: vi.fn(() => Promise.reject(new DOMException('Error starting capture', 'AbortError'))),
    };
    const heroes = readJson('heroes.json') as Hero[];
    const items = readJson('items.json') as Item[];
    const abilities = readJson('abilities.json') as Ability[];
    const hero = heroes.find((h) => h.id === 1)!;

    render(<BrawlView hero={hero} heroes={heroes} items={items} abilities={abilities} onHero={() => {}} />);

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('capture failed:'));
    expect(screen.getByRole('status').textContent).not.toContain('Deadlock window not found');
  });
});
