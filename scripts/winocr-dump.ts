// Writes every readable labelled name crop (as the trimmed black-on-white line, 3x) to a folder with an index.json, for
// scripts/winocr.ps1 to read with Windows.Media.Ocr; scripts/winocr-score.ts then resolves the output.
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { trimInk } from './lib/paddle';
import { loadNameSamples } from './lib/nameFrames';
const dir = process.argv[2]!;
mkdirSync(dir, { recursive: true });
const all = (await loadNameSamples({ videoStep: 2 })).filter((s) => s.label !== null || s.covered);
const idx: { file: string; frame: string; slot: number; label: string | null; covered: boolean }[] = [];
for (const [n, s] of all.entries()) {
  let ink = 0;
  for (let i = 0; i < s.crop.data.length; i += 4) if (s.crop.data[i] === 0) ink++;
  if (ink < 500) continue;
  const t = trimInk({ data: s.crop.data, width: s.crop.width, height: s.crop.height, channels: 4 }, 20);
  const file = `c${n}.png`;
  await sharp(Buffer.from(t.data), { raw: { width: t.width, height: t.height, channels: 4 } })
    .resize({ height: Math.max(t.height, 90), kernel: 'lanczos3' })
    .removeAlpha().png().toFile(`${dir}/${file}`);
  idx.push({ file, frame: s.frame, slot: s.slot, label: s.label, covered: !!s.covered });
}
writeFileSync(`${dir}/index.json`, JSON.stringify(idx));
console.log(idx.length);
