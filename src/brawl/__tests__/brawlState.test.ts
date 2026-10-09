import { describe, expect, it } from 'vitest';
import { initialBrawl, setLocked, step, type BrawlEvent, type BrawlState } from '../brawlState';

const run = (s: BrawlState, ...es: BrawlEvent[]) => {
  const fx: string[] = [];
  for (const e of es) {
    const r = step(s, e);
    s = r.state;
    fx.push(...r.effects.map((x) => (x.type === 'log' ? x.name : x.type)));
  }
  return { s, fx };
};
const land = (slot: 0 | 1 | 2, fp: string, id: number): BrawlEvent[] => [
  { type: 'cardLine', slot, fp },
  { type: 'cardLine', slot, fp },
  { type: 'cardRead', slot, fp, itemId: id },
];
const drafting = () => run(initialBrawl(), { type: 'roundStart', round: 1 }, { type: 'label', round: 1, choice: 1 }).s;
const locked = () => run(drafting(), ...land(0, 'a', 1), ...land(1, 'b', 2), ...land(2, 'c', 3)).s;

describe('brawl state machine', () => {
  it('round start warms OCR, logs round.start, round 1 is a new match', () => {
    const { s, fx } = run(initialBrawl(), { type: 'roundStart', round: 1 });
    expect(fx).toEqual(['warm', 'round.start']);
    expect(s).toMatchObject({ phase: 'round-start', round: 1, choice: 1, matchId: 1 });
  });
  it('later round start keeps the match and owned list, clears the per-round re-roll', () => {
    let s = locked();
    s = run(s, { type: 'linesBlank' }).s;
    expect(s.rerollUsedThisRound).toBe(true);
    s = { ...s, owned: [9] };
    const r = run(s, { type: 'roundStart', round: 2 }).s;
    expect(r).toMatchObject({ matchId: s.matchId, owned: [9], rerollUsedThisRound: false, round: 2 });
  });
  it('a card is read once its line holds for 2 frames, not before', () => {
    const one = step(drafting(), { type: 'cardLine', slot: 0, fp: 'a' });
    expect(one.effects).toEqual([]);
    const two = step(one.state, { type: 'cardLine', slot: 0, fp: 'a' });
    expect(two.effects).toEqual([{ type: 'readSlot', slot: 0 }]);
    const changed = step(one.state, { type: 'cardLine', slot: 0, fp: 'x' });
    expect(changed.state.slots[0]).toMatchObject({ kind: 'landing', frames: 1 });
  });
  it('a stale read (line changed since) is dropped', () => {
    let s = run(drafting(), { type: 'cardLine', slot: 0, fp: 'a' }, { type: 'cardLine', slot: 0, fp: 'a' }).s;
    s = run(s, { type: 'cardLine', slot: 0, fp: 'b' }).s;
    expect(run(s, { type: 'cardRead', slot: 0, fp: 'a', itemId: 1 }).s.slots[0].kind).toBe('landing');
  });
  it('a read that lands on the first frame of its line locks the slot', () => {
    const s = run(
      drafting(),
      { type: 'cardLine', slot: 1, fp: 'z' },
      { type: 'cardRead', slot: 1, fp: 'z', itemId: 4 },
    ).s;
    expect(s.slots[1]).toMatchObject({ kind: 'locked', itemId: 4 });
  });
  it('a pick seen from the closing set keeps its source', () => {
    const s = run(locked(), { type: 'pick', itemId: 2, advised: 1, source: 'grid' }).s;
    expect(s.lastPick).toMatchObject({ itemId: 2, source: 'grid' });
  });
  it('the set locks when the third card is read; locked slots are never re-read', () => {
    const s = run(drafting(), ...land(0, 'a', 1), ...land(1, 'b', 2));
    expect(setLocked(s.s)).toBe(false);
    const r = run(s.s, ...land(2, 'c', 3));
    expect(setLocked(r.s)).toBe(true);
    expect(r.fx).toContain('setLocked');
    expect(r.fx).toContain('readCaption');
    const again = run(r.s, { type: 'cardLine', slot: 0, fp: 'a' }, { type: 'cardLine', slot: 1, fp: 'b' });
    expect(again.fx).toEqual([]);
    expect(again.s.reads).toEqual([1, 1, 1]);
  });
  it('blank lines under the same label are a re-roll: slots clear, re-roll used', () => {
    const r = run(locked(), { type: 'linesBlank' });
    expect(r.fx).toContain('reroll');
    expect(r.s).toMatchObject({ rerollUsedThisRound: true, rerollsLeft: 0, phase: 'drafting', choice: 1 });
    expect(r.s.slots.every((x) => x.kind === 'empty')).toBe(true);
  });
  it('blank lines with no set up are not a re-roll', () => {
    expect(run(drafting(), { type: 'linesBlank' }).s.rerollUsedThisRound).toBe(false);
  });
  it('the caption read sets the re-rolls left', () => {
    expect(run(locked(), { type: 'caption', rerollsLeft: 0 }).s.rerollsLeft).toBe(0);
  });
  it('a read pick adds to the owned list with source read', () => {
    const r = run(locked(), { type: 'pick', itemId: 2, advised: 1 });
    expect(r.s).toMatchObject({
      owned: [2],
      lastPick: { itemId: 2, source: 'read' },
      phase: 'picked',
      gridCheck: false,
    });
  });
  it('an unreadable pick assumes the advised card and asks for a grid check', () => {
    const r = run(locked(), { type: 'pick', itemId: null, advised: 1 });
    expect(r.s).toMatchObject({ owned: [1], lastPick: { source: 'assumed' }, gridCheck: true });
  });
  it('the grid corrects a wrong assumed pick and logs owned.corrected', () => {
    let s = run(locked(), { type: 'pick', itemId: null, advised: 1 }).s;
    const r = run(s, { type: 'ownedGrid', ids: [3] });
    expect(r.fx).toContain('owned.corrected');
    expect(r.s).toMatchObject({ owned: [3], gridCheck: false, lastPick: { source: 'grid' } });
  });
  it('the grid agreeing with the assumed pick logs nothing', () => {
    const s = run(locked(), { type: 'pick', itemId: null, advised: 1 }).s;
    const r = run(s, { type: 'ownedGrid', ids: [1] });
    expect(r.fx).toEqual([]);
    expect(r.s.gridCheck).toBe(false);
  });
  it('the label advancing after a pick is a normal step, not a resync', () => {
    const s = run(locked(), { type: 'pick', itemId: 1, advised: 1 }).s;
    const r = run(s, { type: 'label', round: 1, choice: 2 });
    expect(r.s).toMatchObject({ choice: 2, phase: 'drafting', resyncs: 0 });
    expect(r.fx).toEqual([]);
  });
  it('choice 3 pick ends the round and the next round label is a normal step', () => {
    let s = { ...drafting(), choice: 3 };
    s = run(s, { type: 'pick', itemId: 1, advised: 1 }).s;
    expect(s.phase).toBe('between-rounds');
    expect(run(s, { type: 'label', round: 2, choice: 1 }).s).toMatchObject({ round: 2, choice: 1, resyncs: 0 });
  });
  it('a label that jumps resyncs, re-reads and says so', () => {
    const r = run(locked(), { type: 'label', round: 3, choice: 2 });
    expect(r.fx).toEqual(expect.arrayContaining(['readCaption', 'readGrid', 'status', 'resync']));
    expect(r.s).toMatchObject({ round: 3, choice: 2, resyncs: 1 });
    expect(r.s.slots.every((x) => x.kind === 'empty')).toBe(true);
  });
  it('the resync status text names the round and choice', () => {
    const r = step(locked(), { type: 'label', round: 3, choice: 2 });
    expect(r.effects).toContainEqual({ type: 'status', text: 'Resynced to round 3 choice 2' });
  });
  it('F8 forces the same resync on the tracked label', () => {
    const r = step(locked(), { type: 'forceResync' });
    expect(r.effects).toContainEqual({ type: 'status', text: 'Resynced to round 1 choice 1' });
    expect(r.state.resyncs).toBe(1);
  });
  it('rounds going backwards are a new match with a fresh owned list', () => {
    let s = { ...run(drafting(), { type: 'label', round: 4, choice: 1 }).s, owned: [5, 6] };
    s = run(s, { type: 'label', round: 2, choice: 1 }).s;
    expect(s).toMatchObject({ owned: [], round: 2, matchId: 2 });
  });
  it('round 1 choice 1 label via resync clears owned and re-roll', () => {
    const s = { ...locked(), owned: [5], round: 3, choice: 2, rerollsLeft: 0 };
    expect(run(s, { type: 'label', round: 1, choice: 1 }).s).toMatchObject({ owned: [], rerollsLeft: 1 });
  });
});
