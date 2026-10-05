import { describe, expect, it } from 'vitest';
import { chooseHero } from '../heroChoice';

describe('chooseHero', () => {
  it('takes a sure read', () => expect(chooseHero(5, 3, 1)).toEqual({ heroId: 5, source: 'read' }));
  it('keeps the last sure hero of the match when the read fails', () =>
    expect(chooseHero(0, 3, 1)).toEqual({ heroId: 3, source: 'kept' }));
  it('falls back to the selected hero when nothing was ever sure', () =>
    expect(chooseHero(0, 0, 1)).toEqual({ heroId: 1, source: 'selected' }));
});
