// Generates public/demo/gameplay.png: a stand-in "in-round, not the draft screen" frame for Test mode, so the
// ability tip can be seen appearing and expiring without the game. Four plain circles sit where the game's ability
// bar is (abilityCircle in src/brawl/draw.ts), so the tip's outline visibly lines up. Run: npx tsx scripts/make-demo-gameplay.ts
import sharp from 'sharp';
import { abilityCircle } from '../src/brawl/draw';

const W = 1920,
  H = 1080;
const icons = [0, 1, 2, 3]
  .map((slot) => {
    const { cx, cy, r } = abilityCircle(slot, W, H);
    const icon = r * 0.88;
    return `<circle cx="${cx}" cy="${cy}" r="${icon}" fill="#d9d3d6"/><text x="${cx}" y="${cy + icon * 0.35}" font-size="${icon * 1.0}" text-anchor="middle" fill="#3b3b3b" font-family="sans-serif" font-weight="bold">${slot + 1}</text>`;
  })
  .join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a2416"/><stop offset="1" stop-color="#12100f"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <text x="${W / 2}" y="${H * 0.42}" font-size="52" text-anchor="middle" fill="#e8d9c8" font-family="sans-serif" font-weight="bold">TEST MODE: in-round frame (not the draft screen)</text>
  <text x="${W / 2}" y="${H * 0.42 + 64}" font-size="34" text-anchor="middle" fill="#b8a795" font-family="sans-serif">Switch back to a draft screenshot to see the overlay return.</text>
  ${icons}
</svg>`;
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile('public/demo/gameplay.png');
console.log('wrote public/demo/gameplay.png');
