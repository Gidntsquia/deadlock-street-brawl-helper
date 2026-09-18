import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards against a future data refresh silently dropping ability_order_stats for a hero: the advice
// pipeline's ability-order feature (item 6) depends on every per-hero analytics file having it.
const DATA_DIR = path.join(__dirname, '..', '..', 'public', 'data', 'analytics', 'brawl');

describe('ability_order_stats data completeness', () => {
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json') && f !== 'tier-list.json');

  it('found per-hero analytics files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s has non-empty ability_order_stats', (file) => {
    const data = JSON.parse(readFileSync(path.join(DATA_DIR, file), 'utf-8'));
    expect(Array.isArray(data.ability_order_stats)).toBe(true);
    expect(data.ability_order_stats.length).toBeGreaterThan(0);
  });
});
