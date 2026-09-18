// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Ability, Hero, Item } from '../../types';
import { BrawlView } from '../BrawlView';

const root = path.resolve(__dirname, '../../../public/data/');
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

vi.mock('../../data/load', () => ({
  j: (rel: string) => Promise.resolve(readJson(rel)),
  img: (p?: string) => p,
}));

afterEach(cleanup);

describe('BrawlView', () => {
  it('keeps the same <video> element instance across a hero change', async () => {
    const heroes = readJson('heroes.json') as Hero[];
    const items = readJson('items.json') as Item[];
    const abilities = readJson('abilities.json') as Ability[];
    const hero1 = heroes.find((h) => h.id === 1)!;
    const hero2 = heroes.find((h) => h.id !== 1)!;

    const { rerender, container } = render(
      <BrawlView hero={hero1} heroes={heroes} items={items} abilities={abilities} onHero={() => {}} />,
    );
    const before = container.querySelector('video');
    expect(before).not.toBeNull();

    // rerender before the new hero's analytics promise has resolved
    rerender(<BrawlView hero={hero2} heroes={heroes} items={items} abilities={abilities} onHero={() => {}} />);
    expect(container.querySelector('video')).toBe(before);

    // and after it resolves
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('video')).toBe(before);
  });
});
