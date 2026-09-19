// Web Worker that runs the Street Brawl screen recogniser off the main thread, so the page and the overlay stay
// responsive while frames are read. It keeps the small amount of state needed to decide when a screen is "new":
// cards are accepted once two consecutive frames agree, and the expensive labels / hero bar read runs only then.
import {
  decodeIconIndex,
  isShopScreen,
  readDraftMeta,
  readRoundChoice,
  readDraftScreen,
  readInventory,
  type CardRead,
  type DecodedIndex,
  type DraftMeta,
  type InventoryRead,
} from './recognise';
import { readRerollsRemaining } from './ocr';
import type { IconIndex } from './types';

export type WorkerIn =
  | { type: 'init'; index: IconIndex; tiers: Record<number, number>; intervalMs: number }
  | { type: 'frame'; width: number; height: number; buffer: ArrayBuffer; prefer: number[] }
  // Off the draft screen the page copies just the "CHOICE n OF 3" crop (see shopProbeRect) instead of a whole frame.
  | {
      type: 'probe';
      frameW: number;
      frameH: number;
      x: number;
      y: number;
      width: number;
      height: number;
      buffer: ArrayBuffer;
    }
  | { type: 'idle' }; // the page had no frame ready for the last tick

/** The worker paces the capture: it asks the page for a frame, reads it, waits, asks again. Page timers are
 *  throttled to once a second (Chrome: once a minute after five minutes) while the game has the foreground and the
 *  browser tab is hidden; worker timers are not, so the advice keeps updating without alt-tabbing. */
export type WorkerOut =
  | FrameResult
  | { type: 'tick'; full: boolean } // full: send a whole frame; otherwise just the probe crop
  | { type: 'rerolls'; forKey: string; rerollsRemaining: number };

export interface FrameResult {
  type: 'result';
  shop: boolean; // isShopScreen(img) for this frame -- false means card/inventory recognition was skipped entirely
  round: number; // this frame's ROUND / CHOICE labels (0: unread; always 0 on a non-draft frame)
  choice: number;
  reads: CardRead[];
  key: string; // item ids of the three cards, '' when fewer than three are visible
  accepted: boolean; // true on the frame a new stable set of three cards is first accepted
  meta: DraftMeta | null; // round / choice / hero bar, on the accepted frame only
  inventory: number[] | null; // owned items from the inventory grid, once two consecutive reads agree; null otherwise
  ms: number;
}

let index: DecodedIndex | null = null;
let tiers: Record<number, number> = {};
let lastKey = '',
  acceptedKey = '';
let lastInv = '',
  sentInv = '';

let intervalMs = 250;
// Off the shop screen there's nothing to react to quickly -- poll much slower, and only read the small
// "CHOICE n OF 3" crop, until the shop reappears.
const IDLE_INTERVAL_MS = 1000;
// Once the draft screen's cards, round and choice are all settled, only a change matters: look less often.
const SETTLED_INTERVAL_MS = 500;
let wasShop = false; // the previous result was a draft frame: the next non-draft frame is re-checked quickly
let acceptedRound = 0,
  acceptedChoice = 0;

const post = (m: WorkerOut) => (self as unknown as { postMessage(m: unknown): void }).postMessage(m);
let timer: ReturnType<typeof setTimeout> | undefined;
const tick = (after: number, full: boolean) => {
  clearTimeout(timer);
  timer = setTimeout(() => post({ type: 'tick', full }), after);
}; // one chain, even if the page sent two frames

self.addEventListener('message', (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    index = decodeIconIndex(msg.index);
    tiers = msg.tiers;
    intervalMs = msg.intervalMs;
    lastKey = acceptedKey = lastInv = sentInv = '';
    wasShop = false;
    acceptedRound = acceptedChoice = 0;
    tick(0, false);
    return;
  }
  if (msg.type === 'idle') {
    tick(intervalMs, false);
    return;
  }
  if (!index) return;
  const t0 = performance.now();
  if (msg.type === 'probe') {
    const crop = {
      width: msg.width,
      height: msg.height,
      data: new Uint8ClampedArray(msg.buffer),
      channels: 4 as const,
      origin: { x: msg.x, y: msg.y, fullWidth: msg.frameW, fullHeight: msg.frameH },
    };
    if (isShopScreen(crop)) {
      tick(0, true); // a draft screen: ask for the whole frame right away
      return;
    }
    post(nonShopResult(t0));
    // A single non-draft frame between two draft frames is a blink: check again soon before going slow.
    tick(wasShop ? intervalMs : IDLE_INTERVAL_MS, false);
    wasShop = false;
    return;
  }
  const img = { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.buffer), channels: 4 as const };
  // Skip card/inventory recognition entirely off the shop screen (menus, gameplay, the round-end transition
  // into the next shop) -- isShopScreen is one small glyph read instead of three full icon searches.
  const labels = readRoundChoice(img);
  if (labels.choice === 0) {
    post(nonShopResult(t0));
    tick(wasShop ? intervalMs : IDLE_INTERVAL_MS, false);
    wasShop = false;
    return;
  }
  wasShop = true;
  const reads = readDraftScreen(img, index, (id) => tiers[id] ?? 0);
  const seen = reads.filter((r) => r.present).length;
  const key = seen === 3 ? reads.map((r) => `${r.itemId}${r.enhanced ? '+' : ''}`).join(',') : '';
  let accepted = false,
    meta: DraftMeta | null = null,
    inventory: number[] | null = null;
  if (key && key === lastKey) {
    // A new card set, or the ROUND / CHOICE label changed under the same cards (a stale label must not stand):
    // (re)accept, which re-reads the hero bar and labels once the screen has settled.
    const labelsChanged =
      key === acceptedKey && (labels.choice !== acceptedChoice || (labels.round > 0 && labels.round !== acceptedRound));
    if (key !== acceptedKey || labelsChanged) {
      acceptedKey = key;
      acceptedChoice = labels.choice;
      if (labels.round > 0) acceptedRound = labels.round;
      accepted = true;
      meta = readDraftMeta(img, index);
      // rerollsRemaining above is only the fast "is there a glyph at all" read (0 or -1 pending); resolve
      // the actual digit via real OCR off the hot path and post it once it's ready, tagged with the key it
      // was read for so a stale, slow OCR result from a since-superseded card set is never applied.
      if (meta.rerollsRemaining < 0) {
        const forKey = key;
        readRerollsRemaining(img).then((rerollsRemaining) => post({ type: 'rerolls', forKey, rerollsRemaining }));
      }
    }
    // the inventory grid is only on the draft screen; accept a read once two frames agree
    const inv: InventoryRead[] = readInventory(img, index, msg.prefer);
    const ids = inv
      .map((r) => r.itemId)
      .filter(Boolean)
      .sort((a, b) => a - b);
    const ik = ids.join(',');
    if (ik === lastInv && ik !== sentInv) {
      sentInv = ik;
      inventory = ids;
    }
    lastInv = ik;
  } else if (!key) lastInv = '';
  lastKey = key;
  post({
    type: 'result',
    shop: true,
    round: labels.round,
    choice: labels.choice,
    reads,
    key,
    accepted,
    meta,
    inventory,
    ms: performance.now() - t0,
  });
  const settled = key !== '' && key === acceptedKey && labels.choice === acceptedChoice && !accepted;
  tick(settled ? SETTLED_INTERVAL_MS : intervalMs, true);
});

const nonShopResult = (t0: number): FrameResult => {
  lastKey = acceptedKey = lastInv = sentInv = '';
  acceptedRound = acceptedChoice = 0;
  return {
    type: 'result',
    shop: false,
    round: 0,
    choice: 0,
    reads: [],
    key: '',
    accepted: false,
    meta: null,
    inventory: null,
    ms: performance.now() - t0,
  };
};
