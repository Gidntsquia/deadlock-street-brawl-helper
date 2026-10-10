// Re-runs a recorded session (the crops the app kept in debug mode) through the real worker and gate on a virtual
// clock, and reports per draft what the recogniser now reads. Used by `npm run brawl:replay` and the fixture tests.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { analyseDraft, type DraftStats, type StatFrame } from '../src/brawl/sessionStats';
import type { WorkerIn, WorkerOut } from '../src/brawl/worker';
import type { DraftRecord } from '../electron/sessionStore';
import type { TrackSummary } from '../src/brawl/tracker';
import type { Item } from '../src/types';

type Result = Extract<WorkerOut, { type: 'result' }>;
export interface ReplayDraft {
  n: number;
  name: string;
  round: number;
  choice: number;
  stats: DraftStats;
  /** Differences from what the app showed live, as sentences; empty when it matches. */
  diff: string[];
  live: DraftRecord;
  /** Index in frames.json of the frame on which the set was first accepted, -1 when none was. */
  acceptFrame: number;
  /** What the worker read on the way: the player's hero id (0 unread), re-rolls remaining, owned items. */
  hero: number;
  rerolls: number | null;
  inventory: number[] | null;
  /** Last frame on which all three cards had a read, -1 when none. */
  lastFull: number;
  /** Per slot, whether the accepted set read the card as enhanced. */
  enhanced: boolean[];
  /** What the state machine saw: name reads per slot, re-rolls and resyncs during this draft, where the pick came from. */
  track: { reads: [number, number, number]; rerolls: number; resyncs: number; pickSource: string | null };
}

let lastTrack: TrackSummary | null = null;

let clock = 0;
let handler: (ev: { data: WorkerIn }) => void = () => {};
const posted: WorkerOut[] = [];
let ready: Promise<void> | null = null;

function boot() {
  ready ??= (async () => {
    performance.now = () => clock;
    (globalThis as unknown as { self: unknown }).self = {
      addEventListener: (_: string, h: typeof handler) => (handler = h),
      postMessage: (m: WorkerOut) => posted.push(m),
    };
    await import('../src/brawl/worker');
    const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
    handler({
      data: {
        type: 'init',
        index: JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')),
        tiers: Object.fromEntries(items.map((i) => [i.id, i.item_tier])),
        names: Object.fromEntries(items.map((i) => [i.id, i.name])),
        intervalMs: 250,
      },
    });
  })();
  return ready;
}

interface FramesFile {
  t: number;
  regions: { x: number; y: number; width: number; height: number; file: string }[];
}

/** `waitNames`: hold the first frame until its three name reads land (up to 8 s). For a synthetic recording on a loaded
 *  machine; real recordings keep the fixed beat, since their timing is part of what they pin. */
export interface ReplayOpts {
  waitNames?: boolean;
  /** Replay the recorded frames up to this one, then post it four more times 400 ms apart: what the app reads of a screen that stays up. */
  hold?: number;
  /** Called with every worker result and the frame's recorded time (ms), for tools that follow a replay frame by frame. */
  onResult?: (frame: number, res: Result, t: number) => void;
}

/** Replays one draft folder (`dNNN` with draft.json, frames.json and the crops). */
export async function replayDraft(dir: string, opts: ReplayOpts = {}): Promise<ReplayDraft> {
  await boot();
  const live: DraftRecord = JSON.parse(readFileSync(path.join(dir, 'draft.json'), 'utf8'));
  let frames: FramesFile[] = JSON.parse(readFileSync(path.join(dir, 'frames.json'), 'utf8'));
  if (opts.hold !== undefined && frames[opts.hold])
    frames = [
      ...frames.slice(0, opts.hold + 1),
      ...Array.from({ length: 4 }, (_, i) => ({ ...frames[opts.hold!]!, t: frames[opts.hold!]!.t + (i + 1) * 400 })),
    ];
  handler({ data: { type: 'reset' } });
  // The recorder keeps sparse frames, so a long silence between two of them (capture idle, nothing sent) is shortened:
  // the worker's timers (settle, fallback) must not see minutes pass between two neighbouring pictures.
  const GAP_MS = 1000;
  let prevT = frames[0]?.t ?? 0;
  let virtual = 0;
  const stat: StatFrame[] = [];
  let first = true;
  let acceptFrame = -1;
  let lastFull = -1;
  let enhanced: boolean[] = [false, false, false];
  let hero = 0;
  let rerolls: number | null = null;
  let inventory: number[] | null = null;
  const resyncs0 = lastTrack?.resyncs ?? 0;
  const closed0 = lastTrack?.closed.length ?? 0;
  let lastMsg: WorkerIn | null = null;
  for (const [fi, f] of frames.entries()) {
    virtual += Math.min(f.t - prevT, GAP_MS);
    prevT = f.t;
    clock = virtual + 1000;
    const regions = await Promise.all(
      f.regions.map(async (r) => {
        const { data } = await sharp(path.join(dir, r.file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const b = new Uint8ClampedArray(data.length);
        b.set(data);
        return { x: r.x, y: r.y, width: r.width, height: r.height, buffer: b.buffer };
      }),
    );
    posted.length = 0;
    lastMsg = { type: 'frame', width: live.frameW, height: live.frameH, regions, prefer: [] };
    handler({ data: lastMsg });
    // the name reads finish a moment after the frame; give them the time the page would
    await new Promise((r) => setTimeout(r, 40));
    await (await import('../src/brawl/worker')).readsIdle();
    // the first frame's three name reads include the OCR engine's slow start: wait for them (up to 8 s) instead of a fixed
    // beat, so a loaded machine replays the same draft as an idle one
    for (
      let w = 0;
      w < 400 && opts.waitNames && !stat.length && first && posted.filter((m) => m.type === 'name').length < 3;
      w++
    )
      await new Promise((r) => setTimeout(r, 20));
    first = false;
    for (const m of posted) {
      if (m.type === 'rerolls') rerolls = m.rerollsRemaining;
      const t = m.type === 'track' ? m : m.type === 'result' ? m.track : undefined;
      if (t) lastTrack = t.summary;
    }
    const results = posted.filter((m): m is Result => m.type === 'result');
    // a read that landed after the frame was answered re-runs it: the last result is what the screen showed, and the
    // accept may have come with that re-run
    const res = results.at(-1);
    if (!res) continue;
    if (results.some((r) => r.accepted) && !res.accepted) res.accepted = true;
    opts.onResult?.(fi, res, f.t);
    if (res.accepted && acceptFrame < 0) acceptFrame = fi;
    if (res.accepted) enhanced = res.reads.map((x) => x.present && !x.unsure && x.enhanced);
    if (res.reads.length === 3 && res.reads.every((x) => x.present && !x.unsure)) lastFull = fi;
    if (res.meta?.self) hero = res.meta.self;
    // the accepted set carries the count it was accepted with; later changes arrive as separate 'rerolls' messages
    if (res.meta && res.meta.rerollsRemaining >= 0) rerolls = res.meta.rerollsRemaining;
    if (res.inventory) inventory = res.inventory;
    stat.push({
      t: clock,
      shop: res.shop,
      live: res.live,
      accepted: res.accepted,
      picked: res.picked !== null,
      spent: res.spent,
      round: res.round,
      choice: res.choice,
      items: res.reads.map((x) => (x.present && !x.unsure ? x.itemId : 0)),
      unsure: res.reads.filter((x) => x.unsure).length,
      tiers: res.reads.map((x) => x.tier),
    });
  }
  // A last identical frame, not counted in the stats, collects the name reads that landed after the final recorded one.
  if (lastMsg?.type === 'frame') {
    await new Promise((r) => setTimeout(r, 150));
    posted.length = 0;
    handler({
      data: { ...lastMsg, regions: lastMsg.regions.map((r) => ({ ...r, buffer: r.buffer.slice(0) })) },
    });
    for (const m of posted) {
      const t = m.type === 'track' ? m : m.type === 'result' ? m.track : undefined;
      if (t) lastTrack = t.summary;
    }
  }
  const stats = analyseDraft(stat);
  const sum = lastTrack as TrackSummary | null;
  const mine = (sum?.closed ?? [])
    .slice(Math.min(closed0, sum?.closed.length ?? 0))
    .filter((c) => c.round === live.round && c.choice === live.choice);
  const set = [...mine].reverse().find((c) => !c.rerolled) ?? mine.at(-1);
  const track: ReplayDraft['track'] = {
    reads: sum?.locked ? sum.reads : (set?.reads ?? sum?.reads ?? [0, 0, 0]),
    rerolls: mine.filter((c) => c.rerolled).length,
    resyncs: (sum?.resyncs ?? 0) - resyncs0,
    pickSource: set?.pickSource ?? null,
  };
  const diff: string[] = [];
  if (stats.items.join(',') !== live.items.join(','))
    diff.push(`items ${live.items.join(',')} became ${stats.items.join(',')}`);
  if (stats.unsure !== live.unsure) diff.push(`unsure ${live.unsure} became ${stats.unsure}`);
  if (stats.changes !== live.changes) diff.push(`changes ${live.changes} became ${stats.changes}`);
  if (stats.dropouts !== live.dropouts) diff.push(`dropouts ${live.dropouts} became ${stats.dropouts}`);
  return {
    n: 0,
    name: path.basename(dir),
    round: live.round,
    choice: live.choice,
    stats,
    diff,
    live,
    acceptFrame,
    hero,
    rerolls,
    inventory,
    lastFull,
    enhanced,
    track,
  };
}

/** Replays every draft of a session folder (`m-...`). */
export async function replaySession(folder: string, opts: ReplayOpts = {}): Promise<ReplayDraft[]> {
  const out: ReplayDraft[] = [];
  if (existsSync(path.join(folder, 'draft.json'))) return [{ ...(await replayDraft(folder, opts)), n: 1 }];
  const dirs = readdirSync(folder)
    .filter((n) => /^d\d+$/.test(n) && existsSync(path.join(folder, n, 'draft.json')))
    .sort();
  for (const [i, n] of dirs.entries()) out.push({ ...(await replayDraft(path.join(folder, n), opts)), n: i + 1 });
  return out;
}

export function describeDraft(d: ReplayDraft, itemName: (id: number) => string): string {
  const s = d.stats;
  return [
    `R${d.round} C${d.choice}`,
    `items: ${s.items.map((id) => (id ? itemName(id) : '?')).join(' / ') || 'none'}`,
    `? ${s.unsure}`,
    `changes ${s.changes}`,
    `dropouts ${s.dropouts}`,
    `advice ${s.adviceMs === null ? 'none' : `${Math.round(s.adviceMs)} ms`}`,
    `reads ${d.track.reads.join('/')}`,
    `re-rolls ${d.track.rerolls}`,
    `resyncs ${d.track.resyncs}`,
    `pick ${d.track.pickSource ?? 'none'}`,
    d.diff.length ? `differs from live: ${d.diff.join('; ')}` : 'same as live',
  ].join(' | ');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'replay.ts') {
  const folder = process.argv[2];
  if (!folder) {
    console.error('usage: npm run brawl:replay -- <session folder>');
    process.exit(2);
  }
  const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
  const name = (id: number) => items.find((i) => i.id === id)?.name ?? `#${id}`;
  const drafts = await replaySession(folder, { waitNames: true });
  for (const d of drafts) console.log(`${d.name}  ${describeDraft(d, name)}`);
  if (!drafts.length) console.log('No drafts found in that folder.');
  process.exit(0);
}
