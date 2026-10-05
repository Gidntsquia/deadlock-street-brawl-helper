import { describe, it, expect, vi } from 'vitest';
import { refreshCardMarkers } from '../settledCardMarkers';
import type { CardRead, RGBImage, CardMarkers } from '../../brawl/recognise';
const img: RGBImage = { width: 2560, height: 1440, channels: 4, data: new Uint8Array(0) };
const reads = [1, 2, 3].map((itemId) => ({
  itemId,
  present: true,
  rare: false,
  enhanced: false,
  match: { itemId, x: 10, y: 20, edge: 30 },
})) as CardRead[];
describe('late modifiers for one accepted source', () => {
  it('adds late flags, retains them under hover and preserves original icon evidence', () => {
    const marker = vi.fn(() => ({ rare: false, enhanced: true }) as CardMarkers);
    const added = refreshCardMarkers(img, reads, [true, true, true], marker);
    expect(added.changed).toBe(true);
    expect(added.reads[1]!.enhanced).toBe(true);
    expect(added.reads[1]!.match).toBe(reads[1]!.match);
    marker.mockReturnValue({ rare: false, enhanced: false } as CardMarkers);
    const hidden = refreshCardMarkers(img, added.reads, [true, true, true], marker);
    expect(hidden.changed).toBe(false);
    expect(hidden.reads).toBe(added.reads);
    const nextOffer = refreshCardMarkers(img, reads, [true, true, true], marker);
    expect(nextOffer.reads.every((r) => !r.enhanced)).toBe(true);
  });
  it('does not attach flags from a foreign or animating source', () => {
    const marker = vi.fn(() => ({ rare: true, enhanced: true }) as CardMarkers);
    const result = refreshCardMarkers(img, reads, [false, true, false], marker);
    expect(result.reads.map((r) => r.rare)).toEqual([false, true, false]);
    expect(marker).toHaveBeenCalledTimes(1);
  });
});
