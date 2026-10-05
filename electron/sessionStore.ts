// Debug-mode recording: the last few matches, what the recogniser read (region crops only) and what the overlay showed,
// one folder per match under `userData/sessions/`. Plain files, so `brawl:replay` and the fixture tool read them without
// the app. Nothing here touches the screen: the page hands over crops it already cut for the worker.
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const KEEP_MATCHES = 3;
export const CAP_BYTES = 300 * 1024 * 1024;

export interface RegionShot {
  index: number; // position in draftRegions()
  x: number;
  y: number;
  width: number;
  height: number;
  rgba: Uint8Array;
}
export interface FrameShot {
  t: number; // ms on the page's clock
  regions: RegionShot[];
}
export interface ShownPlate {
  itemId: number; // 0: a `?` plate
  tier: number;
  score: number | null;
}
export interface DraftRecord {
  round: number;
  choice: number;
  startedAt: number; // wall clock ms
  frameW: number;
  frameH: number;
  items: number[]; // item ids read at the first plates, 0 for `?`
  unsure: number;
  hero: { id: number; source: 'read' | 'kept' | 'selected' | 'none' };
  shown: { plates: ShownPlate[]; takeId: number | null; reroll: boolean };
  adviceMs: number | null;
  changes: number;
  dropouts: number;
  fallback: boolean;
}
export interface DraftRow extends DraftRecord {
  n: number;
  wrong: boolean;
  /** Data URLs of the three card crops (the first frame that has them). */
  crops: string[];
}
export interface SessionSummary {
  id: string;
  drafts: DraftRow[];
}

type Encode = (r: RegionShot) => Buffer | Promise<Buffer>;
const step = (r: { round: number; choice: number }) => (r.round - 1) * 3 + r.choice;
const pad = (n: number) => String(n).padStart(3, '0');
const readJson = async <T>(file: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export class SessionStore {
  /** Recording happens only while debug mode is on; off, every call below does nothing and no file is made. */
  enabled = false;
  private pending: FrameShot[] = [];
  private current: { id: string; drafts: number; lastStep: number } | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly encode: Encode,
    private readonly opts: { keep?: number; capBytes?: number } = {},
  ) {}

  /** A frame of the draft that is up now; kept in memory until `finishDraft`. */
  addFrame(frame: FrameShot) {
    if (!this.enabled) return;
    this.pending.push(frame);
  }
  /** Drops the frames of a draft that is not going to be recorded. */
  discard() {
    this.pending = [];
  }
  /** The game window was lost: the next draft starts a new match. */
  endMatch() {
    this.current = null;
  }

  /** Writes the draft, with the frames added since the last one, into the current match (a new one at round 1 choice 1). */
  finishDraft(rec: DraftRecord): Promise<{ matchId: string; n: number } | null> {
    if (!this.enabled) return Promise.resolve(null);
    const frames = this.pending;
    this.pending = [];
    const run = this.chain.then(() => this.write(rec, frames));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async write(rec: DraftRecord, frames: FrameShot[]) {
    const fresh = !this.current || (rec.round === 1 && rec.choice === 1 && this.current.lastStep > 1);
    if (fresh) {
      const id = `m-${new Date(rec.startedAt).toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${Math.random().toString(36).slice(2, 6)}`;
      this.current = { id, drafts: 0, lastStep: 0 };
      await mkdir(path.join(this.dir, id), { recursive: true });
      await writeFile(
        path.join(this.dir, id, 'session.json'),
        JSON.stringify({ version: 1, startedAt: rec.startedAt }),
      );
    }
    const cur = this.current!;
    cur.drafts++;
    cur.lastStep = Math.max(cur.lastStep, rec.round > 0 ? step(rec) : 0);
    const n = cur.drafts;
    const dd = path.join(this.dir, cur.id, `d${pad(n)}`);
    await mkdir(dd, { recursive: true });
    const index: { t: number; regions: (Omit<RegionShot, 'rgba'> & { file: string })[] }[] = [];
    for (const [k, f] of frames.entries()) {
      const regions = [];
      for (const r of f.regions) {
        const file = `f${k}-r${r.index}.png`;
        await writeFile(path.join(dd, file), await this.encode(r));
        regions.push({ index: r.index, x: r.x, y: r.y, width: r.width, height: r.height, file });
      }
      index.push({ t: f.t, regions });
    }
    await writeFile(path.join(dd, 'frames.json'), JSON.stringify(index));
    await writeFile(path.join(dd, 'draft.json'), JSON.stringify(rec));
    if (fresh) await this.prune();
    return { matchId: cur.id, n };
  }

  /** Deletes the oldest matches beyond the count and the size cap. The match being recorded is never deleted. */
  async prune() {
    const keep = this.opts.keep ?? KEEP_MATCHES,
      cap = this.opts.capBytes ?? CAP_BYTES;
    const ids = (await this.ids()).filter((id) => id !== this.current?.id);
    const sizes = new Map<string, number>();
    for (const id of ids) sizes.set(id, await dirSize(path.join(this.dir, id)));
    let total =
      (this.current ? await dirSize(path.join(this.dir, this.current.id)) : 0) +
      [...sizes.values()].reduce((a, b) => a + b, 0);
    let count = ids.length + (this.current ? 1 : 0);
    for (const id of ids) {
      if (count <= keep && total <= cap) break;
      await rm(path.join(this.dir, id), { recursive: true, force: true });
      total -= sizes.get(id)!;
      count--;
    }
  }

  async ids(): Promise<string[]> {
    const all = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    return all
      .filter((e) => e.isDirectory() && e.name.startsWith('m-'))
      .map((e) => e.name)
      .sort();
  }

  async mark(matchId: string, n: number, wrong: boolean) {
    const file = path.join(this.dir, matchId, 'marks.json');
    const marks = await readJson<Record<string, boolean>>(file, {});
    if (wrong) marks[String(n)] = true;
    else delete marks[String(n)];
    await writeFile(file, JSON.stringify(marks));
  }

  /** Newest match first, each with its drafts in order and the card crops as data URLs. */
  async list(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    for (const id of (await this.ids()).reverse()) {
      const base = path.join(this.dir, id);
      const marks = await readJson<Record<string, boolean>>(path.join(base, 'marks.json'), {});
      const drafts: DraftRow[] = [];
      const names = (await readdir(base).catch(() => [])).filter((d) => /^d\d+$/.test(d)).sort();
      for (const d of names) {
        const rec = await readJson<DraftRecord | null>(path.join(base, d, 'draft.json'), null);
        if (!rec) continue;
        const n = Number(d.slice(1));
        drafts.push({ ...rec, n, wrong: !!marks[String(n)], crops: await this.crops(path.join(base, d)) });
      }
      out.push({ id, drafts });
    }
    return out;
  }

  private async crops(dd: string): Promise<string[]> {
    const index = await readJson<{ regions: { index: number; file: string }[] }[]>(path.join(dd, 'frames.json'), []);
    const out: string[] = [];
    for (const k of [0, 1, 2]) {
      // the last frame is the one the advice was made on
      for (const f of [...index].reverse()) {
        const r = f.regions.find((x) => x.index === k);
        if (!r) continue;
        const buf = await readFile(path.join(dd, r.file)).catch(() => null);
        if (buf) out.push(`data:image/png;base64,${buf.toString('base64')}`);
        break;
      }
    }
    return out;
  }
}
