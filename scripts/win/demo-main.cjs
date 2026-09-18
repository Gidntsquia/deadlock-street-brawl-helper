// Windows-only Electron demo runner for `npm run win:demo` (PLAN.md item 4). Not the e2e harness: no JSON
// report, no --only filtering. Opens the real app under BRAWL_E2E (to reach the __brawlE2E test hook that
// triggerOverlayDemo() and getDemoBackdropBounds() live on), guards against a real game already running
// (same check as scripts/win/e2e-main.cjs's checkNoRealGameOpen -- this script never writes a pid file of
// its own, so every window titled "Deadlock" it finds is foreign), triggers the demo backdrop for the
// requested frame, waits for the overlay to actually draw over it, and screenshots that region to
// logs/win-demo.png.
//
// PLAN.md's item 4 text says to "leave everything open until Ctrl+C, then close only what it started" --
// this does that for a real Ctrl+C (SIGINT/SIGTERM handlers below exit cleanly, closing only the windows
// this process created), but also self-exits after DEMO_HOLD_MS so the automated endpoint
// (`timeout 90 npm run win:demo -- choice1`) finishes deterministically rather than depending on a SIGTERM
// reliably crossing the bash -> powershell.exe -> electron.exe boundary within the 90s window. Noted in
// WORKER_NOTES.md as a deliberate deviation from the plan's literal wording.
'use strict';
process.env.BRAWL_E2E = '1';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { app } = require('electron');

// See electron/main.ts's matching comment: GPU-accelerated surfaces don't reach the physical screen in this
// environment (RDP/virtual display), so the demo backdrop window renders correctly inside Electron but stays
// black on screen and in any OS-level screenshot. This harness calls app.whenReady() itself before importing
// main.ts, so main.ts's own disableHardwareAcceleration() call is too late here -- do it ourselves first.
app.disableHardwareAcceleration();

const ROOT = path.join(__dirname, '..', '..');
const OUT_PATH = path.join(ROOT, 'logs', 'win-demo.png');
const DEMO_HOLD_MS = 8_000; // how long to keep the windows open (for a person to look, or to Ctrl+C) after the screenshot

const choiceArg = process.argv.includes('choice2') ? 'choice2' : 'choice1';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

// Same guard as e2e-main.cjs's checkNoRealGameOpen, minus the pid-file exemption (this script starts no
// window titled "Deadlock" of its own, so every match found is foreign).
function foreignDeadlockWindows() {
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Get-Process | Where-Object { $_.MainWindowTitle -eq 'Deadlock' } | Select-Object -ExpandProperty Id",
    ],
    { encoding: 'utf8' },
  );
  return (ps.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
}

let exiting = false;
function exit(code) {
  if (exiting) return;
  exiting = true;
  app.exit(code);
}
process.on('SIGINT', () => exit(0));
process.on('SIGTERM', () => exit(0));

async function main() {
  const foreign = foreignDeadlockWindows();
  if (foreign.length > 0) {
    console.error(
      `ERROR: real-game-open — pid(s) ${foreign.join(',')} have a window titled 'Deadlock'; refusing to run`,
    );
    return exit(1);
  }

  await app.whenReady();
  if (process.platform !== 'win32') {
    console.error(`ERROR: platform.unsupported process.platform=${process.platform}`);
    return exit(1);
  }

  const mainUrl = require('node:url').pathToFileURL(path.join(ROOT, 'electron-dist', 'main.js')).href;
  await import(mainUrl);
  const e2e = await waitFor(() => globalThis.__brawlE2E, 10_000);
  if (!e2e) {
    console.error('ERROR: __brawlE2E hook never appeared');
    return exit(1);
  }

  const bounds = await waitFor(() => {
    e2e.triggerOverlayDemo(choiceArg);
    return e2e.getDemoBackdropBounds();
  }, 10_000);
  if (!bounds) {
    console.error('ERROR: demo backdrop never appeared');
    return exit(1);
  }

  // Wait for the control window to actually have ranked a best card (".brawl-card.best"), not just for
  // ".brawl-status" to exist -- that status div renders as soon as capture starts, well before the worker's
  // two-frame accept debounce (worker.ts) resolves cards -> advice -> a ranked best pick. Screenshotting on
  // the earlier signal raced ahead of recognition and produced a real-but-blank (no green box) frame.
  const control = e2e.getControl();
  const drew = await waitFor(
    () => control?.webContents.executeJavaScript('!!document.querySelector(".brawl-card.best")'),
    15_000,
  );
  if (!drew) console.error('WARNING: control window never ranked a best card before the screenshot deadline');
  await sleep(1000); // let the overlay's own draw catch up to the relayed state

  // Composited from the backdrop + overlay windows' own rendered pixels (webContents.capturePage(), via
  // the __brawlE2E hook), not an OS-level screen copy: the demo windows are deliberately kept off the
  // screen's top z-order layer (electron/main.ts's sendWindowToBottom) so they never cover whatever the
  // person actually has open, which means an OS-level screenshot of that screen region would legitimately
  // see the person's own windows instead of ours.
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const buf = await e2e.captureDemoComposite();
  if (!buf) {
    console.error('ERROR: captureDemoComposite returned null (demo not running?)');
    return exit(1);
  }
  fs.writeFileSync(OUT_PATH, buf);
  console.log(`saved ${OUT_PATH}`);
  console.log(`demo running (${choiceArg}) — Ctrl+C to close, or it closes itself in ${DEMO_HOLD_MS}ms`);
  await sleep(DEMO_HOLD_MS);
  exit(0);
}

main().catch((e) => {
  console.error('ERROR:', e.stack || e.message);
  exit(1);
});
