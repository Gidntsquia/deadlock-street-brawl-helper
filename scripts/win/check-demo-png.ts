// Checks logs/win-demo.png (produced by `npm run win:demo`) against its sidecar logs/win-demo.json (what the overlay
// drew, in frame px):
//   npx tsx scripts/win/check-demo-png.ts logs/win-demo.png [choice1|choice2]
// Prints `frame-visible` (the screenshot shows the draft image, not a flat/blank window), `teal-on-best` (the best
// card's plate is filled teal and its card has a teal outline in the PNG's own pixels) and `teal-on-non-best` (any
// other card has a teal-filled plate or teal outline: must be false). Drawn boxes are first checked against the
// hand-measured `circles` labels in scripts/win/frames/labels.json, so a plate drawn in the wrong place fails.
// `veil-on-non-best` is true when the other cards' circles are darker than the same pixels of public/demo/<frame>.png
// (the 35% black veil: about 0.65 of the original brightness) and `veil-on-best` when the best card's circle is not (must be false).
// Exits 1 unless frame-visible, teal-on-best and veil-on-non-best are true and teal-on-non-best and veil-on-best are false.
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { adviseDraft, type BrawlInput } from '../../src/brawl';
import type { Ability, Hero, Item } from '../../src/types';
import type { BrawlAnalytics, BrawlConfig } from '../../src/brawl/types';

const file = process.argv[2];
const frameName = process.argv[3] === 'choice2' ? 'choice2' : 'choice1';
if (!file) {
  console.error('usage: check-demo-png.ts <png> [choice1|choice2]');
  process.exit(1);
}

interface Label {
  hero: string;
  round: number;
  cards: { left: string; top: string; right: string };
  circles: Record<'left' | 'top' | 'right', { x0: number; y0: number; x1: number; y1: number }>;
}
const labels: Record<string, Label> = JSON.parse(readFileSync('scripts/win/frames/labels.json', 'utf8'));
const label = labels[frameName];
if (!label) {
  console.error(`no label "${frameName}" in scripts/win/frames/labels.json`);
  process.exit(1);
}

const read = <T>(p: string): T => JSON.parse(readFileSync(`public/data/${p}`, 'utf8'));
const items = read<Item[]>('items.json');
const heroes = read<Hero[]>('heroes.json');
const abilities = read<Ability[]>('abilities.json');
const config = read<BrawlConfig>('brawl-config.json');
const hero = heroes.find((h) => h.name.toLowerCase() === label.hero.toLowerCase());
if (!hero) {
  console.error(`unknown hero "${label.hero}"`);
  process.exit(1);
}
const byName = (name: string) => {
  const it = items.find((i) => i.name.toLowerCase() === name.trim().toLowerCase());
  if (!it) throw new Error(`unknown item "${name}"`);
  return it.id;
};
const input: BrawlInput = {
  hero,
  abilities,
  items,
  analytics: read<BrawlAnalytics>(`analytics/brawl/${hero.id}.json`),
  config,
};
const set = ([label.cards.left, label.cards.top, label.cards.right] as const).map((n) => ({
  itemId: byName(n),
  enhanced: false,
}));
const advice = adviseDraft(input, { round: label.round, owned: [], enemies: [], sets: [set] });
const pick = advice.picks[0] ?? null;
if (!pick) {
  console.error(`engine verdict for "${frameName}" is RE-ROLL; check-demo-png.ts only checks a TAKE verdict`);
  process.exit(1);
}
const bestName = items.find((i) => i.id === pick.item.id)!.name;
const bestPos = (['left', 'top', 'right'] as const).find(
  (p) => label.cards[p].toLowerCase() === bestName.toLowerCase(),
);
if (!bestPos) {
  console.error(`best card "${bestName}" isn't among "${frameName}"'s labelled cards`);
  process.exit(1);
}

interface Sidecar {
  drawn: {
    kind: string;
    card: string | null;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    plate: { x0: number; y0: number; x1: number; y1: number } | null;
  }[];
  frame: { w: number; h: number } | null;
}

async function main() {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const px = (x: number, y: number) => {
    const i = (Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))) * 4;
    return [data[i], data[i + 1], data[i + 2]] as const;
  };
  const colours = new Set<string>();
  for (let sy = 0; sy < 5; sy++)
    for (let sx = 0; sx < 5; sx++)
      colours.add(px(Math.floor(((sx + 0.5) * w) / 5), Math.floor(((sy + 0.5) * h) / 5)).join(','));
  const frameVisible = colours.size > 1;

  const sidecar: Sidecar = JSON.parse(readFileSync(file.replace(/\.png$/, '.json'), 'utf8'));
  const k = w / (sidecar.frame?.w || w); // frame px -> PNG px
  const lk = w / 2000; // label px -> PNG px
  const isTeal = (p: readonly number[]) => p[1] >= 150 && p[2] >= 140 && p[0] <= 90;
  const iou = (a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a) => {
    const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const inter = ix * iy;
    return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter);
  };
  let placed = true;
  let tealBest = false;
  let tealOther = false;
  const orig = await sharp(`public/demo/${frameName}.png`).resize(w, h).ensureAlpha().raw().toBuffer();
  // brightness of the inner half of a card circle in the PNG relative to the screenshot under it
  const ratio = (r: { x0: number; y0: number; x1: number; y1: number }) => {
    let a = 0;
    let b = 0;
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    const hw = (r.x1 - r.x0) / 4;
    for (let y = Math.round(cy - hw); y < cy + hw; y++)
      for (let x = Math.round(cx - hw); x < cx + hw; x++) {
        const i = (y * w + x) * 4;
        a += data[i]! + data[i + 1]! + data[i + 2]!;
        b += orig[i]! + orig[i + 1]! + orig[i + 2]!;
      }
    return a / Math.max(1, b);
  };
  let veilOther = true;
  let veilBest = false;
  for (const pos of ['left', 'top', 'right'] as const) {
    const d = sidecar.drawn.find((r) => r.card === pos && (r.kind === 'best' || r.kind === 'card'));
    const lab = label.circles[pos];
    if (!d || !d.plate) {
      placed = false;
      continue;
    }
    if (
      iou(
        { x0: d.x0 * k, y0: d.y0 * k, x1: d.x1 * k, y1: d.y1 * k },
        { x0: lab.x0 * lk, y0: lab.y0 * lk, x1: lab.x1 * lk, y1: lab.y1 * lk },
      ) < 0.5
    )
      placed = false;
    const plateFill = isTeal(px(d.plate.x1 * k - 4, ((d.plate.y0 + d.plate.y1) / 2) * k));
    const my = ((d.y0 + d.y1) / 2) * k;
    const outline = [-2, -1, 0, 1, 2].some((dx) => isTeal(px(d.x0 * k + dx, my)));
    const isBestCard = pos === bestPos;
    const r = ratio({ x0: d.x0 * k, y0: d.y0 * k, x1: d.x1 * k, y1: d.y1 * k });
    if (isBestCard) veilBest = r < 0.8;
    else if (r > 0.8) veilOther = false;
    if (isBestCard) tealBest = plateFill && outline && d.kind === 'best';
    else if (plateFill || outline || d.kind === 'best') tealOther = true;
  }
  console.log(`frame-visible: ${frameVisible}`);
  console.log(`plates-placed: ${placed}`);
  console.log(`teal-on-best: ${tealBest}`);
  console.log(`teal-on-non-best: ${tealOther}`);
  console.log(`veil-on-non-best: ${veilOther}`);
  console.log(`veil-on-best: ${veilBest}`);
  if (!frameVisible || !placed || !tealBest || tealOther || !veilOther || veilBest) process.exit(1);
}

main();
