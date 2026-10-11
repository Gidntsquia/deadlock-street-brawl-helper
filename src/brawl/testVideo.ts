// Test mode video (manual check only): the dummy "Deadlock" window can play a video file the person picks, such as an
// OBS recording of a match, so the app can be watched working live on it. Nothing in tests, check, win:e2e, win:demo or
// CI plays a video; only the person's own button in the control window does.

/** What the control window shows about the video playing in the dummy window. */
export interface TestVideo {
  name: string; // file name only
  time: number; // seconds
  duration: number; // seconds, 0 until known
  playing: boolean;
  error: string | null;
}

export type TestVideoAction =
  { type: 'open' } | { type: 'close' } | { type: 'play' } | { type: 'pause' } | { type: 'seek'; to: number };

/** File types offered by the picker (what Chromium plays: H.264/VP9/AV1 in MKV, MP4, WebM). */
export const VIDEO_EXTENSIONS = ['mkv', 'mp4', 'webm', 'mov'] as const;

export function isTestVideoAction(a: unknown): a is TestVideoAction {
  if (!a || typeof a !== 'object') return false;
  const t = (a as { type?: unknown }).type;
  if (t === 'open' || t === 'close' || t === 'play' || t === 'pause') return true;
  return t === 'seek' && typeof (a as { to?: unknown }).to === 'number' && Number.isFinite((a as { to: number }).to);
}

/** A seek clamped into the video (0 when the length is not known yet, so it never seeks past the end). */
export function seekTarget(to: number, duration: number): number {
  if (!Number.isFinite(to) || to < 0) return 0;
  if (duration > 0 && to > duration) return duration;
  return Math.round(to * 1000) / 1000;
}

/** `m:ss` or `h:mm:ss`. */
export function formatVideoTime(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
