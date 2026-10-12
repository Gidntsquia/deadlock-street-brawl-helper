// Where the time goes between the first card of a draft set showing and its plates being drawn. Pure: the control
// window feeds it what it already sees (frames sent, results back, OCR round trips) and takes one `SetTiming` per
// accepted set. Only test-mode video runs use it (main logs `video.advice` from it).

/** One accepted set's breakdown, in ms, plus the wall-clock marks main needs. */
export interface SetTiming {
  /** The accepted set's key (`FrameResult.key`). */
  setKey: string;
  /** Wall clock (Date.now) of the first picture in which the worker saw any card of this set. */
  firstSeenWall: number;
  /** Picture presented by the video to the page's frame copy (the staleness of the copy the set was accepted on). */
  capture: number;
  /** Recogniser and name reads: sum of (result back - frame sent) from the first card to the accept. */
  read: number;
  /** Text read round trips (worker to page to main to the helper and back) between the set's first card and the accept,
   *  overlapping reads counted once: the wall time the set spent with a read in flight. */
  ocr: number;
  /** All three cards read to accepted: the gate's wait for the picture to hold still. */
  settle: number;
  /** Wall clock (Date.now) when the control window sent the plates to the overlay; main adds the draw time on ack. */
  sentWall?: number;
}

export class TimingTracker {
  private post: { t: number; capture: number } | null = null;
  private firstSeen: number | null = null;
  private firstSeenWall = 0;
  private firstFull: number | null = null;
  private read = 0;
  private trips: [number, number][] = []; // wall clock [start, end] of each text read
  private done = new Map<string, SetTiming>();

  /** A frame went to the worker; `captureMs` is how long ago the video presented that picture. */
  frameSent(now: number, captureMs: number) {
    this.post = { t: now, capture: Math.max(0, captureMs) };
  }
  /** One text read finished: it went out at `startWall` (Date.now clock) and came back `ms` later. */
  ocrTrip(startWall: number, ms: number) {
    this.trips.push([startWall, startWall + ms]);
    if (this.trips.length > 64) this.trips.shift();
  }
  /** Wall time in [from, to] covered by at least one read. */
  private ocrWithin(from: number, to: number) {
    const iv = this.trips
      .map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as [number, number])
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0]);
    let sum = 0,
      end = -Infinity;
    for (const [a, b] of iv) {
      if (b <= end) continue;
      sum += b - Math.max(a, end);
      end = b;
    }
    return sum;
  }
  /** A worker result: how many cards are present, whether all three are sure, whether it accepted a set, and whether
   *  an accepted set is still up (`live`): those frames belong to no new set, so they never start one. Without that a
   *  set that followed with no empty frame between (a seek, a quick pick) carried the old set's start and settle. */
  result(now: number, wall: number, present: number, sure: number, accepted: boolean, key: string, live = false) {
    if (!present || (live && !accepted)) {
      this.reset();
      return;
    }
    if (this.firstSeen === null) {
      const lag = this.post ? now - this.post.t : 0;
      this.firstSeen = now - lag - (this.post?.capture ?? 0);
      this.firstSeenWall = wall - lag - (this.post?.capture ?? 0);
    }
    if (this.post) this.read += Math.max(0, now - this.post.t);
    if (sure >= 3 && this.firstFull === null) this.firstFull = now;
    if (!accepted) return;
    this.done.set(key, {
      setKey: key,
      firstSeenWall: Math.round(this.firstSeenWall),
      capture: Math.round(this.post?.capture ?? 0),
      read: Math.round(this.read),
      ocr: Math.round(this.ocrWithin(this.firstSeenWall, wall)),
      settle: Math.round(Math.max(0, now - (this.firstFull ?? now))),
    });
    this.reset();
  }
  /** The timing recorded for an accepted set (kept so a later push of the same set finds it). */
  get(key: string): SetTiming | null {
    return this.done.get(key) ?? null;
  }
  private reset() {
    this.firstSeen = null;
    this.firstFull = null;
    this.read = 0;
  }
}
