// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AbilityPanel } from '../AbilityPanel';
import { abilityPanelFor, brawlAbilityOrder } from '../../brawl/abilities';
import { heroByName, inputFor } from '../../brawl/__tests__/testData';

afterEach(cleanup);

describe('AbilityPanel evidence line', () => {
  const hero = heroByName('Infernus');
  const input = inputFor(hero.id);

  it('shows matches and win rate under the title', () => {
    const panel = abilityPanelFor(brawlAbilityOrder(input), hero, input.abilities, 2);
    render(<AbilityPanel panel={panel} />);
    expect(screen.getByText('By end of round 2')).toBeTruthy();
    expect(screen.getByText(/^\d+ matches, \d+% win rate$/)).toBeTruthy();
  });

  it('shows No reliable order when data is thin', () => {
    const thin = { ...input, analytics: { ...input.analytics, ability_order_stats: [] } };
    const panel = abilityPanelFor(brawlAbilityOrder(thin), hero, input.abilities, 1);
    render(<AbilityPanel panel={panel} />);
    expect(screen.getByText('No reliable order')).toBeTruthy();
  });

  it('uses the same round for the overlay title, target and evidence', () => {
    const order = brawlAbilityOrder(input);
    for (let round = 1; round <= 5; round++) {
      const panel = abilityPanelFor(order, hero, input.abilities, round);
      const { container } = render(<AbilityPanel panel={panel} className="overlay-ap" />);
      expect(container.querySelector('.overlay-ap')!.getAttribute('data-round')).toBe(String(round));
      expect(screen.getByText(`By end of round ${round}`)).toBeTruthy();
      expect(container.querySelector('.ap-evidence')!.textContent).toBe(
        `${order.rounds[round - 1]!.support.matches} matches, ${Math.round(order.rounds[round - 1]!.support.winRate * 100)}% win rate`,
      );
      expect(container.querySelectorAll('.ap-done')).toHaveLength(0);
      cleanup();
    }
  });
});
