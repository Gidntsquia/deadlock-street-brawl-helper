import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore, type DraftRecord, type FrameShot } from '../sessionStore';

let dir: string;
beforeEach(async () => (dir = await mkdtemp(path.join(os.tmpdir(), 'sessions-'))));
afterEach(() => rm(dir, { recursive: true, force: true }));

const rec = (round: number, choice: number): DraftRecord => ({
  round,
  choice,
  startedAt: 1_700_000_000_000 + (round * 3 + choice) * 1000,
  frameW: 2000,
  frameH: 1125,
  items: [1, 2, 3],
  unsure: 0,
  hero: { id: 1, source: 'read' },
  shown: { plates: [{ itemId: 1, tier: 1, score: 5 }], takeId: 1, reroll: false },
  adviceMs: 900,
  changes: 0,
  dropouts: 0,
  fallback: false,
});
const frame = (t: number): FrameShot => ({
  t,
  regions: [0, 1, 2].map((index) => ({ index, x: 0, y: 0, width: 2, height: 2, rgba: new Uint8Array(16) })),
});
const store = (opts = {}) => {
  const s = new SessionStore(dir, (r) => Buffer.from(`png${r.index}`), opts);
  s.enabled = true;
  return s;
};

describe('SessionStore', () => {
  it('writes nothing with debug mode off', async () => {
    const s = new SessionStore(dir, (r) => Buffer.from(`png${r.index}`));
    s.addFrame(frame(0));
    expect(await s.finishDraft(rec(1, 1))).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it('writes crops and the record, and lists them with the marks', async () => {
    const s = store();
    s.addFrame(frame(0));
    s.addFrame(frame(500));
    const { matchId, n } = (await s.finishDraft(rec(1, 1)))!;
    expect(n).toBe(1);
    expect(await readdir(path.join(dir, matchId, 'd001'))).toContain('f1-r2.png');
    await s.mark(matchId, 1, true);
    const [m] = await s.list();
    expect(m!.drafts[0]).toMatchObject({ n: 1, wrong: true, round: 1, choice: 1 });
    expect(m!.drafts[0]!.crops).toHaveLength(3);
    expect(await readFile(path.join(dir, matchId, 'marks.json'), 'utf8')).toBe('{"1":true}');
  });

  it('starts a match at round 1 choice 1 and keeps only the last three; a fourth removes the first', async () => {
    const s = store();
    const firsts: string[] = [];
    for (let m = 0; m < 4; m++) {
      s.addFrame(frame(0));
      firsts.push((await s.finishDraft({ ...rec(1, 1), startedAt: 1_700_000_000_000 + m * 60_000 }))!.matchId);
      s.addFrame(frame(0));
      expect((await s.finishDraft(rec(1, 2)))!.matchId).toBe(firsts[m]);
    }
    expect(new Set(firsts).size).toBe(4);
    const left = await s.ids();
    expect(left).toHaveLength(3);
    expect(left).not.toContain(firsts[0]);
  });

  it('starts a new match when the game window is lost and found', async () => {
    const s = store();
    const a = (await s.finishDraft(rec(1, 1)))!.matchId;
    s.endMatch();
    const b = (await s.finishDraft(rec(2, 1)))!.matchId;
    expect(b).not.toBe(a);
  });

  it('deletes the oldest matches first when over the size cap', async () => {
    const s = store({ capBytes: 60 });
    const ids: string[] = [];
    for (let m = 0; m < 3; m++) {
      s.addFrame(frame(0));
      ids.push((await s.finishDraft(rec(1, 1)))!.matchId);
      s.endMatch();
    }
    const left = await s.ids();
    expect(left).not.toContain(ids[0]);
    expect(left).toContain(ids[2]);
  });
});
