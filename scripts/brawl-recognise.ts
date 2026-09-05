// Street Brawl screen recogniser CLI (Node side of src/brawl/recognise.ts, decoding with sharp).
//   npm run brawl:see -- screenshots/brawl/s7.png        name the three cards of a draft screenshot
//   npm run brawl:see -- --fixtures                       accuracy against scripts/fixtures/brawl-cards/labels.json
//   npm run brawl:see -- --save-fixture s7 screenshots/brawl/s7.png "Mystic Regeneration,Extended Magazine,Spirit Strike"
//       crops the three card squares to scripts/fixtures/brawl-cards/<name>-{left,top,right}.png and records the labels
//   npm run brawl:see -- --save-screen s7 screenshots/brawl/s7.png 1 1 "Drifter,Infernus,Bebop,Holliday" "Pocket,Apollo,Ivy,Calico"
//       keeps only the hero bar and the ROUND / CHOICE labels of the screen (rest black) in scripts/fixtures/brawl-screens/
//   npm run brawl:see -- --screens                        accuracy of round, choice and the eight portraits on those
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { cardAnchors, decodeIconIndex, enemiesFrom, matchIcon, readDraftMeta, readDraftScreen, readMarkers, readTier, resolveTwin, type RGBImage } from '../src/brawl';

const FIX = 'scripts/fixtures/brawl-cards';
const SFIX = 'scripts/fixtures/brawl-screens';
const heroes = JSON.parse(readFileSync('public/data/heroes.json', 'utf8'));
const heroName = (id: number) => heroes.find((h: any) => h.id === id)?.name ?? (id ? String(id) : '-');
const heroId = (n: string) => { const h = heroes.find((h: any) => h.name.toLowerCase() === n.trim().toLowerCase()); if (!h) throw new Error(`unknown hero ${n}`); return h.id as number; };
const items = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
const tierOf = (id: number) => items.find((i: any) => i.id === id)?.item_tier ?? 0;
const nameOf = (id: number) => items.find((i: any) => i.id === id)?.name ?? String(id);
const idOf = (n: string) => { const it = items.find((i: any) => i.name.toLowerCase() === n.trim().toLowerCase()); if (!it) throw new Error(`unknown item ${n}`); return it.id as number; };
const load = async (p: string): Promise<RGBImage> => { const { data, info } = await sharp(p).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { width: info.width, height: info.height, data, channels: 3 }; };
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
    await sharp(file).extract({ left: Math.round(a.cx - edge / 2), top: Math.round(a.cy - edge / 2), width: edge, height: edge }).png().toFile(`${FIX}/${name}-${a.name}.png`);
    all[`${name}-${a.name}`] = { item_id: ids[k], name: nameOf(ids[k]), icon: Math.round(a.icon) };
  }
  writeFileSync(`${FIX}/labels.json`, JSON.stringify(all, null, 1));
  console.log(`saved ${name}: ${ids.map(nameOf).join(' / ')}`);
} else if (args[0] === '--save-screen') {
  const [, name, file, round, choice, left, right] = args;
  const meta = await sharp(file).metadata();
  const sx = meta.width! / 2560, sy = meta.height! / 1440;
  const keep = [[640, 0, 1900, 150], [1300, 40, 1370, 90], [200, 370, 320, 440]]; // hero bar, ROUND n, CHOICE n OF 3 (2560x1440 coordinates)
  const parts = [];
  for (const [x0, y0, x1, y1] of keep) {
    const left = Math.round(x0 * sx), top = Math.round(y0 * sy);
    parts.push({ input: await sharp(file).extract({ left, top, width: Math.round(x1 * sx) - left, height: Math.round(y1 * sy) - top }).png().toBuffer(), left, top });
  }
  mkdirSync(SFIX, { recursive: true });
  await sharp({ create: { width: meta.width!, height: meta.height!, channels: 3, background: '#000' } }).composite(parts).png().toFile(`${SFIX}/${name}.png`);
  const all = existsSync(`${SFIX}/labels.json`) ? JSON.parse(readFileSync(`${SFIX}/labels.json`, 'utf8')) : {};
  all[name] = { round: Number(round), choice: Number(choice), left: left.split(',').map(heroId), right: right.split(',').map(heroId) };
  writeFileSync(`${SFIX}/labels.json`, JSON.stringify(all, null, 1));
  console.log(`saved ${name}: round ${round} choice ${choice}, ${left} vs ${right}`);
} else if (args[0] === '--screens') {
  const labels = JSON.parse(readFileSync(`${SFIX}/labels.json`, 'utf8'));
  let ok = 0, n = 0;
  for (const [k, l] of Object.entries<any>(labels)) {
    const m = readDraftMeta(await load(`${SFIX}/${k}.png`), index);
    const got = [m.round, m.choice, ...m.bar.left.map((h) => h.heroId), ...m.bar.right.map((h) => h.heroId)];
    const want = [l.round, l.choice, ...l.left, ...l.right];
    const hits = got.filter((g, i) => g === want[i]).length; ok += hits; n += want.length;
    console.log(`${hits === want.length ? 'ok  ' : 'MISS'} ${k.padEnd(6)} round ${m.round}/${l.round} choice ${m.choice}/${l.choice}  ${m.bar.left.map((h) => heroName(h.heroId)).join(',')} vs ${m.bar.right.map((h) => heroName(h.heroId)).join(',')}  scores ${[...m.bar.left, ...m.bar.right].map((h) => h.score.toFixed(2)).join(' ')}`);
  }
  console.log(`${ok}/${n} labels (${(ok / n * 100).toFixed(1)} %)`);
  if (ok / n < 0.95) process.exit(1);
} else if (args[0] === '--fixtures') {
  const labels = JSON.parse(readFileSync(`${FIX}/labels.json`, 'utf8'));
  let ok = 0, n = 0;
  for (const [k, l] of Object.entries<any>(labels)) {
    const img = await load(`${FIX}/${k}.png`);
    // RGBA is what the browser's canvas hands over; run every second fixture through that path
    if (n % 2) { const rgba = new Uint8Array(img.width * img.height * 4); for (let i = 0; i < img.width * img.height; i++) { rgba[i * 4] = img.data[i * 3]; rgba[i * 4 + 1] = img.data[i * 3 + 1]; rgba[i * 4 + 2] = img.data[i * 3 + 2]; rgba[i * 4 + 3] = 255; } img.data = rgba; img.channels = 4; }
    const m = matchIcon(img, index, img.width / 2, img.height / 2, l.icon);
    const tier = readTier(img, m), mk = readMarkers(img, m), id = resolveTwin(m.itemId, tier, index, tierOf);
    const hit = id === l.item_id && tier === tierOf(l.item_id) && mk.rare === !!l.rare && mk.enhanced === !!l.enhanced; ok += +hit; n++;
    console.log(`${hit ? 'ok  ' : 'MISS'} ${k.padEnd(12)} ${l.name.padEnd(24)} -> ${nameOf(id).padEnd(24)} T${tier}${mk.rare ? ' RARE' : ''}${mk.enhanced ? ' ENH' : ''}  score ${m.score.toFixed(3)} margin ${m.margin.toFixed(3)} rare ${mk.rareFrac.toFixed(2)} enh ${mk.enhancedFrac.toFixed(2)}`);
  }
  console.log(`${ok}/${n} cards (${(ok / n * 100).toFixed(1)} %)`);
  if (ok / n < 0.95) process.exit(1);
} else {
  for (const f of args) {
    const img = await load(f);
    const reads = readDraftScreen(img, index, tierOf);
    const m = readDraftMeta(img, index);
    console.log(`${f}: round ${m.round || '?'} choice ${m.choice || '?'}  ${m.bar.left.map((h) => heroName(h.heroId)).join(',')} vs ${m.bar.right.map((h) => heroName(h.heroId)).join(',')}`);
    console.log('  ', reads.map((r) => `${r.card}: ${r.present ? `${nameOf(r.itemId)} T${r.tier}${r.rare ? ' RARE' : ''}${r.enhanced ? ' ENH' : ''}` : '(none)'} ${r.match.score.toFixed(2)}`).join(' | '));
  }
}
