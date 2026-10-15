/**
 * Old-app baseline read off the OBS footage: for every labelled set, `appear` (first frame any card circle is
 * filled) and `oldPlate` (first frame the old app's teal plate is drawn above a card), `oldMs = (oldPlate - appear)`.
 *
 *   npx tsx scripts/footage-latency.ts "<dir or name.mkv=path>..." [--only s10,s11] [--write-labels]
 *
 * Teal detection: in the plate box above each card (card centre x +-70, y -108 +-22 at 1280x720) count pixels within
 * +-20 of the plate fill `#2ec4b6` (46,196,182); the card ring's green has low blue and the game's teal glow is
 * lighter. A box with >= TEAL_PX (150) such pixels is a teal plate. Only the advised card has one. The previous set's
 * plate lingers a few frames after a pick, so a plate counts only after the plates were seen gone first. A set with
 * no plate (a re-roll call, or one the colour test misses) gets `oldMs: null` and is left out of the comparison.
 * Frames are 4 per second. Output: scripts/video-truth/footage-latency.json; `--write-labels` also stores `appear`
 * on each set in labels.json. Needs the source video; run by hand.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { cardEmpty, cardSquares } from '../src/brawl';
import { onlyIds, resolveVideos } from './lib/videoFiles';

const W = 1280,
  H = 720,
  N = W * H * 3,
  FPS = 4,
  TEAL_PX = 150;
const only = onlyIds(process.argv);
const pathArgs = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--only');
if (!pathArgs.length)
  throw new Error(
    'usage: npx tsx scripts/footage-latency.ts "<dir or name.mkv=path>..." [--only s10,s11] [--write-labels]',
  );
const labelsPath = 'scripts/video-truth/labels.json';
const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
const videos = resolveVideos(
  pathArgs,
  labels.stretches.filter((s: { id: string }) => !only || only.has(s.id)).map((s: { file: string }) => s.file),
);
const squares = cardSquares(W, H);

async function decode(video: string, from: number, to: number): Promise<Buffer> {
  const p = spawn('ffmpeg', [
    ...['-v', 'error', '-ss', String(from), '-t', String(to - from), '-i', video],
    ...['-vf', `fps=${FPS}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  ]);
  const chunks: Buffer[] = [];
  p.stdout.on('data', (c: Buffer) => chunks.push(c));
  await new Promise((r) => p.on('close', r));
  return Buffer.concat(chunks);
}
function tealPlates(buf: Buffer): number {
  let hits = 0;
  for (const sq of squares) {
    const cx = sq.x + sq.edge / 2,
      cy = sq.y + sq.edge / 2;
    let n = 0;
    for (let y = Math.round(cy - 130); y < cy - 86; y++)
      for (let x = Math.round(cx - 70); x < cx + 70; x++) {
        if (y < 0 || x < 0 || x >= W) continue;
        const o = (y * W + x) * 3,
          r = buf[o],
          g = buf[o + 1],
          b = buf[o + 2];
        if (r > 25 && r < 75 && g > 175 && g < 215 && b > 160 && b < 200) n++;
      }
    if (n >= TEAL_PX) hits++;
  }
  return hits;
}

const rows: { stretch: string; draft: string; appear: number | null; oldPlate: number | null; oldMs: number | null }[] =
  [];
for (const st of labels.stretches) {
  if (only && !only.has(st.id)) continue;
  const [v0, v1] = st.video as [number, number];
  const all = await decode(videos.get(st.file)!, v0, v1);
  const nf = Math.floor(all.length / N);
  const frame = (f: number) => all.subarray(f * N, (f + 1) * N);
  const anyCard = (f: number) =>
    squares.some((sq) => !cardEmpty({ width: W, height: H, data: frame(f), channels: 3 }, sq));
  let prevTo = v0;
  for (const s of st.sets as { draft: string; from: number; to: number; appear?: number }[]) {
    const f0 = Math.max(Math.round((Math.max(s.from - 1, prevTo) - v0) * FPS), 0);
    const f1 = Math.min(Math.round((s.to + 1 - v0) * FPS), nf - 1);
    // The set appears at the first filled circle after the last all-empty frame up to just after its labelled `from`
    // (earlier frames hold the previous set fading out); with no empty frame there, the labelled `from` stands.
    const fFrom = Math.round((s.from + 0.5 - v0) * FPS);
    let gap = -1;
    for (let f = f0; f <= Math.min(fFrom, f1); f++) if (!anyCard(f)) gap = f;
    let a = -1;
    if (gap < 0) a = Math.min(Math.max(Math.round((s.from - v0) * FPS), 0), nf - 1);
    else for (let f = gap; f <= f1 && a < 0; f++) if (anyCard(f)) a = f;
    // The previous set's plate lingers a few frames after its pick: a plate counts only once the plates have been
    // seen gone (the `Reading` sign shows in between) and then drawn again.
    let p = -1,
      gone = false;
    for (let f = Math.max(a, 0); f <= f1 && a >= 0 && p < 0; f++) {
      if (tealPlates(frame(f)) === 0) gone = true;
      else if (gone) p = f;
    }
    const appear = a < 0 ? null : v0 + a / FPS,
      oldPlate = p < 0 ? null : v0 + p / FPS;
    s.appear = appear ?? s.from;
    rows.push({
      stretch: st.id,
      draft: s.draft,
      appear,
      oldPlate,
      oldMs: appear != null && oldPlate != null ? Math.round((oldPlate - appear) * 1000) : null,
    });
    console.error(st.id, s.draft, appear, oldPlate);
    prevTo = s.to;
  }
}
const rowsPath = 'scripts/video-truth/footage-latency.json';
// With --only, the other stretches' rows stay as they were.
const kept = only
  ? (JSON.parse(readFileSync(rowsPath, 'utf8')) as { stretch: string }[]).filter((r) => !only.has(r.stretch))
  : [];
const order = (r: { stretch: string }) => Number(r.stretch.slice(1));
writeFileSync(
  rowsPath,
  JSON.stringify(
    [...kept, ...rows].sort((a, b) => order(a) - order(b)),
    null,
    1,
  ) + '\n',
);
if (process.argv.includes('--write-labels')) writeFileSync(labelsPath, JSON.stringify(labels, null, 2) + '\n');
