// Every fixture made by `npm run brawl:fixture` is replayed through the real worker and must now read cleanly.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Item } from '../../src/types';
import type { FixtureExpect } from '../session-fixture';
import { replayDraft } from '../replay';

vi.setConfig({ testTimeout: 120_000 });
const root = path.join('scripts', 'fixtures', 'sessions');
const dirs = existsSync(root) ? readdirSync(root).sort() : [];
const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
const name = (id: number) => items.find((i) => i.id === id)?.name ?? `#${id}`;

describe('session fixtures', () => {
  it.each(dirs)('%s reads cleanly', async (d) => {
    const dir = path.join(root, d);
    const want: FixtureExpect = JSON.parse(readFileSync(path.join(dir, 'expect.json'), 'utf8'));
    const got = await replayDraft(dir);
    expect(got.stats.unsure).toBe(want.unsure);
    expect(got.stats.changes).toBe(want.changes);
    expect(got.stats.dropouts).toBe(want.dropouts);
    if (want.items) expect(got.stats.items.map(name)).toEqual(want.items);
    else expect(got.stats.items.every(Boolean)).toBe(true);
  });
  it('has the tooling to add them', () => {
    expect(existsSync(path.join('scripts', 'session-fixture.ts'))).toBe(true);
  });
});
