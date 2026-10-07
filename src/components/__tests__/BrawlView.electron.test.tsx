// @vitest-environment jsdom
// Electron-only capture-denied path: BrawlView reads `window.brawlAPI`, so it must exist before the
// module under test is imported (isElectron is computed once at module scope).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Ability, Hero, Item } from '../../types';
import { PROBLEM_TEXT } from '../../brawl/problems';

const root = path.resolve(__dirname, '../../../public/data/');
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

vi.mock('../../data/load', () => ({
  j: (rel: string) => Promise.resolve(readJson(rel)),
  img: (p?: string) => p,
}));

type CaptureState = { wanted: boolean; probe: boolean };
let onCaptureStateCb: ((st: CaptureState) => void) | undefined;
let captureState: CaptureState = { wanted: false, probe: false };
const captureIdle = vi.fn();
let onProblemCb: ((p: unknown) => void) | undefined;

(window as unknown as { brawlAPI: unknown }).brawlAPI = {
  isElectron: true,
  getGameRect: () => Promise.resolve(null),
  onGameRect: () => () => {},
  getCaptureState: () => Promise.resolve(captureState),
  onLoadingName: () => () => {},
  onCaptureState: (cb: typeof onCaptureStateCb) => {
    onCaptureStateCb = cb;
    return () => {
      onCaptureStateCb = undefined;
    };
  },
  captureIdle,
  sendOverlayState: () => {},
  onOverlayState: () => () => {},
  onCaptureDenied: () => () => {},
  onTestMode: () => () => {},
  getTestMode: () => Promise.resolve({ on: false, frame: '', frames: [], message: null }),
  getPlatformWarning: () => Promise.resolve(null),
  getProblem: () => Promise.resolve(null),
  onProblem: (cb: (p: unknown) => void) => {
    onProblemCb = cb;
    return () => {
      onProblemCb = undefined;
    };
  },
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

const props = (debug = false) => {
  const heroes = readJson('heroes.json') as Hero[];
  const items = readJson('items.json') as Item[];
  const abilities = readJson('abilities.json') as Ability[];
  return { hero: heroes.find((h) => h.id === 1)!, heroes, items, abilities, onHero: () => {}, debug };
};
const calls = () => (window as unknown as { __getDisplayMediaCalls: () => number }).__getDisplayMediaCalls();

describe('BrawlView main view (Electron)', () => {
  beforeEach(() => {
    localStorage.setItem('brawl.firstRunDone', 'true');
    onCaptureStateCb = undefined;
    captureState = { wanted: false, probe: true };
    let n = 0;
    (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getDisplayMedia: vi.fn(() => {
        n++;
        return Promise.reject(new DOMException('nope', 'AbortError'));
      }),
    };
    (window as unknown as { __getDisplayMediaCalls: () => number }).__getDisplayMediaCalls = () => n;
  });

  it('shows Waiting for Deadlock and no capture or Detect buttons', async () => {
    const { container } = render(<BrawlView {...props()} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Waiting for Deadlock'));
    expect(screen.queryByRole('button', { name: /start capture|stop capture|detect now/i })).toBeNull();
    expect(container.querySelectorAll('select').length).toBe(0);
    // The only other thing in the main view is the collapsed ability order editor.
    const editor = container.querySelector('details.brawl-my-order')!;
    expect(editor.hasAttribute('open')).toBe(false);
    editor.remove();
    expect(container.textContent).not.toMatch(/top items|Owned|Cards on screen|Ability order|Round|Debug/);
  });

  it('shows Ready once the game window is found', async () => {
    const api = (window as unknown as { brawlAPI: Record<string, unknown> }).brawlAPI;
    api.getGameRect = () => Promise.resolve({ x: 0, y: 0, width: 1920, height: 1080 });
    render(<BrawlView {...props()} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Ready. Open a Street Brawl draft'));
    api.getGameRect = () => Promise.resolve(null);
  });

  it('does not start capturing until main.ts says the draft probe hit', async () => {
    render(<BrawlView {...props()} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls()).toBe(0);
    onCaptureStateCb?.({ wanted: true, probe: true });
    await waitFor(() => expect(calls()).toBe(1));
  });

  it('shows each problem as one sentence with the fix, and clears it', async () => {
    render(<BrawlView {...props()} />);
    await waitFor(() => expect(onProblemCb).toBeTypeOf('function'));
    for (const kind of ['fullscreen', 'small', 'denied', 'f8'] as const) {
      act(() => onProblemCb!(kind));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(PROBLEM_TEXT[kind]));
    }
    act(() => onProblemCb!(null));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('First-run check (Electron)', () => {
  it('shows three lines and Show me, runs the test-mode draft, and is not shown again once dismissed', async () => {
    localStorage.clear();
    const api = (window as unknown as { brawlAPI: Record<string, unknown> }).brawlAPI;
    const st = { on: true, frame: 'choice1', frames: ['choice1'], message: null };
    api.setTestMode = vi.fn(() => Promise.resolve(st));
    api.setTestFrame = vi.fn(() => Promise.resolve(st));
    api.getEnv = () =>
      Promise.resolve({
        found: true,
        width: 1920,
        height: 1080,
        borderless: true,
        black: false,
        denied: false,
        f8InUse: false,
      });
    const { unmount } = render(<BrawlView {...props()} />);
    const box = await screen.findByLabelText('First-run check');
    expect(box.querySelectorAll('li').length).toBe(3);
    await waitFor(() => expect(box.textContent).toContain('Deadlock found ok'));
    expect(box.textContent).toContain('Borderless Windowed ok');
    expect(box.textContent).toContain('Resolution readable ok');
    screen.getByRole('button', { name: 'Show me' }).click();
    await waitFor(() => expect(api.setTestFrame).toHaveBeenCalledWith('choice1'));
    expect(api.setTestMode).toHaveBeenCalledWith(true);
    unmount();
    render(<BrawlView {...props()} />);
    await screen.findByRole('status');
    expect(screen.queryByLabelText('First-run check')).toBeNull();
  });

  it('shows an instruction with no tick when Borderless cannot be detected', async () => {
    localStorage.clear();
    const api = (window as unknown as { brawlAPI: Record<string, unknown> }).brawlAPI;
    api.getEnv = () =>
      Promise.resolve({
        found: true,
        width: 1920,
        height: 1080,
        borderless: null,
        black: false,
        denied: false,
        f8InUse: false,
      });
    render(<BrawlView {...props()} />);
    const box = await screen.findByLabelText('First-run check');
    await waitFor(() => expect(box.textContent).toContain('Set Display Mode to Borderless Windowed in Video settings'));
    expect(box.textContent).not.toContain('Borderless Windowed ok');
    expect(box.textContent).not.toContain('Borderless Windowed not yet');
  });
});

describe('BrawlView Debug panel (Electron)', () => {
  it('holds the capture and Detect now buttons, and Detect now needs a game', async () => {
    const api = (window as unknown as { brawlAPI: Record<string, unknown> }).brawlAPI;
    let runCb: (() => void) | undefined;
    api.getGameRect = () => Promise.resolve({ x: 0, y: 0, width: 1920, height: 1080 });
    api.onDetectRun = (cb: () => void) => {
      runCb = cb;
      return () => {};
    };
    api.detectNow = vi.fn(() => Promise.resolve(true));
    captureState = { wanted: false, probe: true };
    (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getDisplayMedia: vi.fn(() => new Promise(() => {})),
    };
    render(<BrawlView {...props(true)} />);
    expect(screen.getByRole('button', { name: /start capture/i })).toBeTruthy();
    const detect = (await screen.findByRole('button', { name: /detect now \(f8\)/i })) as HTMLButtonElement;
    await waitFor(() => expect(detect.disabled).toBe(false));
    detect.click();
    expect(api.detectNow).toHaveBeenCalled();
    runCb!();
    await waitFor(() => expect(screen.getByRole('status').textContent).not.toBe('Waiting for Deadlock'));
  });
});
