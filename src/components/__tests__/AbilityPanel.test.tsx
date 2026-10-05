// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AbilityPanel } from '../AbilityPanel';
import { abilityPanelFor, brawlAbilityOrder } from '../../brawl/abilities';
import { heroByName, inputFor } from '../../brawl/__tests__/testData';

describe('AbilityPanel evidence line', () => {
  const hero = heroByName('Infernus');
  const input = inputFor(hero.id);

  it('shows matches and win rate under the title', () => {
    const panel = abilityPanelFor(brawlAbilityOrder(input), hero, input.abilities, 2);
    render(<AbilityPanel panel={panel} />);
    expect(screen.getByText('Round 2: 6 points')).toBeTruthy();
    expect(
      screen.getByText(
        /^\d+ matches, \d+% win rate(?:; first \d+ upgrades supported, remaining upgrades use fallback order)?$/,
      ),
    ).toBeTruthy();
  });

  it('shows No reliable order when data is thin', () => {
    const thin = { ...input, analytics: { ...input.analytics, ability_order_stats: [] } };
    const panel = abilityPanelFor(brawlAbilityOrder(thin), hero, input.abilities, 1);
    render(<AbilityPanel panel={panel} />);
    expect(screen.getByText('No reliable order')).toBeTruthy();
  });

  it('shows Reading and withholds current upgrades while the HUD counter is unresolved', () => {
    const panel = { ...abilityPanelFor(brawlAbilityOrder(input), hero, input.abilities, 2), availablePoints: null };
    const { container } = render(<AbilityPanel panel={panel} />);
    expect(screen.getByText(/Reading/)).toBeTruthy();
    expect(container.querySelectorAll('.ap-now')).toHaveLength(0);
    expect(container.querySelectorAll('.ap-done')).not.toHaveLength(0);
  });
});
