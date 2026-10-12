// The name reader not running (main's `readerState` down): the worker makes no name reads and takes no icon guess, so
// every card of a draft that is still on screen at the fallback shows a grey `?`, and it keeps running.
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { replayDraft } from '../replay';

vi.setConfig({ testTimeout: 120_000 });
const dir = path.join('scripts', 'fixtures', 'sessions', 'm-20261005T050819-atvp-d004');

describe('reader down', () => {
  it('shows every card as ? at the fallback and makes no name read', async () => {
    const results: { present: boolean; unsure?: boolean; itemId: number }[][] = [];
    let cardAt: number | null = null,
      qAt: number | null = null;
    const down = await replayDraft(dir, {
      readerDown: true,
      hold: 6,
      onResult: (_f, res, t) => {
        results.push(res.reads);
        if (res.shop && (res.shown ?? 0) > 0) cardAt ??= t;
        if (res.reads.some((c) => c.unsure)) qAt ??= t;
      },
    });
    const shown = results.filter((r) => r.some((c) => c.present || c.unsure));
    expect(shown.length).toBeGreaterThan(0);
    // the `?` plates come 1 s after the first card showed (frames of this recording are up to ~300 ms apart)
    expect(qAt! - cardAt!).toBeGreaterThanOrEqual(1000);
    expect(qAt! - cardAt!).toBeLessThan(1400);
    for (const reads of shown) expect(reads.every((c) => !!c.unsure)).toBe(true);
    expect(down.stats.unsure).toBe(3);
    expect(down.unsureLog.some((l) => l.endsWith(':reader-down'))).toBe(false);
    // and back up: the same draft reads its three items
    const up = await replayDraft(dir);
    expect(up.stats.items.every(Boolean)).toBe(true);
  });
});
