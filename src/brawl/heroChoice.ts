// Which hero the advice uses. A hero is taken from the scoreboard only when that read is sure (the recogniser returns 0
// otherwise). A read that fails keeps the last sure hero of this match; with none, the hero picked in the window is used
// and the window says so.

export interface HeroChoice {
  heroId: number;
  source: 'read' | 'kept' | 'selected';
}

/** `read`: the sure scoreboard read (0: unread or unsure). `lastSure`: the last sure hero of this match (0: none).
 *  `selected`: the hero chosen in the window. */
export function chooseHero(read: number, lastSure: number, selected: number): HeroChoice {
  if (read) return { heroId: read, source: 'read' };
  if (lastSure) return { heroId: lastSure, source: 'kept' };
  return { heroId: selected, source: 'selected' };
}
