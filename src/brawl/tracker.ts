// Runs the pure Street Brawl state machine (brawlState.ts) for the worker. The worker's reading (name locks, the gate)
// is what sees the screen; this follows it with named events and keeps what the machine knows that the reading does
// not: how many times each slot was read, resyncs, re-roll used this round, where each pick came from. One instance
// lives as long as the worker, across capture sessions, so a match keeps its round, re-roll and owned list while
// capture is off between rounds.
import { initialBrawl, setLocked, step, type BrawlEvent, type BrawlState, type PickSource } from './brawlState';

/** A set that has gone: what it cost to read and how it ended. */
export interface ClosedSet {
  round: number;
  choice: number;
  /** Name reads per slot while the set was up. */
  reads: [number, number, number];
  rerolled: boolean;
  /** How the pick was found, when the set ended in one. */
  pickSource: PickSource | null;
}

export interface TrackLog {
  name: string;
  data?: Record<string, unknown>;
}

/** What the page needs from the machine. */
export interface TrackSummary {
  round: number;
  choice: number;
  phase: BrawlState['phase'];
  matchId: number;
  /** A re-roll was seen this round: none is advised again until the next round. */
  rerollUsedThisRound: boolean;
  resyncs: number;
  /** Name reads per slot for the set that is up now, and whether all three are locked. */
  reads: [number, number, number];
  locked: boolean;
  owned: number[];
  /** Newest status line from the machine (`Resynced to round N choice M`), '' when none. */
  status: string;
  /** Bumped each time `status` is set, so the page shows it even when the text repeats. */
  statusSeq: number;
  closed: ClosedSet[];
}

export interface TrackOut {
  summary: TrackSummary;
  /** Log lines the machine asked for since the last `take`. */
  logs: TrackLog[];
}

const KEEP_CLOSED = 12;
const total = (r: readonly number[]) => r.reduce((a, b) => a + b, 0);

export function createTracker(onWarm: () => void) {
  let state = initialBrawl();
  let status = '',
    statusSeq = 0,
    dirty = false;
  let closed: ClosedSet[] = [];
  let logs: TrackLog[] = [];
  let wantGrid = false;
  const summary = (): TrackSummary => ({
    round: state.round,
    choice: state.choice,
    phase: state.phase,
    matchId: state.matchId,
    rerollUsedThisRound: state.rerollUsedThisRound,
    resyncs: state.resyncs,
    reads: state.reads,
    locked: setLocked(state),
    owned: state.owned,
    status,
    statusSeq,
    closed,
  });
  return {
    state: () => state,
    feed(e: BrawlEvent) {
      const prev = state;
      const r = step(state, e);
      state = r.state;
      let rerolled = false;
      for (const fx of r.effects) {
        if (fx.type === 'log') logs.push({ name: fx.name, data: fx.data });
        else if (fx.type === 'warm') onWarm();
        else if (fx.type === 'reroll') rerolled = true;
        else if (fx.type === 'status') {
          status = fx.text;
          statusSeq++;
        } else if (fx.type === 'readGrid') wantGrid = true;
      }
      if ((total(prev.reads) > 0 || setLocked(prev)) && state.slots.every((x) => x.kind === 'empty'))
        closed = [
          ...closed,
          {
            round: prev.round,
            choice: prev.choice,
            reads: prev.reads,
            rerolled,
            pickSource: e.type === 'pick' ? (state.lastPick?.source ?? null) : null,
          },
        ].slice(-KEEP_CLOSED);
      if (r.effects.length || state !== prev) dirty = true;
    },
    /** True once after the machine asked for the owned grid to be checked. */
    gridWanted() {
      const w = wantGrid;
      wantGrid = false;
      return w;
    },
    /** The summary and the new log lines, or null when nothing happened since the last call. */
    take(): TrackOut | null {
      if (!dirty && !logs.length) return null;
      dirty = false;
      const out = { summary: summary(), logs };
      logs = [];
      return out;
    },
  };
}
export type Tracker = ReturnType<typeof createTracker>;
