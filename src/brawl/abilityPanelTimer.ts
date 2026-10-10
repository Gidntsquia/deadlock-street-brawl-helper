// The "upgrade this ability" tip: appears when the item draft screen closes, lasts ~15 s, then goes away for good
// until the next draft closes. Pure state machine (time is passed in) so it is unit-testable without a clock.

/** How long the tip stays up. */
export const TIP_MS = 15_000;
/** Consecutive non-draft frames before the draft counts as closed (the screen can blink between choices). */
export const CLOSE_FRAMES = 6;
/** On a slow PC frames come a second apart, and six of them would take the better part of ten seconds: the draft also
 *  counts as closed after this many non-draft frames spread over CLOSE_MS. */
export const CLOSE_MIN_FRAMES = 3;
export const CLOSE_MS = 1_500;

export interface TipState<T> {
  draft: boolean; // the draft screen is (still) considered open
  missed: number; // consecutive non-draft frames while draft is true
  missedAt?: number; // when the first of them came
  sawDraft: boolean; // a draft screen was seen since the last tip started (a tip needs a draft to close)
  tip: { value: T; endsAt: number } | null;
}

export const initialTip = <T>(): TipState<T> => ({ draft: false, missed: 0, sawDraft: false, tip: null });

/** Advances the tracker by one frame result (`shop`: the frame is the item draft screen) at time `now` (ms).
 *  `current` is the ability the advisor wants next *now* (latched when the draft closes); null: nothing to show.
 *  Call it with the last `shop` again from a timer to expire the tip without waiting for another frame. */
export function stepTip<T>(
  s: TipState<T>,
  shop: boolean,
  now: number,
  current: T | null,
  durationMs = TIP_MS,
): TipState<T> {
  let { draft, missed, sawDraft, tip } = s;
  let missedAt = s.missedAt;
  if (shop) {
    draft = true;
    missed = 0;
    missedAt = undefined;
    sawDraft = true;
    tip = null; // a draft screen reopening ends the tip at once
  } else if (draft) {
    missed += 1;
    missedAt ??= now;
    if (missed >= CLOSE_FRAMES || (missed >= CLOSE_MIN_FRAMES && now - missedAt >= CLOSE_MS)) {
      draft = false;
      missed = 0;
      missedAt = undefined;
      if (sawDraft && current !== null) tip = { value: current, endsAt: now + durationMs };
      sawDraft = false;
    }
  }
  if (tip && now >= tip.endsAt) tip = null;
  if (draft === s.draft && missed === s.missed && sawDraft === s.sawDraft && tip === s.tip) return s;
  return missedAt === undefined ? { draft, missed, sawDraft, tip } : { draft, missed, missedAt, sawDraft, tip };
}
