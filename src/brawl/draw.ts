import type { CardRead } from './recognise';
import { rerollButtonRect } from './recognise';
import type { AbilityPanelData } from './abilities';
import type { DotState } from './lobbyDot';
import type { TeamWinRateEdge } from '../local/teamWinRate';
import { cardSlotSelection, type CardSlotSelection } from '../local/cardSlotSelection';

export interface OverlayAdviceCard {
  itemId: number;
  name: string;
  score: number;
  enhanced: boolean;
  usage: number;
  winRate: number | null;
  /** Tier-list letter ("S".."C"), "-" when the item has none. */
  grade: string;
  /** Points enhanced adds to this card's score (its score minus the same card's score not enhanced); 0 when not enhanced. */
  enhancedBonus: number;
  /** Tooltip rows: fixed labels and hundredths (see `breakdownRows`); one "No Street Brawl data" row without data. */
  rows: { label: string; cents: number }[];
}

/** Everything the overlay panel needs to render the same advice as the pop-out, without alt-tabbing:
 *  names not ids, since the overlay window has no access to the item/ability catalog. */
export interface OverlayAdvice {
  detail?: 'detailed' | 'off';
  rerollsRemaining?: number | null;
  status: string;
  confidence?: string;
  hero: string;
  round: number;
  choice: number;
  reroll: { expectedBest: number; currentBest: number } | null;
  ranked: OverlayAdviceCard[];
}

/** Everything the overlay may draw. It draws nothing at all unless `draft` (the item draft screen is on the
 *  frame) or `panel` (the ability panel window is running); see `overlayHasContent`. */
export interface OverlayState {
  reads: CardRead[];
  bestId: number | null;
  reroll: boolean;
  frameW: number;
  frameH: number;
  advice: OverlayAdvice | null;
  draft: boolean;
  /** The draft screen is up but no set is accepted yet: the overlay draws the `Reading` sign and nothing else. */
  reading?: boolean;
  panel: AbilityPanelData | null;
  /** The "Use Re-Roll" pill's outline found on the frame (frame px); absent: the nominal layout rect. */
  rerollRect?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** The lobby status dot (set by the main process, not the control window): absent while in a match. */
  dot?: DotState | null;
  /** A one-sentence problem the overlay shows for a few seconds. */
  notice?: string | null;
  teamEdge?: TeamWinRateEdge | null;
  teamVisible?: boolean;
}

/** The blank state: nothing to draw. */
export const BLANK_OVERLAY: OverlayState = {
  reads: [],
  bestId: null,
  reroll: false,
  frameW: 0,
  frameH: 0,
  advice: null,
  draft: false,
  panel: null,
};

export { overlayHasContent } from './overlayContent';

/** One shape `drawReads` actually stroked, in capture-frame px (unscaled by scaleX/scaleY), so a caller that
 *  knows the canvas's own scale relative to the frame can turn these back into canvas px, and something that
 *  only has frame-px labels (e.g. the e2e harness comparing against `scripts/win/frames/labels.json`) can
 *  compare directly without redoing the scale math. For cards the rect is the bounding box of the large
 *  circle the item sits in; `score` is the number drawn above it (null for the re-roll box). */
export interface DrawnRect {
  kind: 'card' | 'best' | 'reroll' | 'unknown';
  itemId: number | null;
  card: string | null; // read.card ("left"/"top"/"right") for card/best, null for reroll
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number | null;
  /** The plate above the card (frame px); null for the re-roll box or a card without a score. */
  plate: FrameRect | null;
  /** The card sits under the dark veil and has the grey plate (every card but the one to take). */
  veiled?: boolean;
  /** Original capture index, including duplicate item IDs. */
  readIndex?: number;
  /** The `Enhanced +n` cell on the plate (frame px) and its text; null without one. For `reroll`, `plate` is the teal label. */
  chip?: FrameRect | null;
  chipText?: string | null;
}

// The large circle an item sits in, relative to the small icon square the recogniser matches: measured on
// the 2000x1125 reference frames (icon edge ~137px, circle diameter ~352px, circle centre ~37px below the
// icon's centre), so everything scales with the matched icon edge.
const CIRCLE_RADIUS_PER_EDGE = 1.285;
const CIRCLE_CENTRE_DROP_PER_EDGE = 0.27;

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}

/** The circle around an item, in the same px space as `match` (frame px). */
export function itemCircle(match: { x: number; y: number; edge: number }): Circle {
  return {
    cx: match.x + match.edge / 2,
    cy: match.y + match.edge / 2 + match.edge * CIRCLE_CENTRE_DROP_PER_EDGE,
    r: match.edge * CIRCLE_RADIUS_PER_EDGE,
  };
}

/** Overlay palette (charcoal + teal). The CSS variables in `src/index.css` are the source; these are the same values
 *  for the canvas, read from the document when there is one. */
export interface OverlayTheme {
  panel: string;
  teal: string;
  tealInk: string;
  text: string;
  muted: string;
  take?: string;
  takeInk?: string;
  reroll?: string;
  /** Border and badge of a non-advised plate. */
  grey: string;
  /** Veil over a non-advised card's circle. */
  veil: string;
  /** Opacity of a non-advised plate (0..1). */
  dim: number;
}
const DEFAULT_THEME: OverlayTheme = {
  panel: 'rgba(16,19,20,0.85)',
  teal: '#2ec4b6',
  tealInk: '#06201d',
  text: '#ece6da',
  muted: '#a39e92',
  take: '#52e38b',
  takeInk: '#092416',
  reroll: '#f3c969',
  grey: '#8a9092',
  veil: 'rgba(0,0,0,0.35)',
  dim: 0.6,
};
function readTheme(): OverlayTheme {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return DEFAULT_THEME;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    panel: v('--overlay-panel', DEFAULT_THEME.panel),
    teal: v('--teal', DEFAULT_THEME.teal),
    tealInk: v('--teal-ink', DEFAULT_THEME.tealInk),
    text: v('--text', DEFAULT_THEME.text),
    muted: v('--muted', DEFAULT_THEME.muted),
    take: v('--overlay-take', DEFAULT_THEME.take!),
    takeInk: v('--overlay-take-ink', DEFAULT_THEME.takeInk!),
    reroll: v('--overlay-reroll', DEFAULT_THEME.reroll!),
    grey: v('--overlay-grey', DEFAULT_THEME.grey),
    veil: v('--overlay-veil', DEFAULT_THEME.veil),
    dim: Number(v('--overlay-dim', String(DEFAULT_THEME.dim))) || DEFAULT_THEME.dim,
  };
}

export interface FrameRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

const PLATE_GAP = (edge: number, scaleY: number) => Math.max(4, edge * 0.04 * scaleY);

/** The one place a plate's size and position come from (canvas px): `drawPlate`, `drawReading` and the re-roll label all
 *  use it, so they scale and anchor together. `cx`/`top` are the card circle's centre x and top edge (frame px). */
export function plateGeometry(
  edge: number,
  cx: number,
  top: number,
  scaleX: number,
  scaleY: number,
  textW: number,
  chipW = 0,
) {
  const font = Math.max(14, Math.round(edge * 0.2 * scaleY));
  const h = Math.round(font * 1.7);
  const pad = Math.round(font * 0.5);
  const w = Math.round(h + textW + pad * 2 + chipW);
  const x = Math.round(cx * scaleX - w / 2);
  const y = Math.max(2, Math.round(top * scaleY - h - PLATE_GAP(edge, scaleY)));
  return { font, h, pad, w, x, y };
}

interface PlateOpts {
  isBest: boolean;
  mode: 'item' | 'unknown';
  badge: string;
  label: string;
  chip: string | null;
  take?: boolean;
}

/** Measures a plate (no drawing) for the given chip text. */
function measurePlate(
  ctx: CanvasRenderingContext2D,
  edge: number,
  cx: number,
  top: number,
  scaleX: number,
  scaleY: number,
  o: PlateOpts,
) {
  const font = Math.max(14, Math.round(edge * 0.2 * scaleY));
  ctx.font = `bold ${font}px sans-serif`;
  const textW =
    o.mode === 'unknown'
      ? 0
      : ctx.measureText(o.label).width + (o.take ? ctx.measureText('TAKE').width + Math.round(font * 0.5) * 2 : 0);
  const pad = Math.round(font * 0.5);
  const chipW = o.chip ? Math.round(ctx.measureText(o.chip).width + pad * 2) : 0;
  const g = plateGeometry(edge, cx, top, scaleX, scaleY, o.mode === 'unknown' ? -pad * 2 : textW, chipW);
  return { ...g, chipW };
}

/** One plate above a card: a tier badge, a label and, for an enhanced card, an `Enhanced +n` cell at the right end.
 *  `isBest` fills it green with TAKE; every other plate is charcoal with a thin teal border and muted text. Returns the plate and chip rectangles in frame px. */
function drawPlate(
  ctx: CanvasRenderingContext2D,
  g: ReturnType<typeof measurePlate>,
  scaleX: number,
  scaleY: number,
  theme: OverlayTheme,
  o: PlateOpts,
): { plate: FrameRect; chip: FrameRect | null } {
  const { x, y, w, h, pad, chipW } = g;
  const { isBest, mode } = o;
  const take = theme.take ?? DEFAULT_THEME.take!;
  const takeInk = theme.takeInk ?? DEFAULT_THEME.takeInk!;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.font = `bold ${g.font}px sans-serif`;
  ctx.fillStyle = isBest ? take : theme.panel;
  roundedRect(ctx, x, y, w, h, 4);
  ctx.fill();
  if (!isBest) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.teal;
    roundedRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4);
    ctx.stroke();
  }
  // tier badge: a square at the left end, a darker cell so the letter reads at a glance
  ctx.fillStyle = isBest ? takeInk : theme.teal;
  roundedRect(ctx, x + 2, y + 2, h - 4, h - 4, 3);
  ctx.fill();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillStyle = isBest ? take : theme.panel;
  ctx.fillText(o.badge, x + h / 2, y + h / 2 + 1);
  ctx.textAlign = 'start';
  const ink = isBest ? takeInk : theme.muted;
  if (mode === 'item') {
    ctx.fillStyle = ink;
    ctx.fillText(o.label, x + h + pad, y + h / 2 + 1);
    if (o.take) ctx.fillText('TAKE', x + h + pad * 3 + ctx.measureText(o.label).width, y + h / 2 + 1);
  }
  let chip: FrameRect | null = null;
  if (o.chip && chipW) {
    const cx0 = x + w - chipW;
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(cx0, y + 4, 1, h - 8);
    ctx.globalAlpha = 1;
    ctx.fillText(o.chip, cx0 + pad, y + h / 2 + 1);
    chip = { x0: cx0 / scaleX, y0: y / scaleY, x1: (x + w) / scaleX, y1: (y + h) / scaleY };
  }
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
  return { plate: { x0: x / scaleX, y0: y / scaleY, x1: (x + w) / scaleX, y1: (y + h) / scaleY }, chip };
}

/** The small `Reading` sign above the middle card, drawn from the draft screen's first frame until the plates replace
 *  it. `middle` is the middle card's match square in frame px. It sits one plate height times 0.35 (min 6 px) above
 *  where the middle plate will land, from the same plate geometry; clamped to the top, it goes below that plate. */
export function drawReading(
  ctx: CanvasRenderingContext2D,
  middle: { x: number; y: number; edge: number },
  scaleX: number,
  scaleY: number,
  theme: OverlayTheme = readTheme(),
): FrameRect {
  const { cx, cy, r } = itemCircle(middle);
  const plate = plateGeometry(middle.edge, cx, cy - r, scaleX, scaleY, 0);
  const { font, h } = plate;
  ctx.font = `bold ${font}px sans-serif`;
  const w = Math.round(ctx.measureText('Reading').width + font);
  const x = Math.round(cx * scaleX - w / 2);
  const gap = Math.max(6, Math.round(plate.h * 0.35));
  const wanted = plate.y - gap - h;
  const y = wanted >= 2 ? wanted : plate.y + plate.h + gap;
  ctx.fillStyle = theme.panel;
  roundedRect(ctx, x, y, w, h, 4);
  ctx.fill();
  ctx.fillStyle = theme.muted;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText('Reading', x + w / 2, y + h / 2 + 1);
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
  return { x0: x / scaleX, y0: y / scaleY, x1: (x + w) / scaleX, y1: (y + h) / scaleY };
}

/** Draws the plate above every offered card (tier badge + `Score: <n>`) and the 3 px teal outline around the best card,
 *  scaled from capture-frame pixels to the target canvas size. Shared by the preview canvas (BrawlView) and the Electron
 *  overlay window. The best card's plate is filled teal with dark text, the others are charcoal with a thin teal border
 *  and muted text. When `reroll` is true no card is best (the engine says re-roll, not take) and the "Use Re-Roll"
 *  button is boxed instead. `scores`/`grades` map itemId to what the advice shows. Returns every shape drawn, in frame
 *  px, for callers (the hover tooltip, the e2e harness) that need to know where things landed. */
export function drawReads(
  ctx: CanvasRenderingContext2D,
  reads: CardRead[],
  bestId: number | null,
  scaleX: number,
  scaleY: number,
  frameW: number,
  frameH: number,
  reroll = false,
  scores: Record<number, number> = {},
  rerollRect: FrameRect | null = null,
  grades: Record<number, string> = {},
  theme: OverlayTheme = readTheme(),
  selectionOrBonuses?: CardSlotSelection | Record<number, number>,
  bonuses: Record<number, number> = {},
): DrawnRect[] {
  const selection =
    selectionOrBonuses && 'cards' in selectionOrBonuses
      ? (selectionOrBonuses as CardSlotSelection)
      : cardSlotSelection(reads, bestId, null, reroll);
  if (selectionOrBonuses && !('cards' in selectionOrBonuses)) bonuses = selectionOrBonuses as Record<number, number>;
  const drawn: DrawnRect[] = [];
  interface Slot {
    read: CardRead;
    readIndex: number;
    score: number | null;
    unknown: boolean;
    isBest: boolean;
    veiled: boolean;
    circle: Circle;
    o: PlateOpts | null;
    bonus: number | null;
  }
  const cards = reads.map((read, readIndex) => ({ read, readIndex })).filter(({ read }) => read.unsure || read.present);
  const hasBest =
    !reroll &&
    selection.bestIndex !== null &&
    cards.some(({ read, readIndex }) => readIndex === selection.bestIndex && !read.unsure && read.itemId === bestId);
  const slots: Slot[] = cards.map(({ read, readIndex }) => {
    const circle = itemCircle(read.match);
    if (read.unsure)
      return {
        read,
        readIndex,
        score: null,
        unknown: true,
        isBest: false,
        veiled: false,
        circle,
        o: { isBest: false, mode: 'unknown', badge: '?', label: '?', chip: null },
        bonus: null,
      };
    const isBest = hasBest && readIndex === selection.bestIndex;
    const card = selection.cards[readIndex];
    const score = card?.score ?? scores[read.itemId];
    const bonus = read.enhanced ? (card?.enhancedBonus ?? bonuses[read.itemId] ?? null) : null;
    return {
      read,
      readIndex,
      score: score ?? null,
      unknown: false,
      isBest,
      veiled: false,
      circle,
      o:
        score === undefined
          ? null
          : {
              isBest,
              mode: 'item',
              badge: card?.grade ?? grades[read.itemId] ?? '-',
              take: isBest,
              label: `Score: ${score.toFixed(2)}`,
              chip: null,
            },
      bonus,
    };
  });
  // Retained geometry metadata supports hover hit testing; fork cards stay unobscured.
  for (const sl of slots) {
    if (!sl.veiled) continue;
    const { cx, cy, r } = sl.circle;
    ctx.fillStyle = theme.veil;
    ctx.beginPath();
    ctx.ellipse(cx * scaleX, cy * scaleY, r * scaleX, r * scaleY, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // chips: the full text unless two neighbouring plates would touch, then the short one for all of them
  const chipText = (short: boolean, b: number) =>
    `${short ? 'Enh' : 'Enhanced'} ${b < 0 ? '-' : '+'}${(Math.round(Math.abs(b) * 100) / 100).toFixed(2)}`;
  const layout = (short: boolean) =>
    slots.map((sl) => {
      if (!sl.o) return null;
      const o = { ...sl.o, chip: sl.bonus !== null ? chipText(short, sl.bonus) : null };
      const { cx, cy, r } = sl.circle;
      return { o, g: measurePlate(ctx, sl.read.match.edge, cx, cy - r, scaleX, scaleY, o) };
    });
  const touches = (ls: ReturnType<typeof layout>) =>
    ls.some((a, i) =>
      ls.some(
        (b, j) =>
          j > i &&
          !!a &&
          !!b &&
          a.g.x < b.g.x + b.g.w + 2 &&
          b.g.x < a.g.x + a.g.w + 2 &&
          a.g.y < b.g.y + b.g.h &&
          b.g.y < a.g.y + a.g.h,
      ),
    );
  let laid = layout(false);
  if (touches(laid)) laid = layout(true);
  slots.forEach((sl, i) => {
    const { cx, cy, r } = sl.circle;
    const box = { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
    if (sl.isBest) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = theme.take ?? DEFAULT_THEME.take!;
      ctx.beginPath();
      ctx.ellipse(cx * scaleX, cy * scaleY, r * scaleX, r * scaleY, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const l = laid[i];
    const res = l ? drawPlate(ctx, l.g, scaleX, scaleY, theme, l.o) : null;
    const score = sl.score;
    drawn.push({
      kind: sl.unknown ? 'unknown' : sl.isBest ? 'best' : 'card',
      itemId: sl.unknown ? null : sl.read.itemId,
      card: sl.read.card,
      readIndex: sl.readIndex,
      ...box,
      score,
      plate: res?.plate ?? null,
      veiled: sl.veiled,
      chip: res?.chip ?? null,
      chipText: res?.chip && l ? l.o.chip : null,
    });
  });
  if (reroll) {
    const rect = rerollRect ?? rerollButtonRect(frameW, frameH);
    const x0 = rect.x0 * scaleX,
      y0 = rect.y0 * scaleY,
      x1 = rect.x1 * scaleX,
      y1 = rect.y1 * scaleY;
    ctx.lineWidth = 4;
    ctx.strokeStyle = theme.reroll ?? DEFAULT_THEME.reroll!;
    roundedRect(ctx, x0, y0, x1 - x0, y1 - y0, 4);
    ctx.stroke();
    // the label is a card plate's size, centred above the button with the gap plates use above cards
    const edge = cards[0]?.read.match.edge ?? Math.round(frameH * 0.12);
    const font = Math.max(14, Math.round(edge * 0.2 * scaleY));
    const h = Math.round(font * 1.7);
    ctx.font = `bold ${font}px sans-serif`;
    const w = Math.round(ctx.measureText('RE-ROLL').width + font * 1.5);
    const lx = Math.round((x0 + x1) / 2 - w / 2);
    const ly = Math.max(2, Math.round(y0 - h - PLATE_GAP(edge, scaleY)));
    ctx.fillStyle = theme.reroll ?? DEFAULT_THEME.reroll!;
    roundedRect(ctx, lx, ly, w, h, 4);
    ctx.fill();
    ctx.fillStyle = theme.takeInk ?? DEFAULT_THEME.takeInk!;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText('RE-ROLL', lx + w / 2, ly + h / 2 + 1);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    drawn.push({
      kind: 'reroll',
      itemId: null,
      card: null,
      x0: rect.x0,
      y0: rect.y0,
      x1: rect.x1,
      y1: rect.y1,
      score: null,
      plate: { x0: lx / scaleX, y0: ly / scaleY, x1: (lx + w) / scaleX, y1: (ly + h) / scaleY },
    });
  }
  return drawn;
}

/** itemId -> points enhanced adds, from the advice ranking. */
export function bonusesFromAdvice(advice: OverlayAdvice | null): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of advice?.ranked ?? []) out[r.itemId] = r.enhancedBonus;
  return out;
}

/** itemId -> tier letter map from the advice ranking. */
export function gradesFromAdvice(advice: OverlayAdvice | null): Record<number, string> {
  const out: Record<number, string> = {};
  for (const r of advice?.ranked ?? []) out[r.itemId] = r.grade;
  return out;
}

/** itemId -> score map from the advice ranking, so drawn scores are exactly the panel's numbers. */
export function scoresFromAdvice(advice: OverlayAdvice | null): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of advice?.ranked ?? []) out[r.itemId] = r.score;
  return out;
}

/** Where the lobby status dot sits on a canvas of this height: ~10 px diameter and a 12 px margin at 1080p. */
function dotGeometry(canvasH: number) {
  const k = canvasH / 1080;
  const r = (10 * k) / 2;
  return { cx: 12 * k + r, cy: 12 * k + r, r };
}
const DOT_COLORS: Record<DotState, string> = { watching: '', reading: '#f0a830', failed: '#8a9092' };
const DOT_WORD: Record<DotState, string> = {
  watching: 'Watching for the draft',
  reading: 'Reading the draft',
  failed: 'Capture failed',
};
// Deadlock bolt from public/favicon.svg (48 x 45 box)
const BOLT =
  'M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z';

/** The lobby badge's rectangle (logo, title and status line around the dot) on a canvas of this height. */
export function dotBadgeRect(canvasH: number) {
  const k = canvasH / 1080;
  return { x: 4 * k, y: 1 * k, w: 232 * k, h: 32 * k };
}

/** Draws the lobby badge: status dot (teal watching / amber reading / grey failed), the bolt logo, the
 *  "STREET BRAWL ADVISOR" title and a status line; returns what it drew (the dot, as before). */
export function drawDot(
  ctx: CanvasRenderingContext2D,
  state: DotState,
  canvasH: number,
  theme: OverlayTheme = readTheme(),
  pulse = 0,
) {
  const g = dotGeometry(canvasH);
  const k = canvasH / 1080;
  const color = DOT_COLORS[state] || theme.teal;
  const b = dotBadgeRect(canvasH);
  ctx.save();
  // plate: charcoal with a thin teal border
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = theme.panel;
  ctx.strokeStyle = theme.teal;
  ctx.lineWidth = Math.max(1, k);
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, 4 * k);
  ctx.fill();
  ctx.stroke();
  // status dot
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2);
  ctx.fill();
  if (state === 'reading') {
    // a ring that grows and fades (`pulse` runs 0..1): the app is working on a frame
    ctx.globalAlpha = 0.6 * (1 - pulse);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, g.r * 0.35);
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.r * (1 + 0.5 * pulse), 0, Math.PI * 2);
    ctx.stroke();
  }
  // logo
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.translate(28 * k, 6 * k);
  ctx.scale((20 * k) / 48, (20 * k) / 48);
  ctx.fillStyle = theme.teal;
  ctx.fill(new Path2D(BOLT));
  ctx.restore();
  // title + status line
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = theme.text;
  ctx.font = `bold ${13 * k}px sans-serif`;
  ctx.fillText('STREET BRAWL ADVISOR', 54 * k, 15 * k);
  ctx.fillStyle = theme.muted;
  ctx.font = `${10.5 * k}px sans-serif`;
  ctx.fillText(`${DOT_WORD[state]}, F8`, 54 * k, 27.5 * k);
  ctx.restore();
  return { ...g, color, state };
}
