// Headless advice-latency run on the user's OBS recording. Run by real Windows electron.exe through
// `npm run win:latency` (scripts/win/run-latency.sh), and only when the worker or the user starts it: never by
// npm test, npm run check, win:e2e, win:demo or CI.
//
// It sets BRAWL_E2E (control window and overlay at opacity 0, the dummy at the bottom of the z-order: nothing shows on
// the desktop), starts test mode, plays the recording in the dummy `Deadlock` window (never renamed) and jumps to each
// labelled stretch of scripts/video-truth/labels.json, playing its `video` range padded 1 s at normal speed, once per
// run. The app's own `video.advice` lines (electron/main.ts, one per drawn set) are collected and turned into one row
// per labelled set that the old app drew a plate for (scripts/video-truth/footage-latency.json `oldMs`): new ms from the
// label's `appear` to the first drawn advice naming all three labelled items, and its capture/read/ocr/settle/draw parts.
// Writes logs/win-latency.json; exit 1 when any row is at 1000 ms or more, is `wrong`, or has no advice.
//
// Flags: --only s7[,s3]  --runs N  --video <Windows path>  --commit <sha> (passed by run-latency.sh: no .git here)
//        --relay page: text reads go worker -> page -> main as before the direct port (BRAWL_OCR_RELAY), to compare
'use strict';
process.env.BRAWL_E2E = '1';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,AllowWgcWindowCapturer');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const ROOT = path.join(__dirname, '..', '..');
const REPORT = path.join(ROOT, 'logs', 'win-latency.json');
const DEBUG_LOG = path.join(ROOT, 'logs', 'win-latency-debug.log');
const LIMIT_MS = 1000;
const PAD_S = 1;
const HARD_TIMEOUT_MS = 15 * 60_000;

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const only = arg('--only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const runs = Math.max(1, Number(arg('--runs')) || 1);
if (arg('--relay') === 'page') process.env.BRAWL_OCR_RELAY = 'page';
const video = arg('--video') || 'D:\\OBS Videos\\2026-10-09 00-46-30.mkv';
const commit = arg('--commit') || 'unknown';

fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
fs.writeFileSync(DEBUG_LOG, `${new Date().toISOString()} --- latency run start ---\n`);
// Lines are kept in memory and written once a second off the main thread's path: a synchronous append per line
// (about 40 ms each on this box) ran inside the app's main process and held back the OCR relay and the plates.
let dbgLines = [];
let dbgWriting = false; // one write at a time keeps the lines in order
const flushDbg = (sync = false) => {
  if (!dbgLines.length || (dbgWriting && !sync)) return;
  const text = dbgLines.join('');
  dbgLines = [];
  try {
    if (sync) fs.appendFileSync(DEBUG_LOG, text);
    else {
      dbgWriting = true;
      fs.appendFile(DEBUG_LOG, text, () => (dbgWriting = false));
    }
  } catch {
    /* best effort */
  }
};
setInterval(flushDbg, 1000).unref();
const dbg = (m) => {
  dbgLines.push(`${new Date().toISOString()} ${m}\n`);
};
const say = (m) => {
  dbg(m);
  process.stdout.write(m + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, stepMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

// The app's main-process log lines: video.advice rows are what the table is built from; everything goes to the debug log.
const advice = [];
for (const level of ['info', 'warn', 'error', 'log']) {
  const real = console[level].bind(console);
  console[level] = (...args) => {
    const line = args.map(String).join(' ');
    dbg(`main ${level}: ${line}`);
    if (line.includes('"msg":"video.advice"')) {
      try {
        advice.push({ ...JSON.parse(line), run: currentRun });
      } catch {
        /* not one JSON line */
      }
    }
    if (level === 'error') real(...args);
  };
}
process.on('uncaughtException', (err) => dbg('uncaughtException: ' + (err && err.stack ? err.stack : String(err))));
let currentRun = 0;

const labels = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'video-truth', 'labels.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'video-truth', 'footage-latency.json'), 'utf8'));
const stretches = labels.stretches.filter((s) => !only || only.includes(s.id));

const sameItems = (a, b) => a.length === b.length && a.every((n) => b.includes(n));

/** One row per labelled set the old app drew a plate for, from the `video.advice` lines of one run. */
function rowsFor(run) {
  const out = [];
  const mine = advice.filter((a) => a.run === run);
  for (const st of stretches) {
    for (let k = 0; k < st.sets.length; k++) {
      const set = st.sets[k];
      const base = baseline.find((b) => b.stretch === st.id && b.draft === set.draft && b.appear === set.appear);
      if (!base || base.oldMs == null) continue;
      const next = st.sets[k + 1];
      const until = next ? (next.appear ?? next.from) : st.video[1] + PAD_S;
      // Every plate drawn while this set was the newest on screen. A `video.advice` row matched to it by main carries
      // its stretch/draft; a row main could not match (other items) is placed by its video time.
      const drawn = mine.filter((a) =>
        a.stretch
          ? a.stretch === st.id && a.draft === set.draft && a.appearAt === set.appear
          : a.videoAt >= set.appear && a.videoAt < until && a.videoAt <= st.video[1] + PAD_S,
      );
      // A slot the labels mark `covered` (a hover tooltip hides its name line) may stay `?`, as in the video-truth
      // rules: the set counts as advised when every other card is advised and the covered ones are the `?`.
      const uncovered = set.items.filter((_, i) => !(set.covered ?? []).includes(i));
      // The first plates that count, whichever kind came first.
      const full = drawn.find(
        (a) =>
          (!a.unsure && sameItems(a.items, set.items)) ||
          (set.covered?.length && a.unsure > 0 && a.unsure <= set.covered.length && sameItems(a.items, uncovered)),
      );
      const first = drawn[0] ?? null;
      const strayItems = drawn.filter((a) => a.items.some((n) => n && !set.items.includes(n)));
      const reroll = drawn.some((a) => a.reroll);
      const strong = (full?.grades ?? []).filter((g) => g === 'S' || g === 'A').length > 0;
      const why = [];
      if (strayItems.length) why.push(`advised ${strayItems.map((a) => a.items.join('/')).join('; ')}`);
      if (reroll && strong) why.push('re-roll called on a set with an S or A item');
      const row = {
        stretch: st.id,
        draft: set.draft,
        labelItems: set.items,
        advisedItems: (full ?? first)?.items ?? [],
        best: (full ?? first)?.best ?? null,
        grades: full?.grades ?? [],
        hero: (full ?? first)?.hero ?? '',
        oldMs: base.oldMs,
        newMs: full ? full.newMs : null,
        coveredUnsure: full ? full.unsure : 0, // `?` plates on labelled covered slots in the counted advice
        firstMs: first ? first.newMs : null,
        firstUnsure: first ? first.unsure : null,
        capture: full?.capture ?? null,
        read: full?.read ?? null,
        ocr: full?.ocr ?? null,
        settle: full?.settle ?? null,
        draw: full?.draw ?? null,
        reroll,
        wrong: why.length > 0,
        why: why.join('; '),
      };
      row.fail = row.wrong ? 'wrong' : row.newMs == null ? 'no advice' : row.newMs >= LIMIT_MS ? '>= 1000 ms' : '';
      out.push(row);
    }
  }
  return out;
}

const pad = (v, n) =>
  String(v ?? '-')
    .padEnd(n)
    .slice(0, n);
const padL = (v, n) => String(v ?? '-').padStart(n);
function printTable(rows) {
  say(
    `${pad('set', 9)} ${pad('label items', 52)} ${pad('advised', 52)} ${padL('old', 5)} ${padL('new', 5)} ${padL('first', 5)} ${padL('cap', 4)} ${padL('read', 5)} ${padL('ocr', 5)} ${padL('settl', 5)} ${padL('draw', 4)} rr  result`,
  );
  for (const r of rows)
    say(
      `${pad(r.stretch + ' ' + r.draft, 9)} ${pad(r.labelItems.join(', '), 52)} ${pad(r.advisedItems.join(', '), 52)} ${padL(r.oldMs, 5)} ${padL(r.newMs, 5)} ${padL(r.firstMs, 5)} ${padL(r.capture, 4)} ${padL(r.read, 5)} ${padL(r.ocr, 5)} ${padL(r.settle, 5)} ${padL(r.draw, 4)} ${r.reroll ? 'yes' : 'no '} ${r.fail || 'ok'}${r.coveredUnsure ? ' (covered slot ?)' : ''}${r.why ? ' (' + r.why + ')' : ''}`,
    );
}

let finished = false;
function finish(code, report) {
  if (finished) return;
  finished = true;
  flushDbg(true);
  if (report) {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
  }
  app.exit(code);
}

async function main() {
  setTimeout(() => {
    say('LATENCY RUN TIMEOUT (15 min)');
    finish(1, { date: new Date().toISOString(), error: 'timeout', rows: [] });
  }, HARD_TIMEOUT_MS).unref();
  if (!fs.existsSync(video)) {
    say(`ERROR: the recording is not there: ${video}`);
    return finish(1, { date: new Date().toISOString(), error: `no video at ${video}`, rows: [] });
  }
  await app.whenReady();
  await import(require('node:url').pathToFileURL(path.join(ROOT, 'electron-dist', 'main.js')).href);
  const e2e = await waitFor(() => globalThis.__brawlE2E, 10_000);
  const control = e2e && (await waitFor(() => e2e.getControl(), 10_000));
  if (!control) {
    say('ERROR: the app did not boot');
    return finish(1, { date: new Date().toISOString(), error: 'no boot', rows: [] });
  }
  const overlay = await waitFor(() => e2e.getOverlay(), 10_000);
  control.webContents.on('console-message', (_e, _l, m) => dbg('control: ' + m));
  overlay?.webContents.on('console-message', (_e, _l, m) => dbg('overlay: ' + m));
  await waitFor(() => control.webContents.executeJavaScript('document.readyState === "complete"'), 10_000);
  // the name reader must be up: these reads are the real Windows OCR helper, no recorded answers
  const ready = await waitFor(() => e2e.readerState?.() === 'ready', 20_000, 200);
  say(`reader: ${e2e.readerState?.()}${ready ? '' : ' (not ready after 20 s)'}`);

  await e2e.startTestMode();
  const win = await waitFor(() => e2e.getTestWindow(), 8_000);
  if (!win || win.getTitle() !== 'Deadlock') {
    say('ERROR: test mode did not open the dummy');
    return finish(1, { date: new Date().toISOString(), error: 'no dummy', rows: [] });
  }
  await e2e.playTestVideo(video);
  const v = (js) => e2e.videoControl(`(() => { const v = document.getElementById('vid'); ${js} })()`);
  const err = await v('return v.error ? String(v.error.code) : null;');
  if (err) {
    say(`ERROR: the recording will not play (code ${err})`);
    return finish(1, { date: new Date().toISOString(), error: `video error ${err}`, rows: [] });
  }
  await v('v.pause();');

  const t0 = Date.now();
  for (let run = 1; run <= runs; run++) {
    currentRun = run;
    for (const st of stretches) {
      const from = Math.max(0, st.video[0] - PAD_S),
        to = st.video[1] + PAD_S;
      await e2e.videoControl(`new Promise((done) => { const v = document.getElementById('vid'); v.pause();
        const t = setTimeout(() => done(false), 8000);
        v.addEventListener('seeked', () => { clearTimeout(t); done(true); }, { once: true });
        v.currentTime = ${from}; })`);
      await v('return v.play().then(() => true, () => false);');
      say(`run ${run} ${st.id}: playing ${from} s to ${to} s`);
      const end = Date.now() + (to - from + 10) * 1000;
      while (Date.now() < end) {
        const at = await v('return v.currentTime;');
        if (typeof at !== 'number' || at >= to) break;
        await sleep(100);
      }
      await v('v.pause();');
    }
  }
  await sleep(500); // the last plates' acks
  say(`played ${stretches.length} stretch(es) x ${runs} in ${Math.round((Date.now() - t0) / 1000)} s`);

  const report = {
    date: new Date().toISOString(),
    machine: `${os.hostname()} (${os.cpus()[0]?.model?.trim() ?? 'cpu'}, ${os.cpus().length} threads)`,
    commit,
    video,
    runs,
    only: only ?? null,
    limitMs: LIMIT_MS,
    rows: [],
    perRun: [],
    advice,
  };
  let bad = [];
  for (let run = 1; run <= runs; run++) {
    const rows = rowsFor(run);
    say(`--- run ${run} ---`);
    printTable(rows);
    report.perRun.push(rows);
    if (run === 1) report.rows = rows;
    bad = bad.concat(rows.filter((r) => r.fail).map((r) => `run ${run} ${r.stretch} ${r.draft} (${r.fail})`));
  }
  // A looped play must not match a set of another stretch: every matched row lies within 60 s of its label.
  const stray = advice.filter((a) => a.stretch && Math.abs(a.newMs) >= 60_000);
  if (stray.length) bad.push(`${stray.length} row(s) matched 60 s or more from their label`);
  const all = report.perRun.flat();
  const ms = all.map((r) => r.newMs).filter((x) => x != null);
  const summary =
    `win:latency ${report.date} ${commit}: ${all.length} rows, ${all.filter((r) => !r.fail).length} ok, ` +
    `max ${ms.length ? Math.max(...ms) : '-'} ms, median ${ms.length ? ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)] : '-'} ms, ` +
    `${all.filter((r) => r.wrong).length} wrong` +
    (bad.length ? `. FAIL: ${bad.join(', ')}` : '. PASS');
  report.summary = summary;
  say(summary);
  finish(bad.length ? 1 : 0, report);
}

main().catch((e) => {
  say('LATENCY RUN ERROR ' + (e && e.stack ? e.stack : String(e)));
  finish(1, { date: new Date().toISOString(), error: String(e), rows: [] });
});
