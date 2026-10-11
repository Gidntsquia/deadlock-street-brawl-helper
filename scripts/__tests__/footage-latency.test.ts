// Guard: no labelled set is advised later than the old app's teal plate in the OBS footage. Each stretch is replayed
// through the real worker as video-truth.test.ts does; the latency runs from `appear` (first frame any card circle is
// filled) to the first frame the correct advice is live, with the name reads' own time (recorded `ms`, or the live
// helper's with BRAWL_OCR=live|record) charged on top. `oldMs` is scripts/video-truth/footage-latency.json.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { scoreStretch } from '../lib/videoTruth';

vi.setConfig({ testTimeout: 180_000 });
const root = path.join('scripts', 'fixtures', 'video-truth');
const dirs = existsSync(root)
  ? readdirSync(root)
      .filter((n) => /^s\d+$/.test(n))
      .sort()
  : [];
const OLD_FILE = process.env.FOOTAGE_LATENCY_FILE ?? path.join('scripts', 'video-truth', 'footage-latency.json');
interface Row {
  stretch: string;
  draft: string;
  oldMs: number | null;
}

describe('advice is faster than the footage', () => {
  it.each(dirs)('%s beats the old plates', async (d) => {
    const rows = (JSON.parse(readFileSync(OLD_FILE, 'utf8')) as Row[]).filter((r) => r.stretch === d);
    const rep = await scoreStretch(path.join(root, d));
    expect(rep.fromAppear.length).toBe(rows.length);
    const slow: string[] = [];
    rows.forEach((row, i) => {
      const now = rep.fromAppear[i]!;
      if (row.oldMs == null) return;
      if (now.newMs == null || now.newMs >= row.oldMs)
        slow.push(`${d} ${row.draft} (set ${i}): old ${row.oldMs} ms, new ${now.newMs ?? 'never advised'} ms`);
    });
    expect(slow).toEqual([]);
  });
});
