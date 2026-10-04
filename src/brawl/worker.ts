// Web Worker that runs the Street Brawl screen recogniser off the main thread, so the page and the overlay stay
// responsive while frames are read. It keeps the small amount of state needed to decide when a screen is "new":
// cards are accepted once the screen has settled and the player has not already picked from them (draftGate.ts), and
// the expensive labels / hero bar read runs only then.
import {
  BRAWL_LAYOUT,
  HERO_BAR,
  decodeIconIndex,
  isShopScreen,
  readDraftMeta,
  readRoundChoice,
  readDraftScreen,
  readInventory,
  cardNameCrop,
  type CardRead,
  type DecodedIndex,
  type DraftMeta,
  type InventoryRead,
} from './recognise';
import { readCardName, readRerollsRemaining, terminateOCR, warmOCR } from './ocr';
import { matchItemName, nameList, type NameList } from './names';
import { initialGate, offScreenGate, stepGate } from './draftGate';
import type { IconIndex } from './types';

export interface FrameRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

export type WorkerIn =
  // names: item names by id, for reading the name printed under each card (absent: cards are read by icon only)
  | { type: 'warm'; index: IconIndex; tiers: Record<number, number>; names?: Record<number, string> }
  | {
      type: 'init';
      index: IconIndex;
      tiers: Record<number, number>;
      names?: Record<number, string>;
      intervalMs: number;
    }
  // A draft frame is only the rectangles the recogniser reads (draftRegions), each with its own pixels: the worker
  // pastes them into a reused frame-sized buffer, so nothing outside them is ever copied out of the video.
  | { type: 'frame'; width: number; height: number; regions: FrameRegion[]; prefer: number[] }
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
  | { type: 'idle' } // the page had no frame ready for the last tick
  | { type: 'reset' } // capture (re)started: forget the last draft and start ticking again
  | { type: 'stop' }; // capture stopped: forget the last draft and free the OCR engine; the worker then stays silent

/** The worker paces the capture: it asks the page for a frame, reads it, waits, asks again. Page timers are
 *  throttled to once a second (Chrome: once a minute after five minutes) while the game has the foreground and the
 *  browser tab is hidden; worker timers are not, so the advice keeps updating without alt-tabbing. */
export type WorkerOut =
  | FrameResult
  | { type: 'tick'; full: boolean } // full: send a whole frame; otherwise just the probe crop
  | { type: 'rerolls'; forKey: string; rerollsRemaining: number }
  // a card's name line was read: what the icon said, the OCR text, and the item it names (0: no clear match)
  | { type: 'name'; slot: number; icon: number; text: string; itemId: number; ms: number };

interface FrameResult {
  type: 'result';
  shop: boolean; // isShopScreen(img) for this frame -- false means card/inventory recognition was skipped entirely
  round: number; // this frame's ROUND / CHOICE labels (0: unread; always 0 on a non-draft frame)
  choice: number;
  reads: CardRead[];
  key: string; // item ids of the three cards, '' when fewer than three are visible
  accepted: boolean; // true on the frame a new, settled set of three cards is first accepted (see draftGate.ts)
  live: boolean; // the accepted set is still what is on screen: its advice stands
  picked: number | null; // the item the player just selected from the accepted set (seen in the inventory grid)
  spent: boolean; // the cards on screen are a set the player already selected from: advise nothing
  meta: DraftMeta | null; // round / choice / hero bar, on the accepted frame only
  inventory: number[] | null; // owned items from the inventory grid, once two consecutive reads agree; null otherwise
  ms: number;
  stages?: Record<string, number>; // dev builds only: milliseconds per recogniser stage
}

let index: DecodedIndex | null = null;
let tiers: Record<number, number> = {};
let names: NameList | null = null;
const setNames = (n: Record<number, string> | undefined) => {
  if (!n || !index) return;
  const list = nameList(index.ids, n);
  names = list.length ? list : null;
};

// ---- item names under the cards ----------------------------------------------------------------------------
// The name printed under each card is the item's exact name, so a clear OCR match overrides the icon search (which
// misses when the game's art differs from the shop art). Each card is read once per (slot, icon guess) while the draft
// screen stays up; a card whose icon match is shaky is held back from the gate until its name is in, so wrong advice
// never shows first. A name that does not read (the hover tooltip covers it, a mid-animation frame) is retried.
const NAME_RETRY_MS = 700;
/** An icon match below this score or margin is not trusted on its own: the card waits for its name. */
const SURE_SCORE = 0.8,
  SURE_MARGIN = 0.08;
const nameFix = new Map<string, { id: number; at: number }>(); // `${slot}:${iconId}` -> named item (0: unread)
const nameBusy = new Set<string>();
let nameChoice = 0;
const forgetNames = () => {
  nameFix.clear();
  nameChoice = 0;
};
/** The reads with each card's item replaced by the one its name line names; `waiting` while a shaky card's name is
 *  still being read. Starts the OCR reads that are missing. */
const applyNames = (
  img: Parameters<typeof cardNameCrop>[0],
  reads: CardRead[],
  choice: number,
): { reads: CardRead[]; waiting: boolean } => {
  if (!names) return { reads, waiting: false };
  if (choice !== nameChoice) {
    nameFix.clear(); // a new choice can bring the same icon guess in the same slot for a different card
    nameChoice = choice;
  }
  const list = names;
  let waiting = false;
  const out = reads.map((r, slot) => {
    if (!r.present) return r;
    const k = `${slot}:${r.itemId}`;
    const fix = nameFix.get(k);
    const sure = r.match.score >= SURE_SCORE && r.match.margin >= SURE_MARGIN;
    if (fix && fix.id) {
      if (fix.id === r.itemId) return r;
      return { ...r, itemId: fix.id, tier: tiers[fix.id] ?? r.tier, match: { ...r.match, itemId: fix.id } };
    }
    const retry = !fix || performance.now() - fix.at > NAME_RETRY_MS;
    if (!nameBusy.has(k) && retry) {
      const crop = cardNameCrop(img, r.match);
      if (crop) {
        nameBusy.add(k);
        const t = performance.now(),
          forChoice = choice;
        readCardName(crop)
          .then((text) => {
            const m = matchItemName(text, list);
            if (forChoice === nameChoice) nameFix.set(k, { id: m?.itemId ?? 0, at: performance.now() });
            post({ type: 'name', slot, icon: r.itemId, text, itemId: m?.itemId ?? 0, ms: performance.now() - t });
          })
          .catch(() => {}) // the OCR engine was freed (capture stopped) while this was running
          .finally(() => nameBusy.delete(k));
      }
    }
    // A shaky icon waits for its first name read; once a read failed, the icon guess stands (retries go on).
    if (!sure && !fix) waiting = true;
    return r;
  });
  return { reads: out, waiting };
};
let lastKey = '',
  acceptedKey = '';
let lastInv = '',
  sentInv = '';
let stableInv: number[] | null = null; // the last inventory read two frames agreed on
let gate = initialGate();
// re-roll caption re-reads on a settled draft screen (see the draft branch of the frame handler)
let rerollBusy = false,
  rerollAt = 0,
  rerollLast = -2,
  rerollKey = '';

let intervalMs = 250;
// Off the shop screen there's nothing to react to quickly -- poll much slower, and only read the small
// "CHOICE n OF 3" crop, until the shop reappears.
const IDLE_INTERVAL_MS = 300;
// Once the draft screen's cards, round and choice are all settled, only a change matters: look less often.
const SETTLED_INTERVAL_MS = 100;
// While the cards are settled, a frame that looks the same (coarse pixel grid, same round/choice labels) skips the
// expensive card and inventory reads and reuses the last result: a change is noticed within one interval and the
// idle draft screen costs almost nothing.
const SIG_STEP = 16;
const SIG_CHANGED_SAMPLES = 12; // sampled channel values that moved by more than 24 (of 255) mean "changed"
let settledSig: Uint8Array | null = null;
let knownHero: { bar: DraftMeta['bar']; self: number } | null = null;
let settledReads: CardRead[] = [];
let pendingSig: Uint8Array | null = null,
  pendingReads: CardRead[] = [],
  pendingChoice = 0;
// Samples a coarse grid inside each region (not the whole frame: the rest was never copied).
const frameSig = (regions: FrameRegion[]): Uint8Array => {
  const out: number[] = [];
  for (const r of regions) {
    const d = new Uint8ClampedArray(r.buffer);
    for (let y = 0; y < r.height; y += SIG_STEP)
      for (let x = 0; x < r.width; x += SIG_STEP) {
        const i = (y * r.width + x) * 4;
        out.push(d[i]!, d[i + 1]!, d[i + 2]!);
      }
  }
  return Uint8Array.from(out);
};
// Reused across frames (same regions every time, so nothing stale survives); reallocated when the frame size changes.
let frameBuf = new Uint8ClampedArray(0);
const pasteRegions = (width: number, height: number, regions: FrameRegion[]) => {
  if (frameBuf.length !== width * height * 4) frameBuf = new Uint8ClampedArray(width * height * 4);
  for (const r of regions) {
    const src = new Uint8ClampedArray(r.buffer);
    for (let y = 0; y < r.height; y++)
      frameBuf.set(src.subarray(y * r.width * 4, (y + 1) * r.width * 4), ((r.y + y) * width + r.x) * 4);
  }
  return { width, height, data: frameBuf, channels: 4 as const };
};
const sameSig = (a: Uint8Array | null, b: Uint8Array): boolean => {
  if (!a || a.length !== b.length) return false;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 24 && ++changed >= SIG_CHANGED_SAMPLES) return false;
  return true;
};
let wasShop = false; // the previous result was a draft frame: the next non-draft frame is re-checked quickly
/** Draft frames in a row with no CHOICE glyph before the draft screen counts as closed. */
const OFF_FRAMES = 3;
let offFrames = 0;
let acceptedRound = 0,
  acceptedChoice = 0;

const forgetDraft = () => {
  forgetNames();
  lastKey = acceptedKey = lastInv = sentInv = '';
  rerollLast = -2;
  rerollKey = '';
  wasShop = false;
  offFrames = 0;
  settledSig = pendingSig = null;
  knownHero = null;
  acceptedRound = acceptedChoice = 0;
  gate = initialGate();
  stableInv = null;
};
// Dev builds only (`import.meta.env.DEV` is false in a production build, so this all folds away): milliseconds per
// recogniser stage, sent back on each result for the page's perf summary.
const DEV = import.meta.env.DEV;
let stages: Record<string, number> | undefined;
const stage = <T>(name: string, fn: () => T): T => {
  if (!stages) return fn();
  const t = performance.now();
  try {
    return fn();
  } finally {
    stages[name] = performance.now() - t;
  }
};
// Pre-bake: the hero bar (eight portraits) is the slowest read, about 0.8 s, and it is the same for the whole match.
// Keep the last read with a fingerprint of the bar's pixels; a later draft screen whose bar still matches reuses it
// instead of searching all eight portraits again. A new match (other portraits) fails the check and is read afresh.
const BAR_SIG_MAX_CHANGED = 12; // of ~200 sampled channel values; a different portrait moves most of them
let matchBar: { bar: DraftMeta['bar']; self: number; sig: Uint8Array } | null = null;
const barSig = (img: { width: number; height: number; data: Uint8ClampedArray }): Uint8Array => {
  const sx = img.width / BRAWL_LAYOUT.ref.width,
    sy = img.height / BRAWL_LAYOUT.ref.height,
    out: number[] = [];
  for (const cx of [...HERO_BAR.left, ...HERO_BAR.right])
    for (let dy = -30; dy <= 30; dy += 15)
      for (let dx = -30; dx <= 30; dx += 15) {
        const i = (Math.round((HERO_BAR.cy + dy) * sy) * img.width + Math.round((cx + dx) * sx)) * 4;
        out.push(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
      }
  return Uint8Array.from(out);
};
const sameBar = (a: Uint8Array, b: Uint8Array) => {
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 40 && ++changed > BAR_SIG_MAX_CHANGED) return false;
  return true;
};
const post = (m: WorkerOut) => (self as unknown as { postMessage(m: unknown): void }).postMessage(m);
let timer: ReturnType<typeof setTimeout> | undefined;
const tick = (after: number, full: boolean) => {
  clearTimeout(timer);
  timer = setTimeout(() => post({ type: 'tick', full }), after);
}; // one chain, even if the page sent two frames

self.addEventListener('message', (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === 'stop') {
    clearTimeout(timer);
    forgetDraft();
    // matchBar is kept: capture stops between every round, and the bar fingerprint is checked before it is reused
    // (a new match has different portraits), so the ~0.7 s hero bar read is paid once per match, not once per round.
    void terminateOCR();
    return;
  }
  if (msg.type === 'warm') {
    // Sent when the app opens, long before a draft: decode the icon index now so the first frame does not.
    index ??= decodeIconIndex(msg.index);
    tiers = msg.tiers;
    setNames(msg.names);
    return;
  }
  if (msg.type === 'init' || msg.type === 'reset') {
    if (msg.type === 'init') {
      index ??= decodeIconIndex(msg.index);
      tiers = msg.tiers;
      setNames(msg.names);
      intervalMs = msg.intervalMs;
    }
    forgetDraft();
    warmOCR(); // capture only runs around the draft now: load the OCR engine with it (freed again on 'stop')
    tick(0, false);
    return;
  }
  if (msg.type === 'idle') {
    tick(intervalMs, false);
    return;
  }
  if (!index) return;
  const idx = index; // narrowed for the stage closures below
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
  stages = DEV ? {} : undefined;
  const img = stage('paste', () => pasteRegions(msg.width, msg.height, msg.regions));
  // Skip card/inventory recognition entirely off the shop screen (menus, gameplay, the round-end transition
  // into the next shop) -- isShopScreen is one small glyph read instead of three full icon searches.
  const labels = readRoundChoice(img);
  if (labels.choice === 0) {
    // One unreadable CHOICE glyph on a draft screen (a hover glow, a frame caught mid-animation) is not the screen
    // closing: look at the next frames before forgetting the accepted set, or the plates blank and re-settle.
    if (wasShop && ++offFrames < OFF_FRAMES) {
      tick(intervalMs, true);
      return;
    }
    post(nonShopResult(t0));
    tick(wasShop ? intervalMs : IDLE_INTERVAL_MS, false);
    wasShop = false;
    return;
  }
  wasShop = true;
  offFrames = 0;
  const sig = frameSig(msg.regions);
  if (
    acceptedKey &&
    acceptedKey === lastKey &&
    labels.choice === acceptedChoice &&
    (labels.round === 0 || labels.round === acceptedRound) &&
    sameSig(settledSig, sig)
  ) {
    post({
      type: 'result',
      shop: true,
      round: labels.round,
      choice: labels.choice,
      reads: settledReads,
      key: acceptedKey,
      accepted: false,
      live: true,
      picked: null,
      spent: false,
      meta: null,
      inventory: null,
      ms: performance.now() - t0,
      stages,
    });
    tick(SETTLED_INTERVAL_MS, true);
    return;
  }
  // A new picture is about to be read: ask for the next frame now, so the page copies it while this one is being read
  // (the two-frame check below then finds it waiting instead of paying copy + hop after the read). One tick per frame:
  // the end of this handler does not tick again.
  clearTimeout(timer);
  post({ type: 'tick', full: true });
  // A frame that looks the same as the one that just produced a full set of cards (and carries the same choice
  // label) confirms that read without repeating the expensive icon search: a new screen is accepted a frame sooner.
  const confirmed = lastKey !== '' && pendingChoice === labels.choice && sameSig(pendingSig, sig);
  const raw = confirmed ? pendingReads : stage('cards', () => readDraftScreen(img, idx, (id) => tiers[id] ?? 0));
  const named = applyNames(img, raw, labels.choice);
  const reads = named.reads;
  const seen = reads.filter((r) => r.present).length;
  // A set with a shaky card whose name is still being read is not a full set yet: the gate must not settle on it.
  const key = seen === 3 && !named.waiting ? reads.map((r) => `${r.itemId}${r.enhanced ? '+' : ''}`).join(',') : '';
  let meta: DraftMeta | null = null,
    inventory: number[] | null = null;
  if (key && key === lastKey) {
    // the inventory grid is only on the draft screen; a read counts once two frames agree
    const inv: InventoryRead[] = stage('inventory', () => readInventory(img, idx, msg.prefer));
    const ids = inv
      .map((r) => r.itemId)
      .filter(Boolean)
      .sort((a, b) => a - b);
    const ik = ids.join(',');
    if (ik === lastInv) {
      stableInv = ids;
      if (ik !== sentInv) {
        sentInv = ik;
        inventory = ids;
      }
    }
    lastInv = ik;
  } else if (!key) lastInv = '';
  // The gate decides when this screen is settled enough to advise on, and spots the player's selection.
  const g = stepGate(gate, {
    key,
    present: reads.filter((r) => r.present).map((r) => r.itemId),
    round: labels.round,
    choice: labels.choice,
    now: performance.now(),
    inventory: stableInv,
  });
  gate = g.state;
  if (g.live && gate.last) acceptedRound = gate.last.round;
  const accepted = g.accept;
  if (accepted) {
    acceptedKey = key;
    acceptedChoice = labels.choice;
    acceptedRound = labels.round;
    const bsig = barSig(img);
    if (!knownHero && matchBar && sameBar(matchBar.sig, bsig)) knownHero = matchBar;
    meta = stage('meta', () => readDraftMeta(img, idx, knownHero ?? undefined, true));
    if (meta.self) matchBar = { bar: meta.bar, self: meta.self, sig: bsig };
    // the hero bar is constant while the draft screen stays up; keep it until the screen closes (nonShopResult)
    knownHero = meta.self ? { bar: meta.bar, self: meta.self } : null;
    // rerollsRemaining above is only the fast "is there a glyph at all" read (0 or -1 pending); resolve
    // the actual digit via real OCR off the hot path and post it once it's ready, tagged with the key it
    // was read for so a stale, slow OCR result from a since-superseded card set is never applied.
    if (meta.rerollsRemaining < 0) {
      const forKey = key;
      readRerollsRemaining(img)
        .then((rerollsRemaining) => {
          rerollLast = rerollsRemaining;
          rerollKey = forKey;
          post({ type: 'rerolls', forKey, rerollsRemaining });
        })
        .catch(() => {}); // the OCR engine was freed (capture stopped) while this was running
    }
  } else if (g.live && key === acceptedKey) {
    // The caption can update a beat after the cards do (or the first read can land mid-animation), so keep
    // re-reading it on the settled screen and post whenever the count changes. Throttled, one read at a time.
    const now = Date.now();
    if (!rerollBusy && now - rerollAt > 600) {
      rerollBusy = true;
      rerollAt = now;
      const forKey = key;
      readRerollsRemaining(img)
        .then((v) => {
          if (v !== rerollLast || forKey !== rerollKey) {
            rerollLast = v;
            rerollKey = forKey;
            post({ type: 'rerolls', forKey, rerollsRemaining: v });
          }
        })
        .catch(() => {})
        .finally(() => {
          rerollBusy = false;
        });
    }
  }
  if (!g.live) acceptedKey = '';
  lastKey = key;
  pendingSig = key ? sig : null;
  pendingReads = raw;
  pendingChoice = labels.choice;
  settledSig = key !== '' && key === acceptedKey ? sig : null;
  settledReads = reads;
  post({
    type: 'result',
    shop: true,
    round: labels.round,
    choice: labels.choice,
    reads,
    key,
    accepted,
    live: g.live,
    picked: g.picked,
    spent: g.spent,
    meta,
    inventory,
    ms: performance.now() - t0,
    stages,
  });
});

const nonShopResult = (t0: number): FrameResult => {
  forgetNames();
  lastKey = acceptedKey = lastInv = sentInv = '';
  settledSig = pendingSig = null;
  knownHero = null;
  acceptedRound = acceptedChoice = 0;
  gate = offScreenGate(gate);
  stableInv = null;
  return {
    type: 'result',
    shop: false,
    round: 0,
    choice: 0,
    reads: [],
    key: '',
    accepted: false,
    live: false,
    picked: null,
    spent: false,
    meta: null,
    inventory: null,
    ms: performance.now() - t0,
  };
};
