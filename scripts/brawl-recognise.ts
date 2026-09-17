// Street Brawl screen recogniser CLI (Node side of src/brawl/recognise.ts, decoding with sharp).
//   npm run brawl:see -- screenshots/brawl/s7.png        name the three cards of a draft screenshot
//   npm run brawl:see -- --fixtures                       accuracy against scripts/fixtures/brawl-cards/labels.json
//   npm run brawl:see -- --save-fixture s7 screenshots/brawl/s7.png "Mystic Regeneration,Extended Magazine,Spirit Strike"
//       crops the three card squares to scripts/fixtures/brawl-cards/<name>-{left,top,right}.png and records the labels
//   npm run brawl:see -- --save-screen s7 screenshots/brawl/s7.png 1 1 "Drifter,Infernus,Bebop,Holliday" "Pocket,Apollo,Ivy,Calico"
//       keeps only the hero bar and the ROUND / CHOICE labels of the screen (rest black) in scripts/fixtures/brawl-screens/
//   npm run brawl:see -- --screens                        accuracy of round, choice, the player's own slot and the eight portraits on those
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { cardAnchors, decodeIconIndex, readDraftMeta, readDraftScreen, type RGBImage } from '../src/brawl';
import type { Hero, Item } from '../src/types';
import { checkFixtures } from './fixtureCheck';

const FIX = 'scripts/fixtures/brawl-cards';
const SFIX = 'scripts/fixtures/brawl-screens';
const heroes: Hero[] = JSON.parse(readFileSync('public/data/heroes.json', 'utf8'));
const heroName = (id: number) => heroes.find((h) => h.id === id)?.name ?? (id ? String(id) : '-');
const heroId = (n: string) => {
  const h = heroes.find((h) => h.name.toLowerCase() === n.trim().toLowerCase());
  if (!h) throw new Error(`unknown hero ${n}`);
  return h.id;
};
const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
const tierOf = (id: number) => items.find((i) => i.id === id)?.item_tier ?? 0;
const nameOf = (id: number) => items.find((i) => i.id === id)?.name ?? String(id);
const idOf = (n: string) => {
  const it = items.find((i) => i.name.toLowerCase() === n.trim().toLowerCase());
  if (!it) throw new Error(`unknown item ${n}`);
  return it.id;
};
const load = async (p: string): Promise<RGBImage> => {
  const { data, info } = await sharp(p).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data, channels: 3 };
};
const args = process.argv.slice(2);
const PAD = 130; // fixture crops keep this much context around the icon so the position search still has room

if (args[0] === '--save-fixture') {
  const [, name, file, labels] = args;
  const img = await sharp(file).metadata();
  const anchors = cardAnchors(img.width!, img.height!);
  const ids = labels.split(',').map(idOf);
  const all = existsSync(`${FIX}/labels.json`) ? JSON.parse(readFileSync(`${FIX}/labels.json`, 'utf8')) : {};
  for (const [k, a] of anchors.entries()) {
    const edge = Math.round(a.icon + 2 * PAD);
    await sharp(file)
      .extract({ left: Math.round(a.cx - edge / 2), top: Math.round(a.cy - edge / 2), width: edge, height: edge })
      .png()
      .toFile(`${FIX}/${name}-${a.name}.png`);
    all[`${name}-${a.name}`] = { item_id: ids[k], name: nameOf(ids[k]), icon: Math.round(a.icon) };
  }
  writeFileSync(`${FIX}/labels.json`, JSON.stringify(all, null, 1));
  console.log(`saved ${name}: ${ids.map(nameOf).join(' / ')}`);
} else if (args[0] === '--save-screen') {
  const [, name, file, round, choice, left, right] = args;
  const meta = await sharp(file).metadata();
  const sx = meta.width! / 2560,
    sy = meta.height! / 1440;
  const keep = [
    [640, 0, 1900, 150],
    [1300, 40, 1370, 90],
    [200, 370, 320, 440],
  ]; // hero bar, ROUND n, CHOICE n OF 3 (2560x1440 coordinates)
  const parts = [];
  for (const [x0, y0, x1, y1] of keep) {
    const left = Math.round(x0 * sx),
      top = Math.round(y0 * sy);
    parts.push({
      input: await sharp(file)
        .extract({ left, top, width: Math.round(x1 * sx) - left, height: Math.round(y1 * sy) - top })
        .png()
        .toBuffer(),
      left,
      top,
    });
  }
  mkdirSync(SFIX, { recursive: true });
  await sharp({ create: { width: meta.width!, height: meta.height!, channels: 3, background: '#000' } })
    .composite(parts)
    .png()
    .toFile(`${SFIX}/${name}.png`);
  const all = existsSync(`${SFIX}/labels.json`) ? JSON.parse(readFileSync(`${SFIX}/labels.json`, 'utf8')) : {};
  all[name] = {
    round: Number(round),
    choice: Number(choice),
    left: left.split(',').map(heroId),
    right: right.split(',').map(heroId),
  };
  writeFileSync(`${SFIX}/labels.json`, JSON.stringify(all, null, 1));
  console.log(`saved ${name}: round ${round} choice ${choice}, ${left} vs ${right}`);
} else if (args[0] === '--screens') {
  const labels = JSON.parse(readFileSync(`${SFIX}/labels.json`, 'utf8'));
  let ok = 0,
    n = 0;
  for (const [k, l] of Object.entries<any>(labels)) {
    const m = readDraftMeta(await load(`${SFIX}/${k}.png`), index);
    const got = [m.round, m.choice, m.self, ...m.bar.left.map((h) => h.heroId), ...m.bar.right.map((h) => h.heroId)];
    const want = [l.round, l.choice, l.self ?? 0, ...l.left, ...l.right];
    const hits = got.filter((g, i) => g === want[i]).length;
    ok += hits;
    n += want.length;
    console.log(
      `${hits === want.length ? 'ok  ' : 'MISS'} ${k.padEnd(6)} round ${m.round}/${l.round} choice ${m.choice}/${l.choice} self ${heroName(m.self)}  ${m.bar.left.map((h) => heroName(h.heroId)).join(',')} vs ${m.bar.right.map((h) => heroName(h.heroId)).join(',')}  scores ${[...m.bar.left, ...m.bar.right].map((h) => h.score.toFixed(2)).join(' ')}`,
    );
  }
  console.log(`${ok}/${n} labels (${((ok / n) * 100).toFixed(1)} %)`);
  if (ok / n < 0.95) process.exit(1);
} else if (args[0] === '--fixtures') {
  const results = await checkFixtures(index, tierOf);
  for (const r of results) {
    console.log(
      `${r.hit ? 'ok  ' : 'MISS'} ${r.key.padEnd(12)} ${r.label.name.padEnd(24)} -> ${nameOf(r.gotId).padEnd(24)} T${r.tier}${r.rare ? ' RARE' : ''}${r.enhanced ? ' ENH' : ''}  score ${r.score.toFixed(3)} margin ${r.margin.toFixed(3)} rare ${r.rareFrac.toFixed(2)} enh ${r.enhancedFrac.toFixed(2)}`,
    );
  }
  const ok = results.filter((r) => r.hit).length;
  console.log(`${ok}/${results.length} cards (${((ok / results.length) * 100).toFixed(1)} %)`);
  if (ok / results.length < 0.95) process.exit(1);
} else {
  for (const f of args) {
    const img = await load(f);
    const reads = readDraftScreen(img, index, tierOf);
    const m = readDraftMeta(img, index);
    console.log(
      `${f}: round ${m.round || '?'} choice ${m.choice || '?'} self ${heroName(m.self)}  ${m.bar.left.map((h) => heroName(h.heroId)).join(',')} vs ${m.bar.right.map((h) => heroName(h.heroId)).join(',')}`,
    );
    console.log(
      '  ',
      reads
        .map(
          (r) =>
            `${r.card}: ${r.present ? `${nameOf(r.itemId)} T${r.tier}${r.rare ? ' RARE' : ''}${r.enhanced ? ' ENH' : ''}` : '(none)'} ${r.match.score.toFixed(2)}`,
        )
        .join(' | '),
    );
  }
}
