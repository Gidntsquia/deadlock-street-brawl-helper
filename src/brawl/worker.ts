// Web Worker that runs the Street Brawl screen recogniser off the main thread, so the page and the overlay stay
// responsive while frames are read. It keeps the small amount of state needed to decide when a screen is "new":
// cards are accepted once two consecutive frames agree, and the expensive labels / hero bar read runs only then.
import { decodeIconIndex, readDraftMeta, readDraftScreen, readInventory, type CardRead, type DecodedIndex, type DraftMeta, type InventoryRead } from './recognise';
import type { IconIndex } from './types';

export type WorkerIn =
  | { type: 'init'; index: IconIndex; tiers: Record<number, number> }
  | { type: 'frame'; width: number; height: number; buffer: ArrayBuffer; prefer: number[] };

export interface FrameResult {
  type: 'result';
  reads: CardRead[];
  key: string;                 // item ids of the three cards, '' when fewer than three are visible
  accepted: boolean;           // true on the frame a new stable set of three cards is first accepted
  meta: DraftMeta | null;      // round / choice / hero bar, on the accepted frame only
  inventory: number[] | null;  // owned items from the inventory grid, once two consecutive reads agree; null otherwise
  ms: number;
}

let index: DecodedIndex | null = null;
let tiers: Record<number, number> = {};
let lastKey = '', acceptedKey = '';
let lastInv = '', sentInv = '';

const post = (m: FrameResult) => (self as unknown as { postMessage(m: unknown): void }).postMessage(m);

self.addEventListener('message', (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === 'init') { index = decodeIconIndex(msg.index); tiers = msg.tiers; lastKey = acceptedKey = lastInv = sentInv = ''; return; }
  if (!index) return;
  const t0 = performance.now();
  const img = { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.buffer), channels: 4 as const };
  const reads = readDraftScreen(img, index, (id) => tiers[id] ?? 0);
  const seen = reads.filter((r) => r.present).length;
  const key = seen === 3 ? reads.map((r) => `${r.itemId}${r.enhanced ? '+' : ''}`).join(',') : '';
  let accepted = false, meta: DraftMeta | null = null, inventory: number[] | null = null;
  if (key && key === lastKey) {
    if (key !== acceptedKey) { acceptedKey = key; accepted = true; meta = readDraftMeta(img, index); }
    // the inventory grid is only on the draft screen; accept a read once two frames agree
    const inv: InventoryRead[] = readInventory(img, index, msg.prefer);
    const ids = inv.map((r) => r.itemId).filter(Boolean).sort((a, b) => a - b);
    const ik = ids.join(',');
    if (ik === lastInv && ik !== sentInv) { sentInv = ik; inventory = ids; }
    lastInv = ik;
  } else if (!key) lastInv = '';
  lastKey = key;
  post({ type: 'result', reads, key, accepted, meta, inventory, ms: performance.now() - t0 });
});
