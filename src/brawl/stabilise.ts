// Smooths the per-frame card reads before they reach the overlay: a card's circle stays put while the matcher's
// position wobbles, and a card that goes unreadable for a few frames (animation, a hover glow, a dropped frame) keeps
// being drawn instead of blinking out. Pure; the caller keeps the returned state.
import type { CardRead } from './recognise';

/** Frames a card may go unread before it is dropped (~0.4 s at the 15 fps draft rate), unless `hold` is set. */
export const HOLD_FRAMES = 6;
/** Position/size change, as a share of the icon edge, that counts as noise and is ignored. */
const DEADBAND = 0.06;

type Match = CardRead['match'];

export interface StableState {
  reads: CardRead[];
  missed: number[];
  /** A position that differed from the drawn one on the last frame: adopted when the next frame agrees with it. */
  pending: (Match | null)[];
}
export const emptyStable = (): StableState => ({ reads: [], missed: [], pending: [] });

const near = (a: Match, b: Match, edge: number) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.edge - b.edge)) <= DEADBAND * edge;

/**
 * `hold`: the accepted set is still on screen (draftGate's `live`), so a card hidden by the hover tooltip keeps its
 * last read for as long as the hover lasts instead of HOLD_FRAMES.
 */
export function stabilise(prev: StableState, next: CardRead[], hold = false): StableState {
  const reads: CardRead[] = [];
  const missed: number[] = [];
  const pending: (Match | null)[] = [];
  next.forEach((n, i) => {
    const p = prev.reads[i];
    if (n.present) {
      if (p?.present && p.itemId === n.itemId) {
        // A move is only taken once two frames in a row agree on it: a matcher flipping between two positions
        // (a hover glow, an animation) never makes the circle hop back and forth.
        const e = n.match.edge;
        const was = prev.pending[i] ?? null;
        let match = p.match,
          wait: Match | null = null;
        if (!near(n.match, p.match, e)) {
          if (was && near(n.match, was, e)) match = n.match;
          else wait = n.match;
        }
        reads.push({ ...n, match });
        pending.push(wait);
      } else {
        reads.push(n);
        pending.push(null);
      }
      missed.push(0);
    } else if (p?.present && (hold || (prev.missed[i] ?? 0) < HOLD_FRAMES)) {
      reads.push(p);
      missed.push((prev.missed[i] ?? 0) + 1);
      pending.push(null);
    } else {
      reads.push(n);
      missed.push(0);
      pending.push(null);
    }
  });
  return { reads, missed, pending };
}
