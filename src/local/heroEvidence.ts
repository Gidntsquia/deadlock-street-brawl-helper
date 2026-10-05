import { chooseHero } from '../brawl/heroChoice';

/** Loading names identify a hero, never a player slot or team. Bind them only to a confirmed match. */
export class HeroEvidence {
  generation = 0;
  private active = false;
  private lastSure = 0;
  private loading: { id: number; at: number; generation: number } | null = null;
  private pendingLoading: { id: number; at: number } | null = null;

  observeLoading(id: number, now: number) {
    if (this.active) this.pendingLoading = { id, at: now };
    else this.loading = { id, at: now, generation: this.generation };
    return this.active ? 0 : id;
  }

  confirmNewMatch(now: number) {
    if (this.active) this.generation++;
    const loading = this.active ? this.pendingLoading : this.loading;
    this.active = true;
    this.lastSure = 0;
    this.loading = loading && now - loading.at < 60 * 60_000 ? { ...loading, generation: this.generation } : null;
    this.pendingLoading = null;
  }

  resolve(portrait: number, selected: number, pinned: boolean, now: number) {
    const loading = this.loading;
    const name = loading && loading.generation === this.generation && now - loading.at < 60 * 60_000 ? loading.id : 0;
    const read = name || portrait;
    if (read) this.lastSure = read;
    return pinned ? { heroId: selected, source: 'selected' as const } : chooseHero(read, this.lastSure, selected);
  }
}
