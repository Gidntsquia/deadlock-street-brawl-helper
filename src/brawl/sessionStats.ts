// What a draft looked like from the worker's side, frame by frame: used live (the page logs it into the session) and by
// `brawl:replay`, so both count the same things.

/** One worker result on a draft frame. `items` are the three slots' item ids, 0 for an unread or `?` card. */
export interface StatFrame {
  t: number; // ms
  shop: boolean; // the draft screen is on this frame
  live: boolean; // advice stands (the accepted set is on screen)
  accepted: boolean; // the set was newly accepted on this frame
  picked: boolean;
  spent: boolean;
  round: number;
  choice: number;
  items: number[];
  unsure: number; // `?` slots in the reads
  tiers: number[];
}

export interface DraftStats {
  items: number[]; // what was shown first (0: `?`)
  unsure: number;
  adviceMs: number | null; // first draft frame to first plates
  changes: number; // frames on which a live set differed from what was first drawn
  dropouts: number; // times the plates went away while the same cards were still up
  fallback: boolean; // the first plates carried a `?`
}

const sig = (f: StatFrame) => f.items.map((id, i) => `${id}/${f.tiers[i] ?? 0}`).join(',');

export function analyseDraft(frames: StatFrame[]): DraftStats {
  const first = frames.find((f) => f.shop);
  const start = frames.find((f) => f.accepted);
  const out: DraftStats = {
    items: start?.items ?? [],
    unsure: start?.unsure ?? 0,
    adviceMs: first && start ? start.t - first.t : null,
    changes: 0,
    dropouts: 0,
    fallback: !!start && start.unsure > 0,
  };
  let shown: StatFrame | null = null,
    drawn = '',
    wasLive = false;
  for (const f of frames) {
    if (f.accepted) {
      shown = f;
      drawn = sig(f);
    } else if (f.live && shown && sig(f) !== drawn) {
      // a `?` slot may turn into a real plate once (spec 4); a sure plate that moves is a change
      const s0 = shown;
      if (f.items.some((id, i) => s0.items[i] !== 0 && (id !== s0.items[i] || f.tiers[i] !== s0.tiers[i])))
        out.changes++;
      else {
        shown = f;
        drawn = sig(f);
      }
    }
    if (wasLive && !f.live && shown && f.shop && !f.picked && !f.spent) {
      const ids = shown.items.filter((id) => id);
      const same = f.round === shown.round && f.choice === shown.choice;
      const reads = f.items.filter((id) => id);
      if (same && reads.every((id) => ids.includes(id))) out.dropouts++;
    }
    wasLive = f.live;
  }
  return out;
}
