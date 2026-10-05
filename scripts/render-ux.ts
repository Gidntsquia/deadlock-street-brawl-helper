// Renders the overlay (before/after the UX pass) over every demo draft frame at several sizes, through the real
// drawReads path, into plans/eval-artifacts/ux-pass/. Needs src/brawl/draw.before.ts (git show HEAD~:src/brawl/draw.ts).
//   npx tsx scripts/render-ux.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { decodeIconIndex, readDraftScreen, readRoundChoice, type CardRead } from '../src/brawl/recognise';
import { adviseDraft, type BrawlInput } from '../src/brawl';
import * as after from '../src/brawl/draw';
import { breakdownRows } from '../src/brawl/breakdown';
import { svgCtx } from './lib/svgCtx';
import type { Ability, Hero, Item } from '../src/types';
import type { BrawlAnalytics, BrawlConfig } from '../src/brawl/types';

// the old drawing code: `git show <commit before the UX pass>:src/brawl/draw.ts > src/brawl/draw.before.ts` (not committed)
const before = (await import(pathToFileURL(`${process.cwd()}/src/brawl/draw.before.ts`).href)) as any;

const rd = <T>(p: string): T => JSON.parse(readFileSync(`public/data/${p}`, 'utf8'));
const items = rd<Item[]>('items.json'),
  heroes = rd<Hero[]>('heroes.json'),
  abilities = rd<Ability[]>('abilities.json'),
  config = rd<BrawlConfig>('brawl-config.json');
const hero = heroes.find((h) => h.id === 1)!;
const input: BrawlInput = { hero, abilities, items, analytics: rd<BrawlAnalytics>('analytics/brawl/1.json'), config };
const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
const OUT = 'plans/eval-artifacts/ux-pass';
mkdirSync(OUT, { recursive: true });
const SIZES: [number, number][] = [
  [1280, 720],
  [1600, 900],
  [1920, 1080],
  [2560, 1440],
];

interface Case {
  name: string;
  frame: string;
  note: string;
  reroll?: boolean;
  unsure?: number;
  forceEnhanced?: number;
}
const CASES: Case[] = [
  { name: 'choice1', frame: 'public/demo/choice1.png', note: 'normal pick' },
  { name: 'choice2', frame: 'public/demo/choice2.png', note: 'normal pick' },
  {
    name: 'draft-r1c2',
    frame: 'public/demo/draft-r1c2.png',
    note: 'BAKED OVERLAY in the frame (an older overlay is part of the screenshot, so ghost text shows under the new plates). Normal pick, third card read as enhanced (real frame)',
  },
  {
    name: 'draft-r2c1',
    frame: 'public/demo/draft-r2c1.png',
    note: 'BAKED OVERLAY in the frame (see above). Normal pick',
  },
  {
    name: 'draft-r2c3-reroll',
    frame: 'public/demo/draft-r2c3-reroll.png',
    note: 'BAKED OVERLAY in the frame (see above). Re-roll call (the frame is the real round 2 choice 3 screen; the call is set on, as the engine would for a weak set)',
    reroll: true,
  },
  {
    name: 'reroll-clean',
    frame: 'screenshots/brawl/reroll-choice1.png',
    note: 'clean frame (no baked overlay), re-roll call forced on',
    reroll: true,
  },
  {
    name: 'unsure-clean',
    frame: 'screenshots/brawl/reroll-choice2.png',
    note: 'SYNTHETIC: clean frame with its third card forced to a grey ? plate',
    unsure: 2,
  },
  {
    name: 'enhanced-clean',
    frame: 'screenshots/brawl/reroll-choice1.png',
    note: 'SYNTHETIC: clean frame, first card forced to enhanced, to show a chip on a grey plate beside the advised card',
    forceEnhanced: 0,
  },
  {
    name: 'unsure-r2c1',
    frame: 'public/demo/draft-r2c1.png',
    note: 'SYNTHETIC: draft-r2c1 with its third card forced to a grey ? plate (no demo frame has an unread card)',
    unsure: 2,
  },
  {
    name: 'enhanced-strong-r2c1',
    frame: 'public/demo/draft-r2c1.png',
    note: 'SYNTHETIC: draft-r2c1 with its first card forced to enhanced (no demo frame shows an enhanced best card)',
    forceEnhanced: 0,
  },
];

for (const c of CASES) {
  const { data, info } = await sharp(c.frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = { width: info.width, height: info.height, data, channels: 4 as const };
  let reads: CardRead[] = readDraftScreen(img, index, () => 0);
  if (c.forceEnhanced !== undefined)
    reads = reads.map((r, i) => (i === c.forceEnhanced ? { ...r, enhanced: true } : r));
  if (c.unsure !== undefined) reads = reads.map((r, i) => (i === c.unsure ? { ...r, unsure: true } : r));
  const rc = readRoundChoice(img);
  const real = reads.filter((r) => !r.unsure);
  const adv = adviseDraft(input, {
    round: rc.round,
    owned: [],
    enemies: [],
    sets: [real.map((r) => ({ itemId: r.itemId, enhanced: r.enhanced }))],
  });
  const ranked = adv.sets[0]!;
  const letters = ['S', 'A', 'B', 'C'];
  const scores: Record<number, number> = {},
    grades: Record<number, string> = {},
    bonuses: Record<number, number> = {};
  ranked.forEach((r, i) => {
    scores[r.item.id] = r.score;
    grades[r.item.id] = letters[i] ?? 'C';
    bonuses[r.item.id] = r.enhancedBonus;
    void breakdownRows;
  });
  const bestId = c.reroll ? null : (ranked[0]?.item.id ?? null);
  for (const [w, h] of SIZES) {
    const bg = await sharp(c.frame).resize(w, h).png().toBuffer();
    const sx = w / info.width,
      sy = h / info.height;
    const mk = async (which: 'before' | 'after') => {
      const { ctx, svg } = svgCtx(w, h);
      if (which === 'before')
        before.drawReads(ctx, reads, bestId, sx, sy, info.width, info.height, !!c.reroll, scores, null, grades);
      else
        after.drawReads(
          ctx,
          reads,
          bestId,
          sx,
          sy,
          info.width,
          info.height,
          !!c.reroll,
          scores,
          null,
          grades,
          undefined,
          bonuses,
        );
      const file = `${c.name}-${which}-${w}x${h}.png`;
      await sharp(bg)
        .composite([{ input: Buffer.from(svg()) }])
        .png()
        .toFile(`${OUT}/${file}`);
      return file;
    };
    await mk('before');
    await mk('after');
  }
  console.log(c.name, 'ok');
}
const lines = [
  '# UX pass: before/after',
  '',
  'Before = `src/brawl/draw.ts` at commit b4c0e95 (main). After = this change. Both go through the real `drawReads`; text is',
  'rendered from an SVG recording of the canvas calls (sharp), over the demo frame scaled to each size, so fonts differ a little',
  'from the game overlay. Advice comes from `adviseDraft` for Infernus, no owned items; tier letters are by rank (the app uses tier-list grades).',
  '',
  '| case | what it shows |',
  '|---|---|',
  ...CASES.map((c) => `| ${c.name} | ${c.note} |`),
  '',
  `Files: \`<case>-before-<W>x<H>.png\` and \`<case>-after-<W>x<H>.png\` for ${SIZES.map(([w, h]) => `${w}x${h}`).join(', ')}.`,
];
writeFileSync(`${OUT}/INDEX.md`, lines.join('\n') + '\n');
