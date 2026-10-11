// Turns the drafts worth keeping from a recorded session into permanent test fixtures under
// scripts/fixtures/sessions/: every draft marked wrong, every draft that fell back to a `?`, every draft whose shown set
// changed. This is the only way fixtures are added; nothing under scripts/fixtures is edited by hand.
//
//   npm run brawl:fixture -- <session folder> [--items "d002=Item A,Item B,Item C"]
//
// `--items` states what the cards really were for a draft the player marked wrong; without it the fixture only demands a
// clean read (no `?`, no change, no drop-out), which the recogniser must reach for the test to pass.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DraftRecord } from '../electron/sessionStore';

export const FIXTURE_ROOT = path.join('scripts', 'fixtures', 'sessions');
export interface FixtureExpect {
  reason: string[];
  items?: string[]; // item names, in slot order
  /** The card the advice must take (item name), and whether a re-roll may be called: checked against the engine with
   *  the hero, enemies and owned items the replay read. */
  best?: string;
  reroll?: boolean;
  unsure: 0;
  changes: 0;
  dropouts: 0;
}

export function pickDrafts(folder: string) {
  const marks: Record<string, boolean> = existsSync(path.join(folder, 'marks.json'))
    ? JSON.parse(readFileSync(path.join(folder, 'marks.json'), 'utf8'))
    : {};
  const out: { dir: string; reason: string[] }[] = [];
  const dirs = readdirSync(folder)
    .filter((n) => /^d\d+$/.test(n))
    .sort();
  for (const [i, d] of dirs.entries()) {
    const rec: DraftRecord = JSON.parse(readFileSync(path.join(folder, d, 'draft.json'), 'utf8'));
    const reason = [
      marks[String(i + 1)] ? 'marked wrong' : '',
      rec.unsure > 0 || rec.fallback ? 'fallback' : '',
      rec.changes > 0 ? 'changed within set' : '',
    ].filter(Boolean);
    if (reason.length) out.push({ dir: d, reason });
  }
  return out;
}

export function makeFixtures(folder: string, items: Record<string, string[]> = {}, root = FIXTURE_ROOT): string[] {
  const made: string[] = [];
  const id = path.basename(folder);
  for (const { dir, reason } of pickDrafts(folder)) {
    const target = path.join(root, `${id}-${dir}`);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(folder, dir), target, { recursive: true });
    const expectation: FixtureExpect = {
      reason,
      unsure: 0,
      changes: 0,
      dropouts: 0,
      ...(items[dir] ? { items: items[dir] } : {}),
    };
    writeFileSync(path.join(target, 'expect.json'), JSON.stringify(expectation, null, 2) + '\n');
    made.push(target);
  }
  return made;
}

/** A fixture cut from a video-truth stretch (scripts/fixtures/video-truth/sN): the frames between `fromS` and `toS`
 *  video seconds, in the same format as a recorded session draft, so `session-fixtures.test.ts` replays it. */
export function fixtureFromStretch(
  stretch: string,
  fromS: number,
  toS: number,
  name: string,
  want: { round: number; choice: number; items: string[]; best?: string; reroll?: boolean },
  root = FIXTURE_ROOT,
): string {
  const truth = JSON.parse(readFileSync(path.join(stretch, 'truth.json'), 'utf8')) as { video: [number, number] };
  const all = JSON.parse(readFileSync(path.join(stretch, 'frames.json'), 'utf8')) as {
    t: number;
    regions: { file: string }[];
  }[];
  const live = JSON.parse(readFileSync(path.join(stretch, 'draft.json'), 'utf8')) as DraftRecord;
  const itemList = JSON.parse(readFileSync(path.join('public', 'data', 'items.json'), 'utf8')) as {
    id: number;
    name: string;
  }[];
  const idOf = (n: string) => itemList.find((i) => i.name === n)?.id ?? 0;
  const frames = all.filter((f) => {
    const v = truth.video[0] + f.t / 1000;
    return v >= fromS && v <= toS;
  });
  const target = path.join(root, name);
  mkdirSync(target, { recursive: true });
  for (const f of frames) for (const r of f.regions) cpSync(path.join(stretch, r.file), path.join(target, r.file));
  writeFileSync(path.join(target, 'frames.json'), JSON.stringify(frames) + '\n');
  const rec: DraftRecord = {
    ...live,
    round: want.round,
    choice: want.choice,
    items: want.items.map(idOf),
    unsure: 0,
    changes: 0,
    dropouts: 0,
    fallback: false,
  };
  writeFileSync(path.join(target, 'draft.json'), JSON.stringify(rec) + '\n');
  const expectation: FixtureExpect = {
    reason: [`cut from ${path.basename(stretch)} ${fromS}-${toS} s of the OBS recording`],
    items: want.items,
    ...(want.best !== undefined ? { best: want.best } : {}),
    ...(want.reroll !== undefined ? { reroll: want.reroll } : {}),
    unsure: 0,
    changes: 0,
    dropouts: 0,
  };
  writeFileSync(path.join(target, 'expect.json'), JSON.stringify(expectation, null, 2) + '\n');
  return target;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'session-fixture.ts') {
  const args = process.argv.slice(2);
  const flag = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // npm run brawl:fixture -- --stretch scripts/fixtures/video-truth/s7 --from 2501 --to 2511 --name s7-d023 \
  //   --round 2 --choice 3 --items "Burst Fire,Alchemical Fire,Rapid Recharge" --best "Burst Fire" --no-reroll
  const stretch = flag('stretch');
  if (stretch) {
    const made = fixtureFromStretch(stretch, Number(flag('from')), Number(flag('to')), flag('name') ?? 'stretch', {
      round: Number(flag('round')),
      choice: Number(flag('choice')),
      items: (flag('items') ?? '').split(',').map((x) => x.trim()),
      best: flag('best'),
      reroll: args.includes('--no-reroll') ? false : args.includes('--reroll') ? true : undefined,
    });
    console.log(`Added fixture ${made}`);
    process.exit(0);
  }
  const folder = args.find((a) => !a.startsWith('--'));
  if (!folder) {
    console.error('usage: npm run brawl:fixture -- <session folder> [--items "d002=A,B,C"]');
    process.exit(2);
  }
  const items: Record<string, string[]> = {};
  for (const [i, a] of args.entries())
    if (a === '--items') {
      const [d, list] = (args[i + 1] ?? '').split('=');
      if (d && list) items[d] = list.split(',').map((s) => s.trim());
    }
  const made = makeFixtures(folder, items);
  console.log(
    made.length
      ? `Added ${made.length} fixture(s):\n${made.join('\n')}`
      : 'Nothing to add: no marked, fallback or changed drafts.',
  );
}
