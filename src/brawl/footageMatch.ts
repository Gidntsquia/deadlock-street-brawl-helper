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
export interface LabelMatch {
  stretch: string;
  draft: string;
  appearAt: number;
}

/** The labelled set whose items equal the advised names (a `?` slot may be missing: at least two must match) and whose
 *  time is nearest `videoAt`; null when the playing file is not the labelled recording or nothing matches. */
export function matchLabel(
  labels: LabelFile | null,
  file: string,
  names: string[],
  videoAt: number,
): LabelMatch | null {
  if (!labels || file !== labels.video) return null;
  let best: { m: LabelMatch; d: number } | null = null;
  for (const st of labels.stretches)
    for (const s of st.sets) {
      if (s.appear == null) continue;
      const same = names.filter((n) => s.items.includes(n)).length;
      if (same < 2 || same < names.length) continue;
      const d = videoAt < s.from ? s.from - videoAt : Math.max(0, videoAt - s.to);
      if (!best || d < best.d) best = { m: { stretch: st.id, draft: s.draft, appearAt: s.appear }, d };
    }
  return best && best.d <= 15 ? best.m : null;
}

/** The text added to every plate: `1234 ms`, or `~1234 ms` when no label gave a start mark. */
export function msLabel(ms: number, approx: boolean): string {
  return `${approx ? '~' : ''}${Math.max(0, Math.round(ms))} ms`;
}
