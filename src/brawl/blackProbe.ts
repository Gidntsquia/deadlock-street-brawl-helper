// When the first-run check may say "Capture reads black" (what an exclusive fullscreen game gives a screen read). A
// borderless game shows dark screens too (loading, lobby, a fade), which once gave borderless players the fullscreen
// verdict after 3 polls. Now the probe region must read black for `BLACK_MS` without a break, while the game is the
// foreground window and covers its whole monitor; any non-black read, any draft or round read and any capture that
// started clears it at once. Pure, so the rule is tested without Windows.

export const BLACK_MS = 10_000;

export interface BlackState {
  /** When the current unbroken black run began (ms), or null. */
  since: number | null;
  /** The hint is on. */
  black: boolean;
}

export const initialBlack = (): BlackState => ({ since: null, black: false });

export type BlackEvent =
  /** One probe read: `black` the region read solid black; `foreground` the game is the foreground window;
   *  `fullMonitor` its rect equals its monitor's rect (test mode's dummy passes true). */
  | { type: 'probe'; now: number; black: boolean; foreground: boolean; fullMonitor: boolean }
  /** A draft or round read, a loading-name read or a capture that started: the screen is not black to capture. */
  | { type: 'clear' };

export function stepBlack(s: BlackState, e: BlackEvent, ms = BLACK_MS): BlackState {
  if (e.type === 'clear' || !e.black || !e.foreground || !e.fullMonitor)
    return s.since === null && !s.black ? s : initialBlack();
  const since = s.since ?? e.now;
  const black = e.now - since >= ms;
  return since === s.since && black === s.black ? s : { since, black };
}
