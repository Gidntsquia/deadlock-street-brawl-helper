// Structured logging: one JSON line per call via console[level]. `debug` is suppressed unless opted
// into (localStorage.brawlDebug === '1' in the browser, BRAWL_DEBUG=1 in Node), so normal play stays quiet.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function debugEnabled(): boolean {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem('brawlDebug') === '1';
  } catch {
    /* localStorage unavailable (private mode, SSR): fall through to the env check */
  }
  try {
    if (typeof process !== 'undefined') return process.env?.BRAWL_DEBUG === '1';
  } catch {
    /* no process (browser without a bundler shim) */
  }
  return false;
}

export function log(tag: string, level: LogLevel, msg: string, data?: object): void {
  if (level === 'debug' && !debugEnabled()) return;
  const line = { tag, level, msg, ...data };
  console[level](JSON.stringify(line));
}
