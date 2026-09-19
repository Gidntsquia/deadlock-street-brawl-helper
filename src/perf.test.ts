import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPerf } from './perf';

afterEach(() => vi.restoreAllMocks());

describe('createPerf', () => {
  it('does nothing when disabled: no samples, no log, fn still runs', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const p = createPerf(false, 't');
    p.record('a', 5);
    expect(p.time('b', () => 7)).toBe(7);
    p.flush();
    expect(p.enabled).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('logs one summary with count, average and max, then clears', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const p = createPerf(true, 't', 60_000);
    p.record('a', 2);
    p.record('a', 6);
    p.flush();
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ tag: 't', msg: 'perf', stats: { a: { n: 2, avg: 4, max: 6 } } });
    p.flush();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
