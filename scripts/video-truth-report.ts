// Prints the truth-set violations and advice latencies per stretch: `npx tsx scripts/video-truth-report.ts [s0,s3]`.
// Two latencies per set, which are not the same thing: `ready` is seconds from the labelled `readable` start to the
// first correct advice (virtual clock, the R2 rule, limit 1.0 s); `appear` is milliseconds from the first frame any
// card circle is filled, with the name reads' time charged (what the user sees, and what footage-latency.test.ts guards).
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
    `== ${d}: ${r.violations.length} violations; ready-based ${r.latency.map((l) => `${l.set} ${l.secs ?? '-'} s`).join(', ')}`,
  );
  console.log(`   appear-based ${r.fromAppear.map((l) => `${l.set} ${l.newMs ?? '-'} ms`).join(', ')}`);
  if (r.covered.length) console.log(`   covered (frame:slot): ${r.covered.join(' ')}`);
  for (const v of r.violations) console.log('  ' + v);
}
console.log(`total violations ${total}`);
process.exit(0);
