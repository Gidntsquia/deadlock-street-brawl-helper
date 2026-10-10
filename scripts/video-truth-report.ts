// Prints the truth-set violations and advice latencies per stretch: `npx tsx scripts/video-truth-report.ts [s0,s3]`.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { scoreStretch } from './lib/videoTruth';

const root = path.join('scripts', 'fixtures', 'video-truth');
const only = process.argv[2]?.split(',');
let total = 0;
for (const d of readdirSync(root)
  .filter((n) => /^s\d+$/.test(n))
  .sort()) {
  if (only && !only.includes(d)) continue;
  const r = await scoreStretch(path.join(root, d));
  total += r.violations.length;
  console.log(
    `== ${d}: ${r.violations.length} violations; latency ${r.latency.map((l) => `${l.set} ${l.secs ?? '-'}`).join(', ')}`,
  );
  for (const v of r.violations) console.log('  ' + v);
}
console.log(`total violations ${total}`);
process.exit(0);
