// Every real frame in the repo that shows a draft's name lines, with the name each card truly carries where a label
// exists. Shared by the template harvest (scripts/build-glyphs.ts), the comparison tool (scripts/name-compare.ts) and the
// glyph tests. Labels: icon reads on the demo/live/screen frames (the icon search is pinned by frame-reads.test.ts and
// `brawl:see --fixtures`), the hand labels of the video truth set, and the recorded drafts of the session fixtures.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  cardNameCrop,
  cardSquares,
  decodeIconIndex,
  draftRegions,
  readDraftScreen,
  type RGBImage,
} from '../../src/brawl/recognise';
import type { Item } from '../../src/types';

export type NameCrop = NonNullable<ReturnType<typeof cardNameCrop>>;

export interface NameSample {
  source: 'demo' | 'live' | 'screen' | 'session' | 'video';
  /** file or folder#frame, for reports */
  frame: string;
  /** frame width in px */
  width: number;
  slot: number;
  crop: NameCrop;
  /** the item's name, or null when no label exists for this card */
  label: string | null;
  /** a hover tooltip or the cursor hides this name for good: unsure is right, a wrong item is not */
  covered?: boolean;
}

const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
export const itemName = (id: number) => items.find((i) => i.id === id)?.name ?? null;
const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
const tierOf = (id: number) => items.find((i) => i.id === id)?.item_tier ?? 0;

/** Only the pixels the worker would copy (draftRegions) stay; the rest is black. */
function keepRegions(data: Buffer, width: number, height: number, channels: 3 | 4): RGBImage {
  const kept = Buffer.alloc(data.length);
  for (const r of draftRegions(width, height))
    for (let y = r.y; y < r.y + r.height; y++)
      data.copy(kept, (y * width + r.x) * channels, (y * width + r.x) * channels, (y * width + r.x + r.width) * channels);
  return { width, height, data: kept, channels };
}

export async function loadFrame(file: string, resizeTo?: [number, number]): Promise<RGBImage> {
  let s = sharp(file).removeAlpha();
  if (resizeTo) s = s.resize(resizeTo[0], resizeTo[1], { fit: 'fill', kernel: 'lanczos3' });
  const { data, info } = await s.raw().toBuffer({ resolveWithObject: true });
  return keepRegions(data, info.width, info.height, 3);
}

export function cropsOf(img: RGBImage): (NameCrop | null)[] {
  const sq = cardSquares(img.width, img.height);
  return sq.map((s) => cardNameCrop(img, { ...s, itemId: 0, score: 0, margin: 0 } as never));
}

/** Item ids the icon search reads from the three cards (0 where a card is not found). */
export function iconIds(img: RGBImage): number[] {
  return readDraftScreen(img, index, tierOf).map((r) => (r.present ? r.itemId : 0));
}

export const DEMO_FRAMES = [
  'public/demo/choice1.png',
  'public/demo/choice2.png',
  'public/demo/draft-r1c2.png',
  'public/demo/draft-r2c1.png',
  'public/demo/draft-r2c3-reroll.png',
];
export const LIVE_FRAMES = ['scripts/win/frames/live/draft-r1c2.png', 'scripts/win/frames/live/draft-r2c1.png'];

/** Frames of a recorded draft folder (frames.json + region crops) as full-size images. */
export async function loadRegionFrame(
  dir: string,
  f: { regions: { x: number; y: number; width: number; height: number; file: string }[] },
  w: number,
  h: number,
  data: Buffer,
): Promise<RGBImage> {
  // The recorder stores only the regions that changed: the rest of the frame is what the last frame left there.
  for (const r of f.regions) {
    const { data: px } = await sharp(path.join(dir, r.file))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let y = 0; y < r.height; y++) px.copy(data, ((r.y + y) * w + r.x) * 3, y * r.width * 3, (y + 1) * r.width * 3);
  }
  return { width: w, height: h, data, channels: 3 };
}

interface FramesFile {
  t: number;
  regions: { x: number; y: number; width: number; height: number; file: string }[];
}

export interface LoadOpts {
  /** only these sources */
  only?: NameSample['source'][];
  /** video frames per stretch kept (every n-th), for quick runs */
  videoStep?: number;
}

export async function loadNameSamples(opts: LoadOpts = {}): Promise<NameSample[]> {
  const out: NameSample[] = [];
  const want = (s: NameSample['source']) => !opts.only || opts.only.includes(s);
  const fromFrame = (source: NameSample['source'], frame: string, img: RGBImage, labels: (string | null)[]) => {
    const crops = cropsOf(img);
    crops.forEach((crop, slot) => {
      if (crop) out.push({ source, frame, width: img.width, slot, crop, label: labels[slot] ?? null });
    });
  };
  const iconLabels = (img: RGBImage) => iconIds(img).map((id) => (id ? itemName(id) : null));
  if (want('demo'))
    for (const f of DEMO_FRAMES) {
      const img = await loadFrame(f);
      fromFrame('demo', f, img, iconLabels(img));
    }
  if (want('live'))
    for (const f of LIVE_FRAMES) {
      const img = await loadFrame(f);
      fromFrame('live', f, img, iconLabels(img));
    }
  if (want('screen')) {
    const dir = 'scripts/fixtures/brawl-screens';
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.png'))) {
      const img = await loadFrame(path.join(dir, f));
      fromFrame('screen', path.join(dir, f), img, iconLabels(img));
    }
  }
  if (want('session')) {
    const root = 'scripts/fixtures/sessions';
    for (const d of readdirSync(root).filter((n) => n.startsWith('m-'))) {
      const dir = path.join(root, d);
      const rec = JSON.parse(readFileSync(path.join(dir, 'draft.json'), 'utf8')) as {
        frameW: number;
        frameH: number;
        items: number[];
      };
      const frames: FramesFile[] = JSON.parse(readFileSync(path.join(dir, 'frames.json'), 'utf8'));
      const buf = Buffer.alloc(rec.frameW * rec.frameH * 3);
      for (const [fi, f] of frames.entries()) {
        const img = await loadRegionFrame(dir, f, rec.frameW, rec.frameH, buf);
        const ids = iconIds(img);
        // a card counts as labelled only where the frame's icon agrees with the recorded draft
        const labels = rec.items.map((id, i) => (id && ids[i] === id ? itemName(id) : null));
        fromFrame('session', `${dir}#${fi}`, img, labels);
      }
    }
  }
  if (want('video')) {
    const root = 'scripts/fixtures/video-truth';
    for (const d of readdirSync(root).filter((n) => /^s\d+$/.test(n))) {
      const dir = path.join(root, d);
      if (!existsSync(path.join(dir, 'truth.json'))) continue;
      const truth = JSON.parse(readFileSync(path.join(dir, 'truth.json'), 'utf8')) as {
        video: [number, number];
        fps: number;
        sets: { items: string[]; readable: [number, number] | null; covered?: number[] }[];
      };
      const rec = JSON.parse(readFileSync(path.join(dir, 'draft.json'), 'utf8')) as { frameW: number; frameH: number };
      const frames: FramesFile[] = JSON.parse(readFileSync(path.join(dir, 'frames.json'), 'utf8'));
      const buf = Buffer.alloc(rec.frameW * rec.frameH * 3);
      for (const [fi, f] of frames.entries()) {
        const t = truth.video[0] + fi / truth.fps;
        const set = truth.sets.find((s) => s.readable && t >= s.readable[0] && t <= s.readable[1]);
        // every frame feeds the buffer; only the labelled ones are cut
        const img = await loadRegionFrame(dir, f, rec.frameW, rec.frameH, buf);
        if (!set || (opts.videoStep && fi % opts.videoStep)) continue;
        const crops = cropsOf(img);
        crops.forEach((crop, slot) => {
          if (!crop) return;
          const covered = !!set.covered?.includes(slot);
          out.push({
            source: 'video',
            frame: `${dir}#${fi}`,
            width: img.width,
            slot,
            crop,
            label: covered ? null : (set.items[slot] ?? null),
            covered,
          });
        });
      }
    }
  }
  return out;
}
