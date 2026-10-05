// Re-runs a recorded session (the crops the app kept in debug mode) through the real worker and gate on a virtual
// clock, and reports per draft what the recogniser now reads. Used by `npm run brawl:replay` and the fixture tests.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { analyseDraft, type DraftStats, type StatFrame } from '../src/brawl/sessionStats';
import type { WorkerIn, WorkerOut } from '../src/brawl/worker';
import type { DraftRecord } from '../electron/sessionStore';
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
}

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

/** Replays one draft folder (`dNNN` with draft.json, frames.json and the crops). */
export async function replayDraft(dir: string): Promise<ReplayDraft> {
  await boot();
  const live: DraftRecord = JSON.parse(readFileSync(path.join(dir, 'draft.json'), 'utf8'));
  const frames: FramesFile[] = JSON.parse(readFileSync(path.join(dir, 'frames.json'), 'utf8'));
  handler({ data: { type: 'reset' } });
  // The recorder keeps sparse frames, so a long silence between two of them (capture idle, nothing sent) is shortened:
  // the worker's timers (settle, fallback) must not see minutes pass between two neighbouring pictures.
  const GAP_MS = 1000;
  let prevT = frames[0]?.t ?? 0;
  let virtual = 0;
  const stat: StatFrame[] = [];
  for (const f of frames) {
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
    handler({ data: { type: 'frame', width: live.frameW, height: live.frameH, regions, prefer: [] } });
    // the name reads finish a moment after the frame; give them the time the page would
    await new Promise((r) => setTimeout(r, 40));
    const res = posted.find((m): m is Result => m.type === 'result');
    if (!res) continue;
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
  const stats = analyseDraft(stat);
  const diff: string[] = [];
  if (stats.items.join(',') !== live.items.join(','))
    diff.push(`items ${live.items.join(',')} became ${stats.items.join(',')}`);
  if (stats.unsure !== live.unsure) diff.push(`unsure ${live.unsure} became ${stats.unsure}`);
  if (stats.changes !== live.changes) diff.push(`changes ${live.changes} became ${stats.changes}`);
  if (stats.dropouts !== live.dropouts) diff.push(`dropouts ${live.dropouts} became ${stats.dropouts}`);
  return { n: 0, name: path.basename(dir), round: live.round, choice: live.choice, stats, diff, live };
}

/** Replays every draft of a session folder (`m-...`). */
export async function replaySession(folder: string): Promise<ReplayDraft[]> {
  const out: ReplayDraft[] = [];
  const dirs = readdirSync(folder)
    .filter((n) => /^d\d+$/.test(n) && existsSync(path.join(folder, n, 'draft.json')))
    .sort();
  for (const [i, n] of dirs.entries()) out.push({ ...(await replayDraft(path.join(folder, n))), n: i + 1 });
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
  const drafts = await replaySession(folder);
  for (const d of drafts) console.log(`${d.name}  ${describeDraft(d, name)}`);
  if (!drafts.length) console.log('No drafts found in that folder.');
  process.exit(0);
}
