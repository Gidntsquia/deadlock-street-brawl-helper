// @vitest-environment jsdom
import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAutoHero } from '../useAutoHero';
afterEach(cleanup);
describe('match-scoped manual hero selection', () => {
  it('allows detection over the saved starting value, but retains an explicit override through later corrections', () => {
    const select = vi.fn();
    const { result, rerender } = renderHook(() => useAutoHero(select));
    act(() => result.current.choose(67, 'detected'));
    act(() => result.current.choose(76, 'manual'));
    act(() => result.current.choose(67, 'detected'));
    rerender();
    expect(select.mock.calls.map((c) => c[0])).toEqual([67, 76]);
    expect(result.current.source).toBe('manual');
    act(() => result.current.newMatch(64));
    expect(select).toHaveBeenLastCalledWith(64);
    expect(result.current.source).toBe('detected');
  });
  it('explicit Auto releases the override to the newest confirmed evidence', () => {
    const select = vi.fn();
    const { result } = renderHook(() => useAutoHero(select));
    act(() => result.current.choose(67, 'detected'));
    act(() => result.current.choose(76, 'manual'));
    act(() => result.current.choose(64, 'detected'));
    expect(result.current.pinned).toBe(true);
    expect(select).toHaveBeenLastCalledWith(76);
    act(() => result.current.resumeAuto());
    expect(result.current.pinned).toBe(false);
    expect(select).toHaveBeenLastCalledWith(64);
  });
  it('preserves a manual selection made before first recognition and releases to the latest confirmed next-match hero', () => {
    const select = vi.fn();
    const { result } = renderHook(() => useAutoHero(select));
    act(() => result.current.choose(76));
    act(() => result.current.choose(67, 'detected'));
    expect(select).toHaveBeenCalledTimes(1);
    act(() => result.current.newMatch());
    expect(select).toHaveBeenLastCalledWith(67);
  });
});
