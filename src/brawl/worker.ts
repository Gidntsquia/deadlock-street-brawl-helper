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
  cardEmpty,
  cardNameCrop,
  readMarkers,
  quickGuess,
  cardSquares,
  type CardRead,
  type DecodedIndex,
  type DraftMeta,
  type InventoryRead,
} from './recognise';
import { readCardName, readRerollsRemaining, terminateOCR, warmOCR, type NameCrop } from './ocr';
import { matchItemName, nameList, type NameList } from './names';
import { initialGate, offScreenGate, stepGate } from './draftGate';
import { setLocked } from './brawlState';
import { createTracker, type TrackOut } from './tracker';
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
  | { type: 'roundStart'; round: number } // the round banner probe hit: warm the OCR, log round.start
  | { type: 'forceResync' } // F8: start from the next frame's labels again
  | { type: 'advised'; itemId: number | null } // the card the overlay told the player to take (null: re-roll or none)
  | { type: 'idle' } // the page had no frame ready for the last tick
  | { type: 'reset' } // capture (re)started: forget the last draft and start ticking again
  | { type: 'stop' }; // capture stopped: forget the last draft (the OCR engines are freed after OCR_KEEP_MS); the worker then stays silent

/** The worker paces the capture: it asks the page for a frame, reads it, waits, asks again. Page timers are
 *  throttled to once a second (Chrome: once a minute after five minutes) while the game has the foreground and the
 *  browser tab is hidden; worker timers are not, so the advice keeps updating without alt-tabbing. */
export type WorkerOut =
  | FrameResult
  | { type: 'load'; slow: boolean } // this machine reads frames slowly: the page lowers its frame rate
  | { type: 'seen' } // the probe saw the draft screen: no cards are read yet
  | { type: 'tick'; full: boolean } // full: send a whole frame; otherwise just the probe crop
  | { type: 'rerolls'; forKey: string; rerollsRemaining: number }
  | ({ type: 'track' } & TrackOut) // the state machine moved outside a frame (a round started)
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
  track?: TrackOut; // the state machine's summary and log lines, when something happened since the last result
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
// A changed line (re-roll, next choice, a tooltip over it) is read again (~30 ms). Hovering a card grows it and the
// game's tooltip covers the next card's name line, often with an item name of its own, so a changed line under a lock
// is a hover and keeps the lock: only after a re-roll (two name lines blank in one frame as the cards fade, or the
// re-roll count dropping) does a clear read of another item move the lock. Until a slot has its first lock it is "waiting" and the set is not offered to the gate, so a wrong
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
  /** Set from the icon alone, before the name was read: the name read confirms it, or moves it whatever the state. */
  provisional?: boolean;
}
let locks: (SlotLock | null)[] = [null, null, null];
let nameFail: ({ sig: Uint8Array; at: number; since: number } | null)[] = [null, null, null];
const quickSeen: ({ id: number; sig: Uint8Array } | null)[] = [null, null, null];
const nameBusy = [false, false, false];
let nameChoice = 0,
  nameGen = 0; // bumped when locks are dropped, so a read started before that lands nowhere
/** For this long after a re-roll is seen, a changed name line is a new card rather than a hover. */
const REROLL_WINDOW_MS = 600;
let rerollAt: number | null = null; // when the cards were last seen re-rolling (this choice)
const rerolling = (now: number) => rerollAt !== null && now - rerollAt < REROLL_WINDOW_MS;
/** The locked cards are the set being advised for this choice: only then is other lettering under a lock a hover. Right
 *  after the CHOICE label moves on, the gate can still hold the previous choice's set as live. */
const advising = () => gate.live && acceptedChoice === nameChoice;
const dropLocks = () => {
  locks = [null, null, null];
  nameFail = [null, null, null];
  quickSeen.fill(null);
  nameGen++;
  lockFp.fill(null);
};
const forgetNames = () => {
  dropLocks();
  nameChoice = 0;
  rerollAt = null;
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
const nameCellsMoved = (a: Uint8Array, b: Uint8Array) => {
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 42) changed++;
  return changed;
};
const sameName = (a: Uint8Array, b: Uint8Array) => nameCellsMoved(a, b) <= 4;
/** Different lettering, not a hover over the same name: well over the hover tolerance moved, as when a re-roll prints
 *  another item. With no icon to tell, this is what makes a slot unsettled at once. */
const otherName = (a: Uint8Array, b: Uint8Array) => a.length === b.length && nameCellsMoved(a, b) > OTHER_NAME_CELLS;
const OTHER_NAME_CELLS = 6;
/** A line with almost no ink shows no name (hidden, or the screen is mid-swap): nothing to read. */
const hasInk = (s: Uint8Array) => s.reduce((n, v) => n + v, 0) > 255 * 2;

/** The reads with each slot's item set from its name lock and its position pinned to the fixed card square;
 *  `waiting`: a slot's item is too unsure to offer the set to the gate; `pending`: a slot's name is still being read,
 *  so the set must not be accepted yet. Starts the name reads that are needed. */
const applyNames = (
  img: Parameters<typeof cardNameCrop>[0],
  raw: CardRead[],
  choice: number,
): {
  reads: CardRead[];
  waiting: boolean;
  pending: boolean;
  slotSure: boolean[];
  changed: boolean;
  inked: boolean;
  cardsUp: boolean;
  empty: number; // card circles showing no card
  sigs: (Uint8Array | null)[];
} => {
  const squares = cardSquares(img.width, img.height);
  // The RARE / ENHANCED marks are read at the fixed card square too: the icon search's wobble (an enhanced icon
  // matches poorly) must not move the box off the label.
  const pinned = raw.map((r, i) => {
    const match = { ...r.match, ...squares[i]! };
    if (!r.present) return { ...r, match };
    const mk = readMarkers(img, match);
    return { ...r, match, rare: mk.rare, enhanced: mk.enhanced };
  });
  const iconless = raw.every((r) => !r.present && r.match.score === 0); // see squareReads
  if (!names)
    return {
      reads: pinned,
      waiting: false,
      pending: false,
      slotSure: pinned.map((r) => r.present),
      changed: false,
      inked: false,
      cardsUp: false,
      empty: 0,
      sigs: [null, null, null],
    };
  if (choice !== nameChoice) {
    forgetNames(); // the next choice's cards
    nameChoice = choice;
  }
  const list = names;
  const now = performance.now();
  let waiting = false,
    pending = false,
    changed = false,
    inked = true;
  // A slot is sure when its name is locked, or (no lock yet) its icon is a clear match. The fallback shows the rest as `?`.
  const slotSure = [false, false, false];
  const crops = pinned.map((r) => cardNameCrop(img, r.match));
  const sigs = crops.map((c) => (c ? nameSig(c) : null));
  // The cards fading out for a re-roll: two locked name lines blank at once (a hover blanks at most the one it grows).
  // Two locked cards' circles are empty (a hover only hides name lines, it leaves the icons): those cards are gone, and with them every lock: whatever comes next is a new set (a card still showing may be a new
  // one drawn over the old, or hidden by a tooltip, and must not keep the old item).
  const emptyCount = squares.filter((sq) => cardEmpty(img, sq)).length;
  if ((gate.live || locks.some(Boolean)) && emptyCount >= 2) {
    rerollAt = now;
    dropLocks();
    changed = true;
  }
  // A clear icon at the fixed square names the card at once, so the set can settle while the name is read: on a slow PC the
  // name reads (three wasm engines on one core) were the whole wait. The name read below confirms or overrules the guess.
  let quick: number[] | null = null;
  const out = pinned.map((r, slot) => {
    const crop = crops[slot] ?? null;
    const sig = sigs[slot] ?? null;
    if (!sig || !hasInk(sig)) inked = false;
    let lock = locks[slot];
    // A guess made from the icon belongs to the picture it was made on: when the name line moves (the cards fading out
    // or in, a new card where the old one was) the guess is dropped and made again.
    if (lock?.provisional && sig && !sameName(lock.sig, sig)) lock = locks[slot] = null;
    if (!lock && sig && hasInk(sig) && index && !(nameFail[slot] && hasInk(nameFail[slot]!.sig))) {
      quick ??= quickGuess(img, index, squares);
      const id = quick[slot]!;
      // The guess must hold on two frames in a row with the name line still: a card is not fully drawn while it fades.
      const before = quickSeen[slot];
      quickSeen[slot] = id ? { id, sig } : null;
      // With the other two cards already read by name, the last card's clear icon stands at once: waiting a second frame
      // for it cost a frame interval (and its name read) on every set; the name read confirms it once the set is live.
      const lastCard = locks.filter((l, i) => i !== slot && l && !l.provisional).length >= 2;
      if (id && ((before?.id === id && sameName(before.sig, sig)) || lastCard))
        lock = locks[slot] = { id, sig, enhanced: r.enhanced, rare: r.rare, provisional: true };
    } else if (!lock) quickSeen[slot] = null;
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
    // A mark that shows up after the lock (the label draws a beat after the card) is added to it, never removed.
    if (lock && (r.present ? r.itemId === lock.id : iconless)) {
      lock.enhanced ||= r.enhanced;
      lock.rare ||= r.rare;
    }
    if (lock && !lock.provisional && sig && sameName(lock.sig, sig)) {
      slotSure[slot] = true;
      return asLock(lock);
    }
    // The line changed (or is hidden): read it again unless that exact picture already failed a moment ago.
    const fail = nameFail[slot];
    const failedThis =
      !!fail && !!sig && fail.sig.length === sig.length && sameName(fail.sig, sig) && now - fail.at < NAME_RETRY_MS;
    if (!crop || !sig || !hasInk(sig)) {
      // nothing printed there to read: counts as a failed read, so a slot that never shows a name falls back in time
      if (!lock) nameFail[slot] = { sig: sig ?? new Uint8Array(0), at: now, since: fail?.since ?? now };
    } else if (!nameBusy[slot] && !failedThis && (!lock?.provisional || gate.live)) {
      // (a guess from the icon is confirmed after the set is advised: the OCR threads would take the frames' CPU while it settles)
      nameBusy[slot] = true;
      const fp0 = sigFp(slot, sig);
      // What the icon says right now: a hover tooltip covers the name line with another item's text, never the icon.
      const iconNow = lock && index ? quickGuess(img, index, [squares[slot]!])[0]! : 0;
      const lockBefore = locks[slot],
        gen = nameGen,
        seq = frameSeq,
        icon = r.present ? r.itemId : 0,
        t = now,
        enhanced = r.enhanced,
        rare = r.rare;
      track(readCardName(crop, slot))
        .then((text) => {
          const m = matchItemName(text, list);
          const ms = performance.now() - t;
          post({ type: 'name', slot, icon, text, itemId: m?.itemId ?? 0, ms });
          if (gen !== nameGen) return;
          const prev = locks[slot];
          const twin = m ? locks.findIndex((l, i) => i !== slot && l?.id === m.itemId) : -1;
          if (twin >= 0 && !gate.live) {
            // A draft never offers one item twice: one of the two lines showed the hover tooltip's title (the hovered
            // card's name). Before the set is advised, both slots are read again; neither picture is re-read at once.
            const at = performance.now();
            nameFail[twin] = { sig: locks[twin]!.sig, at, since: nameFail[twin]?.since ?? at };
            nameFail[slot] = { sig, at, since: nameFail[slot]?.since ?? t };
            locks[twin] = locks[slot] = null;
          } else if (
            m &&
            ((prev && !prev.provisional && prev.id !== m.itemId && advising() && !rerolling(performance.now())) ||
              (prev && iconNow === prev.id && prev.id !== m.itemId) ||
              twin >= 0)
          ) {
            // another item's name over the advised card without a re-roll: the hover tooltip's title. Keep the lock, and
            // do not read this same picture again for a moment. Before the accept the lock moves: the game swaps the
            // CHOICE label a beat before the cards, so the first lock can be the previous choice's card.
            nameFail[slot] = { sig, at: performance.now(), since: nameFail[slot]?.since ?? t };
          } else if (m) {
            locks[slot] =
              prev?.id === m.itemId ? { ...prev, sig, provisional: false } : { id: m.itemId, sig, enhanced, rare };
            nameFail[slot] = null;
            if (fp0) {
              if (!prev || prev.id !== m.itemId || !lockFp[slot]) lockFp[slot] = fp0;
              tracker.feed({ type: 'cardRead', slot: slot as 0 | 1 | 2, fp: fp0, itemId: m.itemId });
            }
          } else {
            const f = nameFail[slot];
            nameFail[slot] = { sig, at: performance.now(), since: f?.since ?? t };
          }
        })
        .catch(() => {}) // the OCR engine was freed (capture stopped) while this was running
        .finally(() => {
          nameBusy[slot] = false;
          if (gen === nameGen && locks[slot] !== lockBefore) restepSoon(seq);
        });
    }
    if (lock) {
      // A changed line under a lock is a hover/tooltip unless the cards were just seen re-rolling. Only then does an
      // icon that surely shows another item, or other lettering, make the slot unsettled until its name is read.
      // (other lettering alone is not enough: the cursor's tooltip covers a line too. The icon must show another item.)
      if (
        rerolling(now) &&
        ((sure && r.itemId !== lock.id) ||
          (iconless &&
            sig &&
            hasInk(sig) &&
            otherName(lock.sig, sig) &&
            !!index &&
            ((g) => g !== 0 && g !== lock.id)(quickGuess(img, index, [squares[slot]!])[0]!)))
      ) {
        waiting = true;
        changed = true;
        return r;
      }
      // Before the accept, other lettering under a lock may be the real card replacing the previous choice's: hold the
      // accept until that picture has been read (a hover tooltip's title is caught by the twin check).
      if (!advising() && !lock.provisional && sig && hasInk(sig) && otherName(lock.sig, sig) && !failedThis)
        pending = true;
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
  return { reads: out, waiting, pending, slotSure, changed, inked, sigs, cardsUp: emptyCount <= 1, empty: emptyCount };
};
/** The three cards at their fixed squares with no icon search: the item comes from the name lock alone (the name
 *  under a card is exact; the icon search was the slowest part of the first read). Only the RARE / ENHANCED marks are
 *  read here, from the fixed square. */
const squareReads = (img: Parameters<typeof cardNameCrop>[0]): CardRead[] =>
  cardSquares(img.width, img.height).map((sq, i) => {
    const match = { itemId: 0, score: 0, margin: 0, ...sq };
    const mk = readMarkers(img, match);
    return {
      card: ['left', 'top', 'right'][i]!,
      match,
      present: false,
      itemId: 0,
      tier: 0,
      rare: mk.rare,
      enhanced: mk.enhanced,
    };
  });
let lastKey = '',
  lastSetKey = '',
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
/** Two card keys name the same cards; a `?` (a name still being read) stands for whatever the other has there. */
const sameCards = (a: string, b: string) => {
  if (!a || !b) return false;
  const x = a.replace(/\+/g, '').split(','),
    y = b.replace(/\+/g, '').split(',');
  return x.length === y.length && x.every((v, i) => v === y[i] || v === '?' || y[i] === '?');
};
const sameRerollSet = (a: string, b: string) => {
  const [ca, ka] = a.split('|'),
    [cb, kb] = b.split('|');
  return ca === cb && sameCards(ka ?? '', kb ?? '');
};
const readRerolls = (img: Parameters<typeof readRerollsRemaining>[0], set: string, onChange: (v: number) => void) => {
  // The read started on the provisional set (a `?` per unread name) carries over once the names fill it in.
  if (rr.set !== set && !sameRerollSet(rr.set, set)) forgetRerolls();
  rr.set = set;
  const now = performance.now();
  if (rr.busy || (rr.value !== null && now - rr.at < REROLL_REREAD_MS)) return;
  rr.busy = true;
  rr.at = now;
  const gen = rrGen,
    seq = frameSeq,
    before = rr.value;
  track(readRerollsRemaining(img))
    .then((v) => {
      if (gen !== rrGen) return;
      if (rr.value === null) {
        rr.value = v;
        tracker.feed({ type: 'caption', rerollsLeft: v });
        if (acceptedKey) onChange(v); // read after the accept (a match's first set): the page assumed one re-roll
      } else if (v === rr.value) rr.next = null;
      else if (rr.next === v) {
        if (v < rr.value) rerollAt = performance.now(); // a re-roll was spent: the cards are being replaced
        rr.value = v;
        rr.next = null;
        tracker.feed({ type: 'caption', rerollsLeft: v });
        onChange(v);
      } else rr.next = v;
    })
    .catch(() => {}) // the OCR engine was freed (capture stopped) while this was running
    .finally(() => {
      if (gen === rrGen) {
        rr.busy = false;
        if (rr.value !== before) restepSoon(seq);
      }
    });
};

let intervalMs = 250;
// Off the shop screen there's nothing to react to quickly -- poll much slower, and only read the small
// "CHOICE n OF 3" crop, until the shop reappears.
const IDLE_INTERVAL_MS = 300;
// Once the draft screen's cards, round and choice are all settled, only a change matters: look less often.
const SETTLED_INTERVAL_MS = 250;
// Load adapter: a moving average of what a full frame read costs. Over SLOW_ENTER_MS the machine is struggling: the
// settled interval doubles and the page is told to lower its frame rate; back under SLOW_EXIT_MS it recovers.
const SLOW_ENTER_MS = 150;
const SLOW_EXIT_MS = 90;
let readEma = 0;
let slow = false;
const noteReadMs = (ms: number) => {
  readEma = readEma === 0 ? ms : readEma * 0.7 + ms * 0.3;
  const next = slow ? readEma > SLOW_EXIT_MS : readEma > SLOW_ENTER_MS;
  if (next !== slow) {
    slow = next;
    post({ type: 'load', slow });
  }
};
const settledInterval = () => (slow ? SETTLED_INTERVAL_MS * 2 : SETTLED_INTERVAL_MS);
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
/** Two cards read and the third circle is full but unreadable (the hover tooltip covers it): a shorter wait. */
const FALLBACK_COVERED_MS = 1200;
let readingSince: number | null = null; // when the cards on the not-yet-accepted screen last changed (or were first seen)
let lastSpent = false; // the previous frame showed a set a pick was already made from: its cards leaving is not a new set to wait on
let readingFirst: number | null = null; // when the not-yet-accepted screen was first seen
let readingCardsSig: Uint8Array | null = null; // the card pictures at readingSince
/** The fallback clock restarts while the three card pictures are still changing (the swap animation after a pick or
 *  re-roll), but never runs past this long from the first sight. */
const FALLBACK_MAX_MS = 6000;
let earlyMeta: { sig: Uint8Array; meta: DraftMeta } | null = null; // the hero bar read before the accept
let frozenReads: CardRead[] | null = null; // the accepted set's reads, sent unchanged for as long as the set is live

const forgetDraft = () => {
  forgetNames();
  lastKey = lastSetKey = acceptedKey = lastInv = sentInv = '';
  forgetRerolls();
  wasShop = false;
  offFrames = 0;
  settledSig = pendingSig = null;
  knownHero = null;
  acceptedRound = acceptedChoice = 0;
  readingSince = readingFirst = readingCardsSig = frozenReads = earlyMeta = null;
  gate = initialGate();
  stableInv = null;
  lastFull = null;
};
// Dev builds only (`import.meta.env.DEV` is false in a production build, so this all folds away): milliseconds per
// recogniser stage, sent back on each result for the page's perf summary.
const DEV = import.meta.env?.DEV;
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

// ---- the Street Brawl state machine, following what the reading sees ---------------------------------------------
// brawlState.ts holds match, round, choice, re-roll used, the three slots and the owned list. The reading above is what
// sees the screen; the machine gets its facts as named events (`trackFrame`, the name-read callback) and answers with
// the things the page shows: `Resynced to round N choice M`, a re-roll used this round, per-slot read counts, where each
// pick came from. It never changes what is advised.
const tracker = createTracker(() => warmOCR());
const slotFp: { sig: Uint8Array | null; n: number }[] = [0, 1, 2].map(() => ({ sig: null, n: 0 }));
/** The fingerprint id of a slot while its lock stands: a hover changes the line but not the card. */
const lockFp: (string | null)[] = [null, null, null];
let advisedId: number | null = null;
let blankAt: number | null = null;
let forcePending = false;
/** After a pick or re-roll the lines are told apart from the old set's, even when the same item is dealt again. */
const PICK_WAIT_MS = 400;
const sigFp = (slot: number, sig: Uint8Array | null): string | null => {
  if (!sig || !hasInk(sig)) return null;
  const f = slotFp[slot]!;
  if (!f.sig || !sameName(f.sig, sig)) {
    f.sig = sig;
    f.n++;
  }
  return `${slot}:${f.n}`;
};
const resetFps = () => {
  for (const f of slotFp) f.sig = null;
  lockFp.fill(null);
  blankAt = null;
};
const slotIds = [0, 1, 2] as const;

/** A screen identical to the last one (the settled shortcut): only the pick wait can run out. */
function trackIdle(now: number) {
  const st = tracker.state();
  if (blankAt === null || !setLocked(st) || st.phase !== 'drafting' || now - blankAt < PICK_WAIT_MS) return;
  tracker.feed({ type: 'linesBlank' });
  resetFps();
}

/** Feeds the machine this frame's facts, in the order the game produces them: a closing set first (pick or re-roll),
 *  then the label, then the lines of the new set. */
function trackFrame(
  labels: { round: number; choice: number },
  named: { sigs: (Uint8Array | null)[] },
  g: { picked: number | null },
  now: number,
  stable: number[] | null,
) {
  let st = tracker.state();
  let round = labels.round;
  if (!round && st.round) round = st.round + (labels.choice === 1 && st.choice === 3 ? 1 : 0);
  const sigs = named.sigs;
  const blankAll = sigs.every((x) => !x || !hasInk(x));
  const differs = round > 0 && st.round > 0 && (round !== st.round || labels.choice !== st.choice);
  const advance =
    differs &&
    ((round === st.round && labels.choice === st.choice + 1) ||
      (round === st.round + 1 && labels.choice === 1 && st.choice === 3));
  const pick = (itemId: number | null, source: 'read' | undefined) => {
    tracker.feed({ type: 'pick', itemId, advised: advisedId, source });
    resetFps();
  };
  if (setLocked(st) && st.phase === 'drafting') {
    if (g.picked !== null) pick(g.picked, 'read');
    else if (advance) pick(null, undefined);
    else if (!differs && blankAll) {
      blankAt ??= now;
      if (now - blankAt >= PICK_WAIT_MS) {
        tracker.feed({ type: 'linesBlank' });
        resetFps();
      }
    } else if (!differs && blankAt !== null) {
      // the lines are back: the same cards (a blink) or new ones (a re-roll under the same label)
      const same = sigs.every((x, i) => x && slotFp[i]!.sig && sameName(slotFp[i]!.sig!, x));
      blankAt = null;
      if (!same) {
        tracker.feed({ type: 'linesBlank' });
        resetFps();
      }
    }
  }
  if (round > 0) {
    const before = tracker.state().resyncs;
    tracker.feed({ type: 'label', round, choice: labels.choice });
    if (tracker.state().round !== st.round || tracker.state().choice !== st.choice) resetFps();
    if (forcePending) {
      forcePending = false;
      if (tracker.state().resyncs === before) tracker.feed({ type: 'forceResync' });
      resetFps();
    }
  }
  st = tracker.state();
  for (const slot of slotIds) {
    const fp = lockFp[slot] && locks[slot] ? lockFp[slot] : sigFp(slot, sigs[slot] ?? null);
    if (!fp) continue;
    tracker.feed({ type: 'cardLine', slot, fp });
    const cur = tracker.state().slots[slot];
    const lock = locks[slot],
      sig = sigs[slot];
    // the worker already holds this name (a resync, or a re-dealt card): the slot locks without a read
    if (cur.kind === 'landing' && cur.fp === fp && lock && !lock.provisional && sig && sameName(lock.sig, sig)) {
      lockFp[slot] = fp;
      tracker.feed({ type: 'cardRead', slot, fp, itemId: lock.id, fromLock: true });
    }
  }
  st = tracker.state();
  if (stable && st.gridCheck && setLocked(st)) tracker.feed({ type: 'ownedGrid', ids: stable });
}

const post = (m: WorkerOut) => (self as unknown as { postMessage(m: unknown): void }).postMessage(m);
let timer: ReturnType<typeof setTimeout> | undefined;
// Capture stops between rounds, and loading the OCR engines again on the next draft took longer than FALLBACK_MS on a
// PC running the game: the first cards of a round came up as `?`. The engines stay loaded this long after a stop.
const OCR_KEEP_MS = 10 * 60_000;
let ocrFree: ReturnType<typeof setTimeout> | undefined;
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
    clearTimeout(ocrFree);
    ocrFree = setTimeout(() => void terminateOCR(), OCR_KEEP_MS);
    (ocrFree as { unref?: () => void }).unref?.(); // Node (tests, CLI): never keep the process alive for it
    return;
  }
  if (msg.type === 'warm') {
    // Sent when the app opens, long before a draft: decode the icon index now so the first frame does not.
    index ??= decodeIconIndex(msg.index);
    tiers = msg.tiers;
    setNames(msg.names);
    // Load the OCR engines now too: on a slow PC they take seconds to start, which used to land inside the first
    // draft's 2.5 s. (They are freed OCR_KEEP_MS after a 'stop', and loaded again by the next 'init'/'reset'.)
    warmOCR();
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
    clearTimeout(ocrFree);
    warmOCR(); // capture only runs around the draft now: load the OCR engines with it (freed OCR_KEEP_MS after 'stop')
    // Capture is started for a draft (the probe saw the CHOICE glyph, F8, test mode): ask for a whole frame at once rather
    // than a probe crop first. A frame that is not a draft falls back to probing in its own handler.
    tick(0, msg.type === 'reset');
    return;
  }
  if (msg.type === 'roundStart') {
    tracker.feed({ type: 'roundStart', round: msg.round });
    resetFps();
    const t = tracker.take();
    if (t) post({ type: 'track', ...t });
    return;
  }
  if (msg.type === 'forceResync') {
    forcePending = true;
    return;
  }
  if (msg.type === 'advised') {
    advisedId = msg.itemId;
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
  draftFrame(msg, t0, idx);
});

// The last full draft frame, so a name or caption read that lands before the set is accepted can be acted on at once
// instead of waiting a whole frame interval (about 300 ms at x4 CPU) for the next picture.
let lastFull: { msg: Extract<WorkerIn, { type: 'frame' }>; idx: DecodedIndex; seq: number } | null = null;
let frameSeq = 0;
let restepping = false;
const restep = (seq: number) => {
  if (!lastFull || lastFull.seq !== seq || frameSeq !== seq || gate.live) return;
  restepping = true;
  try {
    draftFrame(lastFull.msg, performance.now(), lastFull.idx);
  } finally {
    restepping = false;
  }
};
/** Re-runs the frame the read was started on, once the read has landed (and only if no newer frame came). */
/** A frame is re-run at most this many times (a lock dropped again by the frame itself must not loop). */
const MAX_RESTEPS = 3;
let restepsDone = 0;
const restepSoon = (seq: number) => {
  if (restepsDone >= MAX_RESTEPS) return;
  restepsDone++;
  restepsDue++;
  setTimeout(() => {
    restepsDue--;
    restep(seq);
  }, 0);
};
// Reads in flight (name lines, the re-roll caption). Tests and the replay tool wait on them to model a machine that
// finishes each read before the next picture arrives.
const inflight = new Set<Promise<unknown>>();
let restepsDue = 0;
export const readsIdle = async (): Promise<void> => {
  while (inflight.size || restepsDue) {
    await Promise.allSettled([...inflight]);
    await new Promise((r) => setTimeout(r, 0));
  }
};
const track = <T>(p: Promise<T>): Promise<T> => {
  inflight.add(p);
  const done = () => inflight.delete(p);
  p.then(done, done);
  return p;
};

function draftFrame(msg: Extract<WorkerIn, { type: 'frame' }>, t0: number, idx: DecodedIndex) {
  if (!restepping) {
    lastFull = { msg, idx, seq: ++frameSeq };
    restepsDone = 0;
  }
  stages = DEV ? {} : undefined;
  const img = stage('paste', () => pasteRegions(msg.width, msg.height, msg.regions));
  // Skip card/inventory recognition entirely off the shop screen (menus, gameplay, the round-end transition
  // into the next shop) -- isShopScreen is one small glyph read instead of three full icon searches.
  const labels = stage('labels', () => readRoundChoice(img));
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
  const sig = stage('sig', () => frameSig(msg.regions));
  if (
    acceptedKey &&
    acceptedKey === lastKey &&
    labels.choice === acceptedChoice &&
    (labels.round === 0 || labels.round === acceptedRound) &&
    sameSig(settledSig, sig)
  ) {
    trackIdle(performance.now());
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
      track: tracker.take() ?? undefined,
      ms: performance.now() - t0,
      stages,
    });
    tick(settledInterval(), true);
    return;
  }
  // A new picture is about to be read: ask for the next frame now, so the page copies it while this one is being read
  // (the two-frame check below then finds it waiting instead of paying copy + hop after the read). One tick per frame:
  // the end of this handler does not tick again.
  if (!restepping) {
    clearTimeout(timer);
    post({ type: 'tick', full: true });
  }
  // A frame that looks the same as the one that just produced a full set of cards (and carries the same choice
  // label) confirms that read without repeating the expensive icon search: a new screen is accepted a frame sooner.
  const confirmed = lastKey !== '' && pendingChoice === labels.choice && sameSig(pendingSig, sig);
  const raw = names
    ? stage('cards', () => squareReads(img))
    : confirmed
      ? pendingReads
      : stage('cards', () => readDraftScreen(img, idx, (id) => tiers[id] ?? 0));
  const named = stage('names', () => applyNames(img, raw, labels.choice));
  const reads = named.reads;
  const seen = reads.filter((r) => r.present).length;
  // A set with a shaky card whose name is still being read is not a full set yet: the gate must not settle on it.
  const key = seen === 3 && !named.waiting ? reads.map((r) => `${r.itemId}${r.enhanced ? '+' : ''}`).join(',') : '';
  // While the names are still being read, the gate already gets the set with a `?` for each unread slot, so its settle
  // time runs alongside the OCR instead of starting after it (a `?` stands for whatever the slot turns out to be).
  const provisionalKey =
    names && !gate.live && !key && named.inked && !named.changed
      ? reads.map((r) => (r.present ? `${r.itemId}${r.enhanced ? '+' : ''}` : '?')).join(',')
      : '';
  const nowMs = performance.now();
  if (gate.live) readingFirst = readingCardsSig = null;
  else {
    const cardsSig = frameSig(msg.regions.slice(0, 3));
    const slidingIn = named.empty >= 2 || (named.empty > 0 && seen < 2) || lastSpent;
    if (readingSince === null) readingFirst = readingSince = nowMs;
    // two or three empty card slots mean the cards are still sliding in: no grey `?` on a card that is not there (at most FALLBACK_MAX_MS)
    else if ((!sameSig(readingCardsSig, cardsSig) && locks.filter(Boolean).length < 2) || slidingIn)
      readingSince = nowMs;
    if (slidingIn) readingFirst = nowMs;
    readingCardsSig = cardsSig;
  }
  // Fallback: no sure set within FALLBACK_MS. The sure cards are advised, the others become `?`. Never for a set the
  // player already picked from (its cards read sure, so it never gets here with its own key).
  const fullKey = seen === 3 ? reads.map((r) => `${r.itemId}${r.enhanced ? '+' : ''}`).join(',') : '';
  const fbDue =
    !gate.live &&
    seen > 0 && // all three cards still empty (sliding in, or the game is slow): nothing to put a `?` on, keep waiting
    readingSince !== null &&
    (nowMs - readingSince >=
      (named.empty === 0 && locks.filter((l) => l && !l.provisional).length >= 2 ? FALLBACK_COVERED_MS : FALLBACK_MS) ||
      nowMs - (readingFirst ?? nowMs) >= FALLBACK_MAX_MS) &&
    !gate.spent.some((k) => fullKey && k.replace(/\+/g, '') === fullKey.replace(/\+/g, ''));
  const fbReads = reads.map((r, i) =>
    named.slotSure[i] && r.present ? r : { ...r, present: true, unsure: true, itemId: 0, tier: 0, enhanced: false },
  );
  const fbKey = fbDue ? fbReads.map((r) => (r.unsure ? '?' : `${r.itemId}${r.enhanced ? '+' : ''}`)).join(',') : '';
  let meta: DraftMeta | null = null,
    inventory: number[] | null = null;
  // The grid is read while the names are still coming in too: the inventory at accept time is what a pick is spotted
  // against, and an accept on the first frame that names every card would otherwise have none.
  const setKey = key || provisionalKey;
  // Cards land one at a time: with two of them up the grid and the hero bar are read already (neither depends on the
  // third), so the last card only has its own name to wait for.
  const partialKey =
    names && !gate.live && !setKey && seen >= 2 ? reads.map((r) => (r.present ? String(r.itemId) : '?')).join(',') : '';
  const warmKey = setKey || partialKey;
  const fresh = (labels.round === 1 || labels.round === 0) && labels.choice === 1 && gate.last === null;
  if (sameCards(warmKey, lastSetKey)) {
    // the inventory grid is only on the draft screen; a read counts once two frames agree
    const inv: InventoryRead[] = stage('inventory', () => readInventory(img, idx, msg.prefer));
    const ids = inv
      .map((r) => r.itemId)
      .filter(Boolean)
      .sort((a, b) => a - b);
    const ik = ids.join(',');
    if (ik === lastInv) stableInv = ids;
    lastInv = ik;
  } else if (!warmKey) lastInv = '';
  // Read the hero bar while the set is still settling (a first draft of a match has no cached bar), so the accept does
  // not wait for it. Only once the same three cards are up on two frames, so a transition frame never pays for it.
  if (warmKey && !gate.live && !earlyMeta && !(knownHero ?? (matchBar && sameBar(matchBar.sig, barSig(img))))) {
    const sig = barSig(img);
    earlyMeta = { sig, meta: stage('meta', () => readDraftMeta(img, idx, undefined, true)) };
  }
  // The re-roll caption is read for every full set (its own key: the '+' flags wobble), and the gate holds the accept
  // until it is in, so the first advice already knows whether a re-roll is left.
  const set = setKey ? `${labels.choice}|${setKey.replace(/\+/g, '')}` : '';
  if (set && !(fresh && !gate.live))
    stage('rr', () =>
      readRerolls(img, set, (v) => {
        if (acceptedKey) post({ type: 'rerolls', forKey: acceptedKey, rerollsRemaining: v });
      }),
    );
  // The gate decides when this screen is settled enough to advise on, and spots the player's selection.
  const inFallback = !!gate.last && gate.live && gate.last.key.includes('?');
  const g = stepGate(gate, {
    changed: named.changed,
    cardsUp: named.cardsUp,
    ready: !(partialKey && !fbDue) && !named.pending && (!set || fresh || (rr.set === set && rr.value !== null)),
    key: fbDue ? fbKey : key || provisionalKey || partialKey,
    force: fbDue,
    present: reads.filter((r, i) => r.present && (!inFallback || named.slotSure[i])).map((r) => r.itemId),
    round: labels.round,
    choice: labels.choice,
    now: performance.now(),
    inventory: stableInv,
  });
  gate = g.state;
  lastSpent = g.spent;
  trackFrame(labels, named, g, performance.now(), stableInv);
  if (g.live && gate.last) acceptedRound = gate.last.round;
  const accepted = g.accept;
  if (accepted) {
    readingSince = readingFirst = readingCardsSig = null;
    frozenReads = fbDue ? fbReads : reads;
    acceptedKey = fbDue ? fbKey : key;
    acceptedChoice = labels.choice;
    acceptedRound = labels.round;
    const bsig = barSig(img);
    if (!knownHero && matchBar && sameBar(matchBar.sig, bsig)) knownHero = matchBar;
    // The hero bar read is the slowest step on a slow PC: when a settling frame already did it, reuse that read.
    const early = earlyMeta && sameBar(earlyMeta.sig, bsig) ? earlyMeta.meta : null;
    meta = early ?? stage('meta', () => readDraftMeta(img, idx, knownHero ?? undefined, true));
    if (meta.self) matchBar = { bar: meta.bar, self: meta.self, sig: bsig };
    earlyMeta = null;
    // the hero bar is constant while the draft screen stays up; keep it until the screen closes (nonShopResult)
    knownHero = meta.self ? { bar: meta.bar, self: meta.self } : null;
    // A match starts with its one re-roll: advised on that, and the caption read (started now) corrects it if it is wrong.
    meta.rerollsRemaining = rr.value ?? (fresh && meta.rerollsRemaining !== 0 ? 1 : meta.rerollsRemaining);
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
  lastSetKey = warmKey;
  pendingSig = key ? sig : null;
  pendingReads = raw;
  pendingChoice = labels.choice;
  settledSig = key !== '' && key === acceptedKey && !locks.some((l) => l?.provisional) ? sig : null;
  settledReads = sent;
  noteReadMs(performance.now() - t0);
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
    track: tracker.take() ?? undefined,
    ms: performance.now() - t0,
    stages,
  });
}

const nonShopResult = (t0: number): FrameResult => {
  // the draft screen went away with a set still locked: the player took a card (the last choice of a round ends this way)
  const st = tracker.state();
  if (setLocked(st) && st.phase === 'drafting') tracker.feed({ type: 'pick', itemId: null, advised: advisedId });
  resetFps();
  forgetNames();
  lastKey = lastSetKey = acceptedKey = lastInv = sentInv = '';
  settledSig = pendingSig = null;
  knownHero = null;
  acceptedRound = acceptedChoice = 0;
  readingSince = readingFirst = readingCardsSig = frozenReads = null;
  gate = offScreenGate(gate);
  stableInv = null;
  lastFull = null;
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
    track: tracker.take() ?? undefined,
    ms: performance.now() - t0,
  };
};
