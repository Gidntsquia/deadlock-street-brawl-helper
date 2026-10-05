// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { SessionReport } from '../SessionReport';
import type { SessionSummary } from '../../../electron/sessionStore';
import type { Item } from '../../types';

afterEach(cleanup);

const items = [{ id: 7, name: 'Quick Silver' }] as Item[];
const row = (wrong: boolean) => ({
  n: 1,
  wrong,
  round: 2,
  choice: 3,
  startedAt: 0,
  frameW: 1920,
  frameH: 1080,
  items: [7, 0, 7],
  unsure: 1,
  hero: { id: 1, source: 'read' as const },
  shown: {
    plates: [
      { itemId: 7, tier: 1, score: 3 },
      { itemId: 0, tier: 0, score: null },
    ],
    takeId: 7,
    reroll: false,
  },
  adviceMs: 812,
  changes: 1,
  dropouts: 0,
  fallback: true,
  crops: ['data:image/png;base64,AA=='],
});

describe('SessionReport', () => {
  it('lists a row per draft with its facts, and Mark wrong calls the store', async () => {
    let wrong = false;
    const sessionMark = vi.fn((_id: string, _n: number, w: boolean) => {
      wrong = w;
      return Promise.resolve();
    });
    (window as unknown as { brawlAPI: unknown }).brawlAPI = {
      sessionList: () => Promise.resolve([{ id: 'm1', drafts: [row(wrong)] }] as SessionSummary[]),
      sessionMark,
    };
    render(<SessionReport items={items} />);
    await screen.findByText('R2 C3');
    expect(screen.getByText(/Read: Quick Silver, \?, Quick Silver/)).toBeTruthy();
    expect(screen.getByText(/Quick Silver \(take\), \?/)).toBeTruthy();
    expect(screen.getByText(/812 ms/)).toBeTruthy();
    expect(screen.getByText(/changed 1x within set, fallback/)).toBeTruthy();
    expect(screen.getAllByRole('img').length).toBe(1);
    screen.getByRole('button', { name: 'Mark wrong' }).click();
    expect(sessionMark).toHaveBeenCalledWith('m1', 1, true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Marked wrong' })).toBeTruthy());
  });
});
