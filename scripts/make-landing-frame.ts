// Writes public/demo/_choice1-two.png: choice1 with the third (right) card blanked, the way the game shows the set while
// the cards land one at a time. Only the e2e harness lists it (names starting with `_` are hidden from test mode's select).
import sharp from 'sharp';
import { draftRegions } from '../src/brawl/recognise';

const { data, info } = await sharp('public/demo/choice1.png').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const regions = draftRegions(info.width, info.height);
const nameEnds = [...regions.keys()].slice(-6);
// the third card's own region plus the name-line boxes that belong to it (the last two of the six: crop and its end)
const blank = [2, ...nameEnds.slice(-4)];
for (const k of blank) {
  const r = regions[k]!;
  if (k !== 2 && r.x < info.width * 0.6) continue; // keep the first two cards' name lines
  for (let y = r.y; y < r.y + r.height; y++)
    for (let x = r.x; x < r.x + r.width; x++) data.fill(20, (y * info.width + x) * 4, (y * info.width + x) * 4 + 3);
}
await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
  .png()
  .toFile('public/demo/_choice1-two.png');
