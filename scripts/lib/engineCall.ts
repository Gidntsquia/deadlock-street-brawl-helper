// The engine's call on a read set, for the replay tests: the same inputs the page uses (own hero, enemies, owned items).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { adviseDraft, type BrawlInput, type Offer } from '../../src/brawl';
import type { BrawlAnalytics, BrawlConfig } from '../../src/brawl/types';
import type { Ability, Hero, Item } from '../../src/types';

const data = <T>(p: string): T => JSON.parse(readFileSync(path.join('public', 'data', p), 'utf8'));
let cache: { heroes: Hero[]; items: Item[]; abilities: Ability[]; config: BrawlConfig } | null = null;

export function engineCall(
  heroId: number,
  round: number,
  choice: number,
  offers: Offer[],
  owned: number[],
  enemies: number[],
) {
  cache ??= {
    heroes: data<Hero[]>('heroes.json'),
    items: data<Item[]>('items.json'),
    abilities: data<Ability[]>('abilities.json'),
    config: data<BrawlConfig>('brawl-config.json'),
  };
  const hero = cache.heroes.find((h) => h.id === heroId);
  if (!hero) return null;
  const input: BrawlInput = {
    hero,
    abilities: cache.abilities,
    items: cache.items,
    analytics: data<BrawlAnalytics>(`analytics/brawl/${hero.id}.json`),
    config: cache.config,
  };
  const sets: Offer[][] = [[], [], []];
  sets[choice - 1] = offers;
  const advice = adviseDraft(input, { round, owned, enemies, sets });
  return { reroll: advice.reroll !== null, best: advice.sets[choice - 1]?.[0]?.item.name ?? '' };
}
