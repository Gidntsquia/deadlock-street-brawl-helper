import { describe, expect, it } from 'vitest';
import { matchItemName, nameCandidates, nameList } from '../names';
import { items } from './testData';

const all = nameList(
  items.map((i) => i.id),
  Object.fromEntries(items.map((i) => [i.id, i.name])),
);
const idOf = (n: string) => items.find((i) => i.name === n)!.id;

describe('matchItemName', () => {
  // Texts the OCR engine really returned for the name lines of the demo, live and Spellbreaker frames.
  it.each([
    ['Spellbreaker', 'Spellbreaker'],
    ['Transcendent Cooldown', 'Transcendent Cooldown'],
    ['Spirit Shredder Bullets', 'Spirit Shredder'], // the card prints a longer name than the catalogue
    ["chanter's Emble", "Enchanter's Emblem"], // cut off at the crop edge
    ['Torment Pulse r', 'Torment Pulse'], // a stray letter from the card art
    ['Metal Skin', 'Metal Skin'],
    ['a Health', 'Extra Health'], // the left end hidden by a capture glitch
  ])('%s -> %s', (text, name) => {
    expect(matchItemName(text, all)?.itemId).toBe(idOf(name));
  });
  it.each(['', 'r', 'xqzvw kfj', 'Spirit'])('gives no item for %j', (text) => {
    expect(matchItemName(text, all)).toBeNull();
  });
});

describe('nameCandidates', () => {
  // The real read of a card whose left half a tooltip covered (session m-20261009T050536, round 2): it fits two items,
  // so the name alone names none and the card's icon decides.
  it('lists every item a half-covered name fits, and the name alone decides none', () => {
    expect(matchItemName('ig Round', all)).toBeNull();
    const c = nameCandidates('ig Round', all);
    expect(c).toContain(idOf('Opening Rounds'));
    expect(c.length).toBeGreaterThanOrEqual(2);
  });
  it('is one item for a clean read', () => {
    expect(nameCandidates('Metal Skin', all)).toEqual([idOf('Metal Skin')]);
  });
});
