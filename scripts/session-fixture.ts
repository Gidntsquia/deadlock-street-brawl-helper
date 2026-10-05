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

if (process.argv[1] && path.basename(process.argv[1]) === 'session-fixture.ts') {
  const args = process.argv.slice(2);
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
