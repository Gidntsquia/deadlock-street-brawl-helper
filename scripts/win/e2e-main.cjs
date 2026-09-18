// Windows-only Electron test harness. Run by real electron.exe (never Linux Electron): sets BRAWL_E2E=1,
// requires the REAL electron-dist/main.js (not a stub), drives it via executeJavaScript, and writes one
// JSON report. Filter cases with --only <name1,name2,...>. Hard timeout 90s.
'use strict';
process.env.BRAWL_E2E = '1';

const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const { app, screen } = require('electron');

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
const realConsoleLog = console.log.bind(console);
console.log = (...args) => {
  dbg('main-process stdout: ' + args.map(String).join(' '));
  realConsoleLog(...args);
};

const PID_FILE = path.join(require('node:os').tmpdir(), 'brawl-fake-deadlock.pid');

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
    console.log('HARNESS TIMEOUT after 90s');
    finish(1);
  }, 90_000);

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

  if (wantsCase('overlay')) {
    startFakeWindow();
    const fakeRect = await waitFor(() => fakeWindowRect, 5_000);
    await sleep(1500);
    e2e.triggerOverlayDemo();
    await sleep(1000);
    if (overlay) {
      const panelText = await overlay.webContents.executeJavaScript(
        'document.querySelector(".overlay-panel")?.textContent ?? ""',
      );
      check('overlay-panel', panelText.length > 0 && /RE-ROLL/i.test(panelText), panelText.slice(0, 200));
      const bounds = overlay.getBounds();
      const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
      const target = fakeRect?.window;
      const within = (a, b, tol) => Math.abs(a - b) <= tol;
      const boundsMatch =
        !!target &&
        within(bounds.x * scaleFactor, target.x, 20) &&
        within(bounds.y * scaleFactor, target.y, 20) &&
        within(bounds.width * scaleFactor, target.width, 20) &&
        within(bounds.height * scaleFactor, target.height, 20);
      check(
        'overlay-bounds',
        boundsMatch,
        `overlay(DIP)=${JSON.stringify(bounds)} fake-window(physical)=${JSON.stringify(target)} scaleFactor=${scaleFactor}`,
      );
      check('overlay-on-top', overlay.isAlwaysOnTop());
      check(
        'click-through',
        !!e2e.overlayIgnoresMouseEvents,
        'electron/main.ts:overlayIgnoresMouseEvents (live getter)',
      );
    } else {
      check('overlay-panel', false, 'no overlay window');
    }
    stopFakeWindow();
  }

  clearTimeout(timeout);
  finish(checks.every((c) => c.pass) ? 0 : 1);
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
