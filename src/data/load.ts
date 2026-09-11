import type { Ability, Hero, HeroAnalytics, Item } from '../types';

export const base = `${(import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"}data/`;
export async function j<T>(rel: string): Promise<T> {
  const r = await fetch(base + rel);
  if (!r.ok) throw new Error(`Missing snapshot ${rel} – run \`npm run fetch-data\``);
  return r.json();
}
/** How a representative player was picked for a hero (absent on older snapshots with one hand-picked player per hero). */
export interface ValidationSelection { rank: number; recent_matches: number; recent_wins: number; total_hero_matches: number; last_played: number; score: number }
export interface ValidationSetRef { account_id: number; player: string; hero_id: number; hero: string; file: string; matches: number; selection?: ValidationSelection }
export interface Manifest { fetched_at: string; window_days: number; counts: Record<string, number>; validation_sets?: ValidationSetRef[] }
export const loadCore = () => Promise.all([j<Item[]>('items.json'), j<Hero[]>('heroes.json'), j<Ability[]>('abilities.json'), j<Manifest>('manifest.json')]);
export const loadAnalytics = (heroId: number) => j<HeroAnalytics>(`analytics/${heroId}.json`);

/** Image fields in the snapshot are app-relative (img/...) after fetch-data; absolute URLs pass through. */
export const img = (p?: string) => (!p ? undefined : /^https?:/.test(p) ? p : base + p);
