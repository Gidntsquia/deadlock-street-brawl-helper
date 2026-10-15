// Every fixture made by `npm run brawl:fixture` is replayed through the real worker and must now read cleanly.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { adviseDraft, type BrawlInput, type Offer } from '../../src/brawl';
import type { BrawlAnalytics, BrawlConfig } from '../../src/brawl/types';
import type { Ability, Hero, Item } from '../../src/types';
import type { FixtureExpect } from '../session-fixture';
import { replayDraft } from '../replay';

vi.setConfig({ testTimeout: 120_000 });
const root = path.join('scripts', 'fixtures', 'sessions');
const dirs = existsSync(root) ? readdirSync(root).sort() : [];
const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
const name = (id: number) => items.find((i) => i.id === id)?.name ?? `#${id}`;
const data = <T>(p: string): T => JSON.parse(readFileSync(path.join('public', 'data', p), 'utf8'));

describe('session fixtures', () => {
  it.each(dirs)('%s reads cleanly', async (d) => {
    const dir = path.join(root, d);
    const want: FixtureExpect = JSON.parse(readFileSync(path.join(dir, 'expect.json'), 'utf8'));
    const got = await replayDraft(dir);
    expect(got.stats.unsure).toBe(want.unsure);
    expect(got.stats.changes).toBe(want.changes);
    expect(got.stats.dropouts).toBe(want.dropouts);
    if (want.items) expect(got.stats.items.map(name)).toEqual(want.items);
    else expect(got.stats.items.every(Boolean)).toBe(true);
    if (want.best !== undefined || want.reroll !== undefined) {
      // the advice the app would give on the replayed read: the own hero, enemies and owned items the worker read
      expect(got.hero).toBeGreaterThan(0);
      const heroes = data<Hero[]>('heroes.json');
      const hero = heroes.find((h) => h.id === got.hero)!;
      const abilities = data<Ability[]>('abilities.json');
      const input: BrawlInput = {
        hero,
        abilities,
        items,
        analytics: data<BrawlAnalytics>(`analytics/brawl/${hero.id}.json`),
        config: data<BrawlConfig>('brawl-config.json'),
      };
      const sets: Offer[][] = [[], [], []];
      sets[got.choice - 1] = got.stats.items.map((itemId, i) => ({ itemId, enhanced: got.enhanced[i] ?? false }));
      const advice = adviseDraft(input, {
        round: got.round,
        owned: got.inventory ?? [],
        enemies: got.enemies,
        sets,
      });
      if (want.best !== undefined) expect(advice.sets[got.choice - 1]?.[0]?.item.name).toBe(want.best);
      if (want.reroll !== undefined) expect(advice.reroll !== null).toBe(want.reroll);
    }
  });
  it('has the tooling to add them', () => {
    expect(existsSync(path.join('scripts', 'session-fixture.ts'))).toBe(true);
  });
});
