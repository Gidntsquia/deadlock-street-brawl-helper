import { describe, expect, it } from 'vitest';
import { matchItemName, nameList } from '../names';
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
