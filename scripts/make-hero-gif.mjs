// Usage: node scripts/make-hero-gif.mjs <clip.mp4> <start-end[,start-end...]> [out.gif]
// Joins the excerpts (seconds in the clip), speeds them up (SPEED=<x>, default 1), scales to GIF_WIDTH
// (default 1280) px wide, 12 fps, two-pass palette, looping, no sound. The gif must run 4 to 8 s.
// ffmpeg comes from PATH, or from FFMPEG=<path> (Open Video Editor ships one in ffmpeg-static).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const [clip, ranges, out = 'docs/brawl-overlay.gif'] = process.argv.slice(2);
const segs = (ranges ?? '').split(',').map((r) => r.split('-').map(Number));
if (!clip || !existsSync(clip) || segs.some((s) => s.length !== 2 || !(s[1] > s[0]))) {
  console.error('usage: node scripts/make-hero-gif.mjs <clip.mp4> <start-end[,start-end...]> [out.gif]');
  process.exit(2);
}
const speed = Number(process.env.SPEED) || 1;
const outDur = segs.reduce((t, [a, b]) => t + (b - a), 0) / speed;
if (!(outDur >= 4 && outDur <= 8)) {
  console.error(`gif length ${outDur.toFixed(1)}s is outside 4 to 8 s`);
  process.exit(2);
}
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const width = Number(process.env.GIF_WIDTH) || 1280;
const parts = segs.map(
  ([a, b], i) => `[0:v]trim=${a}:${b},setpts=(PTS-STARTPTS)/${speed},fps=12,scale=${width}:-2:flags=lanczos[v${i}]`,
);
const join = segs.map((_, i) => `[v${i}]`).join('') + `concat=n=${segs.length}:v=1:a=0`;
const graph = `${parts.join(';')};${join},split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
const r = spawnSync(ffmpeg, ['-y', '-i', clip, '-an', '-filter_complex', graph, '-loop', '0', out], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
