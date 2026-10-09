import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { fetchOrderStats } from '../orderFetch';

const dir = mkdtempSync(path.join(os.tmpdir(), 'brawl-order-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ok = () =>
  vi.fn(
    async (_u: string) =>
      ({ ok: true, json: async () => [{ item_id: 5, wins: 6, matches: 10, extra: 1 }] }) as Response,
  );

describe('fetchOrderStats', () => {
  it('fetches the exact prefix once, caches it, and serves the cache without the network', async () => {
    const get = ok();
    const a = await fetchOrderStats(dir, 7, [1, 2, 3], get as unknown as typeof fetch, () => 2_000_000);
    expect(get).toHaveBeenCalledTimes(1);
    const url = String(get.mock.calls[0]![0]);
    expect(url).toContain('hero_id=7');
    expect(url).toContain('game_mode=street_brawl');
    expect(url).toContain('ability_order_prefix=1,2,3');
    expect(a).toEqual({ order: [1, 2, 3], matches: 10, item_stats: [{ item_id: 5, wins: 6, matches: 10 }] });
    expect(readdirSync(dir)).toEqual(['7-1_2_3.json']);
    const offline = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await fetchOrderStats(dir, 7, [1, 2, 3], offline as unknown as typeof fetch)).toEqual(a);
    expect(offline).not.toHaveBeenCalled();
  });
  it('returns null offline and caches nothing', async () => {
    const down = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await fetchOrderStats(dir, 7, [9, 9], down as unknown as typeof fetch)).toBeNull();
    expect(readdirSync(dir)).toEqual(['7-1_2_3.json']);
  });
});
