// Which hero the advice uses, per match. Order: a hero picked by hand (`pinned`) beats everything; the loading screen's
// "Joining the fight as <name>" read sets the hero for the whole match and no portrait read changes it; the scoreboard
// portrait is used only when no loading name was read this match (the app was started mid-match, or the read failed),
// and the app then says the hero is a guess. With nothing read, the hero picked in the window is used.
//
// A match starts at a loading-screen read, or at a round 1 choice 1 draft with no fresh loading read (a loading read
// older than `LOADING_FRESH_MS` there belongs to an earlier match); a round lower than one already read this match counts
// as a new match too (round 1 choice 1 may be missed). A loading read is never used past `LOADING_MAX_MS`.

export type HeroSource = 'pinned' | 'loading' | 'portrait' | 'kept' | 'selected';

export interface HeroChoice {
  heroId: number;
  source: HeroSource;
  /** The hero comes from the scoreboard portraits only (no loading name this match): the app says it is guessing. */
  guessed: boolean;
}

/** A loading read this old at a round 1 choice 1 draft is from an earlier match. The loading screen sits right
 *  before the first draft (about 20 s in both recordings); a match lasts well over this. */
export const LOADING_FRESH_MS = 5 * 60_000;
/** A loading read is never used past this, whatever happens (the old 60 min window). */
export const LOADING_MAX_MS = 60 * 60_000;

/** Pure precedence: `loading` (0: none this match), `portrait` (sure read of this frame, 0: none), `lastPortrait`
 *  (the last sure portrait read this match, 0: none), `selected` (the window's hero). */
export function chooseHero(s: {
  pinned: boolean;
  loading: number;
  portrait: number;
  lastPortrait: number;
  selected: number;
}): HeroChoice {
  if (s.pinned) return { heroId: s.selected, source: 'pinned', guessed: false };
  if (s.loading) return { heroId: s.loading, source: 'loading', guessed: false };
  if (s.portrait) return { heroId: s.portrait, source: 'portrait', guessed: true };
  if (s.lastPortrait) return { heroId: s.lastPortrait, source: 'kept', guessed: true };
  return { heroId: s.selected, source: 'selected', guessed: false };
}

/** The per-match memory behind `chooseHero`: the loading read and the last sure portrait read of this match. */
export class HeroTracker {
  private loading: { id: number; at: number } | null = null;
  private lastPortrait = 0;
  /** The furthest draft read this match (round * 10 + choice): an earlier one means the draft belongs to a new match. */
  private lastPos = 0;
  /** A new match began (a loading read, or round 1 choice 1 with no fresh loading read) since the last `take`. */
  private fresh = true;

  /** The loading screen named a hero: a new match with that hero. */
  onLoading(id: number, now: number): void {
    if (!id) return;
    if (this.loading?.id !== id || now - this.loading.at > LOADING_FRESH_MS) this.fresh = true;
    this.loading = { id, at: now };
    this.lastPortrait = 0;
    this.lastPos = 0;
  }

  /** The loading hero valid at `now` (0: none this match). */
  loadingHero(now: number): number {
    return this.loading && now - this.loading.at < LOADING_MAX_MS ? this.loading.id : 0;
  }

  /** One read draft frame: round/choice (0 when unread) and the sure portrait read (0 when none). */
  onDraft(
    d: { round: number; choice: number; portrait: number; pinned: boolean; selected: number },
    now: number,
  ): HeroChoice {
    const loadingFresh = !!this.loading && now - this.loading.at < LOADING_FRESH_MS;
    const pos = d.round && d.choice ? d.round * 10 + d.choice : 0;
    const back = d.round > 0 && d.round < Math.floor(this.lastPos / 10);
    const first = pos === 11 && (this.lastPos > 11 || (this.lastPos === 0 && !!this.loading));
    if ((first || back) && !loadingFresh) {
      this.fresh = true;
      this.loading = null;
      this.lastPortrait = 0;
      this.lastPos = 0;
    }
    if (pos > this.lastPos) this.lastPos = pos;
    const pick = chooseHero({
      pinned: d.pinned,
      loading: this.loadingHero(now),
      portrait: d.portrait,
      lastPortrait: this.lastPortrait,
      selected: d.selected,
    });
    if (d.portrait) this.lastPortrait = d.portrait;
    return pick;
  }

  /** True once per match: the first draft of a new match (the overlay's guess note shows only then). */
  takeNewMatch(): boolean {
    const f = this.fresh;
    this.fresh = false;
    return f;
  }
}
