// Matches the OCR'd name line under a draft card to an item. The name is the exact item name, so a clear match beats
// the icon search, which can fall short when the game draws an icon differently from the shop art (Spellbreaker's
// in-game art has a teal background). Pure; the OCR read itself is in ocr.ts.

export interface NameMatch {
  itemId: number;
  /** 0..1, 1 = the same letters. */
  score: number;
  /** score minus the next-best item's. */
  margin: number;
}

/** A name match this strong, and this far ahead of the next item, decides the card. */
export const NAME_MIN_SCORE = 0.75;
export const NAME_MIN_MARGIN = 0.08;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

const lev = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
};

/** How well OCR text `t` (normalised) reads as item name `n` (normalised). The game can print a longer name than the
 *  catalogue (catalogue "Spirit Shredder", card "Spirit Shredder Bullets"): a whole name found inside the text counts
 *  by how much of the text it covers. */
const similarity = (t: string, n: string): number => {
  const whole = 1 - lev(t, n) / Math.max(t.length, n.length);
  const inside = n.length >= 5 && t.includes(n) ? 0.8 + (0.2 * n.length) / t.length : 0;
  // Something drawn over one end of the line (a capture glitch, a tooltip) leaves only the other end to read: a
  // read of six or more letters that is the exact start or end of a longer name counts by how much of it was seen.
  const part =
    t.length >= 6 && n.length > t.length && (n.endsWith(t) || n.startsWith(t)) ? 0.7 + (0.3 * t.length) / n.length : 0;
  return Math.max(whole, inside, part);
};

export type NameList = { id: number; key: string }[];

/** Item names prepared for matchItemName: only items the icon index can show (the draft pool). */
export function nameList(ids: Iterable<number>, names: Record<number, string>): NameList {
  const out: NameList = [];
  const seen = new Set<number>();
  for (const id of ids) {
    const n = names[id];
    if (!n || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, key: norm(n) });
  }
  return out;
}

/** The item the text names, or null when it is too garbled (or empty, e.g. hidden by the hover tooltip) to say. */
export function matchItemName(text: string, list: NameList): NameMatch | null {
  const t = norm(text);
  if (t.length < 3) return null;
  let best = { id: 0, s: -1 },
    second = -1;
  for (const { id, key } of list) {
    const s = similarity(t, key);
    if (s > best.s) {
      second = best.s;
      best = { id, s };
    } else if (s > second) second = s;
  }
  const margin = best.s - Math.max(0, second);
  if (best.s < NAME_MIN_SCORE || margin < NAME_MIN_MARGIN) return null;
  return { itemId: best.id, score: best.s, margin };
}

/** A hero name read off the loading screen must be this close: hero names are short, so one wrong letter in a
 *  four-letter read ("SHIP") already scores 0.75 against "Shiv". */
export const HERO_MIN_SCORE = 0.85;

/** The hero the loading screen's text names, or null when the read is not near-exact. */
export function matchHeroName(text: string, list: NameList): NameMatch | null {
  const m = matchItemName(text, list);
  return m && m.score >= HERO_MIN_SCORE ? m : null;
}
