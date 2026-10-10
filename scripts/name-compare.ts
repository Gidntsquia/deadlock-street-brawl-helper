// Name reader comparison: every labelled name crop through one engine, resolved by the app's matchers.
//   npm run names:compare -- [--engine paddle|tesseract] [--runtime wasm|node] [--sizes] [--quick]
// Writes logs/name-compare-<engine>[-<runtime>].json and prints one summary line.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { ctcDecode, parseDict, recTensor, trimInk } from './lib/paddle';
import { matchItemName, nameList } from '../src/brawl/names';
import { loadFrame, cropsOf, DEMO_FRAMES, loadNameSamples, type NameCrop, type NameSample } from './lib/nameFrames';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};
const engineName = arg('engine', 'paddle') as 'paddle' | 'tesseract';
const runtime = arg('runtime', 'node') as 'wasm' | 'node';
const quick = process.argv.includes('--quick');

export interface Reader {
  read(crop: NameCrop): Promise<string>;
  close(): Promise<void>;
}

async function paddleReader(rt: 'wasm' | 'node'): Promise<Reader> {
  const model = 'public/data/ocr/en_PP-OCRv5_mobile_rec_infer.onnx';
  const dict = parseDict(readFileSync('public/data/ocr/ppocrv5_en_dict.txt', 'utf8'));
  const ort: any = rt === 'node' ? await import('onnxruntime-node') : await import('onnxruntime-web');
  if (rt === 'wasm') {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
  }
  const session = await ort.InferenceSession.create(
    rt === 'node' ? model : new Uint8Array(readFileSync(model)),
    rt === 'node' ? { graphOptimizationLevel: 'all' } : { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
  );
  const inName = session.inputNames[0];
  return {
    async read(crop) {
      const t = recTensor(trimInk({ data: crop.data, width: crop.width, height: crop.height, channels: 4 }));
      const out = await session.run({ [inName]: new ort.Tensor('float32', t.data, [1, 3, 48, t.width]) });
      const o = out[session.outputNames[0]];
      const [, steps, classes] = o.dims as number[];
      return ctcDecode(o.data as Float32Array, steps!, classes!, dict).text;
    },
    close: async () => {},
  };
}

async function tesseractReader(): Promise<Reader> {
  const { readCardName, terminateOCR } = await import('../src/brawl/ocr');
  return { read: (c) => readCardName(c), close: terminateOCR };
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;

async function main() {
  const items = JSON.parse(readFileSync('public/data/items.json', 'utf8')) as { id: number; name: string }[];
  const idx = JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')) as { ids?: number[] };
  const names = Object.fromEntries(items.map((i) => [i.id, i.name]));
  const list = nameList(idx.ids ?? items.map((i) => i.id), names);
  const byName = new Map(items.map((i) => [i.name, i.id]));

  const t0 = performance.now();
  const reader = engineName === 'paddle' ? await paddleReader(runtime) : await tesseractReader();
  const samples = (await loadNameSamples({ videoStep: quick ? 8 : 2 })).filter(
    (s) => s.label !== null || s.covered,
  );
  const readable = (s: NameSample) => {
    let ink = 0;
    for (let i = 0; i < s.crop.data.length; i += 4) if (s.crop.data[i] === 0) ink++;
    return ink >= 500;
  };
  const rows: any[] = [];
  let cold = 0;
  for (const [n, s] of samples.entries()) {
    if (!readable(s)) continue;
    const a = performance.now();
    const text = await reader.read(s.crop);
    const ms = performance.now() - a;
    if (n === 0 || cold === 0) cold = ms;
    const m = matchItemName(text, list);
    const truth = s.label ? (byName.get(s.label) ?? null) : null;
    rows.push({
      frame: s.frame, slot: s.slot, width: s.width, label: s.label, covered: !!s.covered, raw: text,
      resolved: m ? names[m.itemId] : null, sure: !!m, wrong: !!m && (s.covered || m.itemId !== truth), ms: +ms.toFixed(1),
    });
  }
  // A draft never offers one item twice: two slots of one frame resolving to the same item means one of them shows the
  // hover tooltip's title (the worker reads both again), so neither counts as sure here.
  const byFrame = new Map<string, any[]>();
  for (const r of rows) byFrame.set(r.frame, [...(byFrame.get(r.frame) ?? []), r]);
  for (const g of byFrame.values())
    for (const r of g)
      if (r.sure && g.some((o) => o !== r && o.sure && o.resolved === r.resolved)) {
        r.sure = false;
        r.wrong = false;
        r.reason = 'duplicate-in-frame';
      }
  // warm: 20 reads of the same crop, over 10 crops
  const warm: number[] = [];
  for (const s of samples.filter(readable).slice(0, 10))
    for (let i = 0; i < 20; i++) {
      const a = performance.now();
      await reader.read(s.crop);
      if (i >= 2) warm.push(performance.now() - a);
    }
  // resolutions
  const sizeRows: any[] = [];
  if (!quick)
    for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1440]] as const)
      for (const f of DEMO_FRAMES) {
        const img = await loadFrame(f, [w, h]);
        const base = await loadFrame(f);
        const baseCrops = cropsOf(base);
        const labels: (string | null)[] = [0, 1, 2].map((k) => rows.find((r) => r.frame === f && r.slot === k)?.label ?? null);
        for (const [slot, crop] of cropsOf(img).entries()) {
          if (!crop) continue;
          const text = await reader.read(crop);
          const m = matchItemName(text, list);
          const lab = labels[slot] ?? null;
          sizeRows.push({ frame: f, size: w, slot, label: lab, raw: text, resolved: m ? names[m.itemId] : null,
            sure: !!m, wrong: !!m && !!lab && names[m.itemId] !== lab, hasBase: !!baseCrops[slot] });
        }
      }
  await reader.close();
  const wrong = rows.filter((r) => r.wrong).length;
  const sure = rows.filter((r) => r.sure && !r.wrong).length;
  const lab = rows.filter((r) => !r.covered).length;
  const sureRate = rows.filter((r) => !r.covered && r.sure && !r.wrong).length / Math.max(1, lab);
  const summary = {
    engine: engineName, runtime: engineName === 'paddle' ? runtime : 'wasm', crops: rows.length, labelled: lab, wrong,
    sureRate: +(sureRate * 100).toFixed(1), coldMs: +cold.toFixed(0), warmP50: +median(warm).toFixed(1),
    warmP95: +pct(warm, 0.95).toFixed(1), sizes: Object.fromEntries([1280, 1920, 2560].map((w) => {
      const r = sizeRows.filter((x) => x.size === w && x.label);
      return [w, { n: r.length, sure: r.filter((x) => x.sure && !x.wrong).length, wrong: r.filter((x) => x.wrong).length }];
    })),
  };
  mkdirSync('logs', { recursive: true });
  writeFileSync(`logs/name-compare-${engineName}${engineName === 'paddle' ? '-' + runtime : ''}.json`,
    JSON.stringify({ summary, rows, sizeRows }, null, 1));
  if (sure < 0) throw new Error('unreachable');
  console.log(`${engineName}/${summary.runtime}: wrong ${wrong}, sure ${summary.sureRate}% of ${lab}, cold ${summary.coldMs} ms, warm p50 ${summary.warmP50} / p95 ${summary.warmP95} ms (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  console.log(JSON.stringify(summary.sizes));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
