// The name reader: one hidden PowerShell child running electron/winocr-helper.ps1 (Windows.Media.Ocr). Crops go in as
// one stdin line each ("<id> <w> <h> <base64 RGBA>"), answers come back as JSON lines {id, text, ms}. Started with the
// app and warmed with one dummy crop before the first draft; restarted once if it exits; after a second exit (or a
// failed start) it is down for good and every read fails at once. No Electron imports: Node tools reuse it to read
// live from WSL (scripts/lib/textReader.ts).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { log } from '../src/log';

export type ReaderState = 'starting' | 'ready' | 'failed';

export interface NameReader {
  read(width: number, height: number, rgba: Uint8Array): Promise<{ text: string; ms: number }>;
  state(): ReaderState;
  onState(cb: (s: ReaderState) => void): void;
  /** The helper's process id, while it runs. */
  pid(): number | undefined;
  stop(): void;
}

export interface NameReaderOpts {
  /** The helper script as the PowerShell side sees it (a Windows path). */
  script: string;
  powershell?: string;
  /** A read that gets no answer in this long fails (the helper is stuck or gone). */
  timeoutMs?: number;
  /** Start ms budget: a helper that is not ready by then counts as a failed start. */
  startTimeoutMs?: number;
}

const WARM_W = 160,
  WARM_H = 48;
/** A white line with a few dark strokes: enough for the engine to run its whole pass. */
function warmCrop(): Uint8Array {
  const d = new Uint8Array(WARM_W * WARM_H * 4).fill(255);
  for (let x = 14; x < 140; x += 9)
    for (let y = 14; y < 34; y++)
      for (let dx = 0; dx < 2; dx++) {
        const o = (y * WARM_W + x + dx) * 4;
        d[o] = d[o + 1] = d[o + 2] = 0;
      }
  return d;
}

export function startNameReader(opts: NameReaderOpts): NameReader {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const startTimeoutMs = opts.startTimeoutMs ?? 15000;
  let child: ChildProcessWithoutNullStreams | null = null;
  let st: ReaderState = 'starting';
  let exits = 0;
  let stopped = false;
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (v: { text: string; ms: number }) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const listeners: ((s: ReaderState) => void)[] = [];
  const setState = (s: ReaderState) => {
    if (s === st) return;
    st = s;
    for (const l of listeners) l(s);
  };
  const failAll = (why: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
      pending.delete(id);
    }
  };
  const fail = (why: string) => {
    if (st === 'failed') return;
    log('name-reader', 'error', 'reader.failed', { why, exits });
    setState('failed');
    failAll(why);
    if (child && child.exitCode === null) child.kill();
    child = null;
  };

  const send = (width: number, height: number, rgba: Uint8Array) =>
    new Promise<{ text: string; ms: number }>((resolve, reject) => {
      const c = child;
      if (!c || st === 'failed') return reject(new Error('reader-down'));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('reader-timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      c.stdin.write(
        `${id} ${width} ${height} ${Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength).toString('base64')}\n`,
      );
    });

  const launch = () => {
    const t0 = Date.now();
    let ready = false;
    log('name-reader', 'info', 'reader.start', { attempt: exits + 1 });
    let c: ChildProcessWithoutNullStreams;
    try {
      c = spawn(
        opts.powershell ?? 'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', opts.script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (e) {
      fail(`spawn: ${(e as Error).message}`);
      return;
    }
    child = c;
    const startTimer = setTimeout(() => {
      if (!ready && child === c) fail('start-timeout');
    }, startTimeoutMs);
    let buf = '';
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/^﻿/, '').trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m: {
          id?: number;
          text?: string;
          ms?: number;
          ready?: boolean;
          fatal?: string;
          error?: string;
          lang?: string;
        };
        try {
          m = JSON.parse(line);
        } catch {
          log('name-reader', 'warn', 'reader.noise', { line: line.slice(0, 200) });
          continue;
        }
        if (m.fatal) {
          fail(m.fatal);
          return;
        }
        if (m.ready) {
          // one dummy crop through the whole stdin path, so the first draft read is warm
          void send(WARM_W, WARM_H, warmCrop()).then(
            (r) => {
              ready = true;
              clearTimeout(startTimer);
              log('name-reader', 'info', 'reader.ready', {
                ms: Date.now() - t0,
                engineMs: m.ms,
                warmMs: r.ms,
                lang: m.lang,
                pid: c.pid,
              });
              if (child === c) setState('ready');
            },
            (e: Error) => fail(`warm: ${e.message}`),
          );
          continue;
        }
        if (typeof m.id === 'number') {
          const p = pending.get(m.id);
          if (!p) continue;
          pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.error) log('name-reader', 'warn', 'reader.error', { error: m.error });
          p.resolve({ text: m.text ?? '', ms: m.ms ?? 0 });
        }
      }
    });
    c.stderr.setEncoding('utf8');
    c.stderr.on('data', (d: string) => log('name-reader', 'warn', 'reader.stderr', { text: d.slice(0, 300) }));
    c.stdin.on('error', () => {}); // a write after the child died: the exit handler deals with it
    c.on('error', (e) => {
      clearTimeout(startTimer);
      if (child === c) fail(`spawn: ${e.message}`);
    });
    c.on('exit', (code, signal) => {
      clearTimeout(startTimer);
      if (child !== c) return;
      child = null;
      failAll('reader-exit');
      if (stopped) return;
      exits++;
      log('name-reader', 'warn', 'reader.exit', { code, signal, exits });
      if (st === 'failed') return;
      if (exits >= 2) {
        fail('exited twice');
        return;
      }
      log('name-reader', 'info', 'reader.restart', {});
      setState('starting');
      launch();
    });
  };
  launch();

  return {
    read: (w, h, rgba) => (st === 'ready' ? send(w, h, rgba) : Promise.reject(new Error('reader-down'))),
    state: () => st,
    onState: (cb) => listeners.push(cb),
    pid: () => child?.pid,
    stop: () => {
      stopped = true;
      failAll('reader-stopped');
      if (child && child.exitCode === null) {
        child.stdin.end();
        child.kill();
      }
      child = null;
    },
  };
}
