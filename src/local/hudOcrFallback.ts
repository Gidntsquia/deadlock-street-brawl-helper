import type { RGBImage, Region } from '../brawl/recognise';
import { readHudText } from '../brawl/ocr';
import { readItemName, type ItemNameOcrCrop } from './cardNameOcr';

export function strictHudValue(text: string, field: 'points' | 'round' | 'caption'): number | boolean | null {
  const value = text.trim();
  if (field === 'caption') return value.toUpperCase().replace(/[^A-Z0-9]/g, '') === 'ROUNDBEGINSIN' ? true : null;
  if (field === 'round') return /^[1-5]$/.test(value) ? Number(value) : null;
  return /^[0-9]{1,2}$/.test(value) && Number(value) <= 64 ? Number(value) : null;
}
export function hudTextCrop(img: RGBImage, region: Region) {
  const data = new Uint8Array(region.width * region.height * 4);
  let hash = 2166136261,
    ink = false;
  for (let y = 0; y < region.height; y++)
    for (let x = 0; x < region.width; x++) {
      const src = ((region.y + y) * img.width + region.x + x) * img.channels;
      const dst = (y * region.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = img.data[src + c]!;
        data[dst + c] = v;
      }
      data[dst + 3] = 255;
      const hi = Math.max(data[dst]!, data[dst + 1]!, data[dst + 2]!);
      const lo = Math.min(data[dst]!, data[dst + 1]!, data[dst + 2]!);
      const foreground = hi > 140 && lo > 110 && hi - lo < 85;
      hash = Math.imul(hash ^ (foreground ? Math.floor(lo / 16) + 1 : 0), 16777619);
      ink ||= foreground;
    }
  return {
    data,
    width: region.width,
    height: region.height,
    key: `${region.x}:${region.y}:${region.width}:${region.height}:${hash >>> 0}`,
    ink,
  };
}
/** Copied raw primary, our binary, one grayscale nearest pass. Every attempt uses whole-field parsing. */
export async function readHudFallback(
  crop: ItemNameOcrCrop,
  field: 'points' | 'round' | 'caption',
  current: () => boolean = () => true,
  primary = readHudText,
  fallback = readItemName,
) {
  const copied = { ...crop, data: crop.data.slice() };
  let failed = false;
  const run = async (read: () => Promise<{ text: string; confidence: number }>) => {
    try {
      const text = await read();
      return current() && strictHudValue(text.text, field) !== null ? text : null;
    } catch {
      failed = true;
      return null;
    }
  };
  const profile = field === 'caption' ? 'caption' : 'digits';
  const first = await run(() => primary(copied, profile, current));
  if (first || !current()) return first;
  const preprocess = (soft: boolean) => {
    const data = new Uint8Array(copied.data.length).fill(255);
    for (let i = 0; i < data.length; i += 4) {
      if (field === 'points') {
        data[i] = copied.data[i]!;
        data[i + 1] = copied.data[i + 1]!;
        data[i + 2] = copied.data[i + 2]!;
        continue;
      }
      const value = Math.max(copied.data[i]!, copied.data[i + 1]!, copied.data[i + 2]!);
      const v = soft ? 255 - Math.max(0, Math.min(255, ((value - 80) * 255) / 130)) : value > 140 ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
    return { ...copied, data, ...(soft ? { scale: 4, interpolation: 'nearest' as const } : {}) };
  };
  const second = await run(() => fallback(preprocess(false), profile === 'digits'));
  if (second || !current()) return second;
  const third = await run(() => fallback(preprocess(true), profile === 'digits'));
  if (!third && failed) throw new Error('HUD OCR unavailable');
  return third;
}

/** OCR jobs never block frames; two fresh unresolved crops and two fresh confirmations qualify a field. */
export class HudOcrFallback {
  private generation = 0;
  private key = '';
  private firstAt = 0;
  private misses = 0;
  private lastSample = -1;
  private value: number | boolean | null = null;
  private confirmations = 0;
  private busy = false;
  private completed = false;
  private retryAt = 0;
  private field: 'round' | 'caption';
  private read: typeof readHudFallback;
  constructor(field: 'round' | 'caption', read = readHudFallback) {
    this.field = field;
    this.read = read;
  }

  reset() {
    this.generation++;
    this.key = '';
    this.value = null;
    this.confirmations = 0;
    this.misses = 0;
    this.busy = false;
    this.completed = false;
  }
  observe(img: RGBImage, region: Region, sample: number, now: number, enabled = true): number | boolean | null {
    if (!enabled) {
      this.reset();
      return null;
    }
    if (sample === this.lastSample) return this.confirmations >= 2 ? this.value : null;
    this.lastSample = sample;
    const crop = hudTextCrop(img, region);
    if (!crop.ink) {
      this.reset();
      return null;
    }
    if (crop.key !== this.key) {
      this.reset();
      this.key = crop.key;
      this.firstAt = now;
    }
    this.misses++;
    if (this.value !== null) {
      this.confirmations++;
      return this.confirmations >= 2 ? this.value : null;
    }
    if (this.misses < 2 || now - this.firstAt < 250 || this.busy || this.completed || now < this.retryAt) return null;
    this.busy = true;
    const generation = this.generation;
    const current = () => generation === this.generation;
    void this.read(crop, this.field, current)
      .then((text) => {
        if (!current()) return;
        this.value = text ? strictHudValue(text.text, this.field) : null;
        this.completed = true;
      })
      .catch(() => {
        if (current()) this.retryAt = now + 1000;
      })
      .finally(() => {
        if (current()) this.busy = false;
      });
    return null;
  }
}

/** A single HUD field has one physical OCR ladder, with finite immutable-source results. */
export class HudTextJobs {
  private generation = 0;
  private activeSource = '';
  private running: { key: string; promise: Promise<{ text: string; confidence: number } | null> } | null = null;
  private cache = new Map<string, { value: { text: string; confidence: number } | null; retryAt: number }>();
  reset() {
    this.generation++;
    this.activeSource = '';
    this.running = null;
    this.cache.clear();
  }
  constructor(privateReader?: typeof readHudFallback) {
    this.read = privateReader ?? readHudFallback;
  }
  private read: typeof readHudFallback;
  request(crop: ItemNameOcrCrop, field: 'points' | 'round' | 'caption', key: string) {
    this.activeSource = key;
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.retryAt) return Promise.resolve(cached.value);
    if (this.running) return this.running.key === key ? this.running.promise : Promise.resolve(null);
    const generation = this.generation;
    const current = () => generation === this.generation && this.activeSource === key;
    const owner = { key, promise: null as unknown as Promise<{ text: string; confidence: number } | null> };
    this.running = owner;
    owner.promise = this.read(crop, field, current)
      .then((value) => {
        if (current()) this.cache.set(key, { value, retryAt: Infinity });
        return current() ? value : null;
      })
      .catch(() => {
        if (current()) this.cache.set(key, { value: null, retryAt: Date.now() + 1000 });
        return null;
      })
      .finally(() => {
        if (this.running === owner) this.running = null;
        if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
      });
    return owner.promise;
  }
}
