// Loads the real snapshot from public/data for the brawl tests, so nothing is invented. Node-only
// (uses node:fs); vitest runs the whole suite in Node by default so this is safe to import anywhere.
import { readFileSync } from 'node:fs';
import type { Ability, Hero, Item } from '../../types';
import type { BrawlAnalytics, BrawlConfig, BrawlInput } from '../types';
import type { BrawlTierListData } from '../tierlist';

const read = <T>(p: string): T => JSON.parse(readFileSync(`public/data/${p}`, 'utf8'));

export const heroes: Hero[] = read('heroes.json');
export const items: Item[] = read('items.json');
export const abilities: Ability[] = read('abilities.json');
export const config: BrawlConfig = read('brawl-config.json');
export const tierList: BrawlTierListData = read('analytics/brawl/tier-list.json');

export const heroByName = (name: string): Hero => {
  const h = heroes.find((x) => x.name === name);
  if (!h) throw new Error(`unknown hero "${name}" in fixtures/heroes.json`);
  return h;
};
export const itemByName = (name: string): Item => {
  const i = items.find((x) => x.name === name);
  if (!i) throw new Error(`unknown item "${name}" in fixtures/items.json`);
  return i;
};

export function inputFor(heroId: number): BrawlInput {
  const hero = heroes.find((h) => h.id === heroId);
  if (!hero) throw new Error(`hero ${heroId} not in snapshot`);
  const analytics: BrawlAnalytics = read(`analytics/brawl/${heroId}.json`);
  return { hero, abilities, items, analytics, config };
}
