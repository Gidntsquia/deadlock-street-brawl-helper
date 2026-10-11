// Scores a replay of a hand-labelled video stretch (scripts/fixtures/video-truth) against what the cards truly were.
// The rules are about what a player sees: advice only for the real draft on screen, never a wrong or mixed item, every
// readable set advised quickly, and no flicker while a set stays up.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { replayDraft } from '../replay';
import type { Item } from '../../src/types';

export interface TruthSet {
  draft: string;
  round: number;
  choice: number;
  items: [string, string, string];
  /** Video seconds in which this set is the draft on screen. */
  from: number;
  to: number;
  /** Video seconds in which all three cards are plainly readable (null when never). */
  readable: [number, number] | null;
  /** Slots a tooltip or the cursor hides for good: a grey `?` is right there, a wrong item is not. */
  covered?: number[];
}
export interface Truth {
  video: [number, number];
  fps: number;
  sets: TruthSet[];
}

/** Seconds of slack before a set's window (cards fade in) and after it (cards fade out after a pick, and the plates
 *  linger a few frames until the empty circles are seen). */
export const TOL = 0.5;
export const TOL_AFTER = 1.0;
/** A readable set must be advised this soon after it becomes readable. */
export const ADVICE_BY = 1.0;
/** Sets readable for less than this are too brief to demand advice. */
export const BRIEF = 1.0;

export interface TruthReport {
  violations: string[];
  /** Per set: seconds from readable to the first correct advice, or null. */
  latency: { set: string; secs: number | null }[];
}

export async function scoreStretch(dir: string): Promise<TruthReport> {
  const truth: Truth = JSON.parse(readFileSync(path.join(dir, 'truth.json'), 'utf8'));
  const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
  const name = (id: number) => (id ? (items.find((i) => i.id === id)?.name ?? `#${id}`) : '?');
  const vt = (f: number) => truth.video[0] + f / truth.fps;
  const label = (s: TruthSet) => `${s.draft} ${s.round}.${s.choice}`;
  const frames: { t: number; on: boolean; round: number; choice: number; names: string[] }[] = [];
  await replayDraft(dir, {
    waitNames: true,
    onResult: (f, res) =>
      frames.push({
        t: vt(f),
        on: res.live && !res.spent,
        round: res.round,
        choice: res.choice,
        names: res.reads.map((r) => (r.present && !r.unsure ? name(r.itemId) : '?')),
      }),
  });
  const violations: string[] = [];
  const at = (t: number) => `${t.toFixed(2)}s`;
  const matches = (fr: (typeof frames)[number], s: TruthSet) =>
    fr.names.every((n, i) => n === s.items[i] || (n === '?' && !!s.covered?.includes(i)));
  // R1 and R4: what is advised must be the draft on screen, exactly.
  let bad = '';
  for (const fr of frames) {
    if (!fr.on) continue;
    const near = truth.sets.filter((s) => fr.t >= s.from - TOL && fr.t <= s.to + TOL_AFTER);
    const what = `${fr.round}.${fr.choice} ${fr.names.join(' | ')}`;
    let v = '';
    if (!near.length) v = `R4 advice with no draft on screen: ${what}`;
    else if (!near.some((s) => matches(fr, s)))
      v = `R1 wrong advice: ${what}, truth ${near.map((s) => `${s.round}.${s.choice} ${s.items.join(' | ')}`).join(' or ')}`;
    if (v && v !== bad) violations.push(`${at(fr.t)} ${v}`);
    bad = v;
  }
  // R2 and R3: each readable set is advised in time and stays advised while it is readable.
  const latency: TruthReport['latency'] = [];
  for (const s of truth.sets) {
    if (!s.readable || s.readable[1] - s.readable[0] < BRIEF) {
      latency.push({ set: label(s), secs: null });
      continue;
    }
    const [a, b] = s.readable;
    const first = frames.find((f) => f.on && f.t >= s.from - TOL && f.t <= s.to + TOL_AFTER && matches(f, s));
    latency.push({ set: label(s), secs: first ? +(first.t - a).toFixed(2) : null });
    if (!first) violations.push(`R2 ${label(s)} never advised (readable ${at(a)} to ${at(b)})`);
    else {
      if (first.t > a + ADVICE_BY)
        violations.push(`R2 ${label(s)} advised at ${at(first.t)}, ${(first.t - a).toFixed(2)} s after readable`);
      let dropped = false;
      for (const f of frames)
        if (f.t > first.t && f.t <= Math.min(b, s.to) - 1.0) {
          if (!f.on && !dropped) violations.push(`R3 ${label(s)} advice dropped at ${at(f.t)} while readable`);
          dropped = !f.on;
        }
    }
  }
  return { violations, latency };
}
