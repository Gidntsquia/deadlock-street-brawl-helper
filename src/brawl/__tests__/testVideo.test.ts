import { describe, expect, it } from 'vitest';
import { formatVideoTime, isTestVideoAction, seekTarget } from '../testVideo';

describe('test mode video helpers', () => {
  it('accepts only known actions', () => {
    expect(isTestVideoAction({ type: 'open' })).toBe(true);
    expect(isTestVideoAction({ type: 'pause' })).toBe(true);
    expect(isTestVideoAction({ type: 'seek', to: 12.5 })).toBe(true);
    expect(isTestVideoAction({ type: 'seek', to: Number.NaN })).toBe(false);
    expect(isTestVideoAction({ type: 'seek' })).toBe(false);
    expect(isTestVideoAction({ type: 'delete' })).toBe(false);
    expect(isTestVideoAction('open')).toBe(false);
    expect(isTestVideoAction(null)).toBe(false);
  });
  it('clamps seeks into the video', () => {
    expect(seekTarget(-5, 100)).toBe(0);
    expect(seekTarget(150, 100)).toBe(100);
    expect(seekTarget(42.12345, 100)).toBe(42.123);
    expect(seekTarget(500, 0)).toBe(500);
  });
  it('formats times', () => {
    expect(formatVideoTime(0)).toBe('0:00');
    expect(formatVideoTime(65.9)).toBe('1:05');
    expect(formatVideoTime(3092.4)).toBe('51:32');
    expect(formatVideoTime(3725)).toBe('1:02:05');
    expect(formatVideoTime(Number.NaN)).toBe('0:00');
  });
});
