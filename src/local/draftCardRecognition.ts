import {
  cardAnchors,
  CARD_NAME,
  cardNameCrop,
  cardSquares,
  readDraftSlot,
  readMarkers,
  type CardRead,
  type DecodedIndex,
  type RGBImage,
  type Region,
} from '../brawl/recognise';
import { readCardName, type NameCrop, type NameWord } from '../brawl/ocr';
import { cardNameRegions, hasItemNameInk, itemNameCrop, itemNameSoftCrop } from './cardNames';
import { readItemName, type ItemNameOcrCrop } from './cardNameOcr';
import { matchCardName, normaliseCardName } from './cardNameMatch';
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
  glyphSupport?: Uint8Array;
  expandedCatalogName?: boolean;
  wordRects?: Region[];
}
/** Boxes of the characters aligned to the accepted full catalogue name. OCR insertions
 * from badges/runes are diagnostic text, rather than geometry belonging to that name. */
const matchedWordBoxes = (words: readonly NameWord[], name: string) => {
  const chars = words.flatMap((word, index) =>
    (word.symbols?.length ? word.symbols : [word]).flatMap((symbol) =>
      [...normaliseCardName(symbol.text)].map((char) => ({ char, index, box: symbol.bbox })),
    ),
  );
  const target = normaliseCardName(name);
  const cost = Array.from({ length: chars.length + 1 }, (_, i) =>
    Array.from({ length: target.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= chars.length; i++)
    for (let j = 1; j <= target.length; j++)
      cost[i]![j] = Math.min(
        cost[i - 1]![j]! + 1,
        cost[i]![j - 1]! + 1,
        cost[i - 1]![j - 1]! + Number(chars[i - 1]!.char !== target[j - 1]),
      );
  const kept = new Map<number, NameWord['bbox'][]>();
  let i = chars.length,
    j = target.length;
  while (i || j) {
    if (i && j && cost[i]![j] === cost[i - 1]![j - 1]! + Number(chars[i - 1]!.char !== target[j - 1])) {
      const char = chars[--i]!;
      j--;
      const boxes = kept.get(char.index) ?? [];
      boxes.push(char.box);
      kept.set(char.index, boxes);
    } else if (i && cost[i]![j] === cost[i - 1]![j]! + 1) i--;
    else j--;
  }
  return [...kept.values()].map((boxes) => ({
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  }));
};
const addedNameWord = (source: Source, foreground: Uint8Array) => {
  if (!source.expandedCatalogName || !source.wordRects?.length) return false;
  const top = Math.min(...source.wordRects.map((r) => r.y));
  const bottom = Math.max(...source.wordRects.map((r) => r.y + r.height));
  const glyphHeight = Math.min(...source.wordRects.map((r) => r.height));
  const visited = new Uint8Array(foreground.length);
  const added = (i: number) => foreground[i]! > 60 && source.foreground[i]! <= 60 && !source.glyphSupport?.[i];
  for (let y = top; y < bottom; y++)
    for (let x = 0; x < source.width; x++) {
      const start = y * source.width + x;
      if (visited[start] || !added(start)) continue;
      const stack = [start];
      visited[start] = 1;
      let lo = y,
        hi = y,
        count = 0;
      while (stack.length) {
        const i = stack.pop()!,
          py = Math.floor(i / source.width),
          px = i % source.width;
        lo = Math.min(lo, py);
        hi = Math.max(hi, py);
        count++;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const ny = py + dy,
              nx = px + dx,
              next = ny * source.width + nx;
            if (ny >= top && ny < bottom && nx >= 0 && nx < source.width && !visited[next] && added(next)) {
              visited[next] = 1;
              stack.push(next);
            }
          }
      }
      // Extra word candidates must span the same text baseline, rather than a small decoration
      // elsewhere in the band. Their typography is scaled from this OCR result's own word height.
      if (hi - lo + 1 >= glyphHeight * 0.6 && count >= glyphHeight) return true;
    }
  return false;
};
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
const sameSource = (source: Source, foreground: Uint8Array, visual: Uint8Array, nameProof = false) => {
  if (source.foreground.length !== foreground.length || source.visual.length !== visual.length) return false;
  let iconChanges = 0;
  for (let i = 0; i < visual.length && !nameProof; i++)
    if (Math.abs(source.visual[i]! - visual[i]!) > 24 && ++iconChanges >= 12) return false;
  const ink = new Uint32Array(128),
    changes = new Uint32Array(128);
  let totalInk = 0,
    totalChanges = 0;
  for (let i = 0; i < foreground.length; i++) {
    if (nameProof && source.glyphSupport && !source.glyphSupport[i]) continue;
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
  return changes.every((n, cell) => n <= ink[cell]! * 0.1) && !(nameProof && addedNameWord(source, foreground));
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
  private hardSources = new Map<number, { scope: string }>();
  private proofs = new Map<number, { source: Source; job: Job; hard: { scope: string } }>();
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
    this.hardSources.clear();
    this.proofs.clear();
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
        this.hardSources.delete(slot);
        this.proofs.delete(slot);
        outcomes.push({ slot, status: 'unknown', itemId: 0, reason: 'empty-text' });
        return blank;
      }
      const region = regions[slot]!;
      const foreground = nameForeground(img, region);
      const scope = `${candidate}:${catalog}:${slot}:${img.width}:${img.height}:${region.x}:${region.y}:${region.width}:${region.height}`;
      let hard = this.hardSources.get(slot);
      if (hard?.scope !== scope) {
        hard = { scope };
        this.hardSources.set(slot, hard);
      }
      let source = this.sources.get(slot);
      const proof = this.proofs.get(slot);
      const qualifiedNameProof = !!proof?.job.outcome?.itemId && !!proof.source.glyphSupport;
      if (proof?.hard === hard && sameSource(proof.source, foreground, visual[slot]!, qualifiedNameProof)) {
        source = proof.source;
        this.sources.set(slot, source);
      }
      if (
        !source ||
        source.scope !== scope ||
        !sameSource(source, foreground, visual[slot]!, source === proof?.source && qualifiedNameProof)
      ) {
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
        const crop: NameCrop | null = cardNameCrop(img, match);
        const snapshot = source;
        let words: readonly NameWord[] = [],
          wordScaleX = 1,
          wordScaleY = 1;
        let cropX =
          Math.max(0, Math.round(square.x + square.edge / 2 - CARD_NAME.halfWidth * square.edge)) - 12 - region.x;
        let cropY = Math.round(square.y + CARD_NAME.top * square.edge) - 12 - region.y;
        const retainWords = (catalogName: string) => {
          const support = new Uint8Array(snapshot.foreground.length);
          const rects: Region[] = [];
          for (const box of matchedWordBoxes(words, catalogName)) {
            const x0 = Math.max(0, Math.floor(box.x0 / wordScaleX + cropX) - 1);
            const x1 = Math.min(region.width, Math.ceil(box.x1 / wordScaleX + cropX) + 1);
            const y0 = Math.max(0, Math.floor(box.y0 / wordScaleY + cropY) - 1);
            const y1 = Math.min(region.height, Math.ceil(box.y1 / wordScaleY + cropY) + 1);
            if (x1 > x0 && y1 > y0) rects.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
            // Include spaces and holes inside each word, so an added/replaced character
            // cannot reuse an old name solely because its previous strokes remain lit.
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) support[y * region.width + x] = 1;
          }
          if (support.some(Boolean)) {
            snapshot.glyphSupport = support;
            snapshot.wordRects = rects;
          }
          const tokens = catalogName
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
          snapshot.expandedCatalogName = Object.values(names).some((name) => {
            const other = name
              .toLowerCase()
              .split(/[^a-z0-9]+/)
              .filter(Boolean);
            return (
              other.length > tokens.length &&
              other.some((_, start) => tokens.every((token, offset) => other[start + offset] === token))
            );
          });
          words = [];
        };
        if (crop)
          crop.onWords = (result, scaleX, scaleY) => {
            words = result;
            wordScaleX = scaleX;
            wordScaleY = scaleY;
          };
        const binary: ItemNameOcrCrop & { key: string; origin: { x: number; y: number } } = itemNameCrop(img, region);
        const soft = itemNameSoftCrop(img, region) as (ItemNameOcrCrop & { origin: { x: number; y: number } }) | null;
        const bindFallback = (selected: ItemNameOcrCrop & { origin: { x: number; y: number } }) => {
          words = [];
          cropX = selected.origin.x - region.x;
          cropY = selected.origin.y - region.y;
          selected.onWords = (result, scaleX, scaleY) => {
            words = result;
            wordScaleX = scaleX;
            wordScaleY = scaleY;
          };
          return selected;
        };
        job = { outcome: null, retryAt: Infinity };
        this.jobs.set(key, job);
        this.inFlight.set(slot, { key, owner: job });
        const owner = job;
        // Animation updates latest evidence, never the ownership of an immutable physical job.
        const current = () => generation === this.generation && this.hardSources.get(slot) === hard;
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
            retainWords(names[first.found.itemId]!);
            owner.outcome = {
              slot,
              source: 'primary',
              status: first.found.kind as 'exact' | 'corrected',
              itemId: first.found.itemId,
              primary: first.text,
            };
            return;
          }
          const second = await attempt(() => this.fallback(bindFallback(binary)), binary.key);
          if (!current()) return;
          if (second?.found.itemId) {
            retainWords(names[second.found.itemId]!);
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
          const third = soft ? await attempt(() => this.fallback(bindFallback(soft)), fingerprint(soft.data)) : null;
          if (!current()) return;
          if (third?.found.itemId) retainWords(names[third.found.itemId]!);
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
            if (current() && owner.outcome) {
              this.proofs.set(slot, { source: snapshot, job: owner, hard });
              onEvidence?.(
                slot,
                owner.outcome.alternate?.text ?? owner.outcome.primary?.text ?? '',
                owner.outcome.itemId,
                performance.now() - started,
                owner.outcome.source,
              );
            }
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
