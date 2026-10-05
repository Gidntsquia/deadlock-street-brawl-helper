// Decides when a draft screen is ready to advise on, and when the player has made a selection. Pure: the worker
// feeds it one summary per draft frame and keeps the returned state.
//
// The game does not swap screens atomically. After a pick the CHOICE / ROUND labels, the three cards and the
// inventory grid update a beat apart, so a frame mid-transition can show the old cards under the new label, the
// new cards under the old label, or a mix of old and new cards. Accepting such a frame gave advice for the wrong
// round / choice or ranked new cards against old ones. So:
// - a set is accepted only once the same three cards AND the same labels have held for SETTLE_MS (two frames at
//   least): transition states last a moment, a real draft screen stays up until the player clicks;
// - a selection is detected when the inventory grid (when it can be read) gains one of the accepted cards, or when
//   the labels move on while the same cards are still up. A set a selection was made from is "spent": it is never
//   accepted again, and its advice is dropped at once;
// - the same cards under new labels (which is also what a set first read under a stale label looks like) or labels
//   that go backwards are accepted only after RELABEL_SETTLE_MS of no change.

/** A new set of cards must hold, with unchanged labels, this long before it is accepted. */
export const SETTLE_MS = 300;
/** The accepted cards under new labels (or labels that went backwards) must hold this long. */
export const RELABEL_SETTLE_MS = 1200;
/** Frames with no card read at all that keep an accepted set's advice up. */
export const MISSING_FRAMES = 3;
const SPENT_KEEP = 6;

export interface GateFrame {
  key: string; // the three card ids ('123,456+,789'), '' when fewer than three are read
  present: number[]; // ids of the cards read on this frame (any number)
  round: number; // 0: unread
  choice: number;
  now: number; // ms
  inventory: number[] | null; // the inventory grid, once two reads agree; null when not known
  force?: boolean; // accept now whatever the settle time and the pending reads say (the 2.5 s fallback)
  ready?: boolean; // false: a read the advice needs (the re-roll caption) is still in flight; hold the accept
}

interface Labelled {
  key: string;
  round: number;
  choice: number;
}

export interface GateState {
  cand: (Labelled & { since: number; frames: number }) | null; // the triple the screen currently holds
  last: (Labelled & { inv: number[] | null }) | null; // the most recently accepted set
  live: boolean; // `last` is what is on screen now, so its advice stands
  missing: number; // consecutive key-less frames while live
  spent: string[]; // keys of sets a selection was made from
}

export interface GateOut {
  state: GateState;
  accept: boolean; // this frame's set is newly accepted
  live: boolean; // an accepted set's advice stands after this frame
  picked: number | null; // the item just selected from the last accepted set, on the frame that shows it
  spent: boolean; // the cards on screen are a set a selection was already made from
}

export const initialGate = (): GateState => ({ cand: null, last: null, live: false, missing: 0, spent: [] });
/** Off the draft screen: forget everything except which sets were already picked from. */
export const offScreenGate = (s: GateState): GateState => ({ ...initialGate(), spent: s.spent });

const cardIds = (key: string) =>
  key
    .split(',')
    .map((k) => Number(k.replace('+', '')))
    .filter((n) => n > 0); // a '?' slot has no id
/** Same three items, whatever the enhanced ('+') reads say: that flag wobbles under the hover glow. */
const sameSet = (a: string, b: string) => {
  const x = a.replace(/\+/g, '').split(','),
    y = b.replace(/\+/g, '').split(',');
  // a '?' (a card the fallback could not read) stands for whatever the other set has in that slot
  return x.length === y.length && x.every((v, i) => v === y[i] || v === '?' || y[i] === '?');
};
const step = (l: { round: number; choice: number }) => (l.round > 0 ? (l.round - 1) * 3 + l.choice : 0);
/** Same labels; an unread round (0) matches any round. */
const sameLabels = (a: Labelled, b: Labelled) => a.choice === b.choice && (!a.round || !b.round || a.round === b.round);

export function stepGate(s: GateState, f: GateFrame): GateOut {
  let { cand, last, live, missing, spent } = s;
  let picked: number | null = null;

  // A selection shows up in the inventory grid: an item that was on the last accepted set and was not owned then.
  if (last && f.inventory) {
    if (!last.inv) last = { ...last, inv: f.inventory };
    else if (!spent.some((k) => sameSet(k, last!.key))) {
      const was = last.inv,
        ids = cardIds(last.key);
      const gain = f.inventory.find((id) => !was.includes(id) && ids.includes(id));
      if (gain) {
        picked = gain;
        spent = [...spent, last.key].slice(-SPENT_KEEP);
        live = false;
      }
    }
  }

  const out = (accept: boolean, isSpent = false): GateOut => ({
    state: { cand, last, live, missing, spent },
    accept,
    live,
    picked,
    spent: isSpent,
  });

  if (!f.key) {
    cand = null;
    if (live) {
      // A card read that is not on the accepted set means a new screen with a card still hidden: drop at once.
      // Cards that are all from the accepted set (one hidden by the hover tooltip, or by the cursor on a plate) keep
      // the advice up for as long as the hover lasts; only frames with no card read at all count down.
      const shown = last ? cardIds(last.key) : [];
      const read = f.present.filter((id) => id);
      if (read.some((id) => !shown.includes(id))) live = false;
      else if (read.length) missing = 0;
      else if (++missing >= MISSING_FRAMES) live = false;
    }
    return out(false);
  }
  missing = 0;

  if (spent.some((k) => sameSet(k, f.key))) {
    cand = null;
    live = false;
    return out(false, true);
  }

  const now: Labelled = { key: f.key, round: f.round, choice: f.choice };
  // Still the accepted screen: nothing to decide (a round read that was 0 is filled in).
  if (live && last && sameSet(last.key, f.key) && sameLabels(last, now)) {
    if (!last.round && f.round) last = { ...last, round: f.round };
    cand = null;
    return out(false);
  }

  if (cand && sameSet(cand.key, now.key) && sameLabels(cand, now))
    cand = { ...cand, round: cand.round || now.round, frames: cand.frames + 1 };
  else cand = { ...now, since: f.now, frames: 1 };

  // Two frames of something other than the accepted screen: a different set (the old advice is stale), or the same
  // cards under new labels (the player picked from them and they linger under the next choice's label, or they were
  // first read under a stale label). Drop the advice until the new screen settles.
  if (live && cand.frames >= 2) live = false;

  if (cand.frames < 2 && !f.force) return out(false);
  const back = last !== null && step(now) > 0 && step(last) > 0 && step(now) < step(last);
  const relabel = last !== null && sameSet(last.key, f.key) && !sameLabels(last, now);
  // The set that was just up comes back under the same labels (a hover tooltip moved away): no need to wait.
  const returning = last !== null && sameSet(last.key, f.key) && sameLabels(last, now);
  const need = returning ? 0 : relabel || back ? RELABEL_SETTLE_MS : SETTLE_MS;
  if (!f.force && (f.now - cand.since < need || f.ready === false)) return out(false);

  last = { key: f.key, round: cand.round, choice: f.choice, inv: f.inventory ?? last?.inv ?? null };
  live = true;
  cand = null;
  return out(true);
}
