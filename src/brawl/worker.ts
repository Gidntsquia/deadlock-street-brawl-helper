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
  matchInventorySpot,
  inventorySpots,
  inventoryFrom,
  type InventoryMatches,
  inventorySig,
  sameInventory,
  cardEmpty,
  cardNameCrop,
  readMarkers,
  cardSquares,
  coveredSlots,
  type CardRead,
  type DecodedIndex,
  type DraftMeta,
  type InventoryRead,
} from './recognise';
import {
  ReaderDownError,
  hasTextReader,
  readCardNameTimed,
  readRerollsRemaining,
  readerDown,
  setReaderDown,
  setTextReader,
  type TextKind,
} from './ocr';
import { matchItemName, nameList, type NameList } from './names';
import { hasInk, nameSig } from './nameLine';
import { initialGate, offScreenGate, RELABEL_SETTLE_MS, SETTLE_MS, stepGate } from './draftGate';
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
  // `at`: wall clock (Date.now) when the video presented this picture, echoed on the result as `frameAt`
  | { type: 'frame'; width: number; height: number; regions: FrameRegion[]; prefer: number[]; at?: number }
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
  | { type: 'roundStart'; round: number } // the round banner probe hit: log round.start
  // the name reader's answer to an `ocr` request (relayed by the page from main), and whether it is running at all
  | { type: 'ocrResult'; id: number; text: string; ms: number; error?: string; hops?: OcrHops }
  | { type: 'readerState'; down: boolean }
  | { type: 'ocrPort' } // ports[0]: a MessagePort straight to main's name reader; reads go there instead of the page
  | { type: 'forceResync' } // F8: start from the next frame's labels again
  | { type: 'advised'; itemId: number | null } // the card the overlay told the player to take (null: re-roll or none)
  | { type: 'idle' } // the page had no frame ready for the last tick
  | { type: 'reset' } // capture (re)started: forget the last draft and start ticking again
  | { type: 'stop' }; // capture stopped: forget the last draft; the worker then stays silent

/** The worker paces the capture: it asks the page for a frame, reads it, waits, asks again. Page timers are
 *  throttled to once a second (Chrome: once a minute after five minutes) while the game has the foreground and the
 *  browser tab is hidden; worker timers are not, so the advice keeps updating without alt-tabbing. */
export type WorkerOut =
  | FrameResult
  | { type: 'load'; slow: boolean } // this machine reads frames slowly: the page lowers its frame rate
  | { type: 'seen' } // the probe saw the draft screen: no cards are read yet
  | { type: 'tick'; full: boolean } // full: send a whole frame; otherwise just the probe crop
  | { type: 'rerolls'; forKey: string; rerollsRemaining: number }
  // a prepared text crop (src/brawl/ocr.ts) for the name reader: the page passes it to main, the answer comes back as `ocrResult`
  | { type: 'ocr'; id: number; kind: TextKind; width: number; height: number; data: Uint8Array; sentWall: number }
  /** One text read's round trip as the worker saw it (worker to page to main to the helper and back), wall clock ms. */
  | { type: 'ocrTrip'; startWall: number; ms: number; hops?: OcrHops & { back: number } }
  | ({ type: 'track' } & TrackOut) // the state machine moved outside a frame (a round started)
  // a card's name line was read: what the icon said, the OCR text, and the item it names (0: no clear match)
  | {
      type: 'name';
      slot: number;
      icon: number;
      text: string;
      itemId: number;
      score: number;
      ms: number;
      readerMs: number;
    }
  // a slot's name was not taken: nothing in the reply matched an item, the line was blank, the reader is not running.
  // ('covered' rides on each result as `covered`, since it holds frame by frame.)
  /** A card's name line went to the reader (its line had ink and was not covered), before the read lands. */
  | { type: 'namePost'; slot: number }
  /** The inventory grid match: started (a grid that looks changed; `restart` when it replaced one under way), done. */
  | { type: 'gridJob'; phase: 'start' | 'done'; restart?: boolean; ms?: number }
  | { type: 'nameUnsure'; slot: number; reason: 'no-item' | 'empty' | 'reader-down'; text: string };

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
  /** Card circles with something in them on this frame (draft frames read in full): when the set's first card showed. */
  shown?: number;
  covered?: number[]; // card slots whose name line a hovered card or a tooltip covers on this frame: not read, lock kept
  /** The last card of the set landed on this frame (the first frame all three circles show a card): its slot. Once per set. */
  land?: number;
  /** The frame message's `at` (wall clock the picture was presented), when the page sent one. */
  frameAt?: number;
  ms: number;
  stages?: Record<string, number>; // milliseconds per recogniser stage (a few timer reads per frame)
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
// re-roll count dropping) does a clear read of another item move the lock. Until a slot has its first lock it is
// "waiting": the item comes from the name read alone, never from the icon (no icon guesses: they cost time and could be
// wrong). Without a name list (CLI tools) the icon search stands.
interface SlotLock {
  id: number;
  sig: Uint8Array;
  enhanced: boolean;
  rare: boolean;
  /** when the lock was taken and how well its read matched: a fresh, strong lock is a line still fading in */
  at?: number;
  score?: number;
}
/** A lock taken this recently on a read this good is not held for a confirming re-read: the line is only fading in. */
const FRESH_LOCK_MS = 500;
const FRESH_LOCK_SCORE = 0.9;
let locks: (SlotLock | null)[] = [null, null, null];
/** `until`: the ban on re-reading this picture ends then (a read that was fine but clashed with another slot's). */
let nameFail: ({ sig: Uint8Array; at: number; since: number; until?: number } | null)[] = [null, null, null];
/** Two slots read as one item: both pictures wait this long before they are read again (one of them is the hover
 *  tooltip's title, and the tooltip may move off at any moment). */
const TWIN_RETRY_MS = 300;
/** A name line picture that already failed to read is not read again: the same fingerprint (at most this many grid
 *  cells moved, the video's own noise) gives the same text. */
const SAME_PICTURE_CELLS = 1;
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
  nameGen++;
  lockFp.fill(null);
};
const forgetNames = () => {
  dropLocks();
  nameChoice = 0;
  rerollAt = null;
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
  empties: boolean[];
  sigs: (Uint8Array | null)[];
  covered: boolean[];
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
      empties: [false, false, false],
      sigs: [null, null, null],
      covered: [false, false, false],
    };
  // With the name reader down nothing can confirm that the cards under a new CHOICE label are the advised ones (a test
  // mode screenshot switch has no fade): the old advice goes, and the new set gets its `?` plates at the fallback.
  const relabelledDown = choice !== nameChoice && nameChoice !== 0 && gate.live && readerDown();
  if (choice !== nameChoice) {
    forgetNames(); // the next choice's cards
    nameChoice = choice;
  }
  const list = names;
  const now = performance.now();
  let waiting = false,
    pending = false,
    changed = relabelledDown,
    inked = true;
  // A slot is sure when its name is locked. The fallback shows the rest as `?`.
  const slotSure = [false, false, false];
  const crops = pinned.map((r) => cardNameCrop(img, r.match));
  const sigs = crops.map((c) => (c ? nameSig(c) : null));
  // A hovered card grows and tilts its name line, and its tooltip panel covers a neighbour's: those lines show what the
  // cursor is on, not the card. A covered slot is not read and keeps whatever lock it has.
  const covered = coveredSlots(crops);
  const down = readerDown();
  // The cards fading out for a re-roll: two locked name lines blank at once (a hover blanks at most the one it grows).
  // Two locked cards' circles are empty (a hover only hides name lines, it leaves the icons): those cards are gone, and with them every lock: whatever comes next is a new set (a card still showing may be a new
  // one drawn over the old, or hidden by a tooltip, and must not keep the old item).
  const empties = squares.map((sq) => cardEmpty(img, sq));
  const emptyCount = empties.filter(Boolean).length;
  // Cards arriving one by one leave two circles empty beside the first lock: only locked (or advised) cards that went
  // empty mean the set is leaving.
  const lockedGone = empties.filter((e, i) => e && (gate.live || locks[i])).length;
  // Before the accept, a lock on a circle that is now empty belongs to a card that left (the previous choice's, fading).
  if (!gate.live) for (let i = 0; i < 3; i++) if (empties[i] && locks[i]) locks[i] = null;
  if (lockedGone >= 2) {
    rerollAt = now;
    dropLocks();
    changed = true;
  }
  // A re-roll replaces all three cards; a hover changes one line (and covers a neighbour's, which is skipped). So other
  // lettering counts as new cards only when two uncovered locked lines show it at once.
  const otherNow = sigs.filter((sg, i) => {
    const l = locks[i];
    return !covered[i] && !!l && !!sg && hasInk(sg) && otherName(l.sig, sg);
  }).length;
  const out = pinned.map((r, slot) => {
    const crop = crops[slot] ?? null;
    const sig = sigs[slot] ?? null;
    if (!sig || !hasInk(sig)) inked = false;
    let lock = locks[slot];
    const asLock = (l: SlotLock): CardRead => ({
      ...r,
      present: true,
      itemId: l.id,
      tier: tiers[l.id] ?? r.tier,
      enhanced: l.enhanced,
      rare: l.rare,
      match: { ...r.match, itemId: l.id },
    });
    // A line still fading in reads as off-centre text: with no lock yet it is read anyway (a tooltip's title over it
    // matches another slot's lock and is caught by the twin check), so the first clear read is not held back.
    if (covered[slot] && (lock || gate.live)) {
      // keep the lock as it is; a slot never seen uncovered stays unread (`?` once the fallback runs)
      if (lock) {
        slotSure[slot] = true;
        return asLock(lock);
      }
      pending = true;
      return r;
    }
    // A mark that shows up after the lock (the label draws a beat after the card) is added to it, never removed.
    if (lock && (r.present ? r.itemId === lock.id : iconless)) {
      lock.enhanced ||= r.enhanced;
      lock.rare ||= r.rare;
    }
    if (lock && sig && sameName(lock.sig, sig)) {
      slotSure[slot] = true;
      return asLock(lock);
    }
    // The line changed (or is hidden): read it again unless that same picture already failed (it would read the same).
    const fail = nameFail[slot];
    const failedThis =
      !!fail &&
      !!sig &&
      fail.sig.length === sig.length &&
      nameCellsMoved(fail.sig, sig) <= SAME_PICTURE_CELLS &&
      (fail.until === undefined || now < fail.until);
    if (!crop || !sig || !hasInk(sig)) {
      // nothing printed there to read: counts as a failed read, so a slot that never shows a name falls back in time
      if (!lock) nameFail[slot] = { sig: sig ?? new Uint8Array(0), at: now, since: fail?.since ?? now };
    } else if (!down && !nameBusy[slot] && !failedThis) {
      // read the moment the line has ink, whatever the other cards are doing
      nameBusy[slot] = true;
      post({ type: 'namePost', slot });
      const fp0 = sigFp(slot, sig);
      const lockBefore = locks[slot],
        gen = nameGen,
        seq = frameSeq,
        icon = r.present ? r.itemId : 0,
        t = now,
        enhanced = r.enhanced,
        rare = r.rare;
      track(readCardNameTimed(crop))
        .then(({ text, ms: readerMs }) => {
          const m = matchItemName(text, list);
          const ms = performance.now() - t;
          post({ type: 'name', slot, icon, text, itemId: m?.itemId ?? 0, score: m?.score ?? 0, ms, readerMs });
          if (!m) post({ type: 'nameUnsure', slot, reason: text ? 'no-item' : 'empty', text });
          if (gen !== nameGen) return;
          const prev = locks[slot];
          const twin = m ? locks.findIndex((l, i) => i !== slot && l?.id === m.itemId) : -1;
          if (twin >= 0 && !gate.live) {
            // A draft never offers one item twice: one of the two lines showed the hover tooltip's title (the hovered
            // card's name). Before the set is advised, both slots are read again; neither picture is re-read at once.
            const at = performance.now();
            const until = at + TWIN_RETRY_MS;
            nameFail[twin] = { sig: locks[twin]!.sig, at, since: nameFail[twin]?.since ?? at, until };
            nameFail[slot] = { sig, at, since: nameFail[slot]?.since ?? t, until };
            locks[twin] = locks[slot] = null;
          } else if (
            m &&
            ((prev && prev.id !== m.itemId && advising() && !rerolling(performance.now())) || twin >= 0)
          ) {
            // another item's name over the advised card without a re-roll: the hover tooltip's title. Keep the lock, and
            // do not read this same picture again for a moment. Before the accept the lock moves: the game swaps the
            // CHOICE label a beat before the cards, so the first lock can be the previous choice's card.
            nameFail[slot] = { sig, at: performance.now(), since: nameFail[slot]?.since ?? t };
          } else if (m) {
            locks[slot] =
              prev?.id === m.itemId
                ? { ...prev, sig }
                : { id: m.itemId, sig, enhanced, rare, at: performance.now(), score: m.score };
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
        .catch((e: unknown) => {
          // the reader is not running (or a recorded reader has no answer for this picture): the slot stays unread
          if (e instanceof ReaderDownError) post({ type: 'nameUnsure', slot, reason: 'reader-down', text: '' });
          if (gen === nameGen) nameFail[slot] = { sig, at: performance.now(), since: nameFail[slot]?.since ?? t };
        })
        .finally(() => {
          nameBusy[slot] = false;
          if (gen === nameGen && locks[slot] !== lockBefore) restepSoon(seq);
        });
    }
    // With the reader down a lock can never be checked again: when its line shows other lettering, it is dropped and the
    // slot goes grey `?` rather than keep a maybe wrong item. The slot is unsettled at once, as after a re-roll, so the
    // old set stops being advised. A tooltip-covered line never gets here (covered slots return above).
    if (down && lock && sig && hasInk(sig) && otherName(lock.sig, sig)) {
      locks[slot] = null;
      waiting = true;
      changed = true;
      return r;
    }
    if (lock) {
      // A changed line under a lock is a hover/tooltip unless the cards were just seen re-rolling. Only then does other
      // lettering make the slot unsettled until its name is read.
      if (rerolling(now) && otherNow >= 2 && sig && hasInk(sig) && otherName(lock.sig, sig)) {
        waiting = true;
        changed = true;
        return r;
      }
      // Before the accept, other lettering under a lock may be the real card replacing the previous choice's: hold the
      // accept until that picture has been read (a hover tooltip's title is caught by the twin check).
      const freshLock = now - (lock.at ?? -1e9) < FRESH_LOCK_MS && (lock.score ?? 0) >= FRESH_LOCK_SCORE;
      if (!advising() && sig && hasInk(sig) && otherName(lock.sig, sig) && !failedThis && !freshLock) pending = true;
      slotSure[slot] = true;
      return asLock(lock);
    }
    // No lock yet: the slot waits for its name (the 1 s fallback shows it as `?` if it never reads).
    pending = true;
    waiting = true;
    return r;
  });
  return {
    reads: out,
    waiting,
    pending,
    slotSure,
    changed,
    inked,
    sigs,
    cardsUp: emptyCount <= 1,
    empty: emptyCount,
    empties,
    covered,
  };
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
let sentInv = '';
let stableInv: number[] | null = null; // the last inventory read two frames agreed on
/** The last grid read and its coarse picture: an unchanged grid reuses the read (`inventorySig`). */
let gridRead: { sig: Uint8Array[]; raw: InventoryMatches } | null = null;
/** A grid match under way: a copy of the frame it started on, matched a few slots per step between other work. */
let gridJob: { sig: Uint8Array[]; started: number; gen: number } | null = null;
let gridGen = 0;
const GRID_HOLD_MS = 600; // longest the accept waits for a grid match already under way
const GRID_STEP_MS = 8; // matching time per step before the worker looks at its messages again
const startGridJob = (
  img: { width: number; height: number; data: Uint8ClampedArray; channels: 4 },
  idx: DecodedIndex,
  sig: Uint8Array[],
) => {
  if (gridJob && sameInventory(gridJob.sig, sig)) return;
  post({ type: 'gridJob', phase: 'start', restart: !!gridJob });
  const gen = ++gridGen;
  const copy = { width: img.width, height: img.height, data: img.data.slice(), channels: 4 as const };
  const spots = inventorySpots(img.width, img.height);
  const out: InventoryMatches = [[], []];
  // A job replacing one under way keeps its start: the grid can change on every frame while the cards deal, and a hold
  // clock restarted each time held the accept until the 1 s fallback forced it.
  const job = { sig, started: gridJob?.started ?? performance.now(), gen };
  gridJob = job;
  const seq = frameSeq;
  let k = 0;
  track(
    new Promise<void>((resolve) => {
      const step = () => {
        if (gen !== gridGen) return resolve();
        const t = performance.now();
        while (k < spots.length && performance.now() - t < GRID_STEP_MS) {
          const spot = spots[k++]!;
          (out[spot.layout] ??= []).push(matchInventorySpot(copy, idx, spot));
        }
        if (k < spots.length) {
          setTimeout(step, 0);
          return;
        }
        gridRead = { sig, raw: out };
        gridJob = null;
        post({ type: 'gridJob', phase: 'done', ms: Math.round(performance.now() - job.started) });
        restepSoon(seq);
        resolve();
      };
      setTimeout(step, 0);
    }),
  );
};
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
/** Without a read of all three cards this long after the first card of a set appeared, the read cards are advised and
 *  each other card shows a grey `?` that turns into its plate the moment its name reads. */
export const FALLBACK_MS = 1000;
/** The `?` fallback waits at most this long for a name read already on its way (see fbDue). */
const FALLBACK_READ_HOLD_MS = 200;
let fbHeldAt: number | null = null;
/** A card that just landed is still fading in and its name may read blank: a slot goes `?` only after its circle has
 *  shown a card this long. */
const FALLBACK_FRESH_MS = 250;
let fullSince: (number | null)[] = [null, null, null];
/** The set being formed has had all three circles filled (its last card landed): `card.land` went out for it. */
let landed = false;
let lastSpent = false; // the previous frame showed a set a pick was already made from: its cards leaving is not a new set to wait on
let cardsAt: number | null = null; // when the first card of the not-yet-accepted set appeared
let earlyMeta: { sig: Uint8Array; meta: DraftMeta } | null = null; // the hero bar read before the accept
let frozenReads: CardRead[] | null = null; // the accepted set's reads, sent unchanged for as long as the set is live

const forgetDraft = () => {
  forgetNames();
  lastKey = lastSetKey = acceptedKey = sentInv = '';
  forgetRerolls();
  wasShop = false;
  offFrames = 0;
  settledSig = pendingSig = null;
  knownHero = null;
  acceptedRound = acceptedChoice = 0;
  cardsAt = frozenReads = earlyMeta = null;
  fullSince = [null, null, null];
  landed = false;
  gate = initialGate();
  stableInv = null;
  gridRead = null;
  gridJob = null;
  gridGen++;
  lastFull = null;
};
// Milliseconds per recogniser stage, sent back on each result (the page logs the slow ones as worker.slow).
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
const tracker = createTracker(() => {});
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
    if (cur.kind === 'landing' && cur.fp === fp && lock && sig && sameName(lock.sig, sig)) {
      lockFp[slot] = fp;
      tracker.feed({ type: 'cardRead', slot, fp, itemId: lock.id, fromLock: true });
    }
  }
  st = tracker.state();
  if (stable && st.gridCheck && setLocked(st)) tracker.feed({ type: 'ownedGrid', ids: stable });
}

const post = (m: WorkerOut, transfer?: Transferable[]) =>
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(m, transfer ?? []);
let timer: ReturnType<typeof setTimeout> | undefined;

// ---- the name reader, through the page --------------------------------------------------------------------------
// Text crops go to the Windows OCR helper main runs (electron/nameReader.ts): worker -> page -> main and back. A tool
// or test that runs this file in Node installs its own reader first (scripts/lib/textReader.ts), and this relay stays out.
/** A read with no answer in this long counts as the reader being down for that read. */
const OCR_REPLY_MS = 2000;
/** Where a read's round trip went, in ms: worker to page, the page's IPC call to main and back, main's wait on the
 *  helper; `replyWall` is when the page posted the answer (the worker adds the hop back). Logged as `ocr.hops`. */
export interface OcrHops {
  toPage: number;
  ipc: number;
  main: number;
  helper: number;
  replyWall: number;
}
const wallNow = () => performance.timeOrigin + performance.now();
let ocrPort: MessagePort | null = null;
const onOcrResult = (msg: Extract<WorkerIn, { type: 'ocrResult' }>) => {
  const w = ocrWait.get(msg.id);
  ocrWait.delete(msg.id);
  if (!w) return;
  const ms = performance.now() - w.at;
  const hops = msg.hops && { ...msg.hops, back: Math.round(wallNow() - msg.hops.replyWall) };
  post({ type: 'ocrTrip', startWall: performance.timeOrigin + w.at, ms, hops });
  if (msg.error) w.fail(new ReaderDownError(msg.error));
  else w.done({ text: msg.text, ms: msg.ms });
};
let ocrSeq = 0;
const ocrWait = new Map<
  number,
  { at: number; done: (r: { text: string; ms: number }) => void; fail: (e: Error) => void }
>();
const installRelay = () => {
  if (hasTextReader()) return;
  setTextReader(
    (img, kind) =>
      new Promise((done, fail) => {
        const id = ++ocrSeq;
        const to = setTimeout(() => {
          ocrWait.delete(id);
          fail(new ReaderDownError('timeout'));
        }, OCR_REPLY_MS);
        ocrWait.set(id, {
          at: performance.now(),
          done: (r) => {
            clearTimeout(to);
            done(r);
          },
          fail: (e) => {
            clearTimeout(to);
            fail(e);
          },
        });
        const q = {
          type: 'ocr',
          id,
          kind,
          width: img.width,
          height: img.height,
          data: img.data,
          sentWall: wallNow(),
        } as const;
        if (ocrPort) ocrPort.postMessage(q);
        else post(q, [img.data.buffer]);
      }),
  );
};
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
    return;
  }
  if (msg.type === 'warm') {
    // Sent when the app opens, long before a draft: decode the icon index now so the first frame does not.
    index ??= decodeIconIndex(msg.index);
    tiers = msg.tiers;
    setNames(msg.names);
    installRelay();
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
    installRelay();
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
  if (msg.type === 'ocrPort') {
    const port = ev.ports[0];
    if (!port) return;
    ocrPort = port;
    port.onmessage = (e: MessageEvent<Extract<WorkerIn, { type: 'ocrResult' }>>) => onOcrResult(e.data);
    return;
  }
  if (msg.type === 'ocrResult') {
    onOcrResult(msg);
    return;
  }
  if (msg.type === 'readerState') {
    setReaderDown(msg.down);
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
  // once advised, only a `?` set is re-run: the card that read upgrades it now, not a frame later (the cards may be gone)
  if (!lastFull || lastFull.seq !== seq || frameSeq !== seq || (gate.live && !frozenReads?.some((r) => r.unsure)))
    return;
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
/** Re-runs the frame after `ms` (the settle time running out), once per frame. */
let restepTimer: ReturnType<typeof setTimeout> | undefined;
const restepAt = (seq: number, ms: number) => {
  clearTimeout(restepTimer);
  restepTimer = setTimeout(() => restep(seq), Math.ceil(ms) + 1);
};
const sameSetKey = (a: string, b: string) => a.replace(/\+/g, '') === b.replace(/\+/g, '');
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
  stages = {};
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
  // The fallback clock starts at the first frame any card of the set shows (a circle with content). Cards leaving (all
  // three circles empty, a re-roll's fade, or the set a pick was made from) stop it; the next set starts it again.
  if (gate.live || named.empty === 3 || named.changed || lastSpent) cardsAt = null;
  else cardsAt ??= nowMs;
  fullSince = named.empties.map((e, i) => (e ? null : (fullSince[i] ?? nowMs)));
  // The last card lands: the first frame of this set with all three circles filled. Its slot is the circle filled last.
  let land: number | undefined;
  if (cardsAt === null) landed = false;
  else if (named.empty === 0 && !landed) {
    landed = true;
    land = 0;
    for (let i = 1; i < 3; i++) if ((fullSince[i] ?? 0) >= (fullSince[land] ?? 0)) land = i;
  }
  // Fallback: no full read within FALLBACK_MS. The read cards are advised, the others become `?`. Never for a set the
  // player already picked from (its cards read sure, so it never gets here with its own key).
  const fullKey = seen === 3 ? reads.map((r) => `${r.itemId}${r.enhanced ? '+' : ''}`).join(',') : '';
  const fbTime =
    !gate.live &&
    // a card that has not arrived yet is not an unread card: the cards land one after another, so the `?` waits until
    // all three circles show a card. Three full circles with no item at all (the name reader not running) get theirs.
    named.empty === 0 &&
    cardsAt !== null &&
    nowMs - cardsAt >= FALLBACK_MS &&
    named.slotSure.every((sure, i) => sure || nowMs - (fullSince[i] ?? nowMs) >= FALLBACK_FRESH_MS) &&
    !gate.spent.some((k) => fullKey && k.replace(/\+/g, '') === fullKey.replace(/\+/g, ''));
  // A name read of a slot that would go `?` is on its way (its line just came clear): the `?` waits for it, a read takes
  // tens of ms, at most FALLBACK_READ_HOLD_MS.
  const readOnItsWay = named.slotSure.some((sure, i) => !sure && nameBusy[i]);
  if (!fbTime || !readOnItsWay) fbHeldAt = null;
  else fbHeldAt ??= nowMs;
  const fbDue = fbTime && (fbHeldAt === null || nowMs - fbHeldAt >= FALLBACK_READ_HOLD_MS);
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
  // The inventory grid: matching it costs 100 to 500 ms on a real PC, so it never runs inside a frame. A grid that looks
  // as it did on the last match reuses it; a changed one (the pick just made, a new match) is matched in small steps
  // between frames and name answers (`gridJob`), started as soon as a card or the empty draft screen shows.
  const gsig = warmKey || named.empty === 3 || seen > 0 ? inventorySig(img) : null;
  const grid = gsig && gridRead && sameInventory(gridRead.sig, gsig) ? gridRead : null;
  if (gsig && !grid) startGridJob(img, idx, gsig);
  if (sameCards(warmKey, lastSetKey) && grid) {
    // the grid read counts once its picture matches this frame's: the job's frame and this one agree
    const inv: InventoryRead[] = inventoryFrom(grid.raw, idx, msg.prefer);
    stableInv = inv
      .map((r) => r.itemId)
      .filter(Boolean)
      .sort((a, b) => a - b);
  }
  // The owned list goes out with the accepted set, so the accept waits (briefly) for a grid match already under way.
  const gridHold = !!gridJob && !gate.live && performance.now() - gridJob.started < GRID_HOLD_MS;
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
    ready:
      !(partialKey && !fbDue) &&
      !gridHold &&
      !named.pending &&
      (!set || fresh || (rr.set === set && rr.value !== null)),
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
  // A full set waiting only for the settle time is re-run the moment that time is up, not at the next picture.
  const c = gate.cand;
  if (!g.accept && !gate.live && c && !c.key.includes('?') && !named.pending && c.frames >= 2) {
    const left =
      (gate.last && sameSetKey(gate.last.key, c.key) ? RELABEL_SETTLE_MS : SETTLE_MS) - (performance.now() - c.since);
    if (left > 0 && left < RELABEL_SETTLE_MS) restepAt(frameSeq, left);
  }
  trackFrame(labels, named, g, performance.now(), stableInv);
  if (g.live && gate.last) acceptedRound = gate.last.round;
  const accepted = g.accept;
  if (accepted) {
    cardsAt = null;
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
  settledSig = key !== '' && key === acceptedKey ? sig : null;
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
    shown: 3 - named.empty,
    land,
    frameAt: msg.at,
    covered: named.covered.some(Boolean) ? [0, 1, 2].filter((i) => named.covered[i]) : undefined,
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
  lastKey = lastSetKey = acceptedKey = sentInv = '';
  settledSig = pendingSig = null;
  knownHero = null;
  acceptedRound = acceptedChoice = 0;
  cardsAt = frozenReads = null;
  landed = false;
  gate = offScreenGate(gate);
  stableInv = null;
  gridRead = null;
  gridJob = null;
  gridGen++;
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
