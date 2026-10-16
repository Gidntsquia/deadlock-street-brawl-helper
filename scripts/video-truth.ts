/**
 * Cuts the hand-labelled stretches of a gameplay video into replayable folders under
 * scripts/fixtures/video-truth/<id>/ (frames.json, draft.json, truth.json and WebP crops, lossy, quality 95 for the three card squares and 90 for the rest).
 *
 *   npx tsx scripts/video-truth.ts "/mnt/d/OBS Videos"   (rebuilds every crop from the recording each stretch names)
 *   npx tsx scripts/video-truth.ts "<dir or name.mkv=path>..." [--only s10,s11]
 *   npx tsx scripts/video-truth.ts --truth-only          (rewrites only truth.json from the labels)
 *   npx tsx scripts/video-truth.ts "/mnt/d/OBS Videos" --hero-frames
 *       (cuts only the hero frames: the loading-screen frame of each stretch whose label has `loading: {t, hero}` into
 *        scripts/fixtures/loading/<id>.webp with scripts/fixtures/loading/expect.json, and each `heroMisread:
 *        {name, t, read, hero}` frame, where the portrait reader takes another hero for the player, losslessly into
 *        scripts/fixtures/hero-misread/<name>.webp with scripts/fixtures/hero-misread/expect.json)
 * Each stretch of labels.json names its recording in `file`; the arguments say where those files are.
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
import { onlyIds, resolveVideos } from './lib/videoFiles';

const W = 1280,
  H = 720,
  N = W * H * 3,
  FPS = 4;
const args = process.argv.slice(2);
const truthOnly = args.includes('--truth-only');
const loadingOnly = args.includes('--hero-frames');
const only = onlyIds(args);
const pathArgs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--only');
const labels = JSON.parse(readFileSync('scripts/video-truth/labels.json', 'utf8')) as {
  stretches: {
    id: string;
    file: string;
    video: [number, number];
    hero?: string;
    match?: string;
    loading?: { t: number; hero: string };
    heroMisread?: { name: string; t: number; read: string; hero: string };
    sets: unknown[];
  }[];
};
if (!pathArgs.length && !truthOnly)
  throw new Error('usage: npx tsx scripts/video-truth.ts "<dir or name.mkv=path>..." [--only s10,s11] [--truth-only]');
const videos = truthOnly
  ? new Map<string, string>()
  : resolveVideos(
      pathArgs,
      labels.stretches
        .filter((s) => (!only || only.has(s.id)) && (!loadingOnly || s.loading || s.heroMisread))
        .map((s) => s.file),
    );
const regs = draftRegions(W, H).map((r) => {
  const x = Math.max(0, Math.floor(r.x)),
    y = Math.max(0, Math.floor(r.y));
  return { x, y, width: Math.min(W, Math.ceil(r.x + r.width)) - x, height: Math.min(H, Math.ceil(r.y + r.height)) - y };
});
/** Mean absolute difference per byte below this counts as "the same picture" (video noise only). */
const SAME = 3;

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

if (loadingOnly) {
  // One full frame per labelled loading screen (lossy WebP, quality 95), the "Joining the fight as ..." screen of the
  // match that stretch opens; the test reads its name box the way the probe cuts it.
  mkdirSync('scripts/fixtures/loading', { recursive: true });
  const expect: Record<string, { file: string; recording: string; t: number; hero: string; match?: string }> = {};
  for (const st of labels.stretches) {
    if (!st.loading || (only && !only.has(st.id))) continue;
    const frame = (await decode(videos.get(st.file)!, st.loading.t, st.loading.t + 1 / FPS)).subarray(0, N);
    const file = `${st.id}.webp`;
    await sharp(frame, { raw: { width: W, height: H, channels: 3 } })
      .webp({ quality: 95, effort: 5 })
      .toFile(path.join('scripts/fixtures/loading', file));
    expect[st.id] = { file, recording: st.file, t: st.loading.t, hero: st.loading.hero, match: st.match };
    console.error(st.id, `loading frame at ${st.loading.t} s`);
  }
  writeFileSync('scripts/fixtures/loading/expect.json', JSON.stringify(expect, null, 2) + '\n');
  mkdirSync('scripts/fixtures/hero-misread', { recursive: true });
  const misreads: Record<
    string,
    { file: string; stretch: string; recording: string; t: number; read: string; hero: string }
  > = {};
  for (const st of labels.stretches) {
    const m = st.heroMisread;
    if (!m || (only && !only.has(st.id))) continue;
    // one frame straight from the recording, lossless: the misread depends on the exact pixels
    const frame = (await decode(videos.get(st.file)!, m.t, m.t + 1 / FPS)).subarray(0, N);
    const file = `${m.name}.webp`;
    await sharp(frame, { raw: { width: W, height: H, channels: 3 } })
      .webp({ lossless: true })
      .toFile(path.join('scripts/fixtures/hero-misread', file));
    misreads[m.name] = { file, stretch: st.id, recording: st.file, t: m.t, read: m.read, hero: m.hero };
    console.error(st.id, `hero misread frame at ${m.t} s`);
  }
  writeFileSync('scripts/fixtures/hero-misread/expect.json', JSON.stringify(misreads, null, 2) + '\n');
  process.exit(0);
}

for (const st of labels.stretches) {
  if (only && !only.has(st.id)) continue;
  const dir = path.join('scripts/fixtures/video-truth', st.id);
  if (truthOnly) {
    writeFileSync(path.join(dir, 'truth.json'), JSON.stringify({ video: st.video, fps: FPS, sets: st.sets }, null, 1));
    continue;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const [from, to] = st.video;
  const all = await decode(videos.get(st.file)!, from, to);
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
