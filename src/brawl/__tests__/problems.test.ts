import { describe, expect, it } from 'vitest';
import { PROBLEM_TEXT, firstRunLines, problemFor, statusFor, type Env } from '../problems';

const ok: Env = {
  found: true,
  width: 1920,
  height: 1080,
  borderless: true,
  black: false,
  denied: false,
  f8InUse: false,
};

describe('problems', () => {
  it('finds each of the four problems and gives its sentence', () => {
    expect(problemFor(ok)).toBeNull();
    expect(problemFor({ ...ok, black: true })).toBe('fullscreen');
    expect(problemFor({ ...ok, width: 1024, height: 576 })).toBe('small');
    expect(problemFor({ ...ok, denied: true })).toBe('denied');
    expect(problemFor({ ...ok, f8InUse: true })).toBe('f8');
  });
  it('writes each as one short sentence with the fix, without banned symbols', () => {
    for (const t of Object.values(PROBLEM_TEXT)) {
      expect(t.split('. ').length).toBeLessThanOrEqual(2);
      expect(t).not.toMatch(/[!—→·]/);
    }
    expect(PROBLEM_TEXT.fullscreen).toContain('Borderless Windowed');
    expect(PROBLEM_TEXT.f8).toContain('F8');
  });
  it('maps state to the four status sentences', () => {
    expect(statusFor({ found: false, draft: false, advising: false })).toBe('Waiting for Deadlock');
    expect(statusFor({ found: true, draft: false, advising: false })).toBe('Ready. Open a Street Brawl draft');
    expect(statusFor({ found: true, draft: true, advising: false })).toBe('Reading');
    expect(statusFor({ found: true, draft: true, advising: true })).toBe('Advising');
  });
  it('has three first-run lines, with no tick where borderless cannot be told', () => {
    expect(firstRunLines(ok).map((l) => l.ok)).toEqual([true, true, true]);
    expect(firstRunLines({ ...ok, borderless: null })[1]!.ok).toBeNull();
    expect(firstRunLines({ ...ok, found: false }).map((l) => l.ok)).toEqual([false, false, false]);
  });
});
