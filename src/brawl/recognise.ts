// Street Brawl draft-screen recogniser: pure pixel code, no DOM and no Node APIs, so the same function runs
// in the browser (canvas) and in the fixture test (sharp). Layout constants are fractions of a 2560x1440
// screen and were measured from the user's screenshots; a different resolution scales linearly.
import type { IconIndex } from './types';

export interface RGBImage { width: number; height: number; data: Uint8Array | Uint8ClampedArray; channels: 3 | 4 }

/** Draft screen at 2560x1440: three cards, icon centres and icon edge length in pixels. */
export const BRAWL_LAYOUT = {
  ref: { width: 2560, height: 1440 },
  cards: [
    { name: 'left', cx: 712, cy: 855 },
    { name: 'top', cx: 1280, cy: 527 },
    { name: 'right', cx: 1848, cy: 855 },
  ],
  icon: 185,      // icon edge on screen
  search: 24,     // +- pixels of position slack when locating the icon
  scales: [0.92, 0.97, 1.02, 1.07], // icon edge multipliers tried
} as const;

/** Card centres for an arbitrary screen size. */
export const cardAnchors = (width: number, height: number) => {
  const sx = width / BRAWL_LAYOUT.ref.width, sy = height / BRAWL_LAYOUT.ref.height;
  return BRAWL_LAYOUT.cards.map((c) => ({ name: c.name, cx: c.cx * sx, cy: c.cy * sy, icon: BRAWL_LAYOUT.icon * sx }));
};

export interface DecodedIndex { size: number; ids: number[]; pixels: Float32Array[]; twins: Map<number, number[]>; heroIds: number[]; heroPixels: Float32Array[] }

const b64 = (s: string): Uint8Array => {
  if (typeof atob === 'function') { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (!B) throw new Error('no base64 decoder');
  return new Uint8Array(B.from(s, 'base64'));
};

/** Mask: 1 for pixels compared, 0 for the top-right corner where the tier numeral sits. */
export const iconMask = (size: number): Float32Array => {
  const m = new Float32Array(size * size).fill(1);
  const c = Math.ceil(size * 0.28);
  for (let y = 0; y < c; y++) for (let x = size - c; x < size; x++) m[y * size + x] = 0;
  return m;
};

/** Per-channel mean/std normalised pixels, mask applied, so lighting and background offsets cancel. */
export function normalise(px: ArrayLike<number>, size: number, mask: Float32Array): Float32Array {
  const out = new Float32Array(size * size * 3);
  for (let ch = 0; ch < 3; ch++) {
    let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < size * size; i++) if (mask[i]) { const v = px[i * 3 + ch]; s += v; s2 += v * v; n++; }
    const mean = s / n, sd = Math.sqrt(Math.max(1e-6, s2 / n - mean * mean));
    for (let i = 0; i < size * size; i++) out[i * 3 + ch] = mask[i] ? (px[i * 3 + ch] - mean) / sd : 0;
  }
  return out;
}

export function decodeIconIndex(idx: IconIndex): DecodedIndex {
  const mask = iconMask(idx.size);
  const ids = Object.keys(idx.icons).map(Number);
  const twins = new Map<number, number[]>();
  for (const [a, bs] of Object.entries(idx.twins ?? {})) twins.set(Number(a), bs);
  const cmask = circleMask(idx.size);
  const heroIds = Object.keys(idx.heroes ?? {}).map(Number);
  return { size: idx.size, ids, pixels: ids.map((id) => normalise(b64(idx.icons[id]), idx.size, mask)), twins, heroIds, heroPixels: heroIds.map((id) => normalise(b64(idx.heroes![id]), idx.size, cmask)) };
}

/** Mask: 1 inside the inscribed circle (hero portraits are round). */
export const circleMask = (size: number): Float32Array => {
  const m = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const dx = x + 0.5 - size / 2, dy = y + 0.5 - size / 2; m[y * size + x] = dx * dx + dy * dy <= (size / 2 - 1) ** 2 ? 1 : 0; }
  return m;
};

/** Box-filtered resample of the square (x0, y0, edge) of `img` down to size x size RGB. */
export function sampleSquare(img: RGBImage, x0: number, y0: number, edge: number, size: number): Float32Array {
  const out = new Float32Array(size * size * 3);
  const step = edge / size, ch = img.channels, W = img.width, H = img.height, d = img.data;
  // cell edges, clamped to the image once instead of per pixel
  const xs = new Int32Array(size + 1), ys = new Int32Array(size + 1);
  for (let g = 0; g <= size; g++) {
    xs[g] = Math.min(W, Math.max(0, g === size ? Math.ceil(x0 + edge) : Math.floor(x0 + g * step)));
    ys[g] = Math.min(H, Math.max(0, g === size ? Math.ceil(y0 + edge) : Math.floor(y0 + g * step)));
  }
  for (let gy = 0; gy < size; gy++) {
    const ya = ys[gy], yb = Math.max(ya, ys[gy + 1] === ya ? ya + 1 : ys[gy + 1]);
    for (let gx = 0; gx < size; gx++) {
      const xa = xs[gx], xb = Math.max(xa, xs[gx + 1] === xa ? xa + 1 : xs[gx + 1]);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = ya; y < yb && y < H; y++) {
        let p = (y * W + xa) * ch;
        for (let x = xa; x < xb && x < W; x++, p += ch) { r += d[p]; g += d[p + 1]; b += d[p + 2]; n++; }
      }
      const o = (gy * size + gx) * 3;
      if (n) { out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; }
    }
  }
  return out;
}

const ncc = (a: Float32Array, b: Float32Array, n: number) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s / (3 * n); };

export interface IconMatch { itemId: number; score: number; margin: number; x: number; y: number; edge: number }

/** Top `k` icon ids for one sampled window (coarse pass). */
const shortlist = (v: Float32Array, ids: number[], pixels: Float32Array[], n: number, k: number): number[] => {
  const scored = ids.map((id, i) => ({ id, s: ncc(v, pixels[i], n) })).sort((a, b) => b.s - a.s);
  return scored.slice(0, k).map((x) => x.id);
};

/**
 * Best item icon for the square roughly centred on (cx, cy) with edge ~ `icon`, searching nearby positions and scales.
 * Coarse-to-fine: the nominal window is scored against every icon, then the position/scale search runs on the top
 * candidates only (about 20x fewer correlations than the exhaustive search, same answers on the fixtures).
 * `candidates` restricts the search to those item ids (used for the inventory grid).
 */
export function matchIcon(img: RGBImage, index: DecodedIndex, cx: number, cy: number, icon: number, candidates?: number[], opts?: { search?: number; scales?: readonly number[] }): IconMatch {
  const mask = iconMask(index.size);
  let n = 0; for (const v of mask) n += v;
  const search = opts?.search ?? BRAWL_LAYOUT.search, scales = opts?.scales ?? BRAWL_LAYOUT.scales;
  const step = Math.max(2, Math.round(icon / 24));
  let pool: number[];
  if (candidates) pool = candidates;
  else {
    const v0 = normalise(sampleSquare(img, cx - icon / 2, cy - icon / 2, icon, index.size), index.size, mask);
    pool = shortlist(v0, index.ids, index.pixels, n, SHORTLIST);
  }
  const ks = pool.map((id) => index.ids.indexOf(id)).filter((k) => k >= 0);
  let best: IconMatch = { itemId: 0, score: -1, margin: 0, x: 0, y: 0, edge: icon };
  let second = -1;
  for (const sc of scales) {
    const edge = icon * sc;
    for (let dy = -search; dy <= search; dy += step) for (let dx = -search; dx <= search; dx += step) {
      const x = cx - edge / 2 + dx, y = cy - edge / 2 + dy;
      const v = normalise(sampleSquare(img, x, y, edge, index.size), index.size, mask);
      for (const k of ks) {
        const s = ncc(v, index.pixels[k], n);
        if (s > best.score) { if (index.ids[k] !== best.itemId) second = best.score; best = { itemId: index.ids[k], score: s, margin: 0, x, y, edge }; }
        else if (s > second && index.ids[k] !== best.itemId) second = s;
      }
    }
  }
  best.margin = best.score - second;
  return best;
}
const SHORTLIST = 12;

export const MIN_ICON_SCORE = 0.45; // icon similarity floor; between this and SURE_ICON_SCORE a tier numeral must also be read
export const SURE_ICON_SCORE = 0.75;

export interface CardRead { card: string; match: IconMatch; present: boolean; itemId: number; tier: number; rare: boolean; enhanced: boolean }

/** Reads the three draft cards of a full-screen capture. Items that share an icon are told apart by the tier numeral. */
export function readDraftScreen(img: RGBImage, index: DecodedIndex, tierOf: (id: number) => number): CardRead[] {
  return cardAnchors(img.width, img.height).map((a) => {
    const match = matchIcon(img, index, a.cx, a.cy, a.icon);
    const tier = match.score >= MIN_ICON_SCORE ? readTier(img, match) : 0;
    const present = match.score >= SURE_ICON_SCORE || (match.score >= MIN_ICON_SCORE && tier > 0);
    const mk = present ? readMarkers(img, match) : { rare: false, enhanced: false, rareFrac: 0, enhancedFrac: 0 };
    return { card: a.name, match, present, itemId: present ? resolveTwin(match.itemId, tier, index, tierOf) : 0, tier, rare: mk.rare, enhanced: mk.enhanced };
  });
}

/** When several items share the matched icon (Spirit Armor / Spirit Resilience ...), pick the one whose tier matches the numeral. */
export function resolveTwin(itemId: number, tier: number, index: DecodedIndex, tierOf: (id: number) => number): number {
  if (!tier || tierOf(itemId) === tier) return itemId;
  const twins = index.twins?.get(itemId) ?? [];
  return twins.find((t) => tierOf(t) === tier) ?? itemId;
}

// ---- tier numeral and card markers -----------------------------------------------------------------------
// The tier numeral (I..V) is dark text on the coloured triangle in the icon's top-right corner. Dark pixels in that
// box are projected onto x; each run is a stroke. Narrow runs are "I"s, a wide run is a "V".
const luma = (img: RGBImage, x: number, y: number) => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 255;
  const p = (y * img.width + x) * img.channels; return 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2];
};
const rgb = (img: RGBImage, x: number, y: number): [number, number, number] => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return [0, 0, 0];
  const p = (y * img.width + x) * img.channels; return [img.data[p], img.data[p + 1], img.data[p + 2]];
};

/** Tier 1..5 read from the numeral, or 0 when no numeral is found. `m` is the icon square from matchIcon. */
export function readTier(img: RGBImage, m: IconMatch): number {
  const u = m.edge / 185, right = m.x + m.edge, top = m.y;
  const x0 = Math.round(right - 26 * u), x1 = Math.round(right - 2 * u);
  const y0 = Math.round(top - 4 * u), y1 = Math.round(top + 22 * u);
  // the icon's own dark pixels enter the box from the left edge along the corner diagonal: per row, ignore the
  // dark run that touches x0
  const rowStart: number[] = [];
  for (let y = y0; y < y1; y++) { let x = x0; while (x < x1 && luma(img, x, y) < 120) x++; rowStart.push(x); }
  const dark = (x: number, y: number) => x >= rowStart[y - y0] && luma(img, x, y) < 70;
  // 1. the numeral's row band: consecutive rows with some, but not wall-to-wall, dark pixels (borders are wall-to-wall)
  const rowN: number[] = [];
  for (let y = y0; y < y1; y++) { let n = 0; for (let x = x0; x < x1; x++) if (dark(x, y)) n++; rowN.push(n); }
  const okRow = rowN.map((n) => n >= 2 && n <= 16 * u);
  let bestS = 0, bestL = 0, s0 = 0;
  for (let i = 0; i <= okRow.length; i++) {
    if (i < okRow.length && okRow[i]) { if (i === 0 || !okRow[i - 1]) s0 = i; if (i - s0 + 1 > bestL) { bestL = i - s0 + 1; bestS = s0; } }
  }
  if (bestL < 6 * u) return 0;
  const ya = y0 + bestS, yb = ya + bestL;
  // 2. column projection over that band; each run of dark columns is a stroke
  const cols: number[] = [];
  for (let x = x0; x < x1; x++) { let n = 0; for (let y = ya; y < yb; y++) if (dark(x, y)) n++; cols.push(n); }
  const minRows = Math.max(2, Math.round(bestL * 0.3));
  const runs: number[] = []; let run = 0;
  for (const c of cols) { if (c >= minRows) run++; else { if (run) runs.push(run); run = 0; } }
  if (run) runs.push(run);
  const narrow = runs.filter((w) => w <= 6 * u).length, wide = runs.filter((w) => w > 6 * u).length;
  if (wide === 1) return narrow >= 1 ? 4 : 5;
  if (wide === 0 && narrow >= 1 && narrow <= 3) return narrow;
  return 0;
}

const countWhere = (img: RGBImage, x0: number, y0: number, x1: number, y1: number, f: (c: [number, number, number]) => boolean) => {
  let n = 0, t = 0;
  for (let y = Math.round(y0); y < y1; y += 2) for (let x = Math.round(x0); x < x1; x += 2) { t++; if (f(rgb(img, x, y))) n++; }
  return t ? n / t : 0;
};

export interface CardMarkers { rare: boolean; enhanced: boolean; rareFrac: number; enhancedFrac: number }

/** "RARE!" is teal text above the icon; "ENHANCED" is a blue box under the item name. */
export function readMarkers(img: RGBImage, m: IconMatch): CardMarkers {
  const u = m.edge / 185, cx = m.x + m.edge / 2;
  const rareFrac = countWhere(img, m.x - 10 * u, m.y - 48 * u, cx + 30 * u, m.y - 4 * u, ([r, g, b]) => g > 150 && g > r + 50 && b > r + 30 && g > b - 20);
  const enhancedFrac = countWhere(img, cx - 100 * u, m.y + m.edge + 85 * u, cx + 100 * u, m.y + m.edge + 122 * u, ([r, g, b]) => b > 150 && b > r + 60 && b > g + 20);
  return { rare: rareFrac > 0.08, enhanced: enhancedFrac > 0.06, rareFrac, enhancedFrac };
}

// ---- hero bar -------------------------------------------------------------------------------------------
// Eight round portraits along the top: the two teams, four each side of the round timer. Which side is the enemy
// depends on the team the player was put on, so the caller passes its own hero and takes the other side.
export const HERO_BAR = {
  left: [725, 840, 957, 1075], right: [1480, 1595, 1710, 1825], cy: 72, diameter: 100,
  search: 16, step: 4, scales: [0.92, 1, 1.08],
} as const;
export const MIN_HERO_SCORE = 0.6;
const HERO_SHORTLIST = 8;
export const MIN_HERO_MARGIN = 0.08;

export interface HeroMatch { heroId: number; score: number; margin: number }
export interface HeroBar { left: HeroMatch[]; right: HeroMatch[] }

export function matchHero(img: RGBImage, index: DecodedIndex, cx: number, cy: number, diameter: number): HeroMatch {
  const mask = circleMask(index.size);
  let n = 0; for (const v of mask) n += v;
  let best: HeroMatch = { heroId: 0, score: -1, margin: 0 }, second = -1;
  const sx = img.width / BRAWL_LAYOUT.ref.width, step = Math.max(2, Math.round(HERO_BAR.step * sx)), search = HERO_BAR.search * sx;
  // coarse pass from five windows (centre and the four corners of the search range): portraits shift a little between screens
  const pool = new Set<number>();
  for (const [ox, oy] of [[0, 0], [-search, -search], [search, -search], [-search, search], [search, search]]) {
    const v0 = normalise(sampleSquare(img, cx - diameter / 2 + ox, cy - diameter / 2 + oy, diameter, index.size), index.size, mask);
    for (const id of shortlist(v0, index.heroIds, index.heroPixels, n, HERO_SHORTLIST)) pool.add(id);
  }
  const ks = [...pool].map((id) => index.heroIds.indexOf(id));
  for (const sc of HERO_BAR.scales) {
    const e = diameter * sc;
    for (let dy = -search; dy <= search; dy += step) for (let dx = -search; dx <= search; dx += step) {
      const v = normalise(sampleSquare(img, cx - e / 2 + dx, cy - e / 2 + dy, e, index.size), index.size, mask);
      for (const k of ks) {
        const s = ncc(v, index.heroPixels[k], n);
        if (s > best.score) { if (index.heroIds[k] !== best.heroId) second = best.score; best = { heroId: index.heroIds[k], score: s, margin: 0 }; }
        else if (s > second && index.heroIds[k] !== best.heroId) second = s;
      }
    }
  }
  best.margin = best.score - second;
  if (best.score < MIN_HERO_SCORE || best.margin < MIN_HERO_MARGIN) best.heroId = 0;
  return best;
}

/** Reads the eight portraits; heroId is 0 for a slot that could not be read. */
export function readHeroBar(img: RGBImage, index: DecodedIndex): HeroBar {
  const sx = img.width / BRAWL_LAYOUT.ref.width, sy = img.height / BRAWL_LAYOUT.ref.height;
  const read = (xs: readonly number[]) => xs.map((x) => matchHero(img, index, x * sx, HERO_BAR.cy * sy, HERO_BAR.diameter * sx));
  return { left: read(HERO_BAR.left), right: read(HERO_BAR.right) };
}

// The player's own portrait is the one slot drawn as a square-topped tile (the others are circles): its two vertical
// edges run the full height of the upper half, and the tile fill in the top corners differs from the bar background
// beside it. While the "round starting" banner is up every slot sits in a tile, so a frame where several slots show
// tiles is rejected and the next frame is used.
export const SELF_TILE = { edgeRun: 0.9, minScore: 40, maxTiles: 2 } as const;

function pxAt(img: RGBImage, x: number, y: number): [number, number, number] {
  x = Math.min(img.width - 1, Math.max(0, x)); y = Math.min(img.height - 1, Math.max(0, y));
  const i = (y * img.width + x) * img.channels; return [img.data[i], img.data[i + 1], img.data[i + 2]];
}
const colourDiff = (a: number[], b: number[]) => (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
function meanRect(img: RGBImage, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = pxAt(img, x, y); r += p[0]; g += p[1]; b += p[2]; n++; }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

/** Index (0..3) of the player's slot on each side, or -1. */
export function readSelfSlot(img: RGBImage): { left: number; right: number } {
  const sx = img.width / BRAWL_LAYOUT.ref.width, sy = img.height / BRAWL_LAYOUT.ref.height;
  const cy = HERO_BAR.cy * sy, R = HERO_BAR.diameter * sx / 2;
  const y0 = Math.round(cy - 0.9 * R), y1 = Math.round(cy - 0.3 * R), rows = y1 - y0;
  const cb = Math.round(cy - 0.9 * R), ce = Math.round(cy - 0.7 * R);
  const runs = new Map<number, number>();
  const run = (x: number) => { let n = runs.get(x); if (n === undefined) { n = 0; for (let y = y0; y < y1; y++) if (colourDiff(pxAt(img, x - 2, y), pxAt(img, x + 2, y)) > 20) n++; runs.set(x, n); } return n; };
  const tile = (cx: number) => {
    let best = 0;
    for (let xl = Math.round(cx - 1.3 * R); xl <= cx - 0.7 * R; xl++) {
      if (run(xl) < rows * SELF_TILE.edgeRun) continue;
      for (let xr = Math.round(xl + 1.9 * R); xr <= xl + 2.3 * R; xr++) {
        if (run(xr) < rows * SELF_TILE.edgeRun) continue;
        const inL = meanRect(img, xl + 4, cb, xl + 12, ce), inR = meanRect(img, xr - 12, cb, xr - 4, ce);
        const outL = meanRect(img, xl - 10, cb, xl - 4, ce), outR = meanRect(img, xr + 4, cb, xr + 10, ce);
        best = Math.max(best, Math.min(colourDiff(inL, outL), colourDiff(inR, outR)) - colourDiff(inL, inR) / 2);
      }
    }
    return best;
  };
  const scores = [...HERO_BAR.left, ...HERO_BAR.right].map((x) => tile(x * sx));
  const tiles = scores.filter((v) => v > 0).length;
  const order = scores.map((_, i) => i).sort((p, q) => scores[q] - scores[p]);
  const ok = tiles <= SELF_TILE.maxTiles && scores[order[0]] >= SELF_TILE.minScore && scores[order[0]] >= 2 * scores[order[1]];
  if (!ok) return { left: -1, right: -1 };
  const k = order[0];
  return k < HERO_BAR.left.length ? { left: k, right: -1 } : { left: -1, right: k - HERO_BAR.left.length };
}

/** The player's hero id from the bar, or 0 when the square-topped slot is missing or unreadable. */
export function selfHero(bar: HeroBar, self: { left: number; right: number }): number {
  if (self.left >= 0) return bar.left[self.left]?.heroId ?? 0;
  if (self.right >= 0) return bar.right[self.right]?.heroId ?? 0;
  return 0;
}

/** The opposing team's hero ids, given the player's hero; empty when the player's hero is on neither side. */
export function enemiesFrom(bar: HeroBar, myHero: number): number[] {
  const ids = (side: HeroMatch[]) => side.map((m) => m.heroId).filter(Boolean);
  if (ids(bar.left).includes(myHero)) return ids(bar.right);
  if (ids(bar.right).includes(myHero)) return ids(bar.left);
  return [];
}

// ---- round and choice labels --------------------------------------------------------------------------
// "ROUND n" sits above the timer, "CHOICE n OF 3" under the SELECT ITEMS title. The digit is the first glyph in a
// fixed window; it is thresholded on its text colour, cropped to its bounding box and resampled onto an 8x12 grid
// of fill fractions, then compared with templates taken from the same screens (mean squared difference).
const GW = 8, GH = 12;
const LABELS = {
  round: { x0: 1318, y0: 50, x1: 1352, y1: 82 },
  choice: { x0: 238, y0: 380, x1: 268, y1: 428 },
} as const;
const lightText = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b > 165;
const magentaText = (r: number, g: number, b: number) => r > 140 && b > 140 && g < 130;
const tpl = (rows: string[]): Float32Array => Float32Array.from(rows.join(''), (c) => Number(c) / 9);
/** Round digits: bold face with a footed "1" (rows are 8 cells of fill 0-9). The "5" is drawn by hand: no screenshot of round 5 yet. */
const ROUND_DIGITS: Record<number, Float32Array> = {
  1: tpl(['00799500', '25999500', '89999500', '99799500', '53599500', '00599500', '00599500', '00599500', '00599500', '66899866', '99999999', '99999999']),
  2: tpl(['02899982', '05999997', '38634899', '58200699', '22001798', '00005995', '00038962', '01488510', '26995000', '89997666', '99999999', '99999999']),
  3: tpl(['02799950', '07999992', '09533995', '05000995', '00035982', '00099920', '00099950', '00033895', '55000599', '69533896', '29999992', '05999950']),
  4: tpl(['00059960', '00289960', '00599960', '02888960', '16836960', '59506960', '69306960', '89768986', '99999999', '33337973', '00006960', '00006960']),
  5: tpl(['99999999', '99999999', '99500000', '99500000', '99999500', '99999995', '00000999', '00000999', '00000999', '99000999', '89999995', '19999820']),
};
/** Choice digits: display face, "1" without a foot. */
const CHOICE_DIGITS: Record<number, Float32Array> = {
  1: tpl(['00024679', '55789999', '99978999', '00006999', '00006999', '00006999', '00006999', '00006999', '00006999', '00006999', '00006999', '00006999']),
  2: tpl(['59764200', '58999874', '02346896', '00000796', '00000796', '00001895', '00038950', '00289610', '01796100', '38830000', '89877777', '99999999']),
  3: tpl(['05764200', '07999874', '02224696', '00000396', '00014784', '00069961', '00025898', '00000399', '32000399', '88520498', '47987872', '01488510']),
};
export const MAX_DIGIT_DISTANCE = 0.06;

/** Fill grid of the first glyph in the window, or null when the window holds no text. */
export function readGlyph(img: RGBImage, x0: number, y0: number, x1: number, y1: number, test: (r: number, g: number, b: number) => boolean): Float32Array | null {
  const on = (x: number, y: number) => { const [r, g, b] = rgb(img, x, y); return test(r, g, b); };
  const W = x1 - x0, H = y1 - y0;
  const colHas: boolean[] = [];
  for (let x = 0; x < W; x++) { let h = false; for (let y = 0; y < H && !h; y++) h = on(x0 + x, y0 + y); colHas.push(h); }
  const gx0 = colHas.indexOf(true); if (gx0 < 0) return null;
  let gx1 = gx0; while (gx1 + 1 < W && (colHas[gx1 + 1] || colHas[gx1 + 2])) gx1++;
  let gy0 = H, gy1 = -1;
  for (let y = 0; y < H; y++) for (let x = gx0; x <= gx1; x++) if (on(x0 + x, y0 + y)) { gy0 = Math.min(gy0, y); gy1 = Math.max(gy1, y); }
  const bw = gx1 - gx0 + 1, bh = gy1 - gy0 + 1;
  if (bw < 4 || bh < 6) return null;
  const g = new Float32Array(GW * GH);
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    let n = 0, k = 0;
    for (let y = gy0 + Math.floor(gy * bh / GH); y < gy0 + Math.ceil((gy + 1) * bh / GH); y++) for (let x = gx0 + Math.floor(gx * bw / GW); x < gx0 + Math.ceil((gx + 1) * bw / GW); x++) { k++; if (on(x0 + x, y0 + y)) n++; }
    g[gy * GW + gx] = k ? n / k : 0;
  }
  return g;
}

const readDigit = (img: RGBImage, box: { x0: number; y0: number; x1: number; y1: number }, test: (r: number, g: number, b: number) => boolean, digits: Record<number, Float32Array>): number => {
  const sx = img.width / BRAWL_LAYOUT.ref.width, sy = img.height / BRAWL_LAYOUT.ref.height;
  const g = readGlyph(img, Math.round(box.x0 * sx), Math.round(box.y0 * sy), Math.round(box.x1 * sx), Math.round(box.y1 * sy), test);
  if (!g) return 0;
  let best = 0, bestD = Infinity;
  for (const [d, t] of Object.entries(digits)) { let s = 0; for (let i = 0; i < g.length; i++) s += (g[i] - t[i]) ** 2; s /= g.length; if (s < bestD) { bestD = s; best = Number(d); } }
  return bestD <= MAX_DIGIT_DISTANCE ? best : 0;
};

export interface DraftMeta { round: number; choice: number; bar: HeroBar; self: number /* the player's hero id, 0 if unread */ }
/** Round (1-5), choice (1-3) and the hero bar of a draft screen; 0 for a label that could not be read. */
export function readDraftMeta(img: RGBImage, index: DecodedIndex): DraftMeta {
  const bar = readHeroBar(img, index);
  return { round: readDigit(img, LABELS.round, lightText, ROUND_DIGITS), choice: readDigit(img, LABELS.choice, magentaText, CHOICE_DIGITS), bar, self: selfHero(bar, readSelfSlot(img)) };
}

// ---- inventory grid ------------------------------------------------------------------------------------
// The player's items sit bottom-left of the draft screen: two rows of five 66 px icons (2560x1440), 75 px pitch.
// Reading it gives the owned list without any clicking, and a new icon that was on offer is the card the player took.
export const INVENTORY = { x0: 147, y0: 1272, pitch: 75, icon: 66, cols: 5, rows: 2, search: 6, scales: [0.94, 1, 1.06] } as const;
export const MIN_INVENTORY_SCORE = 0.6;   // for items that were on offer or are already owned
export const SURE_INVENTORY_SCORE = 0.85; // for anything else
export const MIN_INVENTORY_SD = 20; // raw pixel std-dev below which a slot counts as empty

export interface InventoryRead { slot: number; itemId: number; score: number; margin: number; sd: number }

/**
 * Item ids in the ten inventory slots (0 = empty or unreadable). `prefer` (every card offered this game + items already
 * owned) settles icon twins and lowers the score floor; an item outside it needs a near-perfect match.
 */
export function readInventory(img: RGBImage, index: DecodedIndex, prefer: number[] = []): InventoryRead[] {
  const sx = img.width / BRAWL_LAYOUT.ref.width, sy = img.height / BRAWL_LAYOUT.ref.height;
  const out: InventoryRead[] = [];
  const pref = new Set(prefer);
  for (let r = 0; r < INVENTORY.rows; r++) for (let c = 0; c < INVENTORY.cols; c++) {
    const edge = INVENTORY.icon * sx;
    const cx = (INVENTORY.x0 + c * INVENTORY.pitch) * sx + edge / 2, cy = (INVENTORY.y0 + r * INVENTORY.pitch) * sy + edge / 2;
    // an empty slot is a flat tinted square: skip it on contrast before matching
    const raw = sampleSquare(img, cx - edge / 2, cy - edge / 2, edge, index.size);
    let s1 = 0, s2 = 0; for (const v of raw) { s1 += v; s2 += v * v; }
    const sd = Math.sqrt(Math.max(0, s2 / raw.length - (s1 / raw.length) ** 2));
    if (sd < MIN_INVENTORY_SD) { out.push({ slot: r * INVENTORY.cols + c, itemId: 0, score: 0, margin: 0, sd }); continue; }
    const m = matchIcon(img, index, cx, cy, edge, undefined, { search: Math.round(INVENTORY.search * sx), scales: INVENTORY.scales });
    let id = m.itemId;
    if (!pref.has(id)) { const tw = index.twins.get(id) ?? []; const p = tw.find((t) => pref.has(t)); if (p) id = p; }
    // a background line through an empty slot can look like a dark streaky icon (Shadow Weave at 0.74 on the
    // screenshots), so an item nobody was offered needs a much better match than one that was
    if (m.score < (pref.has(id) ? MIN_INVENTORY_SCORE : SURE_INVENTORY_SCORE)) id = 0;
    out.push({ slot: r * INVENTORY.cols + c, itemId: id, score: m.score, margin: m.margin, sd });
  }
  return out;
}
