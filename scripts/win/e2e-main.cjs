// Windows-only Electron test harness. Run by real electron.exe (never Linux Electron): sets BRAWL_E2E=1,
// requires the REAL electron-dist/main.js (not a stub), drives it via executeJavaScript, and writes one
// JSON report. Filter cases with --only <name1,name2,...>. Hard timeout 300s (raised from 90s once the
// `frames` and `testmode` cases were added -- a full default run takes ~150-160s end to end, and the old 90s
// ceiling cut it off mid-teardown, cascading into spurious failures on whichever case ran last).
'use strict';
process.env.BRAWL_E2E = '1';

const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const { app, screen } = require('electron');
// A dummy window sitting under other windows must keep rendering (and being capturable): no occlusion throttling.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const ROOT = path.join(__dirname, '..', '..');
const FAKE_PS1 = path.join(__dirname, 'fake-deadlock.ps1');
const REPORT_PATH = path.join(ROOT, 'logs', 'win-e2e.json');

const onlyArg = process.argv.find((a) => a.startsWith('--only'));
const only = onlyArg
  ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : process.argv[process.argv.indexOf(onlyArg) + 1])
      .split(',')
      .map((s) => s.trim())
  : null;

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail ?? null });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

function wantsCase(name) {
  return !only || only.includes(name);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runPs(args) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FAKE_PS1, ...args], {
    windowsHide: false,
  });
}

const DEBUG_LOG = path.join(ROOT, 'logs', 'win-e2e-debug.log');
try {
  fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
  fs.writeFileSync(DEBUG_LOG, `${new Date().toISOString()} --- run start ---\n`);
} catch {
  /* best effort */
}
function dbg(msg) {
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* best effort */
  }
  process.stdout.write(msg + '\n'); // not console.log: console.log is wrapped below to call dbg()
}

let fakeProc = null;
let fakeWindowRect = null; // { pid, client:{x,y,width,height}, window:{...} } parsed from fake-deadlock.ps1's stdout
function startFakeWindow(args = []) {
  stopFakeWindow();
  fakeWindowRect = null;
  dbg(`spawning fake-deadlock.ps1: ${FAKE_PS1} exists=${fs.existsSync(FAKE_PS1)}`);
  // NOTE: detached:true here made the child exit almost instantly on Windows (code 0, no window,
  // no pidfile written) instead of blocking in Application.Run — verified by isolating the spawn
  // outside Electron entirely. Non-detached works correctly; we kill it explicitly via -Stop in
  // stopFakeWindow()/finish(), so we don't need OS-level detachment.
  fakeProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FAKE_PS1, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  dbg(`fake-deadlock pid=${fakeProc.pid}`);
  fakeProc.stdout?.on('data', (d) => {
    const text = d.toString();
    dbg('fake-deadlock stdout: ' + text);
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        fakeWindowRect = JSON.parse(trimmed);
      } catch {
        /* not our JSON line */
      }
    }
  });
  fakeProc.stderr?.on('data', (d) => dbg('fake-deadlock stderr: ' + d.toString()));
  fakeProc.on('error', (e) => dbg('fake-deadlock spawn error: ' + e.message));
  fakeProc.on('exit', (code, sig) => dbg(`fake-deadlock exited code=${code} sig=${sig}`));
}
function stopFakeWindow() {
  runPs(['-Stop']);
  fakeProc = null;
}

async function waitFor(fn, timeoutMs, stepMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

// main.ts's own unhandledRejection handler filters exactly one known Electron artifact to debug and logs
// everything else via src/log.ts's console.error(JSON...) — count those (main process, not renderer).
// Also mirrors every main-process console.log/console.error line into the debug log file.
let mainProcessUnhandledCount = 0;
const realConsoleError = console.error.bind(console);
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('"msg":"unhandled.rejection"')) mainProcessUnhandledCount++;
  dbg('main-process stderr: ' + args.map(String).join(' '));
  realConsoleError(...args);
};
for (const level of ['info', 'warn']) {
  const real = console[level].bind(console);
  console[level] = (...args) => {
    dbg(`main-process ${level}: ` + args.map(String).join(' '));
    real(...args);
  };
}
const realConsoleLog = console.log.bind(console);
console.log = (...args) => {
  dbg('main-process stdout: ' + args.map(String).join(' '));
  realConsoleLog(...args);
};

const PID_FILE = path.join(require('node:os').tmpdir(), 'brawl-fake-deadlock.pid');

// Sets React-controlled selects the way a person would (native value setter + change event).
const SET_SELECT_JS = `
  function __setSelect(sel, value) {
    const el = document.querySelector(sel);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(el, String(value));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  function __setHero(name) {
    const el = document.querySelector('.hero-select');
    if (!el) return false;
    const opt = [...el.options].find((o) => o.textContent.includes(name));
    if (!opt) return false;
    return __setSelect('.hero-select', opt.value);
  }
`;

// Clicks the control window's test-mode button (the same one a person presses).
const CLICK_TEST_MODE_JS = `(() => { const b = document.querySelector('.brawl-testmode button'); if (!b) return false; b.click(); return true; })()`;

// Uncaught main-process exceptions (what surfaces as the "A JavaScript error occurred in the main process"
// dialog for a person) are counted here instead of showing a dialog.
let uncaughtCount = 0;
process.on('uncaughtException', (err) => {
  uncaughtCount++;
  dbg('main-process uncaughtException: ' + (err && err.stack ? err.stack : String(err)));
});

// Must run before any stopFakeWindow()/finish() call: lists every window titled exactly "Deadlock" and
// fails hard if one exists that this harness did not itself start (i.e. its pid isn't the one recorded by
// fake-deadlock.ps1's own pid file). Nothing is stopped either way — that's fake-deadlock.ps1 -Stop's job,
// scoped to its own pid file.
function checkNoRealGameOpen() {
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Get-Process | Where-Object { $_.MainWindowTitle -eq 'Deadlock' } | Select-Object -ExpandProperty Id",
    ],
    { encoding: 'utf8' },
  );
  const titledDeadlock = (ps.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const ourPid = fs.existsSync(PID_FILE) ? Number(fs.readFileSync(PID_FILE, 'utf8').trim()) : null;
  const foreign = titledDeadlock.filter((p) => p !== ourPid);
  if (foreign.length > 0) {
    check(
      'real-game-open',
      false,
      `pid(s) ${foreign.join(',')} have a window titled 'Deadlock' that this harness did not start`,
    );
    return false;
  }
  return true;
}

async function main() {
  const timeout = setTimeout(() => {
    console.log('HARNESS TIMEOUT after 300s');
    finish(1);
  }, 300_000);

  if (!checkNoRealGameOpen()) {
    clearTimeout(timeout);
    const report = { platform: process.platform, electron: process.versions.electron, checks };
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    return app.exit(1);
  }

  await app.whenReady();
  check('platform', process.platform === 'win32', `process.platform=${process.platform}`);

  if (only && only.includes('selftest-fail')) {
    // Deliberately failing check, proving the harness itself can fail (item 1's endpoint). Only runs when
    // explicitly requested via --only selftest-fail — it must NOT appear (and fail) in the default full run.
    check('selftest-fail', false, 'intentional failure to prove the harness can fail');
  }

  // Load the real main.js AFTER app.whenReady has been observed once here so this script's own
  // app.whenReady() call above doesn't race main.js's; main.js registers its own whenReady handler.
  // It's built as ESM (package.json has "type": "module"), so a plain require() fails — use import().
  const mainUrl = require('node:url').pathToFileURL(path.join(ROOT, 'electron-dist', 'main.js')).href;
  await import(mainUrl);
  const e2e = await waitFor(() => globalThis.__brawlE2E, 10_000);
  if (!e2e) {
    check('app-boot', false, 'globalThis.__brawlE2E never appeared — main.js did not finish whenReady');
    return finish(1);
  }

  const control = await waitFor(() => e2e.getControl(), 10_000);
  const overlay = await waitFor(() => e2e.getOverlay(), 10_000);
  if (!control) {
    check('app-boot', false, 'control window never created');
    return finish(1);
  }

  // Attached before any capture attempt (including the auto-start-on-mount one) so capture-start-seen below
  // can prove at least one capture.start line was ever emitted, not just that the retry-window count is low.
  // Every renderer console-message and main-process log line also goes to logs/win-e2e-debug.log.
  let captureStartTotal = 0;
  let captureStartWindow = 0;
  const onControlConsole = (_e, _level, message) => {
    dbg('control console: ' + message);
    if (/"msg":"capture\.attempt"/.test(message)) {
      captureStartTotal++;
      captureStartWindow++;
    }
  };
  control.webContents.on('console-message', onControlConsole);
  overlay?.webContents.on('console-message', (_e, _level, message) => dbg('overlay console: ' + message));

  await waitFor(() => control.webContents.executeJavaScript('document.readyState === "complete"'), 10_000);

  if (wantsCase('boot')) {
    let preloadError = false;
    control.webContents.on('preload-error', () => (preloadError = true));
    overlay?.webContents.on('preload-error', () => (preloadError = true));
    const controlApi = await control.webContents.executeJavaScript('typeof window.brawlAPI');
    check('preload-control', controlApi === 'object', `typeof window.brawlAPI = ${controlApi}`);
    if (overlay) {
      const overlayApi = await overlay.webContents.executeJavaScript('typeof window.brawlAPI');
      check('preload-overlay', overlayApi === 'object', `typeof window.brawlAPI = ${overlayApi}`);
    }
    // waitFor only stops on a truthy return, so a raw length (truthy even at e.g. 18, the "Loading
    // snapshots…" placeholder) would resolve immediately; only resolve once it's actually past the
    // threshold, and keep the last-seen length for the failure detail either way.
    let lastBodyLen = 0;
    const renderedLen = await waitFor(async () => {
      lastBodyLen = await control.webContents.executeJavaScript('document.body.innerText.length');
      return lastBodyLen > 50 ? lastBodyLen : null;
    }, 10_000);
    check('render', !!renderedLen, `body.innerText.length=${lastBodyLen}`);
    await sleep(300);
    check('no-preload-error', !preloadError);
  }

  if (wantsCase('capture-denied')) {
    stopFakeWindow();

    await sleep(6000); // Electron's auto-start-on-mount attempt should have been denied by now
    check('capture-start-seen', captureStartTotal >= 1, `capture.attempt lines seen since boot: ${captureStartTotal}`);
    const statusText = await control.webContents.executeJavaScript(
      'document.querySelector(".brawl-status")?.textContent ?? ""',
    );
    check('status-text', statusText.includes('Deadlock window not found'), `status="${statusText}"`);

    captureStartWindow = 0; // only count retries from here
    mainProcessUnhandledCount = 0;
    await sleep(10_000);
    check('no-retry-loop', captureStartWindow <= 1, `capture.attempt console lines in 10s: ${captureStartWindow}`);

    check(
      'no-unhandled',
      mainProcessUnhandledCount === 0,
      `main-process unhandled.rejection count=${mainProcessUnhandledCount}`,
    );
  }

  if (wantsCase('capture-recover') || wantsCase('capture-found')) {
    startFakeWindow();
    const fakeRect = await waitFor(() => fakeWindowRect, 5_000);
    await sleep(1500);
    const rect = await waitFor(
      () =>
        e2e.getControl() &&
        control.webContents.executeJavaScript('window.brawlAPI ? window.brawlAPI.getGameRect() : null'),
      15_000,
    );
    if (wantsCase('capture-found')) {
      const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
      const within = (a, b, tol) => Math.abs(a - b) <= tol;
      const target = fakeRect?.window;
      const rectMatches =
        !!rect &&
        !!target &&
        within(rect.x, target.x, 20) &&
        within(rect.y, target.y, 20) &&
        within(rect.width, target.width, 20) &&
        within(rect.height, target.height, 20);
      check(
        'game-rect',
        rectMatches,
        `measured=${JSON.stringify(rect)} fake-window=${JSON.stringify(target)} scaleFactor=${scaleFactor}`,
      );
      // Eval round 6: overlay-bounds only ever compared the overlay to the demo backdrop (both already in
      // DIPs, so it never exercised the DPI/scale conversion round-4 flagged). Check it here too, against
      // the real capture path: overlay.getBounds() is DIPs, the fake window's printed rect is physical px.
      if (overlay && target) {
        const overlayBounds = overlay.getBounds();
        const overlayPhys = {
          x: overlayBounds.x * scaleFactor,
          y: overlayBounds.y * scaleFactor,
          width: overlayBounds.width * scaleFactor,
          height: overlayBounds.height * scaleFactor,
        };
        const boundsMatch =
          within(overlayPhys.x, target.x, 20) &&
          within(overlayPhys.y, target.y, 20) &&
          within(overlayPhys.width, target.width, 20) &&
          within(overlayPhys.height, target.height, 20);
        check(
          'overlay-bounds',
          boundsMatch,
          `overlay(DIP)=${JSON.stringify(overlayBounds)} overlay*scale=${JSON.stringify(overlayPhys)} fake-window=${JSON.stringify(target)} scaleFactor=${scaleFactor}`,
        );
      }
    }
    await sleep(3000);
    const streamState = await control.webContents.executeJavaScript(
      '(() => { const v = document.querySelector("video"); return v ? { w: v.videoWidth, ready: v.readyState } : null; })()',
    );
    check(
      wantsCase('capture-recover') && !wantsCase('capture-found') ? 'stream-live' : 'stream-live',
      !!streamState && streamState.w > 0 && streamState.ready >= 2,
      JSON.stringify(streamState),
    );
    if (wantsCase('capture-found')) {
      const centre = await control.webContents.executeJavaScript(`
        (() => {
          const v = document.querySelector('video');
          if (!v || !v.videoWidth) return null;
          const c = document.createElement('canvas');
          c.width = v.videoWidth; c.height = v.videoHeight;
          const ctx = c.getContext('2d');
          ctx.drawImage(v, 0, 0);
          const d = ctx.getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data;
          return [d[0], d[1], d[2]];
        })()
      `);
      const isMagenta =
        !!centre && Math.abs(centre[0] - 255) <= 30 && Math.abs(centre[1] - 0) <= 30 && Math.abs(centre[2] - 255) <= 30;
      check('not-self', isMagenta, JSON.stringify(centre));
    }
    stopFakeWindow();
  }

  if (wantsCase('testmode-refuse')) {
    // A decoy window titled exactly "Deadlock" that the app did not create: test mode must refuse, say why in
    // the control window, open no dummy, and leave the decoy's process alone.
    startFakeWindow();
    const decoy = await waitFor(() => fakeWindowRect, 8_000);
    await sleep(1_500);
    await control.webContents.executeJavaScript(CLICK_TEST_MODE_JS);
    const message = await waitFor(
      () =>
        control.webContents.executeJavaScript('document.querySelector(".brawl-testmode-message")?.textContent ?? ""'),
      8_000,
    );
    check('testmode-refuse-message', !!message && /real Deadlock/i.test(message), `message="${message}"`);
    await sleep(1_000);
    check('testmode-refuse-no-dummy', !e2e.getTestWindow(), `testWindow=${e2e.getTestWindow() ? 'open' : 'none'}`);
    const pidOut = decoy
      ? spawnSync(
          'powershell.exe',
          ['-NoProfile', '-Command', `(Get-Process -Id ${decoy.pid} -ErrorAction SilentlyContinue).Id`],
          {
            encoding: 'utf8',
          },
        ).stdout.trim()
      : '';
    check(
      'testmode-refuse-decoy-alive',
      !!decoy && pidOut === String(decoy.pid),
      `decoy pid=${decoy?.pid} Get-Process=${pidOut}`,
    );
    stopFakeWindow();
    await waitFor(async () => !(await control.webContents.executeJavaScript('window.brawlAPI.getGameRect()')), 8_000);
    await sleep(1_000);
  }

  const labelsForTest = () =>
    JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'win', 'frames', 'labels.json'), 'utf8'));
  const panelText = () =>
    overlay ? overlay.webContents.executeJavaScript('document.querySelector(".overlay-panel")?.textContent ?? ""') : '';
  // The ranked advice lines only (not the status line, which updates a beat before the advice does).
  const panelCardsText = () =>
    overlay
      ? overlay.webContents.executeJavaScript(
          '[...document.querySelectorAll(".overlay-panel-card")].map((e) => e.textContent).join(" | ")',
        )
      : '';
  const waitForPanelNames = async (names) => {
    let last = '';
    const t = await waitFor(async () => {
      last = await panelCardsText();
      return last && names.every((n) => last.includes(n)) ? last : null;
    }, 25_000);
    return { ok: !!t, text: (t ?? last).slice(0, 600) };
  };

  if (wantsCase('testmode')) {
    // The in-app test mode, driven through the control window's own button: a dummy "Deadlock" window shows
    // a real draft screenshot, the normal capture path recognises it, and the overlay follows it.
    const labels = labelsForTest();
    stopFakeWindow();
    await waitFor(async () => !(await control.webContents.executeJavaScript('window.brawlAPI.getGameRect()')), 8_000);
    await sleep(500);
    // hero/round/choice go first, as in a real game (changing them later wipes accepted cards)
    await control.webContents.executeJavaScript(`
      (() => {
        ${SET_SELECT_JS}
        __setHero(${JSON.stringify(labels.choice1.hero)});
        __setSelect('select[aria-label="Round"]', ${labels.choice1.round});
        __setSelect('select[aria-label="Choice"]', ${labels.choice1.choice});
      })();
    `);
    await sleep(500);
    const clicked = await control.webContents.executeJavaScript(CLICK_TEST_MODE_JS);
    const win = await waitFor(() => e2e.getTestWindow(), 10_000);
    check('testmode-on', clicked && !!win, `clicked=${clicked} dummy=${win ? 'open' : 'none'}`);
    if (win) {
      check('testmode-title', win.getTitle() === 'Deadlock', `title="${win.getTitle()}"`);
      const c1 = Object.values(labels.choice1.cards);
      const first = await waitForPanelNames(c1);
      check('testmode-panel-choice1', first.ok, first.text);
      const bounds = win.getBounds();
      const ob = overlay.getBounds();
      const within = (a, b2, tol) => Math.abs(a - b2) <= tol;
      // The overlay is sized from the dummy's physical rect via toDipBounds (125 % scaling in real use).
      check(
        'overlay-bounds-testmode',
        within(ob.x, bounds.x, 3) &&
          within(ob.y, bounds.y, 3) &&
          within(ob.width, bounds.width, 3) &&
          within(ob.height, bounds.height, 3),
        `overlay=${JSON.stringify(ob)} dummy=${JSON.stringify(bounds)}`,
      );
      check('overlay-on-top', overlay.isAlwaysOnTop());
      check(
        'click-through',
        !!e2e.overlayIgnoresMouseEvents,
        `overlayIgnoresMouseEvents=${e2e.overlayIgnoresMouseEvents} (electron/main.ts live getter, mirrors the value passed to the last setIgnoreMouseEvents() call)`,
      );
      // switch the screenshot through the UI select
      await control.webContents.executeJavaScript(
        `(() => { ${SET_SELECT_JS} return __setSelect('select[aria-label="Test screenshot"]', 'choice2'); })()`,
      );
      const c2 = Object.values(labels.choice2.cards);
      const second = await waitForPanelNames(c2);
      check('testmode-switch-frame', second.ok && !c1.every((n) => second.text.includes(n)), second.text);
      // turn it off through the UI
      await control.webContents.executeJavaScript(CLICK_TEST_MODE_JS);
      const gone = await waitFor(() => !e2e.getTestWindow(), 8_000);
      await sleep(1_000);
      check(
        'testmode-off',
        !!gone && !overlay.isVisible() && !control.isDestroyed(),
        `dummy=${e2e.getTestWindow() ? 'open' : 'closed'} overlayVisible=${overlay.isVisible()}`,
      );
    }
    await sleep(1_000);
  }

  if (wantsCase('frames')) {
    // Start from a fresh app state: an earlier case's detected enemies / owned items would change the scores.
    await control.webContents.executeJavaScript('localStorage.clear()');
    control.webContents.reload();
    await waitFor(
      () => control.webContents.executeJavaScript('!!document.querySelector(".brawl-status")').catch(() => false),
      15_000,
    );
    await sleep(1_000);
    await runFramesCase(e2e, control, overlay, () => captureStartTotal);
  }

  if (wantsCase('testmode-overlay-closed')) {
    // Closing the overlay window must not leave anything that throws later: test mode on/off still works
    // (it recreates the overlay) and no uncaught main-process exception (= error dialog) occurs.
    uncaughtCount = 0;
    overlay?.close();
    await sleep(500);
    await control.webContents.executeJavaScript(CLICK_TEST_MODE_JS);
    const win = await waitFor(() => e2e.getTestWindow(), 10_000);
    await sleep(1_500);
    const ov2 = e2e.getOverlay();
    await control.webContents.executeJavaScript(CLICK_TEST_MODE_JS);
    await waitFor(() => !e2e.getTestWindow(), 8_000);
    await sleep(500);
    check(
      'overlay-closed-no-error',
      uncaughtCount === 0 && !!win && !!ov2,
      `uncaught=${uncaughtCount} dummy=${win ? 'opened' : 'none'} overlayRecreated=${!!ov2}`,
    );
  }

  clearTimeout(timeout);
  finish(checks.every((c) => c.pass) ? 0 : 1);
}

// Intersection-over-union of two {x0,y0,x1,y1} rects in the same coordinate space.
function iou(a, b) {
  const x0 = Math.max(a.x0, b.x0),
    y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1),
    y1 = Math.min(a.y1, b.y1);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
  const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function scaleBox(box, scale) {
  return { x0: box.x0 * scale, y0: box.y0 * scale, x1: box.x1 * scale, y1: box.y1 * scale };
}

// Closing the previous frame's fake window invalidates that window's capture handle (WGC fires "target
// source has been closed"), which stops the video track. BrawlView.tsx now retries automatically once the
// game window reappears (see the onGameRect effect there) -- this waits for that retry to actually land.
// video.srcObject/videoWidth are NOT reliable signals here: stopCapture() never clears srcObject, so a
// dead, frozen video element still reports its last-known videoWidth/height forever. Instead wait for a
// fresh "capture.attempt" console line (getCaptureStartTotal, a running count since boot) past the
// baseline taken right before this frame's fake window was spawned, then for the status line to stop
// saying the window isn't found.
async function waitForCaptureOn(control, getCaptureStartTotal, baseline) {
  await waitFor(() => getCaptureStartTotal() > baseline, 10_000);
  await waitFor(async () => {
    const status = await control.webContents.executeJavaScript(
      'document.querySelector(".brawl-status")?.textContent ?? ""',
    );
    return !status.includes('not found');
  }, 10_000);
  await waitFor(
    () =>
      control.webContents.executeJavaScript(
        '(() => { const v = document.querySelector("video"); return !!(v && v.srcObject && v.videoWidth > 0); })()',
      ),
    10_000,
  );
}

// Item 3: the fake window shows real draft frames (scripts/win/frames/*.png) and the harness checks the
// real pipeline against hand-measured labels (scripts/win/frames/labels.json) -- never against the
// recogniser's own output, which would be circular.
async function runFramesCase(e2e, control, overlay, getCaptureStartTotal) {
  const FRAMES_DIR = path.join(ROOT, 'scripts', 'win', 'frames');
  const labels = JSON.parse(fs.readFileSync(path.join(FRAMES_DIR, 'labels.json'), 'utf8'));
  const verdictsPath = path.join(ROOT, 'logs', 'win-e2e-verdicts.json');
  if (!fs.existsSync(verdictsPath)) {
    check('frames', false, `missing ${verdictsPath} -- run-e2e.sh should stage this from compute-verdicts.ts`);
    return;
  }
  const verdicts = JSON.parse(fs.readFileSync(verdictsPath, 'utf8'));

  const setSelectJs = SET_SELECT_JS;

  let anyNaturalReroll = false;
  let lastFrameName = null;

  for (const [frameName, label] of Object.entries(labels)) {
    if (frameName.startsWith('_')) continue;
    lastFrameName = frameName;
    const imgPath = path.join(FRAMES_DIR, `${frameName}.png`);
    // Snapshot before spawning this frame's window, then wait for a fresh capture.attempt past it -- see
    // waitForCaptureOn. Also clear the overlay's last-drawn bookkeeping up front so a stale pass from the
    // previous frame can never leak into this frame's boxes/pixels checks if capture fails to recover.
    const captureBaseline = getCaptureStartTotal();
    if (overlay) await overlay.webContents.executeJavaScript('window.__overlayDrawn = []');
    // Hero/round/choice are set BEFORE this frame's window exists (so before capture can start): changing
    // the Round/Choice selects clears the accepted cards, and the worker never re-sends a set it has already
    // accepted -- set them after a fast capture start and the cards are wiped for good (advice stays null,
    // no card is ever marked best).
    await control.webContents.executeJavaScript(`
      (() => {
        ${setSelectJs}
        __setHero(${JSON.stringify(label.hero)});
        __setSelect('select[aria-label="Round"]', ${label.round});
        __setSelect('select[aria-label="Choice"]', ${label.choice});
      })();
    `);
    await sleep(500);
    startFakeWindow(['-Image', imgPath]);
    await waitFor(() => fakeWindowRect, 5_000);
    await sleep(1500);

    // Closing the previous frame's fake window invalidates that window's capture handle (WGC fires
    // "target source has been closed"), which stops the video track. The app's own retry loop only fires
    // after a denied getDisplayMedia call, not after a capture that stopped for this reason, so each new
    // frame needs to explicitly restart capture if it's not already running.
    await waitForCaptureOn(control, getCaptureStartTotal, captureBaseline);

    let statusText = '';
    await waitFor(async () => {
      statusText = await control.webContents.executeJavaScript(
        'document.querySelector(".brawl-status")?.textContent ?? ""',
      );
      return statusText.split(' / ').length === 3 ? statusText : null;
    }, 15_000);

    const dbgVidSize = await control.webContents.executeJavaScript(
      '(() => { const v = document.querySelector("video"); return v ? { w: v.videoWidth, h: v.videoHeight } : null; })()',
    );
    // Evidence of what capture actually received from the fake "Deadlock" window (the only window the app
    // ever captures): saved per frame so a blank/unpainted fake window is visible in logs/, not guessed at.
    try {
      const dataUrl = await control.webContents.executeJavaScript(`
        (() => {
          const v = document.querySelector('video');
          if (!v || !v.videoWidth) return null;
          const c = document.createElement('canvas');
          c.width = v.videoWidth; c.height = v.videoHeight;
          c.getContext('2d').drawImage(v, 0, 0);
          return c.toDataURL('image/png');
        })()
      `);
      if (dataUrl) {
        fs.writeFileSync(
          path.join(path.dirname(REPORT_PATH), `win-e2e-frame-${frameName}.png`),
          Buffer.from(dataUrl.split(',')[1], 'base64'),
        );
      }
    } catch (e) {
      dbg('frame dump failed: ' + e.message);
    }
    const namesOk = ['left', 'top', 'right'].every((k) => statusText.includes(label.cards[k]));
    check(`cards-read-${frameName}`, namesOk, `${statusText} video=${JSON.stringify(dbgVidSize)}`);

    const expected = verdicts[frameName]?.verdict ?? null;
    if (expected === 'RE-ROLL') anyNaturalReroll = true;
    // adviceText depends on the hero's analytics fetch (started when __setHero ran above) resolving and
    // adviseDraft() re-running -- poll instead of a flat sleep so a slow fetch doesn't false-fail this.
    let adviceText = null;
    await waitFor(async () => {
      adviceText = await control.webContents.executeJavaScript(`
        (() => {
          const banner = document.querySelector('.brawl-reroll-banner');
          if (banner) return 'RE-ROLL';
          const best = document.querySelector('.brawl-card.best b');
          return best ? best.textContent.replace(/^TAKE\\s*/, '').trim() : null;
        })()
      `);
      return adviceText;
    }, 10_000);
    check(
      `verdict-${frameName}`,
      !!expected && !!adviceText && adviceText.startsWith(expected),
      `advice="${adviceText}" expected="${expected}"`,
    );

    const vidSize = await control.webContents.executeJavaScript(
      '(() => { const v = document.querySelector("video"); return v ? { w: v.videoWidth, h: v.videoHeight } : null; })()',
    );
    const expectedBestPos = Object.entries(label.cards).find(([, name]) => name === expected)?.[0] ?? null;
    // The control window's advice text and the overlay window's redraw are two separate IPC-relayed
    // renders (OverlayState → overlay window) -- overlay can lag control by a render tick. Poll until the
    // overlay actually shows a 'best' box at the expected position instead of racing it.
    // Drawn rects and the overlay panel's scores are read in ONE call: both come from the same OverlayState,
    // whereas two reads can straddle a state update (e.g. enemies detected -> scores shift by 0.02).
    const readOverlay = () =>
      overlay.webContents.executeJavaScript(`({
        drawn: window.__overlayDrawn ?? [],
        scores: [...document.querySelectorAll('.overlay-panel-card')]
          .map((e) => (e.textContent || '').match(/ · (-?[0-9.]+) ·/)?.[1]).filter(Boolean),
      })`);
    let drawn = [];
    let panelScores = [];
    if (overlay) ({ drawn, scores: panelScores } = await readOverlay());
    if (overlay && expectedBestPos) {
      await waitFor(async () => {
        ({ drawn, scores: panelScores } = await readOverlay());
        return drawn.some((r) => r.card === expectedBestPos && r.kind === 'best');
      }, 5_000);
    }
    // Gated on namesOk: if this frame's cards were never actually read (e.g. capture didn't recover in
    // time), window.__overlayDrawn could still be showing a stale pass from the previous frame -- an
    // honest fail here beats a spurious pass.
    let boxesOk = !!vidSize && namesOk;
    const boxDetail = [];
    if (vidSize) {
      const scale = vidSize.w / 2000; // labels.json boxes are frame px at the source PNG's own 2000x1125
      for (const posKey of ['left', 'top', 'right']) {
        // hand-measured circle labels (not the icon squares, not recogniser output)
        const labelBox = scaleBox(label.circles[posKey], scale);
        const drawnBox = drawn.find((r) => r.card === posKey);
        const score = drawnBox ? iou(labelBox, drawnBox) : 0;
        const dcx = drawnBox ? (drawnBox.x0 + drawnBox.x1) / 2 : -1,
          dcy = drawnBox ? (drawnBox.y0 + drawnBox.y1) / 2 : -1;
        const contains =
          !!drawnBox && dcx >= labelBox.x0 && dcx <= labelBox.x1 && dcy >= labelBox.y0 && dcy <= labelBox.y1;
        const wantKind = posKey === expectedBestPos ? 'best' : 'card';
        const kindOk = !!drawnBox && drawnBox.kind === wantKind;
        const scoreOk =
          !!drawnBox && typeof drawnBox.score === 'number' && panelScores.includes(drawnBox.score.toFixed(2));
        boxDetail.push(
          `${posKey}:iou=${score.toFixed(2)},contains=${contains},kind=${drawnBox?.kind ?? 'none'},score=${drawnBox?.score?.toFixed?.(2) ?? 'none'}(panel=${panelScores.join('|')})`,
        );
        if (score < 0.5 || !contains || !kindOk || !scoreOk) boxesOk = false;
      }
    }
    check(`boxes-${frameName}`, boxesOk, boxDetail.join(' '));

    // pixels-<frame>: sample the actual overlay canvas pixels via capturePage(), independent of the
    // __overlayDrawn bookkeeping above -- proves the box is really on screen, not just recorded.
    if (overlay && vidSize && expectedBestPos && namesOk) {
      const ok = await checkPixels(overlay, label, vidSize, expectedBestPos, frameName);
      check(`pixels-${frameName}`, ok.pass, ok.detail);
    } else {
      check(`pixels-${frameName}`, false, 'no overlay/vidSize/expectedBestPos');
    }

    stopFakeWindow();
  }

  // Forced reroll-box pass: per PLAN.md, only needed if no frame's natural verdict was RE-ROLL (confirmed
  // by scripts/win/compute-verdicts.ts: both frames' independent engine verdict is TAKE, not RE-ROLL).
  if (!anyNaturalReroll && lastFrameName) {
    const label = labels[lastFrameName];
    const imgPath = path.join(FRAMES_DIR, `${lastFrameName}.png`);
    const captureBaseline = getCaptureStartTotal();
    if (overlay) await overlay.webContents.executeJavaScript('window.__overlayDrawn = []');
    startFakeWindow(['-Image', imgPath]);
    await waitFor(() => fakeWindowRect, 5_000);
    await sleep(1500);
    await waitForCaptureOn(control, getCaptureStartTotal, captureBaseline);
    await control.webContents.executeJavaScript(`
      (() => {
        ${setSelectJs}
        __setHero(${JSON.stringify(label.hero)});
        __setSelect('select[aria-label="Round"]', ${label.round});
        __setSelect('select[aria-label="Choice"]', ${label.choice});
      })();
    `);
    let statusText = '';
    await waitFor(async () => {
      statusText = await control.webContents.executeJavaScript(
        'document.querySelector(".brawl-status")?.textContent ?? ""',
      );
      return statusText.split(' / ').length === 3 ? statusText : null;
    }, 15_000);

    const forced = e2e.forceReroll ? e2e.forceReroll() : false;
    const vidSize = await control.webContents.executeJavaScript(
      '(() => { const v = document.querySelector("video"); return v ? { w: v.videoWidth, h: v.videoHeight } : null; })()',
    );
    // Same overlay-redraw lag as boxes-<frame> above: poll for the reroll box to actually appear instead
    // of racing the IPC relay with a flat sleep.
    let drawn = overlay ? await overlay.webContents.executeJavaScript('window.__overlayDrawn ?? []') : [];
    if (overlay && forced) {
      await waitFor(async () => {
        drawn = await overlay.webContents.executeJavaScript('window.__overlayDrawn ?? []');
        return drawn.some((r) => r.kind === 'reroll');
      }, 5_000);
      // window.__overlayDrawn is set synchronously inside the same draw() call that issues the canvas
      // stroke/fill commands, but capturePage() can still race the compositor flushing that paint to the
      // screen. Force and await two animation frames so the paint is actually on screen before sampling.
      await overlay.webContents.executeJavaScript(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
      );
    }
    let boxOk = forced && !!vidSize;
    let detail = `forced=${forced}`;
    if (forced && vidSize) {
      const scale = vidSize.w / 2000;
      const labelBox = scaleBox(label.boxes.reroll, scale);
      const drawnBox = drawn.find((r) => r.kind === 'reroll');
      const score = drawnBox ? iou(labelBox, drawnBox) : 0;
      detail += ` iou=${score.toFixed(2)} drawn=${JSON.stringify(drawnBox ?? null)}`;
      boxOk = boxOk && score >= 0.5;
      if (overlay) {
        // Sample at the box the app actually drew (drawnBox), not the hand-measured label box: the
        // reroll button position is a fixed formula (rerollButtonRect), not detected from the image, so
        // it can be a few px off from the label even when its own iou passes -- sampling the label edge
        // then misses the stroke entirely. boxes-check above already verifies drawnBox vs. label
        // position; this only needs to prove the stroke is really painted where the app says it is.
        const px = await checkOrangePixel(overlay, drawnBox ?? labelBox, vidSize);
        detail += ` orangePixel=${JSON.stringify(px.sample)}`;
        boxOk = boxOk && px.pass;
      }
    }
    check('reroll-box', boxOk, detail);
    stopFakeWindow();
  } else if (lastFrameName) {
    check('reroll-box', true, 'skipped: a frame naturally verdicted RE-ROLL');
  }
}

async function checkPixels(overlay, label, vidSize, expectedBestPos, frameName) {
  const canvasSize = await overlay.webContents.executeJavaScript(
    '(() => { const c = document.querySelector("canvas"); return c ? { w: c.width, h: c.height } : null; })()',
  );
  if (!canvasSize) return { pass: false, detail: `${frameName}: no overlay canvas` };
  const scaleFrameToCanvas = { x: canvasSize.w / vidSize.w, y: canvasSize.h / vidSize.h };
  const scaleLabelToFrame = vidSize.w / 2000;
  // The best circle's outline must be green and the other circles' outlines grey: look at the
  // strongest pixel within a few px of the circle's leftmost point.
  const img = await overlay.webContents.capturePage();
  const imgSize = img.getSize();
  const bitmap = img.toBitmap(); // BGRA on Windows
  const sampleNear = (box) => {
    const cx = box.x0 * scaleFrameToCanvas.x;
    const cy = ((box.y0 + box.y1) / 2) * scaleFrameToCanvas.y;
    const ix = Math.round(cx * (imgSize.width / canvasSize.w));
    const iy = Math.round(cy * (imgSize.height / canvasSize.h));
    let best = [0, 0, 0, 0];
    for (let dx = -4; dx <= 4; dx++) {
      const x = Math.min(Math.max(ix + dx, 0), imgSize.width - 1);
      const y = Math.min(Math.max(iy, 0), imgSize.height - 1);
      const idx = (y * imgSize.width + x) * 4;
      const px = [bitmap[idx + 2], bitmap[idx + 1], bitmap[idx], bitmap[idx + 3]];
      // strongest = most saturated-or-bright: green stroke beats its antialiased edge, grey beats background
      const w = (p) => p[0] + p[1] + p[2] + 3 * (Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]));
      if (w(px) > w(best)) best = px;
    }
    return best;
  };
  const bestPx = sampleNear(scaleBox(label.circles[expectedBestPos], scaleLabelToFrame));
  const others = ['left', 'top', 'right'].filter((k) => k !== expectedBestPos);
  const otherPx = others.map((k) => sampleNear(scaleBox(label.circles[k], scaleLabelToFrame)));
  const isGreen = (p) => p[1] >= 170 && p[1] - p[0] >= 80 && p[1] - p[2] >= 80;
  const isGrey = (p) => p[0] > 40 && Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]) <= 30;
  return {
    pass: isGreen(bestPx) && otherPx.every(isGrey),
    detail: `${frameName}: bestEdge=${JSON.stringify(bestPx)} otherEdges=${JSON.stringify(otherPx)}`,
  };
}

async function checkOrangePixel(overlay, labelBoxFramePx, vidSize) {
  const canvasSize = await overlay.webContents.executeJavaScript(
    '(() => { const c = document.querySelector("canvas"); return c ? { w: c.width, h: c.height } : null; })()',
  );
  const scaleFrameToCanvas = { x: canvasSize.w / vidSize.w, y: canvasSize.h / vidSize.h };
  const edgeCanvasX = labelBoxFramePx.x0 * scaleFrameToCanvas.x;
  const edgeCanvasY = ((labelBoxFramePx.y0 + labelBoxFramePx.y1) / 2) * scaleFrameToCanvas.y;
  const img = await overlay.webContents.capturePage();
  const imgSize = img.getSize();
  const bitmap = img.toBitmap();
  const x = Math.round(edgeCanvasX * (imgSize.width / canvasSize.w));
  const y = Math.round(edgeCanvasY * (imgSize.height / canvasSize.h));
  const cx = Math.min(Math.max(x, 0), imgSize.width - 1);
  const cy = Math.min(Math.max(y, 0), imgSize.height - 1);
  const idx = (cy * imgSize.width + cx) * 4;
  const sample = [bitmap[idx + 2], bitmap[idx + 1], bitmap[idx], bitmap[idx + 3]];
  const isOrange = Math.abs(sample[0] - 0xff) <= 60 && Math.abs(sample[1] - 0xb0) <= 70 && sample[2] <= 90;
  return { pass: isOrange, sample };
}

function finish(code) {
  const report = { platform: process.platform, electron: process.versions.electron, checks };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  stopFakeWindow();
  app.exit(code);
}

main().catch((err) => {
  console.error('HARNESS ERROR', err);
  check('harness-error', false, err.message);
  finish(1);
});
