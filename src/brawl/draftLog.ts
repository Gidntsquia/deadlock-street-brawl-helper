// Page-side bookkeeping for debug-mode recording: which frames of a draft are worth keeping, and where one draft ends.
// Pure, so it is tested without the page. The page feeds it every draft frame it sends and every worker result.
import { analyseDraft, type DraftStats, type StatFrame } from './sessionStats';

/** Frames kept per draft, at these times after the draft screen was first seen (ms), plus the accepted frame. */
const KEEP_AT = [0, 300, 700, 1200, 1800, 2500, 3200];
const MAX_GAP_MS = 2000; // a silence this long between draft frames restarts the keep schedule
const AFTER_ACCEPT_MS = 1000;
const MIN_MISS_MS = 1000; // a draft that never got plates is recorded only if it was up this long

export type Shot = 'full' | 'light' | null;

export interface DraftEnd {
  stats: DraftStats;
  round: number;
  choice: number;
  startedAt: number;
}

export class DraftLog {
  private t0: number | null = null;
  private kept = 0;
  private keepNext = false;
  private acceptedAt: number | null = null;
  private lastAfter = false;
  private frames: StatFrame[] = [];
  private lastKey = '';
  private startedAt = 0;
  private lastSeen = 0;

  /** Called for each draft frame sent to the worker: whether to keep it, and how much of it. */
  wantFrame(now: number): Shot {
    // No frames for a while (capture was idle): a new run of kept frames starts, so they sit together.
    if (this.t0 !== null && now - this.lastSeen > MAX_GAP_MS && this.acceptedAt === null) {
      this.t0 = now;
      this.kept = 0;
    }
    this.lastSeen = now;
    if (this.t0 === null) {
      this.t0 = now;
      this.startedAt = Date.now();
    }
    const t = now - this.t0;
    let want = this.keepNext;
    this.keepNext = false;
    if (this.kept < KEEP_AT.length && t >= KEEP_AT[this.kept]!) {
      this.kept++;
      want = true;
    }
    if (this.acceptedAt !== null && !this.lastAfter && now - this.acceptedAt >= AFTER_ACCEPT_MS) {
      this.lastAfter = true;
      want = true;
    }
    return want ? (t === 0 || this.frames.length === 0 ? 'full' : 'light') : null;
  }
  /** A worker result. Returns the finished draft when this frame ends one. */
  push(f: StatFrame, key: string, now: number): DraftEnd | null {
    let end: DraftEnd | null = null;
    const accepted = this.frames.find((x) => x.accepted);
    const newSet = f.accepted && !!accepted && key.replace(/\+/g, '') !== this.lastKey.replace(/\+/g, '');
    if (accepted && (f.picked || !f.shop || newSet)) {
      if (f.picked) this.frames.push(f);
      end = this.finish(accepted);
      this.frames = f.picked || !f.shop ? [] : [f];
    } else if (!f.shop) {
      const up = this.frames.length ? this.frames[this.frames.length - 1]!.t - this.frames[0]!.t : 0;
      if (this.frames.length && up >= MIN_MISS_MS) end = this.finish(null);
      this.frames = [];
    } else this.frames.push(f);
    if (f.accepted) {
      this.lastKey = key;
      this.acceptedAt = now;
      this.keepNext = true;
    }
    if (end || !f.shop) this.resetClock();
    return end;
  }

  private finish(accepted: StatFrame | null): DraftEnd {
    const stats = analyseDraft(this.frames);
    return {
      stats,
      round: accepted?.round ?? this.frames.find((x) => x.round)?.round ?? 0,
      choice: accepted?.choice ?? this.frames.find((x) => x.choice)?.choice ?? 0,
      startedAt: this.startedAt,
    };
  }
  private resetClock() {
    this.t0 = null;
    this.kept = 0;
    this.keepNext = false;
    this.acceptedAt = null;
    this.lastAfter = false;
    this.lastKey = '';
  }
}
