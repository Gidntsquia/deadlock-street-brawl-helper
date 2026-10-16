// The hero the app uses, per labelled draft of both OBS recordings (R4): the loading-screen crops cut by
// `scripts/video-truth.ts --loading` (scripts/fixtures/loading/) are read with the name reader the way the page reads
// the probe's crop, the portrait is read from the video-truth bar crops the way the worker reads it, and both go through
// the app's own `HeroTracker` in recording time order. Recording 1 starts mid-match (match A, s0..s2: round 3, no loading
// screen), so match A can only be a portrait guess; every other match has its loading screen and uses it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeIconIndex, loadingNameRect, looksLikeLoadingName, readDraftMeta } from '../../src/brawl';
import { HeroTracker, type HeroChoice } from '../../src/brawl/heroChoice';
import { readHeroName } from '../../src/brawl/ocr';
import { matchHeroName, nameList } from '../../src/brawl/names';
import { installTextReader, stopLiveReader } from '../lib/textReader';

installTextReader();
afterAll(() => stopLiveReader());

const heroes = JSON.parse(readFileSync('public/data/heroes.json', 'utf8')) as { id: number; name: string }[];
const heroId = (name: string) => heroes.find((h) => h.name === name)!.id;
const heroName = (id: number) => heroes.find((h) => h.id === id)?.name ?? String(id);
const roster = nameList(
  heroes.map((h) => h.id),
  Object.fromEntries(heroes.map((h) => [h.id, h.name])),
);
const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
/** The hero picked in the app's window: not Infernus, so a draft that falls back to it shows up. */
const SELECTED = heroId('Kelvin');

interface Stretch {
  id: string;
  file: string;
  video: [number, number];
  hero: string;
  match: string;
  sets: { draft: string; round: number; choice: number; from: number; readable?: [number, number] }[];
}
const labels = JSON.parse(readFileSync('scripts/video-truth/labels.json', 'utf8')) as { stretches: Stretch[] };
const loadingFixtures = JSON.parse(readFileSync('scripts/fixtures/loading/expect.json', 'utf8')) as Record<
  string,
  { file: string; recording: string; t: number; hero: string; match: string }
>;

/** The probe's crop of a loading frame: `loadingNameRect` of the full frame, RGBA. */
async function loadingCrop(file: string) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const r = loadingNameRect(info.width, info.height);
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++)
    out.set(
      data.subarray(((r.y + y) * info.width + r.x) * 4, ((r.y + y) * info.width + r.x + r.width) * 4),
      y * r.width * 4,
    );
  return { width: r.width, height: r.height, data: out, channels: 4 as const };
}

/** What the page does with a loading crop: read, match to a roster name (0 when it does not match). */
async function loadingRead(file: string) {
  const crop = await loadingCrop(file);
  if (!looksLikeLoadingName(crop)) return { text: '', id: 0, probe: false };
  const text = await readHeroName(crop);
  return { text, id: matchHeroName(text, roster)?.itemId ?? 0, probe: true };
}

/** The frame the worker sees at video-truth frame `fi` of a stretch: every region's latest copy pasted in. */
async function frameAt(dir: string, fi: number) {
  const frames = JSON.parse(readFileSync(path.join(dir, 'frames.json'), 'utf8')) as {
    t: number;
    regions: { index: number; x: number; y: number; width: number; height: number; file: string }[];
  }[];
  const W = 1280,
    H = 720;
  const data = new Uint8Array(W * H * 3);
  const latest = new Map<number, (typeof frames)[number]['regions'][number]>();
  for (let f = 0; f <= Math.min(fi, frames.length - 1); f++) for (const r of frames[f]!.regions) latest.set(r.index, r);
  for (const r of latest.values()) {
    const { data: px, info } = await sharp(path.join(dir, r.file))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let y = 0; y < info.height; y++)
      data.set(px.subarray(y * info.width * 3, (y + 1) * info.width * 3), ((r.y + y) * W + r.x) * 3);
  }
  return { width: W, height: H, data, channels: 3 as const };
}

/** A set's first readable moment in recording seconds (its `from` when the label has no readable window). */
const seenAt = (set: Stretch['sets'][number]) => set.readable?.[0] ?? set.from;

/** The worker's portrait read (`readDraftMeta`, lean, as in worker.ts) on a labelled set's first readable frame. */
async function portraitAt(st: Stretch, set: Stretch['sets'][number]) {
  const img = await frameAt(
    path.join('scripts/fixtures/video-truth', st.id),
    Math.round((seenAt(set) - st.video[0]) * 4),
  );
  return readDraftMeta(img, index, undefined, true).self;
}

interface Row {
  stretch: string;
  match: string;
  draft: string;
  round: number;
  choice: number;
  portrait: string;
  used: string;
  source: HeroChoice['source'];
  guessed: boolean;
}

/** One recording replayed in time order: loading reads and drafts into one HeroTracker. `loadingOverride` replaces a
 *  stretch's loading read with another read text (the match-switch case). */
async function replay(recording: string, loadingOverride: Record<string, string | null> = {}) {
  const tracker = new HeroTracker();
  type Ev = { t: number; run: () => Promise<Row | null> };
  const evs: Ev[] = [];
  for (const [id, fx] of Object.entries(loadingFixtures)) {
    if (fx.recording !== recording) continue;
    evs.push({
      t: fx.t,
      run: async () => {
        const over = loadingOverride[id];
        if (over === null) return null; // this loading read failed
        const read =
          over !== undefined
            ? { id: matchHeroName(over, roster)?.itemId ?? 0 }
            : await loadingRead(path.join('scripts/fixtures/loading', fx.file));
        tracker.onLoading(read.id, fx.t * 1000);
        return null;
      },
    });
  }
  for (const st of labels.stretches.filter((s) => s.file === recording))
    for (const set of st.sets) {
      const t = seenAt(set); // label times are recording seconds
      evs.push({
        t,
        run: async () => {
          const portrait = await portraitAt(st, set);
          const pick = tracker.onDraft(
            { round: set.round, choice: set.choice, portrait, pinned: false, selected: SELECTED },
            t * 1000,
          );
          return {
            stretch: st.id,
            match: st.match,
            draft: set.draft,
            round: set.round,
            choice: set.choice,
            portrait: portrait ? heroName(portrait) : '-',
            used: heroName(pick.heroId),
            source: pick.source,
            guessed: pick.guessed,
          };
        },
      });
    }
  evs.sort((a, b) => a.t - b.t);
  const rows: Row[] = [];
  for (const e of evs) {
    const r = await e.run();
    if (r) rows.push(r);
  }
  return rows;
}

const REC1 = '2026-10-09 00-46-30.mkv',
  REC2 = '2026-10-15 15-04-37.mkv';
const NO_LOADING_SCREEN = new Set(['A']); // recording 1 starts in round 3 of match A

describe('loading-screen fixtures', () => {
  it.each(Object.entries(loadingFixtures))(
    '%s reads its labelled hero',
    async (_id, fx) => {
      const r = await loadingRead(path.join('scripts/fixtures/loading', fx.file));
      expect(r.probe).toBe(true);
      expect(heroName(r.id)).toBe(fx.hero);
    },
    60_000,
  );
});

describe('hero used per labelled draft, both recordings', () => {
  for (const rec of [REC1, REC2]) {
    it(`${rec}: Infernus for every draft, from the loading screen wherever the match has one`, async () => {
      const rows = await replay(rec);
      // the list the plan asks for: one line per labelled draft
      console.log(
        rows
          .map(
            (r) =>
              `${r.stretch} ${r.match} ${r.draft} r${r.round}c${r.choice} portrait=${r.portrait} hero=${r.used} source=${r.source}${r.guessed ? ' (guessed)' : ''}`,
          )
          .join('\n'),
      );
      const stretches = labels.stretches.filter((s) => s.file === rec);
      expect(new Set(rows.map((r) => r.stretch))).toEqual(new Set(stretches.map((s) => s.id)));
      for (const r of rows) {
        expect(r.used, `${r.stretch} ${r.draft}`).toBe('Infernus');
        if (NO_LOADING_SCREEN.has(r.match)) {
          expect(['portrait', 'kept'], `${r.stretch} ${r.draft}`).toContain(r.source);
          expect(r.guessed).toBe(true);
        } else expect(r.source, `${r.stretch} ${r.draft}`).toBe('loading');
      }
      expect(rows.some((r) => r.used === 'Viscous')).toBe(false);
    }, 180_000);
  }
});

describe('match switch', () => {
  it('two matches with different loading names: the hero changes at the second loading screen', async () => {
    // match B keeps its real Infernus loading crop; match C's loading screen says Graves (a read text, as the reader
    // would return it). The portraits still read Infernus in C: the loading name wins.
    const rows = await replay(REC1, { s6: 'GRAVES' });
    for (const r of rows.filter((x) => x.match === 'B')) expect([r.used, r.source]).toEqual(['Infernus', 'loading']);
    const c = rows.filter((x) => x.match === 'C');
    expect(c.length).toBeGreaterThan(0);
    for (const r of c) expect([r.stretch, r.used, r.source]).toEqual([r.stretch, 'Graves', 'loading']);
  }, 180_000);

  it("a missed loading read in the next match never carries the last match's hero", async () => {
    // match B read Kelvin at its loading screen (the friend's case); match C's loading read fails: C is a portrait
    // guess (Infernus), not Kelvin
    const rows = await replay(REC1, { s3: 'KELVIN', s6: null });
    for (const r of rows.filter((x) => x.match === 'B')) expect(r.used).toBe('Kelvin');
    for (const r of rows.filter((x) => x.match === 'C')) expect([r.used, r.guessed]).toEqual(['Infernus', true]);
  }, 180_000);
});

// R5, the Viscous class: the user's Viscous misread was in a release run nobody recorded (see plans/WORKER_NOTES.md),
// so this is the nearest recorded case: at s12 t=691 s the portrait reader takes an enemy (McGinnis, on the right side)
// for the player. Without a loading name that read would be a guess, and the app says so; with one it does not matter.
describe('hero misread fixtures (Viscous class)', () => {
  const misreads = JSON.parse(readFileSync('scripts/fixtures/hero-misread/expect.json', 'utf8')) as Record<
    string,
    { file: string; stretch: string; t: number; read: string; hero: string }
  >;
  it.each(Object.entries(misreads))(
    '%s: the enemy read as self shows the guess sign; a loading name overrides it',
    async (_n, m) => {
      const { data, info } = await sharp(path.join('scripts/fixtures/hero-misread', m.file))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const meta = readDraftMeta({ width: info.width, height: info.height, data, channels: 3 }, index, undefined, true);
      expect(heroName(meta.self)).toBe(m.read); // the misread this fixture pins
      expect(meta.bar.right.some((h) => h.heroId === meta.self)).toBe(true); // it is an enemy tile
      const set = labels.stretches.find((s) => s.id === m.stretch)!.sets[0]!;
      const draft = { round: set.round, choice: set.choice, portrait: meta.self, pinned: false, selected: SELECTED };
      // no loading name this match: a guess (the status line, the badge and the overlay note show it)
      const guess = new HeroTracker().onDraft(draft, m.t * 1000);
      expect(guess).toEqual({ heroId: meta.self, source: 'portrait', guessed: true });
      // the match's loading screen named the player's hero: that holds
      const t = new HeroTracker();
      t.onLoading(heroId(m.hero), (m.t - 600) * 1000);
      expect(t.onDraft(draft, m.t * 1000)).toEqual({ heroId: heroId(m.hero), source: 'loading', guessed: false });
    },
  );
});
