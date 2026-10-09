// Item stats for one ability order the stored data does not cover (AGENTS.md, Order term). Fetched from deadlock-api
// once when the order is saved and cached under userData; offline the caller gets null and the Order row says no data.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../src/log';

export interface OrderStats {
  order: number[];
  matches: number;
  item_stats: { item_id: number; wins: number; matches: number }[];
}

const API = 'https://api.deadlock-api.com/v1/analytics/item-stats';
const WINDOW_DAYS = 30;

export const orderCacheFile = (dir: string, heroId: number, order: number[]) =>
  path.join(dir, `${heroId}-${order.join('_')}.json`);

export async function fetchOrderStats(
  dir: string,
  heroId: number,
  order: number[],
  get: typeof fetch = fetch,
  now = () => Math.floor(Date.now() / 1000),
): Promise<OrderStats | null> {
  const file = orderCacheFile(dir, heroId, order);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as OrderStats;
  } catch {
    /* not cached yet */
  }
  const url =
    `${API}?hero_id=${heroId}&game_mode=street_brawl&min_unix_timestamp=${now() - WINDOW_DAYS * 86400}` +
    `&ability_order_prefix=${order.join(',')}`;
  log('electron-main', 'info', 'order.fetch', { heroId, order });
  try {
    const res = await get(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as { item_id: number; wins: number; matches: number }[];
    const item_stats = rows.map((s) => ({ item_id: s.item_id, wins: s.wins, matches: s.matches }));
    const out: OrderStats = { order, matches: Math.max(0, ...item_stats.map((s) => s.matches)), item_stats };
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(out));
    return out;
  } catch (e) {
    log('electron-main', 'warn', 'order.fetch.failed', { heroId, order, message: String(e) });
    return null;
  }
}
