import { describe, expect, it } from 'vitest';
import { BLACK_MS, initialBlack, stepBlack, type BlackState } from '../blackProbe';

const probe = (now: number, black = true, foreground = true, fullMonitor = true) =>
  ({ type: 'probe', now, black, foreground, fullMonitor }) as const;
const run = (s: BlackState, from: number, to: number, step = 250, ...rest: [boolean?, boolean?, boolean?]) => {
  for (let t = from; t <= to; t += step) s = stepBlack(s, probe(t, ...rest));
  return s;
};

describe('stepBlack', () => {
  it('3 black polls (the old rule) and a 5 s dark loading screen give no hint', () => {
    expect(run(initialBlack(), 0, 500).black).toBe(false);
    expect(run(initialBlack(), 0, 5000).black).toBe(false);
  });
  it('10 s of unbroken black shows the hint', () => {
    expect(run(initialBlack(), 0, BLACK_MS - 250).black).toBe(false);
    expect(run(initialBlack(), 0, BLACK_MS).black).toBe(true);
  });
  it('one non-black read starts the 10 s again', () => {
    let s = run(initialBlack(), 0, 8000);
    s = stepBlack(s, probe(8250, false));
    expect(run(s, 8500, 17_000).black).toBe(false);
    expect(run(s, 8500, 18_500).black).toBe(true);
  });
  it('counts only while foreground and filling the monitor', () => {
    expect(run(initialBlack(), 0, 20_000, 250, true, false, true).black).toBe(false);
    expect(run(initialBlack(), 0, 20_000, 250, true, true, false).black).toBe(false);
    let s = run(initialBlack(), 0, 6000);
    s = stepBlack(s, probe(6250, true, false));
    expect(run(s, 6500, 12_000).black).toBe(false);
  });
  it('a draft, round or loading read or a capture start clears the hint at once', () => {
    const s = run(initialBlack(), 0, 12_000);
    expect(s.black).toBe(true);
    expect(stepBlack(s, { type: 'clear' })).toEqual(initialBlack());
  });
  it('takes a shorter window for the harness', () => {
    expect(run(initialBlack(), 0, 2000, 250, true, true, true).black).toBe(false);
    let s = initialBlack();
    for (let t = 0; t <= 2000; t += 250) s = stepBlack(s, probe(t), 2000);
    expect(s.black).toBe(true);
  });
});
