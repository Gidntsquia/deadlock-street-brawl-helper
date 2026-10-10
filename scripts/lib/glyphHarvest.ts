// Harvest of glyph templates: every labelled name line is cut into letters, the letters are matched to the known name
// by position, and the cells of each character are averaged. Offline only; the app reads the result (glyphs.json).
import { cutLine, CELL_H, maskOfCrop, type CutGlyph, type GlyphEntry } from '../../src/brawl/glyphs';
import type { NameSample } from './nameFrames';

export interface Sample {
  c: string;
  /** frame width bucket: glyphs rasterise differently at 1280, 2000 and 2560 wide, so each bucket keeps its own template */
  v: number;
  w: number;
  px: Uint8Array;
}

export const bucketOf = (frameWidth: number) => (frameWidth < 1500 ? 0 : frameWidth < 2300 ? 1 : 2);

/** Averages samples of the same character into one template entry. */
export function averageSamples(samples: Sample[]): GlyphEntry[] {
  const by = new Map<string, Sample[]>();
  for (const s of samples) by.set(`${s.c}\u0000${s.v}`, [...(by.get(`${s.c}\u0000${s.v}`) ?? []), s]);
  const out: GlyphEntry[] = [];
  for (const [key, list] of [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const c = key.split('\u0000')[0]!;
    const W = Math.max(...list.map((s) => s.w));
    const acc = new Float32Array(W * CELL_H);
    for (const s of list)
      for (let y = 0; y < CELL_H; y++) for (let x = 0; x < s.w; x++) acc[y * W + x]! += s.px[y * s.w + x]!;
    const px = new Uint8Array(W * CELL_H);
    for (let i = 0; i < px.length; i++) px[i] = Math.round(acc[i]! / list.length);
    out.push({ c, w: W, n: list.length, b: Buffer.from(px).toString('base64') });
  }
  return out;
}

/** The characters of `label` laid on the cut groups: word by word, the letter count of each label word must equal the
 *  group count of the crop word at the same place. Extra words after the label (the card prints "Spirit Shredder Bullets")
 *  are ignored. Returns null when it does not line up. */
export function alignLabel(label: string, glyphs: CutGlyph[]): string[] | null {
  const words: CutGlyph[][] = [];
  for (const g of glyphs) {
    if (g.space || !words.length) words.push([]);
    words[words.length - 1]!.push(g);
  }
  const want = label.split(' ').filter(Boolean);
  if (words.length < want.length) return null;
  const chars: string[] = [];
  for (const [i, w] of want.entries()) {
    const letters = [...w];
    if (words[i]!.length !== letters.length) return null;
    chars.push(...letters);
  }
  return chars;
}

export interface Harvest {
  samples: Sample[];
  /** names whose letter count did not line up with the groups */
  misaligned: { frame: string; label: string; groups: number }[];
  used: number;
}

export function harvestCards(samples: NameSample[], keep: (s: NameSample) => boolean = () => true): Harvest {
  const out: Harvest = { samples: [], misaligned: [], used: 0 };
  const seen = new Set<string>();
  for (const s of samples) {
    if (!s.label || !keep(s)) continue;
    const { crop } = s;
    const cut = cutLine(maskOfCrop(crop.data, crop.width, crop.height), crop.width, crop.height, 'card', crop.line);
    if (!cut) continue;
    const chars = alignLabel(s.label, cut.glyphs);
    if (!chars) {
      const key = `${s.frame}|${s.slot}`;
      if (!seen.has(key)) out.misaligned.push({ frame: `${s.frame} slot ${s.slot}`, label: s.label, groups: cut.glyphs.length });
      seen.add(key);
      continue;
    }
    out.used++;
    chars.forEach((c, k) => out.samples.push({ c, v: bucketOf(s.width), w: cut.glyphs[k]!.w, px: cut.glyphs[k]!.px }));
  }
  return out;
}
