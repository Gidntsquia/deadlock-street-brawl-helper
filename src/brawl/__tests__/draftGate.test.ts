import { describe, expect, it } from 'vitest';
import { RELABEL_SETTLE_MS, SETTLE_MS, initialGate, offScreenGate, stepGate, type GateOut } from '../draftGate';

// Frames 70 ms apart (the draft capture rate): a screen state that lasts a few frames is a transition, one that lasts
// past SETTLE_MS is a screen the player is looking at.
const DT = 70;
type F = { key: string; round?: number; choice: number; inv?: number[] | null; present?: number[]; ready?: boolean };

function run(frames: F[], start = initialGate()) {
  let s = start,
    t = 0;
  const outs: GateOut[] = [];
  for (const f of frames) {
    const o = stepGate(s, {
      key: f.key,
      present: f.present ?? (f.key ? f.key.split(',').map((k) => Number(k.replace('+', ''))) : []),
      round: f.round ?? 1,
      choice: f.choice,
      now: t,
      inventory: f.inv ?? null,
      ready: f.ready,
    });
    outs.push(o);
    s = o.state;
    t += DT;
  }
  return { outs, state: s, accepted: outs.flatMap((o, i) => (o.accept ? [{ i, ...o.state.last! }] : [])) };
}
const hold = (f: F, ms: number) => Array.from({ length: Math.ceil(ms / DT) + 1 }, () => f);

const A = '1,2,3',
  B = '4,5,6',
  MIX = '4,2,3'; // first new card in, two old ones still up

describe('draftGate', () => {
  it('accepts a set only after it has held, with the same labels, for SETTLE_MS', () => {
    const { outs, accepted } = run(hold({ key: A, choice: 1 }, SETTLE_MS + DT));
    const first = outs.findIndex((o) => o.accept);
    expect(first * DT).toBeGreaterThanOrEqual(SETTLE_MS);
    expect(accepted).toHaveLength(1);
    expect(outs.at(-1)!.live).toBe(true);
  });

  it('never accepts a mixed old/new set or a label that has not settled', () => {
    const { accepted } = run([
      ...hold({ key: A, choice: 1 }, 500),
      // pick: two frames of a half-swapped set, then the new set under the old label for two frames, then settled
      { key: MIX, choice: 1 },
      { key: MIX, choice: 1 },
      { key: B, choice: 1 },
      { key: B, choice: 1 },
      ...hold({ key: B, choice: 2 }, 500),
    ]);
    expect(accepted.map((a) => [a.key, a.choice])).toEqual([
      [A, 1],
      [B, 2],
    ]);
  });

  it('drops the advice as soon as the screen moves on, before the next set is accepted', () => {
    const { outs } = run([...hold({ key: A, choice: 1 }, 500), { key: B, choice: 2 }, { key: B, choice: 2 }]);
    expect(outs.at(-2)!.live).toBe(true); // one odd frame is not enough
    expect(outs.at(-1)!.live).toBe(false);
  });

  it('a selection seen in the inventory spends the set: it is never advised on again', () => {
    const { outs, accepted } = run([
      ...hold({ key: A, choice: 1, inv: [] }, 500),
      { key: A, choice: 1, inv: [2] }, // the pick lands in the grid while the old cards are still up
      ...hold({ key: A, choice: 2, inv: [2] }, 2 * RELABEL_SETTLE_MS), // the old cards linger under the new label
    ]);
    const pickAt = outs.findIndex((o) => o.picked);
    expect(outs[pickAt]!.picked).toBe(2);
    expect(outs[pickAt]!.live).toBe(false);
    expect(accepted).toHaveLength(1);
    expect(outs.at(-1)!.spent).toBe(true);
  });

  it('old cards lingering under the next label are held back, not re-advised at once', () => {
    const { outs, accepted } = run([...hold({ key: A, choice: 1 }, 500), ...hold({ key: A, choice: 2 }, 900)]);
    expect(accepted).toHaveLength(1);
    expect(outs.at(-1)!.live).toBe(false);
  });

  it('a new set settles while its names are read, but old cards under a new label wait from their full read', () => {
    // `?` slots: names still being read (the worker holds the accept until they are in). A new set's settle time runs
    // from its first sight.
    const fresh = run([
      ...hold({ key: '?,?,?', choice: 1, ready: false }, SETTLE_MS),
      { key: A, choice: 1 },
      { key: A, choice: 1 },
    ]);
    expect(fresh.accepted.map((a) => a.key)).toEqual([A]);
    // The same cards under the next label: the provisional frames do not count toward the long settle.
    const linger = run(
      [
        ...hold({ key: '?,?,?', choice: 2, ready: false }, RELABEL_SETTLE_MS),
        ...hold({ key: A, choice: 2 }, RELABEL_SETTLE_MS - DT),
      ],
      fresh.state,
    );
    expect(linger.accepted).toEqual([]);
  });

  it('a set first read under a stale label is re-accepted under the right one once that settles', () => {
    const { accepted } = run([
      ...hold({ key: B, choice: 1 }, 500), // new cards, label not yet updated
      ...hold({ key: B, choice: 2 }, RELABEL_SETTLE_MS + DT),
    ]);
    expect(accepted.map((a) => a.choice)).toEqual([1, 2]);
  });

  it('a re-roll (new cards, same label) is accepted after the normal settle', () => {
    const { accepted } = run([...hold({ key: A, choice: 2 }, 500), ...hold({ key: B, choice: 2 }, SETTLE_MS + DT)]);
    expect(accepted.map((a) => a.key)).toEqual([A, B]);
  });

  it('a hover tooltip hiding a card keeps the advice up for as long as the hover lasts', () => {
    const { outs } = run([
      ...hold({ key: A, choice: 1 }, 500),
      ...hold({ key: '', choice: 1, present: [1, 2] }, 2000),
      { key: A, choice: 1 },
      { key: A, choice: 1 },
    ]);
    const at = outs.findIndex((o) => o.accept);
    expect(outs.slice(at).every((o) => o.live)).toBe(true); // never blanks once accepted
    expect(outs.filter((o) => o.accept)).toHaveLength(1); // no re-accept after the hover
  });

  it('frames with no card read at all drop the advice after a few frames', () => {
    const { outs } = run([...hold({ key: A, choice: 1 }, 500), ...hold({ key: '', choice: 1, present: [] }, 300)]);
    expect(outs.at(-1)!.live).toBe(false);
  });

  it('a wobbling enhanced (+) read keeps the same set live without a re-accept', () => {
    const frames: F[] = [...hold({ key: A, choice: 1 }, 500)];
    for (let i = 0; i < 10; i++) frames.push({ key: i % 2 ? A : '1+,2,3', choice: 1 });
    const { outs } = run(frames);
    expect(outs.filter((o) => o.accept)).toHaveLength(1);
    expect(outs.at(-1)!.live).toBe(true);
  });

  it('a card read outside the accepted set while another is hidden drops the advice at once', () => {
    const { outs } = run([...hold({ key: A, choice: 1 }, 500), { key: '', choice: 2, present: [4, 5] }]);
    expect(outs.at(-1)!.live).toBe(false);
  });

  it('labels going backwards (a misread) need the long settle', () => {
    const { accepted } = run([
      ...hold({ key: A, round: 2, choice: 2 }, 500),
      ...hold({ key: B, round: 1, choice: 2 }, SETTLE_MS + 2 * DT),
    ]);
    expect(accepted.map((a) => a.key)).toEqual([A]);
  });

  it('an unread round (0) does not block acceptance or count as a label change', () => {
    const frames: F[] = [];
    for (let i = 0; i < 12; i++) frames.push({ key: A, round: i % 2 ? 2 : 0, choice: 1 });
    const { accepted, outs } = run(frames);
    expect(accepted).toHaveLength(1);
    expect(outs.at(-1)!.live).toBe(true);
  });

  it('leaving the draft screen forgets the screen but keeps the spent sets', () => {
    const { state } = run([...hold({ key: A, choice: 1, inv: [] }, 500), { key: A, choice: 1, inv: [1] }]);
    const off = offScreenGate(state);
    expect(off.spent).toEqual([A]);
    expect(off.last).toBeNull();
    expect(run(hold({ key: A, choice: 1 }, 600), off).accepted).toHaveLength(0);
  });
});
