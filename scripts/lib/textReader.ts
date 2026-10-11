// The name reader for Node tools and tests. The app reads crops with Windows OCR in a helper main runs; here the same
// prepared crops (src/brawl/ocr.ts) are looked up in recordings of that helper's answers, keyed by a hash of the exact
// pixels, so tests give the same reads on WSL, Linux CI and Windows.
//
// BRAWL_OCR (env):
//   unset / 'recorded'  answers come only from scripts/fixtures/ocr-recorded/; a crop with no recording fails like a
//                       reader that is down (counted in recordedMisses()).
//   'record'            recordings first, the live helper (powershell.exe, so WSL or Windows) for the rest, and the new
//                       answers are saved.
//   'live'              every crop goes to the live helper; the answers are not saved. Used to check that the recordings
//                       still match the reader on this machine.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTextReader, ReaderDownError, type TextImage, type TextKind, type TextRead } from '../../src/brawl/ocr';
import { startNameReader, type NameReader } from '../../electron/nameReader';

const here = dirname(fileURLToPath(import.meta.url));
export const RECORDED_DIR = resolve(here, '../fixtures/ocr-recorded');
const STORE = join(RECORDED_DIR, 'reads.json');
const HELPER = resolve(here, '../../electron/winocr-helper.ps1');

export interface Recorded {
  kind: TextKind;
  w: number;
  h: number;
  text: string;
  ms: number;
}

export function cropKey(img: TextImage, kind: TextKind): string {
  return createHash('sha1').update(`${kind} ${img.width} ${img.height} `).update(img.data).digest('hex');
}

let store: Record<string, Recorded> | null = null;
let dirty = false;
let misses = 0;
const missKeys: string[] = [];
export const recordedMisses = () => misses;
export const recordedMissKeys = () => missKeys.slice();

function loadStore(): Record<string, Recorded> {
  if (!store) store = existsSync(STORE) ? (JSON.parse(readFileSync(STORE, 'utf8')) as Record<string, Recorded>) : {};
  return store;
}

/** Writes new recordings, merged with whatever another process saved meanwhile, keys sorted so diffs stay small. */
export function saveRecordings(): void {
  if (!dirty || !store) return;
  mkdirSync(RECORDED_DIR, { recursive: true });
  const disk = existsSync(STORE) ? (JSON.parse(readFileSync(STORE, 'utf8')) as Record<string, Recorded>) : {};
  const all = { ...disk, ...store };
  const sorted: Record<string, Recorded> = {};
  for (const k of Object.keys(all).sort()) sorted[k] = all[k]!;
  const tmp = `${STORE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(sorted, null, 0).replace(/},"/g, '},\n"') + '\n');
  renameSync(tmp, STORE);
  dirty = false;
}

/** The recorded answer for this prepared crop, if any. */
export function recordedRead(img: TextImage, kind: TextKind): Recorded | undefined {
  return loadStore()[cropKey(img, kind)];
}

let live: NameReader | null = null;
let liveReady: Promise<void> | null = null;

/** The helper script where powershell.exe can open it: as is on Windows, copied to the Windows temp folder on WSL. */
function helperPath(): string {
  if (process.platform === 'win32') return HELPER;
  const winTemp = execFileSync('powershell.exe', ['-NoProfile', '-Command', '[IO.Path]::GetTempPath()'], {
    encoding: 'utf8',
  }).trim();
  const wslTemp = execFileSync('wslpath', ['-u', winTemp], { encoding: 'utf8' }).trim();
  const dest = join(wslTemp, 'brawl-winocr-helper.ps1');
  copyFileSync(HELPER, dest);
  return execFileSync('wslpath', ['-w', dest], { encoding: 'utf8' }).trim();
}

function liveReader(): Promise<NameReader> {
  if (!live) {
    live = startNameReader({ script: helperPath(), timeoutMs: 20000, startTimeoutMs: 30000 });
    const r = live;
    liveReady = new Promise((res, rej) => {
      if (r.state() === 'ready') return res();
      r.onState((s) => (s === 'ready' ? res() : s === 'failed' ? rej(new ReaderDownError('live reader failed')) : 0));
    });
    process.once('exit', () => r.stop());
  }
  return liveReady!.then(() => live!);
}

/** A fresh helper's start to ready (its engine up and one warm-up read answered), in ms. */
export async function measureColdStart(): Promise<number> {
  const script = helperPath();
  const t = performance.now();
  const r = startNameReader({ script, startTimeoutMs: 30000 });
  try {
    await new Promise<void>((res, rej) =>
      r.onState((s) => (s === 'ready' ? res() : s === 'failed' ? rej(new ReaderDownError('cold start failed')) : 0)),
    );
    return performance.now() - t;
  } finally {
    r.stop();
  }
}

/** Stops the live helper (if one was started) so the process can exit. */
export function stopLiveReader(): void {
  saveRecordings();
  live?.stop();
  live = null;
  liveReady = null;
}

export type ReaderMode = 'recorded' | 'record' | 'live';
export const readerMode = (): ReaderMode => {
  const m = process.env.BRAWL_OCR;
  return m === 'record' || m === 'live' ? m : 'recorded';
};

export async function nodeRead(img: TextImage, kind: TextKind, mode = readerMode()): Promise<TextRead> {
  const key = cropKey(img, kind);
  if (mode !== 'live') {
    const hit = loadStore()[key];
    if (hit) return { text: hit.text, ms: hit.ms };
    if (mode === 'recorded') {
      misses++;
      if (missKeys.length < 50) missKeys.push(key);
      throw new ReaderDownError('not recorded');
    }
  }
  const r = await (await liveReader()).read(img.width, img.height, img.data);
  if (mode === 'record') {
    loadStore()[key] = { kind, w: img.width, h: img.height, text: r.text, ms: r.ms };
    dirty = true;
  }
  return r;
}

let installed = false;
/** Installs the Node reader into src/brawl/ocr.ts (idempotent) and saves recordings and stops the helper on exit. */
export function installTextReader(mode = readerMode()): void {
  setTextReader((img, kind) => nodeRead(img, kind, mode));
  if (installed) return;
  installed = true;
  process.once('exit', () => {
    try {
      saveRecordings();
    } catch {
      /* best effort */
    }
  });
}
