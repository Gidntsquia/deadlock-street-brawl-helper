// Dev-only timing: `createPerf(enabled, tag)` returns a recorder that folds samples into one summary log line every
// `everyMs` (count / avg / max per name). Callers pass `import.meta.env.DEV` (renderer, worker) or "the Vite dev server
// is running" (Electron main), so a production build records nothing, starts no timer and logs nothing.
import { log } from './log';

export interface Perf {
  readonly enabled: boolean;
  /** Adds one sample (milliseconds, or any number) under `name`. */
  record(name: string, value: number): void;
  /** Runs `fn` and records how long it took under `name`. */
  time<T>(name: string, fn: () => T): T;
  /** Logs and clears what has been recorded so far (also runs on the timer). */
  flush(): void;
}

const NOOP: Perf = {
  enabled: false,
  record() {},
  time: (_name, fn) => fn(),
  flush() {},
};

export function createPerf(enabled: boolean, tag: string, everyMs = 10_000): Perf {
  if (!enabled) return NOOP;
  const stats = new Map<string, { n: number; total: number; max: number }>();
  let since = Date.now();
  const flush = () => {
    if (!stats.size) return;
    const out: Record<string, { n: number; avg: number; max: number }> = {};
    for (const [k, v] of stats) out[k] = { n: v.n, avg: round(v.total / v.n), max: round(v.max) };
    log(tag, 'info', 'perf', { seconds: round((Date.now() - since) / 1000), stats: out });
    stats.clear();
    since = Date.now();
  };
  const record = (name: string, value: number) => {
    const s = stats.get(name) ?? { n: 0, total: 0, max: 0 };
    s.n += 1;
    s.total += value;
    if (value > s.max) s.max = value;
    stats.set(name, s);
  };
  const timer = setInterval(flush, everyMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    enabled: true,
    record,
    time: (name, fn) => {
      const t0 = performance.now();
      try {
        return fn();
      } finally {
        record(name, performance.now() - t0);
      }
    },
    flush,
  };
}

const round = (x: number) => Math.round(x * 100) / 100;
