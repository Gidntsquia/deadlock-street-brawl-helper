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
  cardSquares,
  type CardRead,
  type DecodedIndex,
  type DraftMeta,
  type InventoryRead,
} from './recognise';
import { readCardName, readRerollsRemaining, terminateOCR, warmOCR, type NameCrop } from './ocr';
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
  | { type: 'seen' } // the probe saw the draft screen: no cards are read yet
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
// The game always draws the three cards at the same place and prints each item's exact name under it, so the name
// decides which item a card is. Each slot keeps a lock: the item its name line last read as, plus a fingerprint of that
// line's pixels. While the line looks the same, the slot is that item whatever the icon search says this frame (a hover
// glow, an animation, a search landing one step off): the per-frame icon wobble never reaches the gate or the overlay.
// A changed line (re-roll, next choice, a tooltip over it) is read again (~30 ms); only a clear read of another item
// moves the lock. Until a slot has its first lock it is "waiting" and the set is not offered to the gate, so a wrong
// icon guess is never advised first. Without a name list (CLI tools) or after a read failed, the icon guess stands.
const NAME_RETRY_MS = 700;
/** An icon match at least this good is trusted on its own; below it a card waits for its name. */
const SURE_SCORE = 0.8,
  SURE_MARGIN = 0.08;
/** A slot whose name reads keep failing falls back to its icon after this long, when the icon is a clear match. */
const NAME_GIVE_UP_MS = 1500;
interface SlotLock {
  id: number;
  sig: Uint8Array;
  enhanced: boolean;
  rare: boolean;
}
let locks: (SlotLock | null)[] = [null, null, null];
let nameFail: ({ sig: Uint8Array; at: number; since: number } | null)[] = [null, null, null];
const nameBusy = [false, false, false];
let nameChoice = 0,
  nameGen = 0; // bumped when locks are dropped, so a read started before that lands nowhere
const forgetNames = () => {
  locks = [null, null, null];
  nameFail = [null, null, null];
  nameChoice = 0;
  nameGen++;
};

// Fingerprint of a name line (the black-on-white OCR crop): ink share in a coarse grid over the text area.
const SIG_COLS = 32,
  SIG_ROWS = 4,
  CROP_PAD = 12; // cardNameCrop's white margin
const nameSig = (c: NameCrop): Uint8Array => {
  const out = new Uint8Array(SIG_COLS * SIG_ROWS);
  const w = c.width - 2 * CROP_PAD,
    h = c.height - 2 * CROP_PAD;
  const counts = new Uint32Array(out.length),
    totals = new Uint32Array(out.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k =
        Math.min(SIG_ROWS - 1, Math.floor((y * SIG_ROWS) / h)) * SIG_COLS +
        Math.min(SIG_COLS - 1, Math.floor((x * SIG_COLS) / w));
      totals[k]++;
      if (c.data[((y + CROP_PAD) * c.width + x + CROP_PAD) * 4] === 0) counts[k]++;
    }
  for (let k = 0; k < out.length; k++) out[k] = totals[k] ? Math.round((255 * counts[k]!) / totals[k]!) : 0;
  return out;
};
/** Same lettering: at most a few grid cells moved by more than a sixth. */
const sameName = (a: Uint8Array, b: Uint8Array) => {
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 42 && ++changed > 4) return false;
  return true;
};
/** A line with almost no ink shows no name (hidden, or the screen is mid-swap): nothing to read. */
const hasInk = (s: Uint8Array) => s.reduce((n, v) => n + v, 0) > 255 * 2;

/** The reads with each slot's item set from its name lock and its position pinned to the fixed card square;
 *  `waiting`: a slot's item is too unsure to offer the set to the gate; `pending`: a slot's name is still being read,
 *  so the set must not be accepted yet. Starts the name reads that are needed. */
const applyNames = (
  img: Parameters<typeof cardNameCrop>[0],
  raw: CardRead[],
  choice: number,
): { reads: CardRead[]; waiting: boolean; pending: boolean; slotSure: boolean[] } => {
  const squares = cardSquares(img.width, img.height);
  const pinned = raw.map((r, i) => ({ ...r, match: { ...r.match, ...squares[i]! } }));
  if (!names) return { reads: pinned, waiting: false, pending: false, slotSure: pinned.map((r) => r.present) };
  if (choice !== nameChoice) {
    forgetNames(); // the next choice's cards
    nameChoice = choice;
  }
  const list = names;
  const now = performance.now();
  let waiting = false,
    pending = false;
  // A slot is sure when its name is locked, or (no lock yet) its icon is a clear match. The fallback shows the rest as `?`.
  const slotSure = [false, false, false];
  const out = pinned.map((r, slot) => {
    const crop = cardNameCrop(img, r.match);
    const sig = crop ? nameSig(crop) : null;
    const lock = locks[slot];
    const sure = r.present && r.match.score >= SURE_SCORE && r.match.margin >= SURE_MARGIN;
    const asLock = (l: SlotLock): CardRead => ({
      ...r,
      present: true,
      itemId: l.id,
      tier: tiers[l.id] ?? r.tier,
      enhanced: l.enhanced,
      rare: l.rare,
      match: { ...r.match, itemId: l.id },
    });
    if (lock && sig && sameName(lock.sig, sig)) return asLock(lock);
    // The line changed (or is hidden): read it again unless that exact picture already failed a moment ago.
    const fail = nameFail[slot];
    const failedThis =
      !!fail && !!sig && fail.sig.length === sig.length && sameName(fail.sig, sig) && now - fail.at < NAME_RETRY_MS;
    if (!crop || !sig || !hasInk(sig)) {
      // nothing printed there to read: counts as a failed read, so a slot that never shows a name falls back in time
      if (!lock) nameFail[slot] = { sig: sig ?? new Uint8Array(0), at: now, since: fail?.since ?? now };
    } else if (!nameBusy[slot] && !failedThis) {
      nameBusy[slot] = true;
      const gen = nameGen,
        icon = r.present ? r.itemId : 0,
        t = now,
        enhanced = r.enhanced,
        rare = r.rare;
      readCardName(crop)
        .then((text) => {
          const m = matchItemName(text, list);
          const ms = performance.now() - t;
          post({ type: 'name', slot, icon, text, itemId: m?.itemId ?? 0, ms });
          if (gen !== nameGen) return;
          if (m) {
            const prev = locks[slot];
            locks[slot] = prev?.id === m.itemId ? { ...prev, sig } : { id: m.itemId, sig, enhanced, rare };
            nameFail[slot] = null;
          } else {
            const f = nameFail[slot];
            nameFail[slot] = { sig, at: performance.now(), since: f?.since ?? t };
          }
        })
        .catch(() => {}) // the OCR engine was freed (capture stopped) while this was running
        .finally(() => (nameBusy[slot] = false));
    }
    if (lock) {
      // A changed line under a lock is a hover/tooltip far more often than a new card. Only an icon that surely shows
      // another item (a re-roll) makes the slot unsettled until its name is read.
      if (sure && r.itemId !== lock.id) {
        waiting = true;
        return r;
      }
      slotSure[slot] = true;
      return asLock(lock);
    }
    // No lock yet. A sure icon offers its set to the gate so the settle time runs while the name is read (`pending`
    // holds the accept until it is in); a shaky one keeps the set out. After the name has failed to read for a while,
    // the icon guess stands.
    const f = nameFail[slot];
    // Only a clear icon stands on its own once the name will not read: a shaky guess is never put on screen.
    if (f && now - f.since > NAME_GIVE_UP_MS && r.present && sure) {
      slotSure[slot] = true;
      return r;
    }
    pending = true;
    if (!sure) waiting = true;
    else slotSure[slot] = true;
    return r;
  });
  return { reads: out, waiting, pending, slotSure };
};
let lastKey = '',
  acceptedKey = '';
let lastInv = '',
  sentInv = '';
let stableInv: number[] | null = null; // the last inventory read two frames agreed on
let gate = initialGate();
// The "N Re-Roll Remaining" caption, read for the set on screen before that set is accepted (so the advice never
// starts as "take" and flips to "re-roll" when the read lands), then re-read while it stays up: the caption can
// update a beat after the cards. A new value is taken only when two re-reads in a row agree on it.
const REROLL_REREAD_MS = 600;
let rr: { set: string; value: number | null; next: number | null; busy: boolean; at: number } = {
  set: '',
  value: null,
  next: null,
  busy: false,
  at: 0,
};
let rrGen = 0;
const forgetRerolls = () => {
  rr = { set: '', value: null, next: null, busy: false, at: 0 };
  rrGen++;
};
/** Starts a caption read for the set `set` when one is due; `onChange` runs when a re-read moves the settled value. */
const readRerolls = (img: Parameters<typeof readRerollsRemaining>[0], set: string, onChange: (v: number) => void) => {
  if (rr.set !== set) (forgetRerolls(), (rr.set = set));
  const now = performance.now();
  if (rr.busy || (rr.value !== null && now - rr.at < REROLL_REREAD_MS)) return;
  rr.busy = true;
  rr.at = now;
  const gen = rrGen;
  readRerollsRemaining(img)
    .then((v) => {
      if (gen !== rrGen) return;
      if (rr.value === null) rr.value = v;
      else if (v === rr.value) rr.next = null;
      else if (rr.next === v) {
        rr.value = v;
        rr.next = null;
        onChange(v);
      } else rr.next = v;
    })
    .catch(() => {}) // the OCR engine was freed (capture stopped) while this was running
    .finally(() => {
      if (gen === rrGen) rr.busy = false;
    });
};

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
/** Without a sure read of all three cards this long after the draft screen (or a new set) appeared, the sure cards are
 *  advised and each other card shows a grey `?`. */
export const FALLBACK_MS = 2500;
let readingSince: number | null = null; // when the current not-yet-accepted screen was first seen
let frozenReads: CardRead[] | null = null; // the accepted set's reads, sent unchanged for as long as the set is live

const forgetDraft = () => {
  forgetNames();
  lastKey = acceptedKey = lastInv = sentInv = '';
  forgetRerolls();
  wasShop = false;
  offFrames = 0;
  settledSig = pendingSig = null;
  knownHero = null;
  acceptedRound = acceptedChoice = 0;
  readingSince = frozenReads = null;
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
      post({ type: 'seen' }); // the page can show its `Reading` sign before the first full frame is read
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
  const nowMs = performance.now();
  if (!gate.live && readingSince === null) readingSince = nowMs;
  // Fallback: no sure set within FALLBACK_MS. The sure cards are advised, the others become `?`. Never for a set the
  // player already picked from (its cards read sure, so it never gets here with its own key).
  const fullKey = seen === 3 ? reads.map((r) => `${r.itemId}${r.enhanced ? '+' : ''}`).join(',') : '';
  const fbDue =
    !gate.live &&
    readingSince !== null &&
    nowMs - readingSince >= FALLBACK_MS &&
    !gate.spent.some((k) => fullKey && k.replace(/\+/g, '') === fullKey.replace(/\+/g, ''));
  const fbReads = reads.map((r, i) =>
    named.slotSure[i] && r.present ? r : { ...r, present: true, unsure: true, itemId: 0, tier: 0, enhanced: false },
  );
  const fbKey = fbDue ? fbReads.map((r) => (r.unsure ? '?' : `${r.itemId}${r.enhanced ? '+' : ''}`)).join(',') : '';
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
    if (ik === lastInv) stableInv = ids;
    lastInv = ik;
  } else if (!key) lastInv = '';
  // The re-roll caption is read for every full set (its own key: the '+' flags wobble), and the gate holds the accept
  // until it is in, so the first advice already knows whether a re-roll is left.
  const set = key ? `${labels.choice}|${key.replace(/\+/g, '')}` : '';
  if (set)
    readRerolls(img, set, (v) => {
      if (acceptedKey) post({ type: 'rerolls', forKey: acceptedKey, rerollsRemaining: v });
    });
  // The gate decides when this screen is settled enough to advise on, and spots the player's selection.
  const inFallback = !!gate.last && gate.live && gate.last.key.includes('?');
  const g = stepGate(gate, {
    ready: !named.pending && (!set || (rr.set === set && rr.value !== null)),
    key: fbDue ? fbKey : key,
    force: fbDue,
    present: reads
      .filter((r, i) => r.present && (!inFallback || named.slotSure[i]))
      .map((r) => r.itemId),
    round: labels.round,
    choice: labels.choice,
    now: performance.now(),
    inventory: stableInv,
  });
  gate = g.state;
  if (g.live && gate.last) acceptedRound = gate.last.round;
  const accepted = g.accept;
  if (accepted) {
    readingSince = null;
    frozenReads = fbDue ? fbReads : reads;
    acceptedKey = key;
    acceptedChoice = labels.choice;
    acceptedRound = labels.round;
    const bsig = barSig(img);
    if (!knownHero && matchBar && sameBar(matchBar.sig, bsig)) knownHero = matchBar;
    meta = stage('meta', () => readDraftMeta(img, idx, knownHero ?? undefined, true));
    if (meta.self) matchBar = { bar: meta.bar, self: meta.self, sig: bsig };
    // the hero bar is constant while the draft screen stays up; keep it until the screen closes (nonShopResult)
    knownHero = meta.self ? { bar: meta.bar, self: meta.self } : null;
    meta.rerollsRemaining = rr.value ?? meta.rerollsRemaining;
  }
  // The owned list changes the scores, so it reaches the page with the accepted set and not again while that set is up
  // (the player cannot gain an item without leaving it): a grid read that wobbles never re-ranks the cards on screen.
  if (stableInv && (accepted || !g.live)) {
    const ik = stableInv.join(',');
    if (ik !== sentInv) {
      sentInv = ik;
      inventory = stableInv;
    }
  }
  if (!g.live) {
    acceptedKey = '';
    frozenReads = null;
  }
  // The accepted set is sent as it was accepted until it stops being live: nothing about it moves with the hover.
  const sent = g.live && frozenReads ? frozenReads : reads;
  if (g.live && fbDue) acceptedKey = fbKey;
  lastKey = key;
  pendingSig = key ? sig : null;
  pendingReads = raw;
  pendingChoice = labels.choice;
  settledSig = key !== '' && key === acceptedKey ? sig : null;
  settledReads = sent;
  post({
    type: 'result',
    shop: true,
    round: labels.round,
    choice: labels.choice,
    reads: sent,
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
  readingSince = frozenReads = null;
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
