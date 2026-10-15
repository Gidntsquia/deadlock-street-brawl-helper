// Headless advice-latency run on the user's OBS recording. Run by real Windows electron.exe through
// `npm run win:latency` (scripts/win/run-latency.sh), and only when the worker or the user starts it: never by
// npm test, npm run check, win:e2e, win:demo or CI.
//
// It sets BRAWL_E2E (control window and overlay at opacity 0, the dummy at the bottom of the z-order: nothing shows on
// the desktop), starts test mode, plays the recording in the dummy `Deadlock` window (never renamed) and jumps to each
// labelled stretch of scripts/video-truth/labels.json, playing its `video` range padded 1 s at normal speed, once per
// run. The app's own `video.advice` lines (electron/main.ts, one per drawn set) are collected and turned into one row
// per labelled set that the old app drew a plate for (scripts/video-truth/footage-latency.json `oldMs`): ms from the
// label's `appear` to the first drawn advice naming all three labelled items (reference only), when the set's last card
// landed (`last card`, ms from `appear`), advice ms after that landing (`from last`, the target: 400 ms), and the
// capture/read/ocr/settle/draw parts. Runs the stretches 3 times by default; each draft is judged on its median `from
// last` over the runs. A set whose label marks a slot `covered` passes when it is advised with that slot as `?` (the
// 1.0 s fallback) and nothing wrong: the 400 ms budget does not apply to it. Records the Windows CPU load at the start
// and end of each run. Writes logs/win-latency.json; exit 1 when any draft fails, any row is `wrong`, or has no advice.
//
// Slow-PC mode (`--slow N`): the app's whole process tree is pinned to 1/N of the logical cores at below-normal
// priority. The pass bar there (`--bar-ms`, default 1000): every labelled set (not only those the old app drew a plate
// for) is advised, a `?` on a covered slot counts, the `?` fallback upgrades every other slot, nothing is `wrong`, and
// every row's `from last` is under the bar. Exit 1 when any row misses it.
//
// Flags: --only s7[,s3]  --runs N (default 3)  --video <Windows dir or file>  --slow N (N = 2 or 4: processor affinity to cores/N, below-normal priority; the bar below) --bar-ms N
//        --commit <sha> (passed by run-latency.sh)
'use strict';
process.env.BRAWL_E2E = '1';
// The overlay is invisible here (opacity 0) and read through executeJavaScript: keep it out of the topmost band too.
process.env.BRAWL_OVERLAY_NOT_TOP = '1';

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
/** The target: advice drawn within this many ms of the set's last card landing (median of the runs). */
const BUDGET_MS = 400;
/** A run that starts with Windows busier than this gets a warning (it still counts). */
const LOAD_WARN_PCT = 50;
const PAD_S = 1;

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const only = arg('--only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const runs = Math.max(1, Number(arg('--runs')) || 3);
/** A full run takes about 4 min: 10 min per run, plus start-up. */
const HARD_TIMEOUT_MS = (5 + 10 * runs) * 60_000;
// Each stretch of labels.json names its recording in `file`. `--video` is a Windows directory holding the recordings
// (default `D:\OBS Videos`) or the path of one recording file, which then serves the stretches that name it.
const videoArg = arg('--video') || 'D:\\OBS Videos';
const videoFor = (file) =>
  /\.(mkv|mp4)$/i.test(videoArg)
    ? videoArg.split(/[\\/]/).pop() === file
      ? videoArg
      : null
    : `${videoArg.replace(/[\\/]+$/, '')}\\${file}`;
const commit = arg('--commit') || 'unknown';
const SLOW = Math.max(1, Number(arg('--slow')) || 1);
/** Normal runs: the 400 ms budget on each draft's median. Slow runs: the bar, on every row (`--bar-ms` tightens or loosens it). */
const LIMIT_MS = Number(arg('--bar-ms')) || (SLOW > 1 ? 1000 : BUDGET_MS);
const overLimit = (ms) => (SLOW > 1 ? ms >= LIMIT_MS : ms > LIMIT_MS);

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
      if (!base || (base.oldMs == null && SLOW === 1)) continue;
      const next = st.sets[k + 1];
      const until = next ? (next.appear ?? next.from) : st.video[1] + PAD_S;
      // Every plate drawn while this set was the newest on screen. A `video.advice` row matched to it by main carries
      // its stretch/draft; a row main could not match (other items) is placed by its video time.
      const drawn = mine.filter((a) =>
        a.stretch
          ? a.stretch === st.id && a.draft === set.draft && a.appearAt === set.appear
          : a.file === st.file && a.videoAt >= set.appear && a.videoAt < until && a.videoAt <= st.video[1] + PAD_S,
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
      const why = [];
      if (strayItems.length) why.push(`advised ${strayItems.map((a) => a.items.join('/')).join('; ')}`);
      // The label's expected call (`expect`: reroll | take) judges the counted advice; sets without one are never wrong on it.
      const calledReroll = full ? !!full.reroll : reroll;
      if (set.expect === 'reroll' && !calledReroll) why.push('expected re-roll, drew take');
      if (set.expect === 'take' && calledReroll) why.push('expected take, drew re-roll');
      // `best`: the item the set must end on (its last complete advice; a late ENHANCED mark re-ranks the set).
      const complete = drawn.filter((a) => !a.unsure && sameItems(a.items, set.items));
      const last = complete.at(-1) ?? null;
      const finalBest = last ? (last.reroll ? 're-roll' : last.best) : null;
      if (set.best && last && finalBest !== set.best) why.push(`expected take ${set.best}, ended on ${finalBest}`);
      const row = {
        stretch: st.id,
        draft: set.draft,
        labelItems: set.items,
        advisedItems: (full ?? first)?.items ?? [],
        best: (full ?? first)?.best ?? null,
        finalBest,
        grades: full?.grades ?? [],
        hero: (full ?? first)?.hero ?? '',
        oldMs: base.oldMs,
        newMs: full ? full.newMs : null,
        lastCard: full?.lastCard ?? null,
        fromLast: full?.fromLast ?? null,
        covered: !!set.covered?.length,
        appear: set.appear,
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
      row.fail = row.wrong
        ? 'wrong'
        : row.newMs == null
          ? 'no advice'
          : row.covered && SLOW === 1
            ? ''
            : row.fromLast == null
              ? row.covered
                ? ''
                : 'no landing'
              : overLimit(row.fromLast)
                ? `${SLOW > 1 ? '>=' : '>'} ${LIMIT_MS} ms`
                : '';
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
    `${pad('set', 9)} ${pad('label items', 52)} ${pad('advised', 52)} ${padL('old', 5)} ${padL('new', 5)} ${padL('last', 5)} ${padL('from', 5)} ${padL('first', 5)} ${padL('cap', 4)} ${padL('read', 5)} ${padL('ocr', 5)} ${padL('settl', 5)} ${padL('draw', 4)} rr  result`,
  );
  for (const r of rows)
    say(
      `${pad(r.stretch + ' ' + r.draft, 9)} ${pad(r.labelItems.join(', '), 52)} ${pad(r.advisedItems.join(', '), 52)} ${padL(r.oldMs, 5)} ${padL(r.newMs, 5)} ${padL(r.lastCard, 5)} ${padL(r.fromLast, 5)} ${padL(r.firstMs, 5)} ${padL(r.capture, 4)} ${padL(r.read, 5)} ${padL(r.ocr, 5)} ${padL(r.settle, 5)} ${padL(r.draw, 4)} ${r.reroll ? 'yes' : 'no '} ${r.fail || 'ok'}${r.coveredUnsure || (r.covered && !r.fail) ? ' (covered slot ?)' : ''}${r.why ? ' (' + r.why + ')' : ''}`,
    );
}

/** Windows CPU load in % over `ms`, from the cores' busy/idle times (no child process). */
async function cpuLoad(ms = 1000) {
  const snap = () =>
    os.cpus().reduce(
      (a, c) => {
        const t = c.times;
        a.idle += t.idle;
        a.total += t.user + t.nice + t.sys + t.irq + t.idle;
        return a;
      },
      { idle: 0, total: 0 },
    );
  const a = snap();
  await sleep(ms);
  const b = snap();
  const total = b.total - a.total;
  return total > 0 ? Math.round((100 * (total - (b.idle - a.idle))) / total) : null;
}
/** Slow-PC mode: pin the app's whole process tree to 1/SLOW of the logical cores, below-normal priority. */
function throttle() {
  if (SLOW <= 1) return;
  const { execFileSync } = require('node:child_process');
  const cores = os.cpus().length;
  const n = Math.max(1, Math.floor(cores / SLOW));
  const mask = (2n ** BigInt(n) - 1n).toString();
  const ps =
    `$r=@(${process.pid});$all=Get-CimInstance Win32_Process;$q=@(${process.pid});` +
    `while($q.Count){$n=@();foreach($x in $q){$n+=$all|?{$_.ParentProcessId -eq $x}|%{$_.ProcessId}};$r+=$n;$q=$n};` +
    `$c=0;foreach($i in $r){try{$p=Get-Process -Id $i -ErrorAction Stop;$p.ProcessorAffinity=[IntPtr]${mask};$p.PriorityClass='BelowNormal';$c++}catch{}};Write-Output $c`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
  say(`slow x${SLOW}: ${out} processes pinned to ${n} of ${cores} logical cores, below-normal priority`);
  slowNote = `x${SLOW}: ${n} of ${cores} logical cores, below-normal priority, ${out} processes`;
}
let slowNote = null;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

/** One entry per labelled set over all runs: best / median / worst `from last` and the verdict. */
function perDraftOf(perRun) {
  const out = [];
  for (const first of perRun[0] ?? []) {
    const same = perRun
      .map((rows) =>
        rows.find((r) => r.stretch === first.stretch && r.draft === first.draft && r.appear === first.appear),
      )
      .filter(Boolean);
    const fl = same.map((r) => r.fromLast).filter((x) => x != null);
    const wrong = same.some((r) => r.wrong);
    const none = same.some((r) => r.newMs == null);
    const med = median(fl);
    const verdict = wrong
      ? 'wrong'
      : none
        ? 'no advice'
        : first.covered && SLOW === 1
          ? 'ok (covered slot ?)'
          : med == null
            ? first.covered
              ? 'ok (covered slot ?)'
              : 'no landing'
            : SLOW > 1
              ? fl.some(overLimit)
                ? `>= ${LIMIT_MS} ms`
                : 'ok'
              : med <= LIMIT_MS
                ? 'ok'
                : `median > ${LIMIT_MS} ms`;
    const mid = (k) => median(same.map((r) => r[k]).filter((x) => x != null));
    out.push({
      stretch: first.stretch,
      draft: first.draft,
      appear: first.appear,
      items: first.labelItems,
      oldMs: first.oldMs,
      runs: same.length,
      lastCard: mid('lastCard'),
      best: fl.length ? Math.min(...fl) : null,
      median: med,
      worst: fl.length ? Math.max(...fl) : null,
      newMs: mid('newMs'),
      capture: mid('capture'),
      read: mid('read'),
      ocr: mid('ocr'),
      settle: mid('settle'),
      draw: mid('draw'),
      reroll: same.some((r) => r.reroll),
      verdict,
      pass: verdict === 'ok' || verdict === 'ok (covered slot ?)',
    });
  }
  return out;
}
function printPerDraft(list) {
  say(
    `${pad('set', 9)} ${pad('label items', 52)} ${padL('old', 5)} ${padL('last', 5)} ${padL('best', 5)} ${padL('med', 5)} ${padL('worst', 5)} ${padL('ocr', 5)} ${padL('settl', 5)} verdict`,
  );
  for (const d of list)
    say(
      `${pad(d.stretch + ' ' + d.draft, 9)} ${pad(d.items.join(', '), 52)} ${padL(d.oldMs, 5)} ${padL(d.lastCard, 5)} ${padL(d.best, 5)} ${padL(d.median, 5)} ${padL(d.worst, 5)} ${padL(d.ocr, 5)} ${padL(d.settle, 5)} ${d.verdict}`,
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
  // Windows paths seen from this process: check every recording the chosen stretches name.
  for (const file of new Set(stretches.map((st) => st.file))) {
    const p = videoFor(file);
    if (!p || !fs.existsSync(p)) {
      say(`ERROR: the recording is not there: ${p ?? file}`);
      return finish(1, { date: new Date().toISOString(), error: `no video at ${p ?? file}`, rows: [] });
    }
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
  const v = (js) => e2e.videoControl(`(() => { const v = document.getElementById('vid'); ${js} })()`);
  let loadedFile = null;
  /** Opens the recording a stretch names in the dummy (once per file); returns an error text or null. */
  const openFile = async (file) => {
    if (file === loadedFile) return null;
    const p = videoFor(file);
    if (!p) return `no path for ${file} (--video ${videoArg})`;
    await e2e.playTestVideo(p);
    const err = await v('return v.error ? String(v.error.code) : null;');
    if (err) return `the recording ${file} will not play (code ${err})`;
    await v('v.pause();');
    loadedFile = file;
    return null;
  };

  const t0 = Date.now();
  const loads = [];
  for (let run = 1; run <= runs; run++) {
    currentRun = run;
    throttle();
    const startLoad = await cpuLoad();
    if (startLoad != null && startLoad > LOAD_WARN_PCT)
      say(
        `WARNING: run ${run} starts with Windows CPU load at ${startLoad} % (over ${LOAD_WARN_PCT} %); it still counts`,
      );
    loads.push({ run, start: startLoad, end: null });
    for (const st of stretches) {
      const openErr = await openFile(st.file);
      if (openErr) {
        say(`ERROR: ${openErr}`);
        return finish(1, { date: new Date().toISOString(), error: openErr, rows: [] });
      }
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
    loads[run - 1].end = await cpuLoad();
    say(`run ${run}: Windows CPU load ${loads[run - 1].start} % at start, ${loads[run - 1].end} % at end`);
  }
  await sleep(500); // the last plates' acks
  say(`played ${stretches.length} stretch(es) x ${runs} in ${Math.round((Date.now() - t0) / 1000)} s`);

  const report = {
    date: new Date().toISOString(),
    machine: `${os.hostname()} (${os.cpus()[0]?.model?.trim() ?? 'cpu'}, ${os.cpus().length} threads)`,
    commit,
    video: videoArg,
    slow: SLOW > 1 ? { n: SLOW, note: slowNote, limitMs: LIMIT_MS } : null,
    runs,
    only: only ?? null,
    budgetMs: LIMIT_MS,
    load: loads,
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
    bad = bad.concat(
      rows.filter((r) => r.wrong || r.newMs == null).map((r) => `run ${run} ${r.stretch} ${r.draft} (${r.fail})`),
    );
  }
  report.perDraft = perDraftOf(report.perRun);
  say(`--- per draft over ${runs} run(s): best / median / worst ms from the last card ---`);
  printPerDraft(report.perDraft);
  bad = bad.concat(
    report.perDraft
      .filter((d) => !d.pass && d.verdict !== 'wrong' && d.verdict !== 'no advice')
      .map((d) => `${d.stretch} ${d.draft} (${d.verdict})`),
  );
  // A looped play must not match a set of another stretch: every matched row lies within 60 s of its label.
  const stray = advice.filter((a) => a.stretch && Math.abs(a.newMs) >= 60_000);
  if (stray.length) bad.push(`${stray.length} row(s) matched 60 s or more from their label`);
  const all = report.perRun.flat();
  const fl = all.map((r) => r.fromLast).filter((x) => x != null);
  const pd = report.perDraft;
  const summary =
    `win:latency ${report.date} ${commit}: ${runs} run(s), ${all.length} rows, ` +
    `${all.filter((r) => r.fromLast != null && (SLOW > 1 ? r.fromLast < LIMIT_MS : r.fromLast <= LIMIT_MS)).length} rows under ${LIMIT_MS} ms from last card, ` +
    `${pd.filter((d) => d.pass).length}/${pd.length} drafts pass (median), ` +
    `from last max ${fl.length ? Math.max(...fl) : '-'} ms, median ${median(fl) ?? '-'} ms, ` +
    `${all.filter((r) => r.wrong).length} wrong, load ${loads.map((l) => `${l.start}->${l.end} %`).join(' ')}` +
    (bad.length ? `. FAIL: ${bad.join(', ')}` : '. PASS');
  report.summary = summary;
  say(summary);
  finish(bad.length ? 1 : 0, report);
}

main().catch((e) => {
  say('LATENCY RUN ERROR ' + (e && e.stack ? e.stack : String(e)));
  finish(1, { date: new Date().toISOString(), error: String(e), rows: [] });
});
