// Template reader for the game's lettering: turns a black-on-white name line into text without an OCR engine.
// Synchronous and pure (no DOM, no Node): it runs inside the worker, the page and the scripts alike.
//
// How a line is read: the ink is cut into 8-connected components, the dots of i and j are merged into the stem below them,
// the groups are ordered left to right (a wide gap is a space), every group is resampled at one fixed scale (cap height
// CAP_PX, baseline on row BASE of a CELL_H tall cell) and compared with the stored templates of that character set.
// A glyph counts only when its best template clears MIN_CORR and leads the best template of another letter by MIN_MARGIN;
// one unsure glyph makes the whole line unsure, because a wrong item is worse than a grey `?`.
import { matchItemName, NAME_MIN_MARGIN, NAME_MIN_SCORE, type NameList, type NameMatch } from './names';

/** Every line is resampled to this cap height (the 2560x1440 size) before it is compared. */
export const CAP_PX = 28;
export const CELL_H = 48;
/** Row of the baseline in a cell: caps and the dots of i/j sit above it, descenders below. */
export const BASE = 36;
const PAD = 1;
/** A glyph's best correlation must be at least this, and this far ahead of the best template of another letter. */
export const MIN_CORR = 0.8;
export const MIN_MARGIN = 0.06;
/** The white margin `cardNameCrop` puts around the text window. */
export const CROP_PAD = 12;
/** Ink taller than this share of the crop's line height is not lettering (a card border stroke, the icon's rim). */
const MAX_INK_OF_LINE = 0.66;
/** The first letter's height must be a believable share of the crop's line height. */
/** Lettering more than this share of the line height from the next group is a different thing (frame strokes, specks). */
const CLUSTER_GAP_OF_LINE = 0.45;
const CAP_OF_LINE_RANGE = [0.25, 0.55] as const;
/** A gap wider than this many x-heights between two groups is a space. */
export const SPACE_GAP = 0.45;
const X_OF_CAP = 0.72;

export type GlyphSetName = 'card' | 'hero' | 'caption';

export interface GlyphEntry {
  /** The character, or the characters of a touching group. */
  c: string;
  /** Cell width in px. */
  w: number;
  /** How many samples were averaged. */
  n: number;
  /** base64 of w x CELL_H bytes (row-major, 0 = paper, 255 = ink). */
  b: string;
}
export interface GlyphFile {
  version: 1;
  capPx: number;
  cellH: number;
  base: number;
  sets: Record<GlyphSetName, GlyphEntry[]>;
}

interface Template {
  c: string;
  cls: string;
  w: number;
  n: number;
  px: Uint8Array;
  norm: number;
  r0: number;
  r1: number;
}
export type DecodedGlyphs = Record<GlyphSetName, Template[]>;

const b64 = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** A [1 2 1] blur in both directions, `passes` times: it takes the rasterisation (1280 px frames upscaled 2x are blocky,
 *  2000 px ones are not) out of the comparison and leaves the stroke structure. */
export function blur(px: Uint8Array, w: number, passes = BLUR_PASSES): Uint8Array {
  let a = px;
  for (let p = 0; p < passes; p++) {
    const b = new Uint8Array(a.length);
    for (let y = 0; y < CELL_H; y++)
      for (let x = 0; x < w; x++) {
        const l = x > 0 ? a[y * w + x - 1]! : 0,
          r = x < w - 1 ? a[y * w + x + 1]! : 0;
        b[y * w + x] = (l + 2 * a[y * w + x]! + r + 2) >> 2;
      }
    const c = new Uint8Array(a.length);
    for (let y = 0; y < CELL_H; y++)
      for (let x = 0; x < w; x++) {
        const u = y > 0 ? b[(y - 1) * w + x]! : 0,
          d = y < CELL_H - 1 ? b[(y + 1) * w + x]! : 0;
        c[y * w + x] = (u + 2 * b[y * w + x]! + d + 2) >> 2;
      }
    a = c;
  }
  return a;
}
const BLUR_PASSES = 2;
const RESCORE_K = 12;

/** Cosine norm and ink row range of a cell. */
function stats(px: Uint8Array, w: number): { norm: number; r0: number; r1: number } {
  let sum = 0,
    r0 = CELL_H,
    r1 = -1;
  for (let y = 0; y < CELL_H; y++)
    for (let x = 0; x < w; x++) {
      const v = px[y * w + x]!;
      if (v) {
        sum += v * v;
        if (y < r0) r0 = y;
        if (y > r1) r1 = y;
      }
    }
  return { norm: Math.sqrt(sum), r0, r1 };
}

export function decodeGlyphs(file: GlyphFile): DecodedGlyphs {
  const out: DecodedGlyphs = { card: [], hero: [], caption: [] };
  for (const set of ['card', 'hero', 'caption'] as const)
    for (const e of file.sets[set] ?? []) {
      const px = blur(b64(e.b), e.w);
      out[set].push({ c: e.c, cls: classOf(e.c), w: e.w, n: e.n, px, ...stats(px, e.w) });
    }
  return out;
}

/** The letters a margin is measured between: case does not matter to the name match, and a capital I is the same stem
 *  as a lowercase l in this font. */
const classOf = (c: string) => (c === 'I' ? 'l' : c.toLowerCase());

let loaded: DecodedGlyphs | null = null;
/** Decodes glyphs.json once; the first reads are as fast as the hundredth. */
export function setGlyphs(file: GlyphFile | undefined | null): void {
  if (file && !loaded) loaded = decodeGlyphs(file);
}
/** Replaces the templates (the harvest tool measures with held-out sets). */
export function overrideGlyphs(file: GlyphFile): void {
  loaded = decodeGlyphs(file);
}
export const glyphsLoaded = () => loaded !== null;

// ---------------------------------------------------------------------------------------------------------------------
// Cutting

export interface Group {
  x0: number;
  x1: number; // inclusive
  y0: number;
  y1: number;
  /** labels of the components in the group */
  labels: number[];
  area: number;
}

interface Comp {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  area: number;
  label: number;
}

/** 8-connected components of an ink mask (1 = ink); tiny specks are dropped. */
function components(mask: Uint8Array, w: number, h: number): { comps: Comp[]; labels: Int32Array } {
  const labels = new Int32Array(w * h);
  const comps: Comp[] = [];
  const stack = new Int32Array(w * h);
  let next = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i]) continue;
    next++;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = next;
    const c: Comp = { x0: w, x1: 0, y0: h, y1: 0, area: 0, label: next };
    while (sp) {
      const p = stack[--sp]!;
      const x = p % w,
        y = (p - x) / w;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mask[q] && !labels[q]) {
            labels[q] = next;
            stack[sp++] = q;
          }
        }
      }
    }
    comps.push(c);
  }
  return { comps: comps.filter((c) => c.area >= 3), labels };
}

/** Groups: dots (i, j) merged into the stem below them, ordered left to right. */
function groupsOf(comps: Comp[]): Group[] {
  if (!comps.length) return [];
  const maxH = Math.max(...comps.map((c) => c.y1 - c.y0 + 1));
  const isSmall = (c: Comp) => c.y1 - c.y0 + 1 < 0.3 * maxH;
  const big = comps.filter((c) => !isSmall(c));
  const groups: Group[] = big.map((c) => ({
    x0: c.x0,
    x1: c.x1,
    y0: c.y0,
    y1: c.y1,
    labels: [c.label],
    area: c.area,
  }));
  for (const d of comps.filter(isSmall)) {
    const cx = (d.x0 + d.x1) / 2;
    // the stem below: its x range holds the dot's centre, and it starts under the dot within a short distance
    const host = groups
      .filter((g) => cx >= g.x0 - 1 && cx <= g.x1 + 1 && g.y0 >= d.y0 && g.y0 - d.y1 < 0.4 * maxH)
      .sort((a, b) => a.y0 - b.y0)[0];
    if (host) {
      host.labels.push(d.label);
      host.x0 = Math.min(host.x0, d.x0);
      host.x1 = Math.max(host.x1, d.x1);
      host.y0 = Math.min(host.y0, d.y0);
      host.area += d.area;
    } else groups.push({ x0: d.x0, x1: d.x1, y0: d.y0, y1: d.y1, labels: [d.label], area: d.area });
  }
  return groups.sort((a, b) => a.x0 - b.x0);
}

/** One group at the fixed scale: a CELL_H tall cell with the baseline on row BASE. */
function cellOf(
  g: Group,
  labels: Int32Array,
  w: number,
  scale: number,
  baseline: number,
): { px: Uint8Array; w: number } {
  const gw = g.x1 - g.x0 + 1;
  const cw = Math.max(3, Math.ceil(gw * scale) + 2 * PAD);
  const px = new Uint8Array(cw * CELL_H);
  const set = new Set(g.labels);
  const r = Math.max(1, 1 / scale);
  const ri = Math.ceil(r);
  const h = labels.length / w;
  for (let dy = 0; dy < CELL_H; dy++) {
    const sy = baseline + (dy - BASE + 0.5) / scale - 0.5;
    if (sy < g.y0 - r - 1 || sy > g.y1 + r + 1) continue;
    const yc = Math.round(sy);
    for (let dx = 0; dx < cw; dx++) {
      const sx = g.x0 + (dx - PAD + 0.5) / scale - 0.5;
      const xc = Math.round(sx);
      let acc = 0,
        wsum = 0;
      for (let yy = yc - ri; yy <= yc + ri; yy++) {
        const wy = 1 - Math.abs(yy - sy) / r;
        if (wy <= 0) continue;
        for (let xx = xc - ri; xx <= xc + ri; xx++) {
          const wx = 1 - Math.abs(xx - sx) / r;
          if (wx <= 0) continue;
          const wt = wx * wy;
          wsum += wt;
          if (xx >= 0 && xx < w && yy >= 0 && yy < h && set.has(labels[yy * w + xx]!)) acc += wt;
        }
      }
      if (wsum > 0) px[dy * cw + dx] = Math.round((255 * acc) / wsum);
    }
  }
  return { px, w: cw };
}

export interface CutGlyph {
  px: Uint8Array;
  w: number;
  /** x offset of the group from the previous one, in source px, and whether a space precedes it */
  space: boolean;
  /** source box */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
export interface CutLine {
  glyphs: CutGlyph[];
  /** cap height in source px that the scale was made from */
  cap: number;
  baseline: number;
}

export type LineKind = 'card' | 'hero' | 'caption';

/** Cuts an ink mask (1 = ink) into letter cells at the fixed scale. `line` is the crop's text line height for a card
 *  name; hero and caption lines take their own glyph height. */
export function cutLine(mask: Uint8Array, w: number, h: number, kind: LineKind, line = 0): CutLine | null {
  const found = components(mask, w, h);
  const labels = found.labels;
  let comps = found.comps;
  if (kind === 'card' && line > 0)
    // Strokes of the card border and the icon's rim cross the text window: they touch its edge or stand far taller
    // than a letter.
    comps = comps.filter(
      (c) =>
        c.y1 - c.y0 + 1 <= MAX_INK_OF_LINE * line &&
        c.x0 > CROP_PAD &&
        c.x1 < w - CROP_PAD - 1 &&
        c.y0 > CROP_PAD &&
        c.y1 < h - CROP_PAD - 1,
    );
  let groups = groupsOf(comps);
  if (kind === 'card' && line > 0 && groups.length > 1) {
    // Specks and strokes of the card frame lie far from the lettering: keep the cluster with the most ink, where a
    // cluster ends at a gap wider than word spacing could be.
    const clusters: Group[][] = [[groups[0]!]];
    for (let i = 1; i < groups.length; i++) {
      const prevEnd = Math.max(...clusters[clusters.length - 1]!.map((g) => g.x1));
      if (groups[i]!.x0 - prevEnd - 1 > CLUSTER_GAP_OF_LINE * line) clusters.push([]);
      clusters[clusters.length - 1]!.push(groups[i]!);
    }
    groups = clusters.sort((a, b) => b.reduce((n, g) => n + g.area, 0) - a.reduce((n, g) => n + g.area, 0))[0]!;
  }
  if (!groups.length) return null;
  const tall = groups.filter((g) => g.y1 - g.y0 + 1 >= 0.5 * Math.max(...groups.map((x) => x.y1 - x.y0 + 1)));
  const bottoms = tall.map((g) => g.y1).sort((a, b) => a - b);
  const baselineRow = bottoms[Math.floor(bottoms.length / 2)]!;
  const baseline = baselineRow + 1;
  let cap: number;
  if (kind === 'card' && line > 0) {
    // Title Case: the first group is a capital. Its height is the cap height of this line at this frame size.
    const first = groups[0]!;
    cap = first.y1 - first.y0 + 1;
    if (cap < CAP_OF_LINE_RANGE[0] * line || cap > CAP_OF_LINE_RANGE[1] * line) return null;
  } else {
    const hs = tall.map((g) => g.y1 - g.y0 + 1).sort((a, b) => a - b);
    cap = hs[Math.floor(hs.length / 2)]!;
  }
  if (cap < 6) return null;
  const scale = CAP_PX / cap;
  const xh = X_OF_CAP * cap;
  const out: CutGlyph[] = [];
  let prev: Group | null = null;
  for (const g of groups) {
    const cell = cellOf(g, labels, w, scale, baseline);
    out.push({
      px: cell.px,
      w: cell.w,
      space: !!prev && g.x0 - prev.x1 - 1 > SPACE_GAP * xh,
      x0: g.x0,
      x1: g.x1,
      y0: g.y0,
      y1: g.y1,
    });
    prev = g;
  }
  return { glyphs: out, cap, baseline };
}

// ---------------------------------------------------------------------------------------------------------------------
// Matching

/** Best cosine similarity of two cells over small shifts (the resample leaves a pixel of jitter). */
function similarity(g: Uint8Array, gw: number, gs: ReturnType<typeof stats>, t: Template): number {
  if (!gs.norm || !t.norm) return 0;
  const r0 = Math.min(gs.r0, t.r0),
    r1 = Math.max(gs.r1, t.r1);
  let best = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      let dot = 0;
      const xa = Math.max(0, dx),
        xb = Math.min(gw, t.w + dx);
      for (let y = r0; y <= r1; y++) {
        const ty = y + dy;
        if (ty < 0 || ty >= CELL_H) continue;
        for (let x = xa; x < xb; x++) {
          const a = g[y * gw + x]!;
          if (a) dot += a * t.px[ty * t.w + x - dx]!;
        }
      }
      const c = dot / (gs.norm * t.norm);
      if (c > best) best = c;
    }
  return best;
}

/** Zero-mean correlation over the union box of glyph and template, best of small shifts. Plain cosine of two
 *  non-negative pictures rates every letter close to every other; centring makes the empty space count. */
function centred(g: Uint8Array, gw: number, t: Template, r0: number, r1: number): number {
  const W = Math.max(gw, t.w) + 2;
  let best = -1;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      const n = (r1 - r0 + 1) * W;
      for (let y = r0; y <= r1; y++) {
        const ty = y + dy;
        for (let x = 0; x < W; x++) {
          const a = x < gw ? g[y * gw + x]! : 0;
          const tx = x - dx;
          const b = ty >= 0 && ty < CELL_H && tx >= 0 && tx < t.w ? t.px[ty * t.w + tx]! : 0;
          sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
        }
      }
      const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
      if (va <= 0 || vb <= 0) continue;
      const c = (sab - (sa * sb) / n) / Math.sqrt(va * vb);
      if (c > best) best = c;
    }
  return best;
}

export interface GlyphRead {
  char: string;
  /** best correlation */
  score: number;
  /** best minus the best template of another letter */
  margin: number;
  sure: boolean;
}

export function matchGlyph(g: CutGlyph, set: Template[]): GlyphRead {
  const px = blur(g.px, g.w);
  const gs = stats(px, g.w);
  const scored: { t: Template; s: number }[] = [];
  for (const t of set) {
    if (Math.abs(t.w - g.w) > 0.3 * Math.max(t.w, g.w) + 2) continue;
    if (Math.abs(t.r0 - gs.r0) > 6 || Math.abs(t.r1 - gs.r1) > 6) continue;
    scored.push({ t, s: similarity(px, g.w, gs, t) });
  }
  // the closest few by cosine are rescored with the centred correlation, which tells lookalike letters apart
  scored.sort((a, b) => b.s - a.s);
  let best = { c: '', cls: '', s: 0 },
    other = 0;
  const seen: { cls: string; s: number }[] = [];
  for (const x of scored.slice(0, RESCORE_K)) {
    const r0 = Math.min(gs.r0, x.t.r0),
      r1 = Math.max(gs.r1, x.t.r1);
    const s = centred(px, g.w, x.t, r0, r1);
    seen.push({ cls: x.t.cls, s });
    if (s > best.s) best = { c: x.t.c, cls: x.t.cls, s };
  }
  for (const x of seen) if (x.cls !== best.cls && x.s > other) other = x.s;
  const margin = best.s - other;
  return { char: best.c, score: best.s, margin, sure: !!best.c && best.s >= MIN_CORR && margin >= MIN_MARGIN };
}

export interface LineRead {
  text: string;
  /** the weakest glyph's correlation */
  score: number;
  glyphs: number;
  /** every glyph cleared the sure rule */
  sure: boolean;
  /** why the line is not sure */
  reason?: 'empty' | 'touching' | 'low-glyph';
}

function readCut(cut: CutLine | null, set: Template[]): LineRead {
  if (!cut || !set.length) return { text: '', score: 0, glyphs: 0, sure: false, reason: 'empty' };
  let text = '',
    score = 1,
    sure = true,
    reason: LineRead['reason'];
  const widest = Math.max(...set.map((t) => t.w));
  for (const g of cut.glyphs) {
    if (g.space) text += ' ';
    if (g.w > widest * 1.25) {
      text += '?';
      sure = false;
      reason ??= 'touching';
      score = Math.min(score, 0);
      continue;
    }
    const r = matchGlyph(g, set);
    // a lone stem opening a word is the capital I of a Title Case name, anywhere else an l
    const stem = r.char === 'l' || r.char === 'I';
    text += stem ? (g.space || text === '' ? 'I' : 'l') : r.char || '?';
    score = Math.min(score, r.score);
    if (!r.sure) {
      sure = false;
      reason ??= 'low-glyph';
    }
  }
  return { text, score, glyphs: cut.glyphs.length, sure, reason };
}

/** A card-name crop's ink mask: `cardNameCrop` already thresholded the line to black on white. */
export function maskOfCrop(data: ArrayLike<number>, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4]! < 128 ? 1 : 0;
  return mask;
}

export interface NameCropLike {
  data: ArrayLike<number>;
  width: number;
  height: number;
  line: number;
}

/** The text of a card-name crop as the templates read it; unsure glyphs print as `?`. */
export function readNameLine(crop: NameCropLike): LineRead {
  if (!loaded) return { text: '', score: 0, glyphs: 0, sure: false, reason: 'empty' };
  const cut = cutLine(maskOfCrop(crop.data, crop.width, crop.height), crop.width, crop.height, 'card', crop.line);
  return readCut(cut, loaded.card);
}

export interface NameRead extends LineRead {
  match: NameMatch | null;
  /** why there is no item: the line, or `no-item` when the text names no item sure enough */
  why?: 'empty' | 'touching' | 'low-glyph' | 'no-item';
}

/** The item a card-name crop names, or null: every glyph must be sure and the text must resolve through matchItemName. */
export function readCardNameDetail(crop: NameCropLike, list: NameList): NameRead {
  const r = readNameLine(crop);
  if (!r.sure) return { ...r, match: null, why: r.reason };
  const match = matchItemName(r.text, list);
  return { ...r, match, why: match ? undefined : 'no-item' };
}

export function readCardNameFast(crop: NameCropLike, list: NameList): NameMatch | null {
  return readCardNameDetail(crop, list).match;
}
export { NAME_MIN_MARGIN, NAME_MIN_SCORE };

// ---------------------------------------------------------------------------------------------------------------------
// Hero name on the loading screen, and the re-roll caption digit

/** Cream lettering on a dark box (the loading screen): the same colour test as `looksLikeLoadingName`. */
export function creamMask(data: ArrayLike<number>, width: number, height: number, channels: 3 | 4): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const r = data[i * channels]!,
      g = data[i * channels + 1]!,
      b = data[i * channels + 2]!;
    mask[i] = r > 170 && g > 150 && b > 110 && r - b > 10 && r - b < 110 ? 1 : 0;
  }
  return mask;
}

export function readHeroLine(
  crop: { data: ArrayLike<number>; width: number; height: number; channels: 3 | 4 },
  set: Template[] | null = loaded?.hero ?? null,
): LineRead {
  if (!set) return { text: '', score: 0, glyphs: 0, sure: false, reason: 'empty' };
  const mask = creamMask(crop.data, crop.width, crop.height, crop.channels);
  return readCut(cutLine(mask, crop.width, crop.height, 'hero'), set);
}

/** The re-roll caption digit: the contrast-stretched crop (`extractRerollLabelCrop`, dark glyph on white). Returns the
 *  digit, or null when the glyph does not clear the sure rule. */
export function readCaptionDigit(crop: { data: ArrayLike<number>; width: number; height: number }): number | null {
  if (!loaded?.caption.length) return null;
  const mask = new Uint8Array(crop.width * crop.height);
  for (let i = 0; i < mask.length; i++) mask[i] = crop.data[i * 4]! < 128 ? 1 : 0;
  const cut = cutLine(mask, crop.width, crop.height, 'caption');
  if (!cut || cut.glyphs.length < 1) return null;
  const r = matchGlyph(cut.glyphs[0]!, loaded.caption);
  return r.sure && /^[0-9]$/.test(r.char) ? Number(r.char) : null;
}
