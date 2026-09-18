import { describe, expect, it } from 'vitest';
import { isGameWindowTitle } from '../gameWindow';

describe('isGameWindowTitle', () => {
  it('matches the game window exactly, not the app control window', () => {
    expect(isGameWindowTitle('Deadlock', 'Deadlock')).toBe(true);
    expect(isGameWindowTitle('Deadlock Street Brawl Helper', 'Deadlock')).toBe(false);
    expect(isGameWindowTitle(' deadlock ', 'Deadlock')).toBe(true);
  });
});
