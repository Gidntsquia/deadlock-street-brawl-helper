// Usage: node scripts/make-hero-gif.mjs <clip.mp4> <startSec> <endSec> [out.gif]
// Cuts the clip, scales to 1280 px wide or less, 12 fps, two-pass palette, looping, no sound.
// ffmpeg comes from PATH, or from FFMPEG=<path> (Open Video Editor ships one in ffmpeg-static).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const [clip, start, end, out = 'docs/brawl-overlay.gif'] = process.argv.slice(2);
if (!clip || start === undefined || end === undefined || !existsSync(clip)) {
  console.error('usage: node scripts/make-hero-gif.mjs <clip.mp4> <startSec> <endSec> [out.gif]');
  process.exit(2);
}
const dur = Number(end) - Number(start);
if (!(dur >= 4 && dur <= 8)) {
  console.error(`duration ${dur}s is outside 4 to 8 s`);
  process.exit(2);
}
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const width = Number(process.env.GIF_WIDTH) || 1280;
const vf = `fps=12,scale=${width}:-2:flags=lanczos`;
const r = spawnSync(
  ffmpeg,
  ['-y', '-ss', start, '-t', String(dur), '-i', clip, '-an', '-filter_complex',
   `[0:v]${vf},split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
   '-loop', '0', out],
  { stdio: 'inherit' },
);
process.exit(r.status ?? 1);
