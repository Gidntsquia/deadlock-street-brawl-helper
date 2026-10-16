import { describe, expect, it } from 'vitest';
import { chooseHero, HeroTracker, LOADING_FRESH_MS } from '../heroChoice';

const KELVIN = 12,
  GRAVES = 76,
  INFERNUS = 1,
  VISCOUS = 35;

describe('chooseHero', () => {
  const base = { pinned: false, loading: 0, portrait: 0, lastPortrait: 0, selected: 1 };
  it('loading read beats a different portrait read', () =>
    expect(chooseHero({ ...base, loading: INFERNUS, portrait: VISCOUS })).toEqual({
      heroId: INFERNUS,
      source: 'loading',
      guessed: false,
    }));
  it('a hand pick beats both', () =>
    expect(chooseHero({ ...base, pinned: true, selected: KELVIN, loading: INFERNUS, portrait: VISCOUS })).toEqual({
      heroId: KELVIN,
      source: 'pinned',
      guessed: false,
    }));
  it('portrait only: a guess', () =>
    expect(chooseHero({ ...base, portrait: VISCOUS })).toEqual({ heroId: VISCOUS, source: 'portrait', guessed: true }));
  it('keeps the last portrait of the match, still a guess', () =>
    expect(chooseHero({ ...base, lastPortrait: GRAVES })).toEqual({ heroId: GRAVES, source: 'kept', guessed: true }));
  it('nothing read: the window hero, not a guess', () =>
    expect(chooseHero(base)).toEqual({ heroId: 1, source: 'selected', guessed: false }));
});

describe('HeroTracker', () => {
  const draft = (round: number, choice: number, portrait = 0, pinned = false, selected = KELVIN) => ({
    round,
    choice,
    portrait,
    pinned,
    selected,
  });

  it('a loading read holds for the whole match whatever the portraits say', () => {
    const t = new HeroTracker();
    t.onLoading(INFERNUS, 0);
    expect(t.onDraft(draft(1, 1, VISCOUS), 20_000)).toMatchObject({ heroId: INFERNUS, source: 'loading' });
    expect(t.onDraft(draft(3, 2, VISCOUS), 600_000)).toMatchObject({ heroId: INFERNUS, source: 'loading' });
    expect(t.onDraft(draft(5, 3, 0), 1_200_000)).toMatchObject({ heroId: INFERNUS, source: 'loading' });
  });

  it('the friend case: Kelvin then Graves, the hero changes at the second loading screen', () => {
    const t = new HeroTracker();
    t.onLoading(KELVIN, 0);
    expect(t.onDraft(draft(1, 1), 20_000).heroId).toBe(KELVIN);
    expect(t.onDraft(draft(5, 3), 1_000_000).heroId).toBe(KELVIN);
    t.onLoading(GRAVES, 1_300_000);
    expect(t.onDraft(draft(1, 1, KELVIN), 1_320_000)).toMatchObject({ heroId: GRAVES, source: 'loading' });
  });

  it('Kelvin then Graves with the second loading read missed: Kelvin is not carried into the new match', () => {
    const t = new HeroTracker();
    t.onLoading(KELVIN, 0);
    t.onDraft(draft(5, 3), 1_000_000);
    expect(t.onDraft(draft(1, 1, GRAVES), 1_300_000)).toMatchObject({
      heroId: GRAVES,
      source: 'portrait',
      guessed: true,
    });
    // no portrait either: the window's hero with the not-read line, never last match's loading hero
    const u = new HeroTracker();
    u.onLoading(KELVIN, 0);
    u.onDraft(draft(5, 3), 1_000_000);
    expect(u.onDraft(draft(1, 1, 0, false, INFERNUS), 1_300_000)).toMatchObject({
      heroId: INFERNUS,
      source: 'selected',
    });
  });

  it('round 1 choice 1 missed too: a lower round still starts a new match', () => {
    const t = new HeroTracker();
    t.onLoading(KELVIN, 0);
    t.onDraft(draft(4, 2), 900_000);
    expect(t.onDraft(draft(1, 2, GRAVES), 1_400_000)).toMatchObject({ heroId: GRAVES, source: 'portrait' });
  });

  it('a loading read just before round 1 choice 1 is this match', () => {
    const t = new HeroTracker();
    t.onLoading(KELVIN, 0);
    t.onDraft(draft(5, 3), 1_000_000);
    t.onLoading(GRAVES, 1_000_000 + LOADING_FRESH_MS);
    expect(t.onDraft(draft(1, 1), 1_000_000 + LOADING_FRESH_MS + 30_000).heroId).toBe(GRAVES);
  });

  it('portrait only (started mid-match): guessed, and the last portrait is kept on a frame that does not read', () => {
    const t = new HeroTracker();
    expect(t.onDraft(draft(3, 1, INFERNUS), 0)).toMatchObject({ heroId: INFERNUS, guessed: true, source: 'portrait' });
    expect(t.onDraft(draft(3, 2, 0), 30_000)).toMatchObject({ heroId: INFERNUS, guessed: true, source: 'kept' });
    // a loading read lands later (next match): no longer a guess
    t.onLoading(INFERNUS, 900_000);
    expect(t.onDraft(draft(1, 1, VISCOUS), 920_000)).toMatchObject({ heroId: INFERNUS, guessed: false });
  });

  it('a pinned hero wins over a loading read', () => {
    const t = new HeroTracker();
    t.onLoading(INFERNUS, 0);
    expect(t.onDraft(draft(1, 1, VISCOUS, true, KELVIN), 10_000)).toMatchObject({ heroId: KELVIN, source: 'pinned' });
  });

  it('reports a new match once, on its first draft', () => {
    const t = new HeroTracker();
    t.onDraft(draft(3, 1, INFERNUS), 0);
    expect(t.takeNewMatch()).toBe(true);
    t.onDraft(draft(3, 1, INFERNUS), 100);
    expect(t.takeNewMatch()).toBe(false);
    t.onDraft(draft(4, 1, INFERNUS), 300_000);
    expect(t.takeNewMatch()).toBe(false);
    t.onDraft(draft(1, 1, INFERNUS), 900_000);
    expect(t.takeNewMatch()).toBe(true);
    t.onDraft(draft(1, 1, INFERNUS), 900_250);
    expect(t.takeNewMatch()).toBe(false);
  });

  it('a loading read is ignored after 60 min', () => {
    const t = new HeroTracker();
    t.onLoading(INFERNUS, 0);
    t.onDraft(draft(2, 1), 60_000);
    expect(t.onDraft(draft(3, 1), 61 * 60_000)).toMatchObject({ source: 'selected' });
  });
});
