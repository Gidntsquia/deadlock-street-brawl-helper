// Matches an advised set to a hand-labelled set of the OBS recording (scripts/video-truth/labels.json) so the live
// overlay can print milliseconds from the label's `appear` and main can log `video.advice` rows. Pure.

export interface LabelSet {
  draft: string;
  items: string[];
  from: number;
  to: number;
  appear?: number;
}
export interface LabelFile {
  video: string;
  stretches: { id: string; video: [number, number]; sets: LabelSet[] }[];
}

/** The stretch whose padded `video` range holds `videoAt`, or null. */
export function stretchAt(labels: LabelFile | null, videoAt: number): string | null {
  const st = labels?.stretches.find(
    (s) => videoAt >= s.video[0] - STRETCH_PAD_S && videoAt <= s.video[1] + STRETCH_PAD_S,
  );
  return st?.id ?? null;
}
export interface LabelMatch {
  stretch: string;
  draft: string;
  appearAt: number;
}

/** A label's stretch is only searched while the video plays inside its `video` range, padded this much each side. */
export const STRETCH_PAD_S = 1;

/** The labelled set whose items equal the advised names (a `?` slot may be missing: at least two must match) and whose
 *  time is nearest `videoAt`, searched only in the stretch whose padded `video` range holds `videoAt` (a looped or
 *  skipped-to video never matches a set of another stretch); null when the playing file is not the labelled recording,
 *  `videoAt` lies in no stretch, or nothing matches. */
export function matchLabel(
  labels: LabelFile | null,
  file: string,
  names: string[],
  videoAt: number,
): LabelMatch | null {
  if (!labels || file !== labels.video) return null;
  let best: { m: LabelMatch; d: number } | null = null;
  for (const st of labels.stretches) {
    if (videoAt < st.video[0] - STRETCH_PAD_S || videoAt > st.video[1] + STRETCH_PAD_S) continue;
    for (const s of st.sets) {
      if (s.appear == null) continue;
      const same = names.filter((n) => s.items.includes(n)).length;
      if (same < 2 || same < names.length) continue;
      const d = videoAt < s.from ? s.from - videoAt : Math.max(0, videoAt - s.to);
      if (!best || d < best.d) best = { m: { stretch: st.id, draft: s.draft, appearAt: s.appear }, d };
    }
  }
  return best?.m ?? null;
}

/** The text added to every plate: `1234 ms`, or `~1234 ms` when no label gave a start mark. */
export function msLabel(ms: number, approx: boolean): string {
  return `${approx ? '~' : ''}${Math.max(0, Math.round(ms))} ms`;
}
