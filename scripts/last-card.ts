/**
 * Last-card investigation (plan: advice within 400 ms of the last card landing). For every labelled set of the OBS
 * recording it decodes the video at its full 30 fps from just before `appear` and, for the card that lands last, finds:
 *   circle   the first frame its circle has content (`cardEmpty` false): the last-card mark
 *   ink      the first frame its name line has ink (`hasInk`, the worker's own test)
 *   read     the first frame whose name line reads (Windows OCR + matchItemName) as the labelled item
 *   icon     the first frame the icon reader (`readDraftScreen`'s card read) names the labelled item, and every other
 *            item it named before that (wrong guesses)
 * Times are ms after `appear`. Prints a table and writes logs/last-card.json.
 *
 *   BRAWL_OCR=live npx tsx scripts/last-card.ts "/mnt/d/OBS Videos/2026-10-09 00-46-30.mkv" [--only s7]
 *
 * Reads go to the live Windows OCR helper (powershell.exe); nothing is saved to the recordings.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  cardEmpty,
  cardNameCrop,
  cardSquares,
  decodeIconIndex,
  readDraftScreen,
  type RGBImage,
} from '../src/brawl/recognise';
import { hasInk, nameSig } from '../src/brawl/nameLine';
import { readCardNameTimed } from '../src/brawl/ocr';
import { matchItemName, nameList } from '../src/brawl/names';
import { installTextReader, stopLiveReader } from './lib/textReader';
import type { Item } from '../src/types';

const W = 1280,
  H = 720,
  N = W * H * 3,
  FPS = 30;
const args = process.argv.slice(2);
const video = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--only');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1]!.split(',') : null;
if (!video) throw new Error('usage: BRAWL_OCR=live npx tsx scripts/last-card.ts "<video.mkv>" [--only s7]');
/** Look this long before `appear` (a card already up) and at most this long after it. */
const BEFORE_S = 1,
  AFTER_S = 3;

interface LabelSet {
  draft: string;
  items: string[];
  from: number;
  to: number;
  appear?: number;
  covered?: number[];
}
const labels = JSON.parse(readFileSync('scripts/video-truth/labels.json', 'utf8')) as {
  stretches: { id: string; video: [number, number]; sets: LabelSet[] }[];
};
const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
const idx = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
const list = nameList(
  idx.ids,
  Object.fromEntries(items.map((i) => [i.id, i.name])),
);
const tiers = Object.fromEntries(items.map((i) => [i.id, i.item_tier]));
const idOf = (n: string) => items.find((i) => i.name === n)?.id ?? 0;
const nameOf = (id: number) => items.find((i) => i.id === id)?.name ?? `#${id}`;
installTextReader(process.env.BRAWL_OCR === 'record' ? 'record' : 'live');

async function decode(from: number, to: number): Promise<Buffer> {
  const p = spawn('ffmpeg', [
    ...['-v', 'error', '-ss', String(from), '-t', String(to - from), '-i', video!],
    ...['-vf', `fps=${FPS}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  ]);
  const chunks: Buffer[] = [];
  p.stdout.on('data', (c: Buffer) => chunks.push(c));
  await new Promise((r) => p.on('close', r));
  return Buffer.concat(chunks);
}

export interface LastCardRow {
  stretch: string;
  draft: string;
  items: string[];
  slot: number; // the last card's slot (0 left, 1 top, 2 right)
  together: boolean; // all three circles filled on one frame
  covered: boolean; // the labels mark this slot covered
  circle: number | null;
  ink: number | null;
  read: number | null;
  icon: number | null;
  iconWrong: string[];
  /** read - circle: how long the name line takes to fade in to a clean read */
  fadeIn: number | null;
  readTexts: string[]; // what the reads said before the clean one
  iconMs: number; // mean time of one icon read of this card
}

const rows: LastCardRow[] = [];
for (const st of labels.stretches) {
  if (only && !only.includes(st.id)) continue;
  for (const set of st.sets) {
    if (set.appear == null) continue;
    const from = Math.max(st.video[0] - 1, set.appear - BEFORE_S);
    const to = Math.min(set.appear + AFTER_S, set.to + 0.5);
    const buf = await decode(from, to);
    const nf = Math.floor(buf.length / N);
    const frames: RGBImage[] = [];
    for (let f = 0; f < nf; f++) frames.push({ width: W, height: H, data: buf.subarray(f * N, (f + 1) * N), channels: 3 });
    const appear = set.appear;
    const tAt = (f: number) => Math.round((from + f / FPS - appear) * 1000);
    const sq = cardSquares(W, H);
    // the set starts after the last frame at or before `appear` with all three circles empty (the previous set gone)
    const appearF = Math.min(nf - 1, Math.round((set.appear - from) * FPS));
    let f0 = 0;
    for (let f = appearF; f >= 0; f--)
      if (sq.every((q) => cardEmpty(frames[f]!, q))) {
        f0 = f;
        break;
      }
    const firstFull = [0, 1, 2].map((s) => {
      for (let f = f0; f < nf; f++) if (!cardEmpty(frames[f]!, sq[s]!)) return f;
      return null;
    });
    const known = firstFull.filter((f): f is number => f !== null);
    const lastF = known.length ? Math.max(...known) : null;
    const slot = lastF === null ? 2 : firstFull.lastIndexOf(lastF);
    const together = known.length === 3 && known.every((f) => f === lastF);
    const want = idOf(set.items[slot]!);
    const row: LastCardRow = {
      stretch: st.id,
      draft: set.draft,
      items: set.items,
      slot,
      together,
      covered: !!set.covered?.includes(slot),
      circle: lastF === null ? null : tAt(lastF),
      ink: null,
      read: null,
      icon: null,
      iconWrong: [],
      fadeIn: null,
      readTexts: [],
      iconMs: 0,
    };
    let iconN = 0,
      iconT = 0;
    if (lastF !== null) {
      const m = { itemId: 0, score: 0, margin: 0, ...sq[slot]! };
      for (let f = lastF; f < nf && (row.read === null || row.icon === null); f++) {
        const img = frames[f]!;
        if (cardEmpty(img, sq[slot]!)) continue;
        if (row.read === null) {
          const crop = cardNameCrop(img, m);
          if (crop && hasInk(nameSig(crop))) {
            row.ink ??= tAt(f);
            const r = await readCardNameTimed(crop).catch(() => ({ text: '(reader down)', ms: 0 }));
            const hit = matchItemName(r.text, list);
            if (hit?.itemId === want) row.read = tAt(f);
            else if (row.readTexts.length < 12) row.readTexts.push(`${tAt(f)}:${r.text || '(blank)'}`);
          }
        }
        if (row.icon === null) {
          const t = performance.now();
          const card = readDraftScreen(img, idx, (id) => tiers[id] ?? 0)[slot]!;
          iconT += performance.now() - t;
          iconN++;
          if (card.present && card.itemId === want) row.icon = tAt(f);
          else if (card.present) {
            const n = nameOf(card.itemId);
            if (!row.iconWrong.includes(n)) row.iconWrong.push(n);
          }
        }
      }
    }
    row.fadeIn = row.read !== null && row.circle !== null ? row.read - row.circle : null;
    row.iconMs = iconN ? Math.round(iconT / iconN) : 0;
    rows.push(row);
    const v = (x: number | null) => (x === null ? '-' : String(x)).padStart(5);
    console.log(
      `${st.id} ${set.draft} slot ${slot}${together ? '*' : ' '}${row.covered ? 'c' : ' '} circle ${v(row.circle)} ink ${v(row.ink)} read ${v(row.read)} icon ${v(row.icon)} fade ${v(row.fadeIn)}` +
        `${row.iconWrong.length ? ` wrong icon: ${row.iconWrong.join('/')}` : ''}  ${set.items[slot]}  (icon ${row.iconMs} ms)`,
    );
  }
}
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : null;
};
const fades = rows.map((r) => r.fadeIn).filter((x): x is number => x !== null);
const iconRight = rows.filter((r) => r.icon !== null).length;
const iconWrongSets = rows.filter((r) => r.iconWrong.length).length;
const iconNone = rows.filter((r) => r.icon === null).length;
const iconEarlier = rows.filter((r) => r.icon !== null && (r.read === null || r.icon < r.read)).length;
const summary = {
  sets: rows.length,
  medianFadeInMs: med(fades),
  medianCircleToInkMs: med(rows.filter((r) => r.ink !== null && r.circle !== null).map((r) => r.ink! - r.circle!)),
  medianCircleToIconMs: med(rows.filter((r) => r.icon !== null && r.circle !== null).map((r) => r.icon! - r.circle!)),
  iconRight,
  iconWrongSets,
  iconNone,
  iconEarlierThanRead: iconEarlier,
  meanIconMs: Math.round(rows.reduce((a, r) => a + r.iconMs, 0) / Math.max(1, rows.length)),
};
console.log(JSON.stringify(summary));
mkdirSync('logs', { recursive: true });
writeFileSync('logs/last-card.json', JSON.stringify({ date: new Date().toISOString(), video, summary, rows }, null, 1));
stopLiveReader();
process.exit(0);
