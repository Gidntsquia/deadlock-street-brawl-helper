// Confirmed problems that stop the app from working, each one plain sentence with the fix, and the four
// status sentences the window shows. Pure, so main, the window and the tests share one source of wording.

export type Problem = 'small' | 'denied' | 'f8';

export const PROBLEM_TEXT: Record<Problem, string> = {
  small: 'The Deadlock window is too small to read. Make it at least 1280 by 720.',
  denied: 'Windows blocked the screen capture. Restart this app, then open the draft again.',
  f8: 'F8 is taken by another program. Close that program, or read from the tray menu.',
};

/** The smallest game window the recogniser reads reliably. */
export const MIN_READ_WIDTH = 1280;
export const MIN_READ_HEIGHT = 720;
export const readableSize = (w: number, h: number) => w >= MIN_READ_WIDTH && h >= MIN_READ_HEIGHT;

export interface Env {
  found: boolean;
  width: number;
  height: number;
  /** The window has no title bar; this alone cannot distinguish borderless from exclusive fullscreen. */
  borderless: boolean | null;
  /** Legacy scene-probe observation. Dark pixels cannot establish display mode or capture failure. */
  black: boolean;
  denied: boolean;
  f8InUse: boolean;
}

/** The one problem to show, the most blocking first. */
export function problemFor(e: Env): Problem | null {
  if (e.found && e.width > 0 && !readableSize(e.width, e.height)) return 'small';
  if (e.denied) return 'denied';
  if (e.f8InUse) return 'f8';
  return null;
}

export const STATUS = {
  waiting: 'Waiting for Deadlock',
  ready: 'Ready. Open a Street Brawl draft',
  reading: 'Reading',
  advising: 'Advising',
} as const;
export type Status = (typeof STATUS)[keyof typeof STATUS];

export function statusFor(s: { found: boolean; draft: boolean; advising: boolean }): Status {
  if (!s.found) return STATUS.waiting;
  if (!s.draft) return STATUS.ready;
  return s.advising ? STATUS.advising : STATUS.reading;
}

/** The three lines of the first-run check. A tick is null when the line is an instruction that cannot be checked. */
export function firstRunLines(e: Env): { label: string; ok: boolean | null }[] {
  return [
    { label: 'Deadlock found', ok: e.found },
    {
      label: 'Borderless Windowed',
      ok: e.found && e.borderless === true ? true : e.borderless === null ? null : false,
    },
    { label: 'Resolution readable', ok: e.found ? readableSize(e.width, e.height) : false },
  ];
}
