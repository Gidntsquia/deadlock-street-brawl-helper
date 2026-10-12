import { describe, expect, it } from 'vitest';
import { TimingTracker } from '../setTiming';
import { matchLabel, msLabel, stretchAt, type LabelFile } from '../footageMatch';

describe('TimingTracker', () => {
  it('splits a set into capture, read, ocr and settle', () => {
    const t = new TimingTracker();
    t.frameSent(1000, 20);
    t.ocrTrip(4900, 5); // before any card: not counted
    t.result(1030, 5030, 1, 0, false, 'k');
    t.ocrTrip(5040, 8);
    t.ocrTrip(5044, 8); // overlaps the first: counted once (5040 to 5052)
    t.frameSent(1100, 30);
    t.result(1140, 5140, 3, 3, false, 'k');
    t.frameSent(1300, 10);
    t.result(1330, 5330, 3, 3, true, 'k');
    expect(t.get('k')).toEqual({
      setKey: 'k',
      firstSeenWall: 5030 - 30 - 20,
      capture: 10,
      read: 30 + 40 + 30,
      ocr: 12,
      settle: 190,
      lastCardWall: null,
    });
  });
  it('carries the last card landing into the accepted set and forgets it after', () => {
    const t = new TimingTracker();
    t.frameSent(0, 0);
    t.result(10, 1010, 2, 2, false, 'a');
    t.land(1100);
    t.result(110, 1110, 3, 2, false, 'a');
    t.result(210, 1210, 3, 3, true, 'a');
    expect(t.get('a')?.lastCardWall).toBe(1100);
    t.result(300, 1300, 0, 0, false, 'b');
    t.result(400, 1400, 3, 3, true, 'b');
    expect(t.get('b')?.lastCardWall).toBeNull();
  });
  it('starts a new cycle after an empty frame and after an accept', () => {
    const t = new TimingTracker();
    t.frameSent(0, 0);
    t.result(10, 10, 2, 2, false, 'a');
    t.result(20, 20, 0, 0, false, 'a');
    t.frameSent(500, 0);
    t.result(510, 510, 3, 3, true, 'b');
    expect(t.get('b')?.read).toBe(10);
    expect(t.get('a')).toBeNull();
  });
  it('does not start a set on frames that still show the accepted one', () => {
    // the accepted set stays up for seconds, then the next set's cards replace it with no empty frame between
    const t = new TimingTracker();
    t.frameSent(0, 0);
    t.result(10, 10, 3, 3, true, 'a');
    t.frameSent(5000, 0);
    t.result(5010, 5010, 3, 3, false, 'a', true);
    t.frameSent(9000, 0);
    t.result(9010, 9010, 1, 0, false, 'b');
    t.frameSent(9200, 0);
    t.result(9210, 9210, 3, 3, false, 'b');
    t.frameSent(9300, 0);
    t.result(9310, 9310, 3, 3, true, 'b');
    expect(t.get('b')).toMatchObject({ firstSeenWall: 9000, read: 30, settle: 100 });
  });
});

describe('matchLabel', () => {
  const labels: LabelFile = {
    video: 'v.mkv',
    stretches: [
      {
        id: 's0',
        video: [0, 20],
        sets: [
          { draft: 'd1', items: ['A', 'B', 'C'], from: 2, to: 5, appear: 2.5 },
          { draft: 'd2', items: ['A', 'B', 'C'], from: 12, to: 15, appear: 12.25 },
        ],
      },
      {
        id: 's1',
        video: [900, 920],
        sets: [{ draft: 'd9', items: ['A', 'B', 'C'], from: 902, to: 905, appear: 902.5 }],
      },
    ],
  };
  it('only matches inside the stretch the video is playing (padded 1 s)', () => {
    // the video looped back past s1: the same items must not match s0's set from 900 s away, nor the reverse
    expect(matchLabel(labels, 'v.mkv', ['A', 'B', 'C'], 903)?.draft).toBe('d9');
    expect(matchLabel(labels, 'v.mkv', ['A', 'B', 'C'], 20.9)?.draft).toBe('d2');
    expect(matchLabel(labels, 'v.mkv', ['A', 'B', 'C'], 21.5)).toBeNull();
    expect(matchLabel(labels, 'v.mkv', ['A', 'B', 'C'], 500)).toBeNull();
    expect(stretchAt(labels, 899.2)).toBe('s1');
    expect(stretchAt(labels, 500)).toBeNull();
  });
  it('picks the nearest set with the same items', () => {
    expect(matchLabel(labels, 'v.mkv', ['A', 'B', 'C'], 13)).toEqual({ stretch: 's0', draft: 'd2', appearAt: 12.25 });
    expect(matchLabel(labels, 'v.mkv', ['A', 'B'], 4)?.draft).toBe('d1');
  });
  it('is null for another file, other items or no labels', () => {
    expect(matchLabel(labels, 'x.mkv', ['A', 'B', 'C'], 3)).toBeNull();
    expect(matchLabel(labels, 'v.mkv', ['A', 'X', 'C'], 3)).toBeNull();
    expect(matchLabel(null, 'v.mkv', ['A'], 3)).toBeNull();
  });
  it('prints ms with a tilde when approximate', () => {
    expect(msLabel(1234.4, false)).toBe('1234 ms');
    expect(msLabel(800, true)).toBe('~800 ms');
  });
});
