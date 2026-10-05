import {
  cardAnchors,
  cardNameCrop,
  cardSquares,
  readDraftSlot,
  readMarkers,
  type CardRead,
  type DecodedIndex,
  type RGBImage,
  type Region,
} from '../brawl/recognise';
import { readCardName, type NameCrop } from '../brawl/ocr';
import { cardNameRegions, hasItemNameInk, itemNameCrop, itemNameSoftCrop } from './cardNames';
import { readItemName } from './cardNameOcr';
import { matchCardName } from './cardNameMatch';
import type { CardNameSlotOutcome, CardNameConfirmationOutcome } from './cardNameConfirmation';

interface Job {
  outcome: CardNameSlotOutcome | null;
  retryAt: number;
  icon?: CardRead;
}
interface Source {
  scope: string;
  key: string;
  width: number;
  height: number;
  foreground: Uint8Array;
  visual: Uint8Array;
}
// Track the fixed name band, not a moving soft-crop bounding box or the dark scene behind it.
const nameForeground = (img: RGBImage, region: Region) => {
  const data = new Uint8Array(region.width * region.height);
  for (let y = 0; y < region.height; y++)
    for (let x = 0; x < region.width; x++) {
      const p = ((region.y + y) * img.width + region.x + x) * img.channels;
      const low = Math.min(img.data[p]!, img.data[p + 1]!, img.data[p + 2]!);
      const high = Math.max(img.data[p]!, img.data[p + 1]!, img.data[p + 2]!);
      // Smooth edges avoid introducing our own 90/91 or chroma 84/85 source discontinuity.
      data[y * region.width + x] = Math.round(
        Math.max(0, low - 90) * Math.max(0, Math.min(1, (110 - high + low) / 25)),
      );
    }
  return data;
};
const sameSource = (source: Source, foreground: Uint8Array, visual: Uint8Array) => {
  if (source.foreground.length !== foreground.length || source.visual.length !== visual.length) return false;
  let iconChanges = 0;
  for (let i = 0; i < visual.length; i++)
    if (Math.abs(source.visual[i]! - visual[i]!) > 24 && ++iconChanges >= 12) return false;
  const ink = new Uint32Array(128),
    changes = new Uint32Array(128);
  let totalInk = 0,
    totalChanges = 0;
  for (let i = 0; i < foreground.length; i++) {
    const cell =
      Math.min(3, Math.floor((Math.floor(i / source.width) * 4) / source.height)) * 32 +
      Math.min(31, Math.floor(((i % source.width) * 32) / source.width));
    if (source.foreground[i]! > 0) {
      ink[cell]++;
      totalInk++;
    }
    if (Math.abs(source.foreground[i]! - foreground[i]!) > 24) {
      changes[cell]++;
      totalChanges++;
    }
  }
  // Symmetric added/deleted strokes, bounded against the ORIGINAL foreground. Local bounds
  // prevent a changed character in a long name from disappearing into a whole-band percentage.
  if (totalChanges > totalInk * 0.05) return false;
  return changes.every((n, cell) => n <= ink[cell]! * 0.1);
};
const fingerprint = (data: ArrayLike<number>) => {
  let hash = 2166136261;
  for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i]!, 16777619);
  return `${data.length}:${hash >>> 0}`;
};

/** Primary upstream name OCR, then our two preprocessing passes, then per-slot icon search.
 * Jobs own immutable crops. Polling never blocks identity, inventory or preparation frames. */
export class DraftCardRecognition {
  private generation = 0;
  private jobs = new Map<string, Job>();
  private catalogNames: Record<string, string> | null = null;
  private catalog = '';
  private primary: typeof readCardName;
  private fallback: typeof readItemName;
  private icon: typeof readDraftSlot;
  private inFlight = new Map<number, { key: string; owner: Job }>();
  private currentSource = new Map<number, string>();
  private sources = new Map<number, Source>();
  private sourceSerial = 0;
  constructor(primary = readCardName, fallback = readItemName, icon = readDraftSlot) {
    this.primary = primary;
    this.fallback = fallback;
    this.icon = icon;
  }

  reset() {
    this.generation++;
    this.jobs.clear();
    this.inFlight.clear();
    this.currentSource.clear();
    this.sources.clear();
  }

  read(
    img: RGBImage,
    index: DecodedIndex,
    names: Record<string, string>,
    tiers: Record<number, number>,
    candidate: string,
    visual: readonly Uint8Array[],
    onEvidence?: (
      slot: number,
      text: string,
      itemId: number,
      ms: number,
      source?: CardNameSlotOutcome['source'],
    ) => void,
  ) {
    const generation = this.generation;
    const anchors = cardAnchors(img.width, img.height);
    const regions = cardNameRegions(img.width, img.height, anchors);
    const squares = cardSquares(img.width, img.height);
    if (this.catalogNames !== names) {
      this.catalogNames = names;
      this.catalog = JSON.stringify(Object.entries(names).sort(([a], [b]) => a.localeCompare(b)));
    }
    const catalog = this.catalog;
    const outcomes: CardNameSlotOutcome[] = [];
    let pending = false;
    const reads = squares.map((square, slot): CardRead => {
      const match = { ...square, itemId: 0, score: 0, margin: 0 };
      const blank: CardRead = {
        card: anchors[slot]!.name,
        match,
        present: false,
        itemId: 0,
        tier: 0,
        rare: false,
        enhanced: false,
      };
      if (!hasItemNameInk(img, regions[slot]!)) {
        this.currentSource.delete(slot);
        this.sources.delete(slot);
        outcomes.push({ slot, status: 'unknown', itemId: 0, reason: 'empty-text' });
        return blank;
      }
      const region = regions[slot]!;
      const foreground = nameForeground(img, region);
      const scope = `${candidate}:${catalog}:${slot}:${img.width}:${img.height}:${region.x}:${region.y}:${region.width}:${region.height}`;
      let source = this.sources.get(slot);
      if (!source || source.scope !== scope || !sameSource(source, foreground, visual[slot]!)) {
        source = {
          scope,
          key: `${scope}:${++this.sourceSerial}`,
          width: region.width,
          height: region.height,
          foreground,
          visual: visual[slot]!.slice(),
        };
        this.sources.set(slot, source);
      }
      // Reuse proof only against this immutable anchor; tolerantly matching frames never replace it.
      let key = source.key;
      this.currentSource.set(slot, key);
      let job = this.jobs.get(key);
      if (!job && this.inFlight.has(slot)) {
        pending = true;
        outcomes.push({ slot, status: 'unknown', itemId: 0 });
        return blank;
      }
      if (!job || (job.outcome?.status === 'unavailable' && Date.now() >= job.retryAt)) {
        // A changed source may have waited for the previous physical slot job. Bind proof to
        // the actual frame being OCRed, rather than that earlier waiting placeholder.
        source = {
          scope,
          key: `${scope}:${++this.sourceSerial}`,
          width: region.width,
          height: region.height,
          foreground,
          visual: visual[slot]!.slice(),
        };
        this.sources.set(slot, source);
        key = source.key;
        this.currentSource.set(slot, key);
        const crop = cardNameCrop(img, match);
        const binary = itemNameCrop(img, region);
        const soft = itemNameSoftCrop(img, region);
        job = { outcome: null, retryAt: Infinity };
        this.jobs.set(key, job);
        this.inFlight.set(slot, { key, owner: job });
        const owner = job;
        const current = () => generation === this.generation && this.currentSource.get(slot) === key;
        const evidence = async () => {
          let unavailable = false;
          const attempt = async (read: () => Promise<{ text: string; confidence: number }>, signature: string) => {
            try {
              const text = await read();
              if (!current()) return null;
              const found = matchCardName(text.text, names);
              return { found, text: Object.freeze({ ...text, cropSignature: signature }) };
            } catch {
              unavailable = true;
              return null;
            }
          };
          const first = crop
            ? await attempt(
                async () => ({ text: await this.primary(crop as NameCrop, slot, current), confidence: NaN }),
                fingerprint(crop.data),
              )
            : null;
          if (!current()) return;
          if (first?.found.itemId) {
            owner.outcome = {
              slot,
              source: 'primary',
              status: first.found.kind as 'exact' | 'corrected',
              itemId: first.found.itemId,
              primary: first.text,
            };
            return;
          }
          const second = await attempt(() => this.fallback(binary), binary.key);
          if (!current()) return;
          if (second?.found.itemId) {
            owner.outcome = {
              slot,
              source: 'binary',
              status: second.found.kind as 'exact' | 'corrected',
              itemId: second.found.itemId,
              primary: first?.text,
              alternate: second.text,
            };
            return;
          }
          const third = soft ? await attempt(() => this.fallback(soft), fingerprint(soft.data)) : null;
          if (!current()) return;
          owner.outcome = third?.found.itemId
            ? {
                slot,
                source: 'nearest',
                status: third.found.kind as 'exact' | 'corrected',
                itemId: third.found.itemId,
                primary: first?.text,
                alternate: third.text,
              }
            : {
                slot,
                status: unavailable ? 'unavailable' : 'unknown',
                itemId: 0,
                reason: unavailable
                  ? 'service-failed'
                  : (third?.found.reason ?? second?.found.reason ?? first?.found.reason ?? 'empty-text'),
                primary: first?.text,
                alternate: third?.text ?? second?.text,
              };
          if (unavailable) owner.retryAt = Date.now() + 1000;
        };
        const started = performance.now();
        void evidence()
          .then(() => {
            if (current() && owner.outcome)
              onEvidence?.(
                slot,
                owner.outcome.alternate?.text ?? owner.outcome.primary?.text ?? '',
                owner.outcome.itemId,
                performance.now() - started,
                owner.outcome.source,
              );
          })
          .finally(() => {
            if (this.inFlight.get(slot)?.owner === owner) this.inFlight.delete(slot);
            if (!owner.outcome && this.jobs.get(key) === owner) this.jobs.delete(key);
          });
        if (this.jobs.size > 96) {
          const settled = [...this.jobs].find(([, entry]) => entry.outcome);
          if (settled) this.jobs.delete(settled[0]);
        }
      }
      if (!job.outcome) {
        pending = true;
        outcomes.push({ slot, status: 'unknown', itemId: 0 });
        return blank;
      }
      const outcome = job.outcome;
      if (outcome.itemId) {
        outcomes.push(outcome);
        match.itemId = outcome.itemId;
        return {
          ...blank,
          present: true,
          itemId: outcome.itemId,
          tier: tiers[outcome.itemId] ?? 0,
          ...readMarkers(img, match),
        };
      }
      // The immutable OCR evidence still matches this source. Match the current slot only.
      const icon = (job.icon ??= this.icon(img, index, (id) => tiers[id] ?? 0, slot));
      if (icon.present && icon.match.score >= 0.82 && icon.match.margin >= 0.08) {
        outcomes.push({
          slot,
          status: 'strong',
          itemId: icon.itemId,
          primary: outcome.primary,
          alternate: outcome.alternate,
        });
        return icon;
      }
      outcomes.push(outcome);
      return blank;
    });
    const outcome: CardNameConfirmationOutcome = { candidate, evidenceKey: candidate, slots: outcomes };
    return { reads, pending, outcome, complete: reads.every((r) => r.present) };
  }
}
