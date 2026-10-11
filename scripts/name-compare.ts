// Name reader comparison: every labelled name crop through one engine, resolved by the app's matcher, with the app's
// covered rule (coveredSlots: a hovered card's tilted line, a tooltip panel over a neighbour) and the duplicate rule
// (two slots of one frame naming the same item) applied as the worker applies them.
//   npm run names:compare -- [--engine winocr|tesseract] [--quick]
// winocr reads through scripts/lib/textReader.ts: recorded answers by default (BRAWL_OCR=live or record to use the
// helper through powershell.exe). tesseract needs `npm i --no-save tesseract.js@7` for the run.
// Writes logs/name-compare-<engine>.json and prints the summary line.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { matchItemName, nameList } from '../src/brawl/names';
import { coveredSlots, decodeIconIndex } from '../src/brawl/recognise';
import { prepareName, readCardNameTimed } from '../src/brawl/ocr';
import { loadFrame, cropsOf, DEMO_FRAMES, loadNameSamples, type NameCrop, type NameSample } from './lib/nameFrames';
import { installTextReader, measureColdStart, readerMode, stopLiveReader, RECORDED_DIR } from './lib/textReader';
import { tesseractNameReader } from './lib/tesseractOcr';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};
const engineName = arg('engine', 'winocr') as 'winocr' | 'tesseract';
const quick = process.argv.includes('--quick');

interface Reader {
  /** text and the engine's time for this read (ms) */
  read(crop: NameCrop): Promise<{ text: string; ms: number }>;
  /** start to first answer (ms) */
  cold(): Promise<number>;
  close(): Promise<void>;
}

const TIMING = `${RECORDED_DIR}/timing.json`;

async function winocrReader(): Promise<Reader> {
  installTextReader();
  const mode = readerMode();
  return {
    read: async (c) => {
      try {
        return await readCardNameTimed(c);
      } catch {
        return { text: '', ms: NaN }; // no recording for this crop (counted below)
      }
    },
    async cold() {
      // A fresh helper's start to its first answer, measured when the helper runs (live/record); the recorded value
      // otherwise.
      if (mode === 'recorded')
        return existsSync(TIMING) ? (JSON.parse(readFileSync(TIMING, 'utf8')) as { coldMs: number }).coldMs : NaN;
      const ms = await measureColdStart();
      if (mode === 'record') writeFileSync(TIMING, JSON.stringify({ coldMs: Math.round(ms) }) + '\n');
      return ms;
    },
    close: async () => stopLiveReader(),
  };
}

async function tessReader(): Promise<Reader> {
  const t0 = performance.now();
  const r = await tesseractNameReader();
  let first: number | null = null;
  return {
    async read(c) {
      const a = performance.now();
      const text = await r.read(c);
      first ??= performance.now() - t0;
      return { text, ms: performance.now() - a };
    },
    cold: async () => first ?? NaN,
    close: () => r.close(),
  };
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const pct = (a: number[], p: number) =>
  [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;
const inked = (c: NameCrop) => {
  let ink = 0;
  for (let i = 0; i < c.data.length; i += 4) if (c.data[i] === 0) ink++;
  return ink >= 500;
};

async function main() {
  const items = JSON.parse(readFileSync('public/data/items.json', 'utf8')) as { id: number; name: string }[];
  const idx = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
  const names = Object.fromEntries(items.map((i) => [i.id, i.name]));
  const list = nameList(idx.ids, names);
  const byName = new Map(items.map((i) => [i.name, i.id]));

  const t0 = performance.now();
  const all = await loadNameSamples({ videoStep: quick ? 8 : 2 });
  const reader = engineName === 'tesseract' ? await tessReader() : await winocrReader();
  // the app's covered rule on each frame's three lines
  const byFrame = new Map<string, (NameSample | null)[]>();
  for (const s of all) {
    const g = byFrame.get(s.frame) ?? [null, null, null];
    g[s.slot] = s;
    byFrame.set(s.frame, g);
  }
  const detCovered = new Map<NameSample, boolean>();
  for (const g of byFrame.values()) {
    const cov = coveredSlots(g.map((s) => s?.crop ?? null));
    g.forEach((s, i) => s && detCovered.set(s, cov[i]!));
  }
  const samples = all.filter((s) => (s.label !== null || s.covered) && inked(s.crop));
  const rows: any[] = [];
  let misses = 0;
  for (const s of samples) {
    const { text, ms } = await reader.read(s.crop);
    if (Number.isNaN(ms)) misses++;
    const m = matchItemName(text, list);
    const truthName = s.label ?? s.truth ?? null;
    const covered = detCovered.get(s)!;
    rows.push({
      frame: s.frame,
      slot: s.slot,
      width: s.width,
      label: s.label,
      truth: truthName,
      labelCovered: !!s.covered,
      covered,
      raw: text,
      resolved: m ? names[m.itemId] : null,
      resolvedId: m?.itemId ?? 0,
      score: m ? +m.score.toFixed(3) : 0,
      ms: Number.isNaN(ms) ? null : +ms.toFixed(1),
    });
  }
  // A draft never offers one item twice: two uncovered slots of one frame naming the same item means one of them shows
  // a tooltip's title; the worker reads both again, so neither is taken from this frame.
  const rowsBy = new Map<string, any[]>();
  for (const r of rows) rowsBy.set(r.frame, [...(rowsBy.get(r.frame) ?? []), r]);
  for (const g of rowsBy.values())
    for (const r of g)
      if (!r.covered && r.resolvedId && g.some((o) => o !== r && !o.covered && o.resolvedId === r.resolvedId))
        r.duplicate = true;
  for (const r of rows) {
    // what the worker takes from this crop: nothing when covered or duplicate, else the resolved item
    const taken = !r.covered && !r.duplicate && r.resolvedId ? r.resolvedId : 0;
    const truthId = r.truth ? (byName.get(r.truth) ?? null) : null;
    r.outcome =
      r.covered || r.duplicate ? 'covered' : !taken ? 'unsure' : truthId && taken === truthId ? 'sure' : 'wrong';
    // a hand-labelled tooltip slot whose real item is unknown counts as wrong if anything is taken from it
  }
  // warm: 20 reads of the same crop, over 10 crops (live engines only; recorded answers carry the helper's own ms)
  const warm: number[] = [];
  if (engineName === 'tesseract' || readerMode() !== 'recorded')
    for (const s of samples.slice(0, 10))
      for (let i = 0; i < 20; i++) {
        const r = await reader.read(s.crop);
        if (i >= 2) warm.push(r.ms);
      }
  // per size: the demo frames scaled to 1280 / 1920 / 2560
  const sizeRows: any[] = [];
  for (const [w, h] of [
    [1280, 720],
    [1920, 1080],
    [2560, 1440],
  ] as const)
    for (const f of DEMO_FRAMES) {
      const img = await loadFrame(f, [w, h]);
      const labels = [0, 1, 2].map((k) => rows.find((r) => r.frame === f && r.slot === k)?.label ?? null);
      for (const [slot, crop] of cropsOf(img).entries()) {
        if (!crop) continue;
        const { text, ms } = await reader.read(crop);
        if (Number.isNaN(ms)) misses++;
        const m = matchItemName(text, list);
        const lab = labels[slot] ?? null;
        sizeRows.push({
          frame: f,
          size: w,
          slot,
          label: lab,
          raw: text,
          resolved: m ? names[m.itemId] : null,
          sure: !!m && names[m.itemId] === lab,
          wrong: !!m && !!lab && names[m.itemId] !== lab,
          ms: Number.isNaN(ms) ? null : +ms.toFixed(1),
          prepared: engineName === 'winocr' ? `${prepareName(crop)?.width}x${prepareName(crop)?.height}` : undefined,
        });
      }
    }
  const cold = await reader.cold();
  await reader.close();
  const uncovered = rows.filter((r) => r.outcome !== 'covered');
  const wrong = rows.filter((r) => r.outcome === 'wrong').length;
  const sureRate = uncovered.filter((r) => r.outcome === 'sure').length / Math.max(1, uncovered.length);
  const msOf = (rs: any[]) => rs.map((r) => r.ms).filter((x: number | null) => x !== null) as number[];
  const sizes = Object.fromEntries(
    [1280, 1920, 2560].map((w) => {
      const r = sizeRows.filter((x) => x.size === w && x.label);
      const ms = msOf(sizeRows.filter((x) => x.size === w));
      return [
        w,
        {
          n: r.length,
          sure: r.filter((x) => x.sure).length,
          wrong: r.filter((x) => x.wrong).length,
          p50: +median(ms).toFixed(1),
          p95: +pct(ms, 0.95).toFixed(1),
        },
      ];
    }),
  );
  const allMs = warm.length ? warm : msOf(rows);
  const summary = {
    engine: engineName,
    mode: engineName === 'winocr' ? readerMode() : 'live',
    crops: rows.length,
    uncovered: uncovered.length,
    covered: rows.length - uncovered.length,
    wrong,
    unsure: uncovered.filter((r) => r.outcome === 'unsure').length,
    sureRate: +(sureRate * 100).toFixed(1),
    notRecorded: misses,
    coldMs: Number.isNaN(cold) ? null : +cold.toFixed(0),
    warmP50: +median(allMs).toFixed(1),
    warmP95: +pct(allMs, 0.95).toFixed(1),
    sizes,
  };
  mkdirSync('logs', { recursive: true });
  writeFileSync(`logs/name-compare-${engineName}.json`, JSON.stringify({ summary, rows, sizeRows }, null, 1));
  console.log(
    `${engineName} (${summary.mode}): wrong ${wrong}, sure ${summary.sureRate}% of ${uncovered.length} uncovered (${summary.covered} covered), cold ${summary.coldMs} ms, warm p50 ${summary.warmP50} / p95 ${summary.warmP95} ms${misses ? `, ${misses} not recorded` : ''} (${((performance.now() - t0) / 1000).toFixed(0)} s)`,
  );
  console.log(JSON.stringify(summary.sizes));
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
