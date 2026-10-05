import type { WorkerIn, WorkerOut } from '../brawl/worker';
import type { PointsOcr } from './abilityPointsReader';

type TextRead = Awaited<ReturnType<PointsOcr>>;
const UNKNOWN: TextRead = { text: '', confidence: 0 };
const MAX_SOURCES = 16;

/** One in-flight HUD crop, with tip-scoped results for immutable ink. A timeout cancels its worker owner. */
export class AbilityPointsBridge {
  private epoch = 0;
  private sample = 0;
  private disposed = false;
  private send: (message: WorkerIn, transfer: ArrayBuffer[]) => void;
  private captureEpoch: number;
  private timeoutMs: number;
  private cache = new Map<string, TextRead>();
  private pending: {
    key: string;
    sample: number;
    epoch: number;
    promise: Promise<TextRead>;
    resolve: (value: TextRead) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(send: (message: WorkerIn, transfer: ArrayBuffer[]) => void, captureEpoch: number, timeoutMs = 1500) {
    this.send = send;
    this.captureEpoch = captureEpoch;
    this.timeoutMs = timeoutMs;
  }

  /** A new tip, draft reopening, or capture change invalidates every queued or completed crop. */
  reset() {
    this.cancel();
    this.cache.clear();
  }

  dispose() {
    this.reset();
    this.disposed = true;
  }

  private cancel() {
    this.send({ type: 'abilityPointsCancel', captureEpoch: this.captureEpoch, tipEpoch: this.epoch }, []);
    this.epoch++;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(UNKNOWN);
    }
  }

  private remember(key: string, value: TextRead) {
    this.cache.set(key, value);
    if (this.cache.size > MAX_SOURCES) this.cache.delete(this.cache.keys().next().value!);
  }

  request: PointsOcr = (glyph) => {
    if (this.disposed) return Promise.resolve(UNKNOWN);
    // The renderer supplies its thresholded ink crop, excluding scene motion and HUD background color.
    const pixels = glyph.data.slice();
    let ink = '';
    for (let index = 0; index < pixels.length; index += 4) ink += pixels[index] === 0 ? '1' : '0';
    const key = `${glyph.width}:${glyph.height}:${ink}`;
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    if (this.pending?.key === key) return this.pending.promise;
    if (this.pending) this.cancel();
    const sample = ++this.sample;
    const epoch = this.epoch;
    let resolve!: (value: TextRead) => void;
    const promise = new Promise<TextRead>((done) => {
      resolve = done;
    });
    const timer = setTimeout(() => {
      if (this.pending?.sample !== sample || this.pending.epoch !== epoch) return;
      this.remember(key, UNKNOWN);
      this.cancel();
    }, this.timeoutMs);
    this.pending = { key, sample, epoch, promise, resolve, timer };
    const buffer = pixels.buffer;
    this.send(
      {
        type: 'abilityPoints',
        captureEpoch: this.captureEpoch,
        tipEpoch: epoch,
        sample,
        width: glyph.width,
        height: glyph.height,
        buffer,
      },
      [buffer],
    );
    return promise;
  };

  receive(result: Extract<WorkerOut, { type: 'abilityPoints' }>) {
    const pending = this.pending;
    if (
      !pending ||
      result.captureEpoch !== this.captureEpoch ||
      result.tipEpoch !== this.epoch ||
      pending.epoch !== result.tipEpoch ||
      pending.sample !== result.sample
    )
      return;
    clearTimeout(pending.timer);
    this.pending = null;
    const digits = result.text.trim();
    const value =
      /^[0-9]{1,2}$/.test(digits) && Number(digits) <= 64 ? { text: digits, confidence: result.confidence } : UNKNOWN;
    this.remember(pending.key, value);
    pending.resolve(value);
  }
}
