// Checks logs/win-demo.png (produced by `npm run win:demo`, PLAN.md item 4's endpoint):
//   npx tsx scripts/win/check-demo-png.ts logs/win-demo.png [choice1|choice2]
// Prints `frame-visible: true|false` (the screenshot shows the draft image, not a flat/blank window) and
// `green-on-best: true|false` (a green highlight pixel lands on the labelled best card's box, scaled from
// scripts/win/frames/labels.json's 2000px-wide label space to this PNG's own resolution -- the same scaling
// scripts/win/e2e-main.cjs's pixels-<frame> check uses for item 3). Exits 1 if either is false.
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
  boxes: Record<'left' | 'top' | 'right' | 'reroll', { x0: number; y0: number; x1: number; y1: number }>;
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
const box = label.boxes[bestPos];

async function main() {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const px = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]] as const;
  };

  // frame-visible: a 5x5 sample grid isn't all the same colour -- proves the screenshot shows the draft
  // image + overlay, not a blank/black window.
  const colours = new Set<string>();
  for (let sy = 0; sy < 5; sy++)
    for (let sx = 0; sx < 5; sx++)
      colours.add(px(Math.floor(((sx + 0.5) * w) / 5), Math.floor(((sy + 0.5) * h) / 5)).join(','));
  const frameVisible = colours.size > 1;

  // green-on-best: labels.json boxes are frame px at the source PNG's own 2000-wide resolution; scale to
  // this screenshot's own width before sampling its edge for the app's highlight green (#39ff6a, +-60/150+/-60
  // same tolerance as scripts/win/e2e-main.cjs's checkPixels).
  const scale = w / 2000;
  const x0 = Math.max(0, Math.round(box.x0 * scale));
  const y0 = Math.max(0, Math.round(box.y0 * scale));
  const x1 = Math.min(w - 1, Math.round(box.x1 * scale));
  const y1 = Math.min(h - 1, Math.round(box.y1 * scale));
  const isGreen = (r: number, g: number, b: number) => Math.abs(r - 0x39) <= 60 && g >= 150 && Math.abs(b - 0x6a) <= 60;
  let greenOnBest = false;
  for (let x = x0; x <= x1 && !greenOnBest; x++) {
    if (isGreen(...px(x, y0)) || isGreen(...px(x, y1))) greenOnBest = true;
  }
  for (let y = y0; y <= y1 && !greenOnBest; y++) {
    if (isGreen(...px(x0, y)) || isGreen(...px(x1, y))) greenOnBest = true;
  }

  console.log(`frame-visible: ${frameVisible}`);
  console.log(`green-on-best: ${greenOnBest}`);
  if (!frameVisible || !greenOnBest) process.exit(1);
}

main();
