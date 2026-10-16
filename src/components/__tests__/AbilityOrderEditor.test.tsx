// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AbilityOrderEditor } from '../AbilityOrderEditor';
import { BrawlView } from '../BrawlView';
import {
  abilityPanelFor,
  brawlAbilityOrder,
  customOrderProblem,
  NOT_BOUGHT,
  type CustomOrder,
} from '../../brawl/abilities';
import { heroByName, inputFor } from '../../brawl/__tests__/testData';
import type { Ability, Hero, Item } from '../../types';

const root = path.resolve(__dirname, '../../../public/data/');
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
vi.mock('../../data/load', () => ({
  j: (rel: string) => Promise.resolve(readJson(rel)),
  img: (p?: string) => p,
}));

const ABILITIES = ['Catalyst', 'Flame Dash', 'Afterburn', 'Concussive Combustion'].map((name, i) => ({
  name,
  icon: '',
  key: 'QERF'[i]!,
}));
const EMPTY: CustomOrder = Array(12).fill(NOT_BOUGHT);
const STANDARD: CustomOrder = [1, 2, 3, 1, 2, 4, 1, 3, 5, 2, 4, 5];

/** The editor with its value held in state, like BrawlView holds it. */
function Harness({ start, onValue }: { start: CustomOrder | null; onValue?: (v: CustomOrder | null) => void }) {
  const [value, setValue] = useState<CustomOrder | null>(start);
  return (
    <AbilityOrderEditor
      heroName="Infernus"
      abilities={ABILITIES}
      standard={STANDARD}
      defaultEvidence="1000 matches, 55% win rate"
      value={value}
      onChange={(v) => {
        setValue(v);
        onValue?.(v);
      }}
    />
  );
}
const pill = (ability: string, cost: number) =>
  screen.getByRole('button', { name: new RegExp(`^${ability} ${cost} point upgrade, `) });
const round = (n: number) => fireEvent.click(screen.getByRole('button', { name: `Round ${n}` }));

afterEach(cleanup);

describe('AbilityOrderEditor', () => {
  it('draws the ability panel: four abilities, pills 5/2/1 top to bottom, round title with points left', () => {
    const { container } = render(<Harness start={null} />);
    const cols = container.querySelectorAll('.ap-editor .ap-col');
    expect([...cols].map((c) => c.getAttribute('data-ability'))).toEqual(ABILITIES.map((a) => a.name));
    expect([...cols[0]!.querySelectorAll('.ap-pill')].map((p) => p.getAttribute('data-cost'))).toEqual(['5', '2', '1']);
    // this standard order: round 1 buys three 1 point pills, 3 of 6
    expect(container.querySelector('.ap-title')!.textContent).toBe('Round 1: 6 points, 3 left');
    expect(screen.getByText('Default order: 1000 matches, 55% win rate')).toBeTruthy();
    expect(pill('Catalyst', 1).getAttribute('aria-label')).toBe('Catalyst 1 point upgrade, round 1');
    expect(pill('Catalyst', 1).getAttribute('data-state')).toBe('now');
    round(3);
    expect(pill('Catalyst', 1).getAttribute('data-state')).toBe('done'); // earlier round: greyed with a check
    expect(pill('Catalyst', 1).textContent).toContain('✓');
    expect(pill('Afterburn', 5).getAttribute('data-state')).toBe('booked'); // round 5, later than the one selected
  });

  it('buys an unbought pill in the selected round and shows the round on it', () => {
    let saved: CustomOrder | null = null;
    render(<Harness start={EMPTY} onValue={(v) => (saved = v)} />);
    round(2);
    fireEvent.click(pill('Flame Dash', 1));
    expect(pill('Flame Dash', 1).getAttribute('aria-label')).toBe('Flame Dash 1 point upgrade, round 2');
    expect(pill('Flame Dash', 1).textContent).toContain('R2');
    expect(saved).toEqual([0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(screen.getByText('Round 2: 6 points, 11 left')).toBeTruthy(); // round 1's 6 carry over
  });

  it('sells a bought pill on click, and the pills above it on that ability', () => {
    let saved: CustomOrder | null = null;
    render(<Harness start={[...STANDARD]} onValue={(v) => (saved = v)} />);
    fireEvent.click(pill('Catalyst', 1));
    expect(pill('Catalyst', 1).getAttribute('aria-label')).toBe('Catalyst 1 point upgrade, not bought');
    expect(pill('Catalyst', 2).getAttribute('aria-label')).toBe('Catalyst 2 point upgrade, not bought');
    expect(saved).toEqual([0, 0, 0, 1, 2, 4, 1, 3, 5, 2, 4, 5]);
    // a not-complete order is not used: the summary says so and the problem line asks for the rest
    expect(screen.getByText(/yours \(not valid, using standard\)/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Pick a round for every point.');
  });

  it('keeps the upgrade order: the 2 point pill needs the 1 point pill in the same or an earlier round', () => {
    let saved: CustomOrder | null = null;
    render(<Harness start={EMPTY} onValue={(v) => (saved = v)} />);
    fireEvent.click(pill('Afterburn', 2));
    expect(screen.getByRole('alert').textContent).toBe(
      'Afterburn: buy the 1 point upgrade first, in round 1 or an earlier one.',
    );
    expect(pill('Afterburn', 2).getAttribute('aria-label')).toMatch(/not bought$/);
    expect(saved).toBeNull();
    round(3);
    fireEvent.click(pill('Afterburn', 1)); // round 3
    round(2);
    fireEvent.click(pill('Afterburn', 2)); // 1 point pill is in a later round: refused
    expect(pill('Afterburn', 2).getAttribute('aria-label')).toMatch(/not bought$/);
    round(3);
    fireEvent.click(pill('Afterburn', 2));
    fireEvent.click(pill('Afterburn', 5));
    expect(pill('Afterburn', 5).getAttribute('aria-label')).toBe('Afterburn 5 point upgrade, round 3');
    expect(saved).toEqual([0, 0, 0, 0, 0, 0, 3, 3, 3, 0, 0, 0]);
  });

  it('refuses to overspend a round with the customOrderProblem text', () => {
    let saved: CustomOrder | null = null;
    render(<Harness start={EMPTY} onValue={(v) => (saved = v)} />);
    fireEvent.click(pill('Catalyst', 1));
    fireEvent.click(pill('Catalyst', 2));
    fireEvent.click(pill('Flame Dash', 1));
    fireEvent.click(pill('Flame Dash', 2)); // 6 of 6 spent
    expect(screen.getByText('Round 1: 6 points, 0 left')).toBeTruthy();
    fireEvent.click(pill('Catalyst', 5));
    const want = customOrderProblem([1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0].map((r) => r || 5));
    expect(want).toBe('Round 1: 11 points spent by now, only 6 handed out.');
    expect(screen.getByRole('alert').textContent).toBe(want);
    expect(pill('Catalyst', 5).getAttribute('aria-label')).toMatch(/not bought$/);
    expect(saved).toEqual([1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('a full order built by clicking is valid and drives the ability panel', () => {
    let saved: CustomOrder | null = null;
    render(<Harness start={EMPTY} onValue={(v) => (saved = v)} />);
    const plan: [number, string, number][] = [
      [1, 'Catalyst', 1],
      [1, 'Flame Dash', 1],
      [1, 'Afterburn', 1],
      [1, 'Concussive Combustion', 1],
      [1, 'Catalyst', 2],
      [2, 'Flame Dash', 2],
      [2, 'Afterburn', 2],
      [2, 'Concussive Combustion', 2],
      [3, 'Catalyst', 5],
      [4, 'Flame Dash', 5],
      [5, 'Afterburn', 5],
      [5, 'Concussive Combustion', 5],
    ];
    for (const [r, a, c] of plan) {
      round(r);
      fireEvent.click(pill(a, c));
    }
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saved).toEqual([1, 1, 3, 1, 2, 4, 1, 2, 5, 1, 2, 5]);
    expect(customOrderProblem(saved!)).toBeNull();
    const hero = heroByName('Infernus');
    const input = inputFor(hero.id);
    expect(abilityPanelFor(brawlAbilityOrder(input), hero, input.abilities, 2, saved).evidence).toBe('Your order');
  });

  it('Reset to default order drops the own order', () => {
    let saved: CustomOrder | null = [];
    render(<Harness start={[...STANDARD]} onValue={(v) => (saved = v)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default order' }));
    expect(saved).toBeNull();
    expect(screen.getByText(/^Ability order for Infernus: standard$/)).toBeTruthy();
  });
});

describe('AbilityOrderEditor persistence (brawl.customOrders in BrawlView)', () => {
  const heroes = readJson('heroes.json') as Hero[];
  const items = readJson('items.json') as Item[];
  const abilities = readJson('abilities.json') as Ability[];
  const infernus = heroes.find((h) => h.id === 1)!;
  // saved by the editor before this change (12 rounds, no 0): must load unchanged
  const OLD = [4, 4, 5, 1, 1, 2, 2, 4, 5, 1, 1, 3];
  beforeEach(() => localStorage.clear());

  it('loads a saved pre-change order unchanged and saves clicks in the same format', async () => {
    localStorage.setItem('brawl.customOrders', JSON.stringify({ '1': OLD }));
    const { container } = render(
      <BrawlView hero={infernus} heroes={heroes} items={items} abilities={abilities} onHero={() => {}} />,
    );
    await waitFor(() => expect(container.querySelector('.ap-editor')).not.toBeNull());
    expect(container.querySelector('details.brawl-my-order summary')!.textContent).toBe(
      'Ability order for Infernus: yours',
    );
    const labels = [...container.querySelectorAll('.ap-editor .ap-pill')].map((p) => p.getAttribute('aria-label'));
    // columns in bar order, pills 5/2/1: the first column's 1 point pill is OLD[0] = round 4
    expect(labels[2]).toMatch(/ 1 point upgrade, round 4$/);
    expect(labels[0]).toMatch(/ 5 point upgrade, round 5$/);
    expect(JSON.parse(localStorage.getItem('brawl.customOrders')!)).toEqual({ '1': OLD });
    // sell the first ability's 5 point pill: stored as 12 numbers, 0 for not bought
    fireEvent.click(container.querySelectorAll('.ap-editor .ap-pill')[0]!);
    expect(JSON.parse(localStorage.getItem('brawl.customOrders')!)).toEqual({ '1': [4, 4, 0, ...OLD.slice(3)] });
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default order' }));
    expect(JSON.parse(localStorage.getItem('brawl.customOrders')!)).toEqual({});
  });
});
