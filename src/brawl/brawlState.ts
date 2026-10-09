// Street Brawl state machine: match > round 1-5 > choice 1-3, one re-roll, three card slots. Pure: every transition
// is a named event, `step` returns the next state and the effects the caller should act on (log lines, reads to do).
//
// What the game guarantees, and the machine relies on: the round banner shows first; cards land one at a time left to
// right; a set never changes until a pick or a re-roll; a re-roll blanks all three name lines under the same CHOICE
// label; a pick advances the CHOICE label (or ends the round after choice 3).

export type Phase = 'lobby' | 'round-start' | 'drafting' | 'picked' | 'between-rounds';
export type PickSource = 'read' | 'assumed' | 'grid';

/** Frames a name line must hold unchanged before it is read. */
export const LAND_FRAMES = 2;

export type Slot =
  { kind: 'empty' } | { kind: 'landing'; fp: string; frames: number } | { kind: 'locked'; fp: string; itemId: number };

export interface BrawlState {
  phase: Phase;
  round: number; // 0 until a round banner or label is seen
  choice: number; // 0 until a label is seen
  matchId: number;
  /** A re-roll was used in this round (never advise another this round). */
  rerollUsedThisRound: boolean;
  /** Re-rolls left in the match, 1 at the start; the once-per-set caption read overrides it. */
  rerollsLeft: number;
  slots: [Slot, Slot, Slot];
  owned: number[];
  /** Per slot, how many times its name line was read (for the session report). */
  reads: [number, number, number];
  resyncs: number;
  lastPick: { itemId: number; source: PickSource } | null;
  /** Unverified assumed picks: the grid is read once at the next set to check them. */
  gridCheck: boolean;
}

export type BrawlEvent =
  | { type: 'roundStart'; round: number }
  | { type: 'label'; round: number; choice: number }
  | { type: 'cardLine'; slot: 0 | 1 | 2; fp: string }
  /** `fromLock`: the worker already held this name (no OCR ran), so the slot locks without counting a read. */
  | { type: 'cardRead'; slot: 0 | 1 | 2; fp: string; itemId: number; fromLock?: boolean }
  | { type: 'linesBlank' }
  | { type: 'caption'; rerollsLeft: number }
  /** `itemId`: the card seen taken; null when it was not seen, then `advised` is assumed. `source` names how a seen pick was found (default `read`). */
  | { type: 'pick'; itemId: number | null; advised: number | null; source?: PickSource }
  | { type: 'ownedGrid'; ids: number[] }
  | { type: 'forceResync' };

export type Effect =
  | { type: 'warm' }
  | { type: 'log'; name: string; data?: Record<string, unknown> }
  | { type: 'readSlot'; slot: 0 | 1 | 2 }
  | { type: 'setLocked' }
  | { type: 'reroll' }
  | { type: 'readCaption' }
  | { type: 'readGrid' }
  | { type: 'status'; text: string };

const emptySlots = (): BrawlState['slots'] => [{ kind: 'empty' }, { kind: 'empty' }, { kind: 'empty' }];

export const initialBrawl = (): BrawlState => ({
  phase: 'lobby',
  round: 0,
  choice: 0,
  matchId: 0,
  rerollUsedThisRound: false,
  rerollsLeft: 1,
  slots: emptySlots(),
  owned: [],
  reads: [0, 0, 0],
  resyncs: 0,
  lastPick: null,
  gridCheck: false,
});

export const setLocked = (s: BrawlState) => s.slots.every((x) => x.kind === 'locked');
/** Round 1 choice 1 starts a match: owned list and re-roll are fresh. */
const newMatch = (s: BrawlState): BrawlState => ({
  ...initialBrawl(),
  matchId: s.matchId + 1,
  resyncs: s.resyncs,
});
const clearSet = (s: BrawlState): BrawlState => ({ ...s, slots: emptySlots(), reads: [0, 0, 0] });

export function step(s: BrawlState, e: BrawlEvent): { state: BrawlState; effects: Effect[] } {
  const fx: Effect[] = [];
  const done = (state: BrawlState) => ({ state, effects: fx });
  switch (e.type) {
    case 'roundStart': {
      let n = e.round === 1 || e.round < s.round ? newMatch(s) : s;
      n = { ...clearSet(n), phase: 'round-start', round: e.round, choice: 1, rerollUsedThisRound: false };
      fx.push({ type: 'warm' }, { type: 'log', name: 'round.start', data: { round: e.round } });
      return done(n);
    }
    case 'label': {
      if (e.round === s.round && e.choice === s.choice)
        return done(s.phase === 'round-start' ? { ...s, phase: 'drafting' } : s);
      const advance =
        (e.round === s.round && e.choice === s.choice + 1) ||
        (e.round === s.round + 1 && e.choice === 1 && s.choice === 3);
      if (advance || s.round === 0) {
        // the natural step after a pick (or the first label ever seen): no resync
        let n = clearSet(s);
        if (e.round !== s.round) n = { ...n, rerollUsedThisRound: false };
        if (s.round === 0 && e.round === 1 && e.choice === 1) n = { ...newMatch(n) };
        return done({ ...n, round: e.round, choice: e.choice, phase: 'drafting' });
      }
      // any other disagreement: resync to the label; backwards rounds are a new match
      let n = e.round < s.round ? newMatch(s) : s;
      n = {
        ...clearSet(n),
        round: e.round,
        choice: e.choice,
        phase: 'drafting',
        resyncs: n.resyncs + 1,
        rerollUsedThisRound: false,
        gridCheck: false,
      };
      if (e.round === 1 && e.choice === 1) n = { ...n, owned: [], rerollsLeft: 1 };
      fx.push(
        { type: 'readCaption' },
        { type: 'readGrid' },
        { type: 'status', text: `Resynced to round ${e.round} choice ${e.choice}` },
        { type: 'log', name: 'resync', data: { round: e.round, choice: e.choice } },
      );
      return done(n);
    }
    case 'forceResync': {
      const n = { ...clearSet(s), phase: 'drafting' as Phase, resyncs: s.resyncs + 1, gridCheck: false };
      fx.push(
        { type: 'readCaption' },
        { type: 'readGrid' },
        { type: 'status', text: `Resynced to round ${s.round} choice ${s.choice}` },
        { type: 'log', name: 'resync', data: { round: s.round, choice: s.choice, forced: true } },
      );
      return done(n);
    }
    case 'cardLine': {
      if (s.phase !== 'drafting' && s.phase !== 'round-start') return done(s);
      const cur = s.slots[e.slot];
      // a locked slot whose line looks the same is never read again
      if (cur.kind === 'locked' && cur.fp === e.fp) return done(s);
      const frames = cur.kind === 'landing' && cur.fp === e.fp ? cur.frames + 1 : 1;
      const slots = [...s.slots] as BrawlState['slots'];
      slots[e.slot] = { kind: 'landing', fp: e.fp, frames };
      if (frames === LAND_FRAMES) fx.push({ type: 'readSlot', slot: e.slot });
      return done({ ...s, slots, phase: 'drafting' });
    }
    case 'cardRead': {
      const cur = s.slots[e.slot];
      // a read of a line that has changed since it was requested is stale. The worker starts its read on the first
      // frame a line shows (the 2-frame hold is for the pick and re-roll rules, not for waiting to read), so one frame is enough.
      if (cur.kind !== 'landing' || cur.fp !== e.fp) return done(s);
      const slots = [...s.slots] as BrawlState['slots'];
      slots[e.slot] = { kind: 'locked', fp: e.fp, itemId: e.itemId };
      const reads = [...s.reads] as BrawlState['reads'];
      if (!e.fromLock) reads[e.slot]++;
      const n = { ...s, slots, reads };
      fx.push({ type: 'log', name: 'card.name', data: { slot: e.slot, itemId: e.itemId } });
      if (setLocked(n))
        fx.push(
          { type: 'setLocked' },
          { type: 'readCaption' },
          ...(s.gridCheck ? [{ type: 'readGrid' as const }] : []),
        );
      return done(n);
    }
    case 'linesBlank': {
      // all three name lines gone under the same CHOICE label: a re-roll (only when a set was up)
      if (s.phase !== 'drafting' || s.slots.every((x) => x.kind === 'empty')) return done(s);
      fx.push({ type: 'reroll' }, { type: 'log', name: 'reroll.seen', data: { round: s.round, choice: s.choice } });
      return done({
        ...clearSet(s),
        rerollUsedThisRound: true,
        rerollsLeft: Math.max(0, s.rerollsLeft - 1),
      });
    }
    case 'caption':
      return done({ ...s, rerollsLeft: e.rerollsLeft });
    case 'pick': {
      if (s.phase !== 'drafting') return done(s);
      const itemId = e.itemId ?? e.advised;
      if (itemId === null) return done({ ...clearSet(s), phase: s.choice === 3 ? 'between-rounds' : 'picked' });
      const source: PickSource = e.itemId !== null ? (e.source ?? 'read') : 'assumed';
      const n: BrawlState = {
        ...clearSet(s),
        owned: [...s.owned, itemId],
        lastPick: { itemId, source },
        gridCheck: source === 'assumed',
        phase: s.choice === 3 ? 'between-rounds' : 'picked',
      };
      fx.push({ type: 'log', name: 'pick', data: { itemId, source } });
      return done(n);
    }
    case 'ownedGrid': {
      if (!s.gridCheck && s.lastPick?.source !== 'assumed') return done(s);
      const same = e.ids.length === s.owned.length && e.ids.every((id) => s.owned.includes(id));
      if (same) return done({ ...s, gridCheck: false });
      fx.push({ type: 'log', name: 'owned.corrected', data: { was: s.owned, now: e.ids } });
      return done({
        ...s,
        owned: [...e.ids],
        gridCheck: false,
        lastPick: s.lastPick ? { ...s.lastPick, source: 'grid' } : null,
      });
    }
  }
}
