// Guard: every labelled set the old app advised is advised within BUDGET_MS + one replay frame (400 + 250 ms) of the
// replay's last-card frame (the first frame all three card circles show a card: the worker's `land`), and sooner than
// the old app's teal plate in the OBS footage. Each stretch is replayed through the real worker as video-truth.test.ts
// does; the name reads' own time (recorded `ms`, or the live helper's with BRAWL_OCR=live|record) from the landing frame
// on is charged on top. `oldMs` (from `appear`) is scripts/video-truth/footage-latency.json. A set the labels mark
// `covered` is advised with a `?` by the 1.0 s fallback: the budget does not apply to it (only `oldMs` does).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { scoreStretch, type Truth } from '../lib/videoTruth';

vi.setConfig({ testTimeout: 180_000 });
const root = path.join('scripts', 'fixtures', 'video-truth');
const dirs = existsSync(root)
  ? readdirSync(root)
      .filter((n) => /^s\d+$/.test(n))
      .sort()
  : [];
const OLD_FILE = process.env.FOOTAGE_LATENCY_FILE ?? path.join('scripts', 'video-truth', 'footage-latency.json');
/** The target: advice drawn within 400 ms of the last card landing (win:latency judges it live). */
const BUDGET_MS = 400;
/** The replay sees a picture every 250 ms (4 fps), the live app about every 67 ms: one replay frame of slack. */
const FRAME_MS = 250;
interface Row {
  stretch: string;
  draft: string;
  oldMs: number | null;
}

describe('advice is fast after the last card lands', () => {
  it.each(dirs)('%s is within 400 + 250 ms of the last card and beats the old plates', async (d) => {
    const rows = (JSON.parse(readFileSync(OLD_FILE, 'utf8')) as Row[]).filter((r) => r.stretch === d);
    const truth: Truth = JSON.parse(readFileSync(path.join(root, d, 'truth.json'), 'utf8'));
    const sets = truth.sets.filter((s) => s.appear != null);
    const rep = await scoreStretch(path.join(root, d));
    expect(rep.fromAppear.length).toBe(rows.length);
    const slow: string[] = [];
    rows.forEach((row, i) => {
      const now = rep.fromAppear[i]!;
      if (row.oldMs == null) return;
      const name = `${d} ${row.draft} (set ${i})`;
      if (now.newMs == null) slow.push(`${name}: never advised`);
      else if (now.newMs >= row.oldMs) slow.push(`${name}: old ${row.oldMs} ms, new ${now.newMs} ms from appear`);
      if (sets[i]?.covered?.length) return;
      if (now.fromLastMs == null) slow.push(`${name}: no last-card frame before the advice`);
      else if (now.fromLastMs > BUDGET_MS + FRAME_MS)
        slow.push(`${name}: ${now.fromLastMs} ms after the last card (limit ${BUDGET_MS + FRAME_MS})`);
    });
    expect(slow).toEqual([]);
  });
});
