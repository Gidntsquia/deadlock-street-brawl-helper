import { describe, expect, it } from 'vitest';
import { debugDefault, isPreRelease } from '../debugMode';

describe('debug mode default', () => {
  it('is on for a release candidate and in dev, off for a plain version', () => {
    expect(debugDefault('0.3.0-rc.1', false)).toBe(true);
    expect(debugDefault('0.3.0', true)).toBe(true);
    expect(debugDefault('0.3.0', false)).toBe(false);
    expect(isPreRelease('0.2.0')).toBe(false);
    expect(isPreRelease('0.3.0-rc.1')).toBe(true);
  });
});
