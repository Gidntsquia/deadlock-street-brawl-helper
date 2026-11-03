import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchHeroName, nameList } from '../../src/brawl/names';

const heroes = JSON.parse(readFileSync('public/data/heroes.json', 'utf8')) as { id: number; name: string }[];
const index = JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')) as {
  size: number;
  heroes: Record<string, string>;
};

describe('Violet (86) and Nurse Harrow (87)', () => {
  for (const [id, name] of [
    [86, 'Violet'],
    [87, 'Nurse Harrow'],
  ] as const) {
    it(`${name} is in the hero list with portraits, the portrait index and the required list`, () => {
      expect(heroes.find((h) => h.id === id)?.name).toBe(name);
      expect(existsSync(`public/data/img/heroes/${id}.webp`)).toBe(true);
      expect(existsSync(`public/data/img/heroes/${id}-card.webp`)).toBe(true);
      expect(index.heroes[String(id)]).toBeTruthy();
      expect(readFileSync('scripts/fetch-data.mjs', 'utf8')).toMatch(
        new RegExp(`REQUIRED_HEROES = \\[[^\\]]*\\b${id}\\b`),
      );
    });

    it(`${name}: the loading screen name reads to the hero`, () => {
      const list = nameList(
        heroes.map((h) => h.id),
        Object.fromEntries(heroes.map((h) => [h.id, h.name])),
      );
      expect(matchHeroName(name.toUpperCase(), list)?.itemId).toBe(id);
    });

    it(`${name}: the portrait differs from every other hero's (nearest portrait is itself)`, () => {
      const px = (k: string) => Buffer.from(index.heroes[k]!, 'base64');
      const own = px(String(id));
      const dist = (a: Buffer, b: Buffer) => {
        let d = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++) d += Math.abs(a[i]! - b[i]!);
        return d;
      };
      const others = Object.keys(index.heroes)
        .filter((k) => k !== String(id))
        .map((k) => dist(own, px(k)));
      expect(Math.min(...others)).toBeGreaterThan(0);
    });
  }
});
