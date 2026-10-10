/**
 * Cuts the hand-labelled stretches of a gameplay video into replayable folders under
 * scripts/fixtures/video-truth/<id>/ (frames.json, draft.json, truth.json and WebP crops, lossy, quality 95 for the three card squares and 90 for the rest).
 *
 *   npx tsx scripts/video-truth.ts "<video.mkv>"
 *
 * The labels (what the cards truly were, and when they were readable) live in scripts/video-truth/labels.json and were
 * written by looking at the video; they are never derived from the app's own output. Frames are 4 per second at the
 * video's 1280x720. A region is listed in a frame only when its pixels changed since the last listed copy, which is
 * what the page does too (it copies a region only when the picture changed).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { draftRegions } from '../src/brawl';

const W = 1280,
  H = 720,
  N = W * H * 3,
  FPS = 4;
const [video] = process.argv.slice(2);
if (!video) throw new Error('usage: npx tsx scripts/video-truth.ts "<video.mkv>"');
const labels = JSON.parse(readFileSync('scripts/video-truth/labels.json', 'utf8')) as {
  stretches: { id: string; video: [number, number]; sets: unknown[] }[];
};
const regs = draftRegions(W, H).map((r) => {
  const x = Math.max(0, Math.floor(r.x)),
    y = Math.max(0, Math.floor(r.y));
  return { x, y, width: Math.min(W, Math.ceil(r.x + r.width)) - x, height: Math.min(H, Math.ceil(r.y + r.height)) - y };
});
/** Mean absolute difference per byte below this counts as "the same picture" (video noise only). */
const SAME = 3;

async function decode(from: number, to: number): Promise<Buffer> {
  const p = spawn('ffmpeg', [
    ...['-v', 'error', '-ss', String(from), '-t', String(to - from), '-i', video],
    ...['-vf', `fps=${FPS}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  ]);
  const chunks: Buffer[] = [];
  p.stdout.on('data', (c: Buffer) => chunks.push(c));
  await new Promise((r) => p.on('close', r));
  return Buffer.concat(chunks);
}

for (const st of labels.stretches) {
  const dir = path.join('scripts/fixtures/video-truth', st.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const [from, to] = st.video;
  const all = await decode(from, to);
  const nf = Math.floor(all.length / N);
  const last: (Buffer | null)[] = regs.map(() => null);
  const frames: unknown[] = [];
  let files = 0;
  for (let f = 0; f < nf; f++) {
    const rs: unknown[] = [];
    for (const [i, r] of regs.entries()) {
      const crop = await sharp(all.subarray(f * N, (f + 1) * N), { raw: { width: W, height: H, channels: 3 } })
        .extract({ left: r.x, top: r.y, width: r.width, height: r.height })
        .raw()
        .toBuffer();
      const prev = last[i];
      if (prev) {
        let d = 0;
        for (let k = 0; k < crop.length; k++) d += Math.abs(crop[k] - prev[k]);
        if (d / crop.length < SAME && f % 16 !== 0) continue;
      }
      last[i] = crop;
      const file = `f${f}-r${i}.webp`;
      await sharp(crop, { raw: { width: r.width, height: r.height, channels: 3 } })
        .webp({ quality: i < 3 ? 95 : 90, effort: 5 })
        .toFile(path.join(dir, file));
      files++;
      rs.push({ index: i, ...r, file });
    }
    frames.push({ t: (f * 1000) / FPS, regions: rs });
  }
  writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(frames));
  writeFileSync(
    path.join(dir, 'draft.json'),
    JSON.stringify({
      round: 1,
      choice: 1,
      startedAt: 0,
      frameW: W,
      frameH: H,
      items: [],
      unsure: 0,
      hero: { id: 0, source: 'none' },
      shown: { plates: [], takeId: null, reroll: false },
      adviceMs: null,
      changes: 0,
      dropouts: 0,
      fallback: false,
    }),
  );
  writeFileSync(path.join(dir, 'truth.json'), JSON.stringify({ video: st.video, fps: FPS, sets: st.sets }, null, 1));
  console.error(st.id, `${nf} frames`, `${files} crops`);
}
