import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
  session,
  Tray,
  Menu,
  nativeImage,
} from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, existsSync } from 'node:fs';
import { findGameWindow, isGameWindowTitle, type Rect } from './gameWindow';
import { CHANNELS } from './channels';
import { log } from '../src/log';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const GAME_WINDOW_TITLE = 'Deadlock'; // exact match only (electron/gameWindow.ts#isGameWindowTitle):
// the app's own control window is titled "Deadlock Street Brawl Helper" and must never match.
const RECT_POLL_MS = 250; // ~4 Hz, per the plan

let control: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let tray: Tray | null = null;
let lastRect: Rect | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
// Mirrors the value passed to the last setIgnoreMouseEvents() call, so the e2e harness can assert the
// *actual* live click-through state instead of the literal `true` createOverlayWindow() happens to pass
// today (electron/main.ts has no BrowserWindow getter to read this back).
let overlayIgnoresMouseEvents = false;
// Last OverlayState relayed to the overlay window, kept only so the e2e harness's forceReroll() hook can
// resend a reroll:true clone of it -- real capture-derived reads, not a fabricated OverlayState -- for
// PLAN.md's item 3 forced reroll-box pass (both tracked frames' actual engine verdict is TAKE, so a natural
// RE-ROLL never occurs in the frames harness case). Unused outside BRAWL_E2E.
let lastOverlayState: import('../src/brawl/draw').OverlayState | null = null;
// The Ctrl+Shift+D demo backdrop window and its auto-clear timer (PLAN.md item 4): an app-owned window
// (never titled "Deadlock", so capture logic could never mistake it for the game even if it tried) showing
// a real draft screenshot purely for a person or the demo harness to look at on screen. The control window
// never captures it (see triggerOverlayDemo below); it loads the same PNG file directly and runs it through
// the real recognise/advise/draw path, same as it would a live game -- so the demo's boxes are proof the
// pipeline works, not a fabricated state.
let demoBackdrop: BrowserWindow | null = null;
let demoTimer: ReturnType<typeof setTimeout> | null = null;
// Set right alongside the overlayDemoStart push (see CHANNELS.getPendingDemoFrame) so a BrawlView that
// mounts after the push was sent can still catch up instead of the demo silently never starting.
let pendingDemoFrame: string | null = null;
const DEMO_MS = 10_000;
// Keeping these windows fully invisible to the user was tried three other ways first, and each one broke
// something: screen-saver-level always-on-top visibly covered the user's other work; showInactive() +
// SetWindowPos-to-bottom-of-z-order still covered other work briefly on first show, and once something real
// did cover it, Chromium's occlusion tracking suspended its rendering (capturePage() came back blank); and a
// real position far outside every monitor's bounds never gets composited at all in this environment (also
// blank). setOpacity(0) on a window at a normal, real, on-monitor position sidesteps all three: the window is
// still actually composited (real content, so capturePage() sees real pixels; no occlusion-suspend since
// nothing needs to "cover" it) but is 100% transparent, so it is never visible to the user no matter its
// z-order.

/** Path to a shipped demo screenshot: `public/demo/<name>.png` in dev (served relative to this file, same
 *  convention as the tray icon below), `dist/demo/<name>.png` inside the asar once packaged (Vite copies
 *  `public/` into `dist/` on build). */
function demoImagePath(name: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'dist', 'demo', `${name}.png`)
    : path.join(__dirname, '../public/demo', `${name}.png`);
}

// Electron's own setDisplayMediaRequestHandler implementation throws "Video was requested, but no video
// stream was provided" as an unhandled rejection *inside Electron*, not something our handler's try/catch
// can reach, whenever the request asked for video (it always does here) and we deny by calling callback({})
// with none — this is Electron's documented-by-behavior way of surfacing a denial, confirmed against
// Electron 33's actual runtime (not just its .d.ts, which allows callback({}) but doesn't say what happens
// next). Left unhandled, Node just warns by default, but log it instead of leaving a scary, unexplained
// trace on every deny so it doesn't look like a crash.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  if (err.message === 'Video was requested, but no video stream was provided') {
    log('electron-main', 'debug', 'capture.deny.artifact', { message: err.message });
    return;
  }
  log('electron-main', 'error', 'unhandled.rejection', { message: err.message, stack: err.stack });
});

function loadRoute(win: BrowserWindow, route: string) {
  if (DEV_SERVER_URL) win.loadURL(`${DEV_SERVER_URL}${route}`);
  else win.loadFile(path.join(__dirname, '../dist/index.html'), { hash: route.replace(/^#/, '') });
}

/** Logs a preload load failure instead of leaving `window.brawlAPI` silently undefined (the symptom
 *  a bad preload build — e.g. emitted as ESM — produces with no other visible error). */
function logPreloadErrors(win: BrowserWindow) {
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    log('electron-main', 'error', 'preload.error', { preloadPath, message: error.message, stack: error.stack });
  });
}

function createControlWindow() {
  control = new BrowserWindow({
    width: 1200,
    height: 900,
    show: !process.env.BRAWL_E2E,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  logPreloadErrors(control);
  if (process.env.BRAWL_E2E) {
    // Under the e2e/demo harness, this window is driven entirely via executeJavaScript, never actually
    // looked at by a person -- setOpacity(0) keeps it fully composited (real paint, real content) while
    // making it 100% invisible regardless of its z-order, instead of trying to keep it out of the way via
    // position or z-order (see the comment above DEMO_MS for why those don't work here).
    control.once('ready-to-show', () => {
      control?.setOpacity(0);
      control?.showInactive();
    });
  }
  loadRoute(control, '#/');
  control.on('closed', () => {
    control = null;
    app.quit();
  });
}

function createOverlayWindow() {
  overlay = new BrowserWindow({
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  logPreloadErrors(overlay);
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlayIgnoresMouseEvents = true;
  overlay.setAlwaysOnTop(true, 'screen-saver');
  // Under the harness nobody looks at the overlay (checks read it via capturePage/executeJavaScript), and it
  // is always-on-top: left visible it would draw over whatever the person is working in. Same opacity-0
  // approach as the control window above.
  if (process.env.BRAWL_E2E) overlay.setOpacity(0);
  loadRoute(overlay, '#/overlay');
  overlay.on('closed', () => {
    overlay = null;
  });
}

/** Snaps a physical-pixel screen rect to the DIPs `setBounds` expects on the display it's on. */
function toDipBounds(rect: Rect) {
  const display = screen.getDisplayMatching({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  const scale = display.scaleFactor || 1;
  return {
    x: Math.round(rect.x / scale),
    y: Math.round(rect.y / scale),
    width: Math.round(rect.width / scale),
    height: Math.round(rect.height / scale),
  };
}

function rectsEqual(a: Rect | null, b: Rect | null) {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Native window handles for this app's own windows, so findGameWindow can never latch onto them even if
 *  a title match somehow slipped through. */
function ownWindowHandles(): Set<bigint> {
  const handles = new Set<bigint>();
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      handles.add(w.getNativeWindowHandle().readBigUInt64LE());
    } catch {
      /* not on win32, or window already destroyed */
    }
  }
  return handles;
}

function startRectPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    const found = findGameWindow(GAME_WINDOW_TITLE, ownWindowHandles());
    if (!rectsEqual(found, lastRect)) {
      lastRect = found;
      log('electron-main', 'info', found ? 'window.found' : 'window.lost', found ?? undefined);
      control?.webContents.send(CHANNELS.gameRect, found);
      if (found && overlay) {
        overlay.setBounds(toDipBounds(found));
        if (!overlay.isVisible()) overlay.showInactive();
      } else if (!found && overlay?.isVisible()) {
        overlay.hide();
      }
    }
    // The game re-focusing (e.g. after an alt-tab elsewhere, or a fullscreen toast) can cover the overlay
    // even though it's marked always-on-top; re-assert every tick while the game is found so it never
    // silently drops behind, without waiting for the next rect change.
    if (found && overlay) {
      overlay.setAlwaysOnTop(true, 'screen-saver');
      overlay.moveTop();
    }
  }, RECT_POLL_MS);
}

/** Opens an app-owned backdrop window showing a real draft screenshot (purely so a person, or the demo
 *  harness's screenshot, has something to look at on screen) and tells the control window which frame to
 *  run through the real recognise -> advise -> draw path for 10s. The control window never captures the
 *  backdrop window's pixels -- desktopCapturer/getDisplayMedia stays reserved for a window actually titled
 *  "Deadlock" (see GAME_WINDOW_TITLE / setupDisplayMediaHandler) -- it loads the same PNG file directly and
 *  draws it to a canvas, so the demo can never accidentally end up capturing an arbitrary window. Triggered
 *  by Ctrl+Shift+D or the tray menu. No-op while a real game is already found: the live overlay already
 *  shows the real thing then. */
function triggerOverlayDemo(choice: 'choice1' | 'choice2' = 'choice1') {
  if (!overlay || !control) return;
  if (lastRect) {
    log('electron-main', 'info', 'overlay.demo.skipped-game-open');
    return;
  }
  if (demoTimer) {
    clearTimeout(demoTimer);
    demoTimer = null;
  }
  demoBackdrop?.close();
  const imagePath = demoImagePath(choice);
  demoBackdrop = new BrowserWindow({
    x: 0,
    y: 0,
    width: 1280,
    height: 720,
    title: 'Brawl Helper Demo Backdrop', // never "Deadlock": must not be captured as the game
    show: false,
    resizable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // A small file:// HTML file, not a `data:text/html,...` loadURL: two things were tried and ruled out by
  // watching the real window on screen (stayed solid black both times, not just in the screenshot):
  //  1. `<img src="file://...">` inside a `data:` page -- a data: document has an opaque origin, and
  //     Chromium refuses to load a file:// subresource from it regardless of whether the file:// URL is
  //     well-formed.
  //  2. The PNG inlined as a base64 `data:image/png` src, with that whole page still passed to loadURL as
  //     one big `data:text/html,...` string -- these draft screenshots are 1.2-1.3MB, so base64 + percent
  //     encoding pushes the single data: URL past ~2MB, which Chromium's data: URL loader silently drops
  //     load of, at least intermittently, leaving only the plain black body background.
  // A real file:// page loaded via loadFile has no URL-length ceiling and can reference a sibling file://
  // image (same scheme) without the cross-origin restriction from (1).
  const html = `<!doctype html><html><body style="margin:0;overflow:hidden;background:#000">
    <img src="${pathToFileURL(imagePath).href}" style="width:100vw;height:100vh;object-fit:fill;display:block" />
    </body></html>`;
  const tmpHtmlPath = path.join(app.getPath('temp'), `brawl-demo-backdrop-${choice}.html`);
  writeFileSync(tmpHtmlPath, html);
  log('electron-main', 'info', 'overlay.demo.paths', {
    imagePath,
    imageExists: existsSync(imagePath),
    tmpHtmlPath,
    isPackaged: app.isPackaged,
  });
  demoBackdrop.loadFile(tmpHtmlPath);
  demoBackdrop.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('electron-main', 'error', 'overlay.demo.did-fail-load', { code, desc, url });
  });
  demoBackdrop.webContents.on('console-message', (_e, level, message) => {
    log('electron-main', 'debug', 'overlay.demo.console', { level, message });
  });
  const backdrop = demoBackdrop;
  // Wait for the <img> to actually finish decoding (poll `complete`/naturalWidth), not just 'ready-to-show'
  // -- 'ready-to-show' fires on the page's first compositor frame, which can land before a 1.2MB local PNG
  // has decoded, and showInactive() before that first real paint (over RDP/remote-session GPU compositing
  // in particular) left the window showing only its plain black body background permanently, never
  // repainting once the image did arrive.
  const waitForImageDecoded = async (): Promise<boolean> => {
    for (let i = 0; i < 50; i++) {
      if (demoBackdrop !== backdrop) return false; // superseded
      try {
        const ok = await backdrop.webContents.executeJavaScript(
          "(() => { const i = document.querySelector('img'); return !!i && i.complete && i.naturalWidth > 0; })()",
        );
        if (ok) return true;
      } catch {
        /* webContents may not be ready yet on the very first poll */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  backdrop.webContents.once('did-finish-load', () => {
    void waitForImageDecoded().then((decoded) => {
      if (demoBackdrop !== backdrop) return; // superseded by a newer trigger before this finished loading
      if (!decoded) log('electron-main', 'warn', 'overlay.demo.image-not-decoded', { choice });
      // Real showInactive() (not hidden, not offscreen-mode), but at DEMO_OFFSCREEN_X/Y -- a position no
      // real monitor covers -- so it's fully composited (capturePage() below sees real pixels) without ever
      // being visible to the user. The overlay is moved to sit exactly over the backdrop at that same
      // off-monitor position, same as it would track a real game window.
      // setOpacity(0), not a hidden/offscreen window: see the comment above DEMO_MS for why this is the
      // only combination that both actually renders (capturePage() sees real pixels) and is guaranteed
      // never visible to the user, regardless of z-order.
      backdrop.setOpacity(0);
      backdrop.showInactive();
      const bounds = backdrop.getBounds(); // an Electron window's own bounds are already DIPs -- no scale conversion needed
      overlay?.setBounds(bounds);
      // Always-on-top like the real path (createOverlayWindow already sets this at startup) -- it never
      // matters visually since both windows sit off-monitor at opacity 0, but the e2e harness checks
      // isAlwaysOnTop() to prove the demo overlay behaves like the real one, not a stripped-down copy.
      overlay?.setAlwaysOnTop(true, 'screen-saver');
      overlay?.setOpacity(0);
      overlay?.showInactive();
      // Sends the frame name, not a captured source: the control window fetches the same PNG this backdrop
      // window is displaying and draws it straight to a canvas -- no desktopCapturer/getUserMedia involved.
      pendingDemoFrame = choice;
      control?.webContents.send(CHANNELS.overlayDemoStart, choice);
      log('electron-main', 'info', 'overlay.demo.start', { choice, bounds, decoded });
    });
  });
  demoTimer = setTimeout(stopOverlayDemo, DEMO_MS);
}

/** Ends demo mode immediately: same cleanup DEMO_MS's auto-clear timer runs, factored out so it can also be
 *  called on demand (the e2e harness needs this -- without an explicit stop, the `frames` case's first
 *  iteration can start while a demo triggered by the earlier `overlay` case is still active, and the control
 *  window keeps drawing the demo PNG instead of switching to that iteration's real fake-window capture). */
function stopOverlayDemo() {
  if (demoTimer) {
    clearTimeout(demoTimer);
    demoTimer = null;
  }
  pendingDemoFrame = null;
  control?.webContents.send(CHANNELS.overlayDemoStop);
  demoBackdrop?.close();
  demoBackdrop = null;
  if (!lastRect) {
    overlay?.hide();
    // restore for the next real game session or manual toggle (the harness keeps it invisible throughout)
    if (!process.env.BRAWL_E2E) overlay?.setOpacity(1);
  }
}

/** Composites the demo backdrop and overlay windows' own rendered pixels into one PNG, via
 *  webContents.capturePage() -- Electron's internal compositor output -- rather than an OS-level screen
 *  copy. Needed because the demo windows are deliberately opacity-0 (see the comment above DEMO_MS) so
 *  they never visibly cover the user's other work; an OS-level screenshot of that screen region would just
 *  show whatever's really behind them, but capturePage() reads each window's own buffer directly regardless
 *  of opacity or z-order, so it still proves the real recognise -> advise -> draw pipeline drew boxes.
 *  Composited via a throwaway <canvas> in the control window's own renderer (drawImage layers backdrop then
 *  the transparent overlay on top, preserving overlay alpha) since there's no Node-side image compositor
 *  available here. Returns null if the demo isn't currently running. */
async function captureDemoComposite(): Promise<Buffer | null> {
  if (!demoBackdrop || !overlay || !control) return null;
  const backdrop = demoBackdrop;
  const ov = overlay;
  // Chromium suspends compositing an opacity-0 window (same as an occluded or offscreen one -- see the
  // comment above DEMO_MS), so capturePage() right after setOpacity(0) is set can return a stale/blank
  // frame from before it went invisible. Flip to visible just long enough to force one real frame (two
  // rAF callbacks guarantees a compositor frame actually landed, not just a script tick), capture, then
  // immediately flip back -- the visible window exists for at most a couple of frames (~30ms), not the
  // whole demo, so it reads as a capture artifact rather than something blocking the user's screen.
  backdrop.setOpacity(1);
  const forceFrame = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';
  await backdrop.webContents.executeJavaScript(forceFrame);
  const bgImage = await backdrop.webContents.capturePage();
  backdrop.setOpacity(0);
  const bgDataUrl = bgImage.toDataURL();
  // NOT ov.webContents.capturePage(): Electron's capturePage() flattens a transparent BrowserWindow to an
  // opaque RGB bitmap (confirmed via sharp: hasAlpha=false on the captured PNG even though the window is
  // `transparent: true`), so drawing that over the backdrop blotted out the whole draft screen with solid
  // near-black everywhere the overlay wasn't drawing a box. The overlay's own <canvas> element's own
  // toDataURL() is a real canvas rasterisation, not a window screenshot, so it keeps its real per-pixel
  // alpha -- only the stroked boxes/TAKE/RE-ROLL text are opaque, everywhere else is truly transparent.
  const fgDataUrl: string = await ov.webContents.executeJavaScript(
    "document.querySelector('canvas')?.toDataURL('image/png') ?? ''",
  );
  const composedDataUrl: string = await control.webContents.executeJavaScript(`
    (function () {
      return new Promise((resolve, reject) => {
        const bg = new Image();
        const fg = new Image();
        let loaded = 0;
        function onLoad() {
          loaded += 1;
          if (loaded < 2) return;
          const canvas = document.createElement('canvas');
          canvas.width = bg.naturalWidth;
          canvas.height = bg.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);
          ctx.drawImage(fg, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        }
        bg.onerror = fg.onerror = () => reject(new Error('demo composite image failed to load'));
        bg.onload = onLoad;
        fg.onload = onLoad;
        bg.src = ${JSON.stringify(bgDataUrl)};
        fg.src = ${JSON.stringify(fgDataUrl)};
      });
    })()
  `);
  const base64 = composedDataUrl.slice(composedDataUrl.indexOf(',') + 1);
  return Buffer.from(base64, 'base64');
}

function setupDisplayMediaHandler() {
  // Serves the Deadlock window directly to getDisplayMedia in the renderer, so no picker dialog appears.
  // Never fall back to the first source in the list: capturing an arbitrary window when Deadlock isn't
  // running would silently show advice for whatever happened to be first instead of telling the user
  // the game isn't open.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['window'] });
      const ownIds = new Set([control?.getMediaSourceId(), overlay?.getMediaSourceId()].filter(Boolean));
      log('electron-main', 'debug', 'capture.candidates', { names: sources.map((s) => s.name) });
      const match = sources.find((s) => !ownIds.has(s.id) && isGameWindowTitle(s.name, GAME_WINDOW_TITLE));
      log('electron-main', match ? 'info' : 'warn', match ? 'capture.chosen' : 'capture.denied', { name: match?.name });
      if (!match) {
        control?.webContents.send(CHANNELS.captureDenied);
        callback({}); // denies the request instead of falling back to an arbitrary window
        return;
      }
      callback({ video: match });
    },
    { useSystemPicker: false },
  );
}

/** Only real Windows electron.exe can find the game window or capture it (koffi's win32 calls and
 *  desktopCapturer's window matching both no-op elsewhere) — `npm run dev:electron` run inside WSL boots
 *  Linux Electron under WSLg instead, so warn loudly rather than let capture silently never find anything.
 *  `npm run win:dev` is what actually runs Windows Electron from WSL. */
function platformWarning(): string | null {
  if (process.platform === 'win32') return null;
  const msg = `platform.unsupported: process.platform=${process.platform} — run "npm run win:dev" from WSL (or "npm run dev:electron" from a Windows terminal in the synced Windows copy), not dev:electron inside WSL`;
  log('electron-main', 'warn', 'platform.unsupported', { platform: process.platform });
  return msg;
}

function setupIpc() {
  ipcMain.handle(CHANNELS.getGameRect, () => lastRect);
  ipcMain.handle(CHANNELS.platformWarning, () => platformWarning());
  ipcMain.handle(CHANNELS.getPendingDemoFrame, () => pendingDemoFrame);
  // Relay: the control window computes advice from its capture and forwards state for the overlay to draw.
  ipcMain.on(CHANNELS.overlayState, (_event, state) => {
    lastOverlayState = state;
    overlay?.webContents.send(CHANNELS.overlayState, state);
  });
}

function setupTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'dist', 'apple-touch-icon.png')
    : path.join(__dirname, '../public/apple-touch-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Deadlock Street Brawl Helper');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Toggle overlay', click: toggleOverlay },
      { label: 'Overlay demo', click: () => triggerOverlayDemo() },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function toggleOverlay() {
  if (!overlay) return;
  if (overlay.isVisible()) overlay.hide();
  else if (lastRect) overlay.showInactive();
}

// The demo backdrop window (triggerOverlayDemo) renders correctly inside Electron itself -- confirmed via
// webContents.capturePage(), which reads Electron's own compositor output -- but never actually reaches the
// physical screen: an OS-level screenshot (CopyFromScreen) and the user's own eyes both see solid black.
// The real "Deadlock" capture path never showed this because desktopCapturer/getUserMedia read frames
// straight from the GPU surface, bypassing DWM's window-to-screen composition entirely; this demo window has
// no such bypass and depends on that composition actually reaching the monitor, which fails in this
// environment (RDP/virtual-display sessions are a documented case where Chromium's GPU-accelerated surfaces
// never get composited to the real screen by DWM). Forcing software rendering (no GPU process) makes Chromium
// paint through the normal software/GDI path instead, which DWM does composite correctly.
// Only scoped to BRAWL_E2E (demo/e2e harness) runs, never a real game session: disabling hardware
// acceleration forces every window, including the real overlay, onto software/GDI rendering, which (a)
// is CPU-heavy enough to visibly lag a running game and (b) composites through DWM differently than the
// game's GPU flip-model surface, letting the game win the always-on-top fight and cover the overlay. The
// demo backdrop is the only window that actually needs this (see the comment above), and only when DWM
// isn't compositing GPU surfaces to the real screen (RDP/virtual-display sessions) -- real hardware runs
// must keep GPU acceleration on.
// scripts/win/demo-main.cjs and e2e-main.cjs both await app.whenReady() themselves before dynamically
// importing this module (so they can guard/instrument first), so app is already ready by the time this
// line runs under those harnesses -- disableHardwareAcceleration() throws in that case; it's a no-op we
// can safely skip since the harness process is short-lived and re-launched per run anyway.
if (process.env.BRAWL_E2E && !app.isReady()) app.disableHardwareAcceleration();

app.whenReady().then(() => {
  setupDisplayMediaHandler();
  setupIpc();
  createControlWindow();
  createOverlayWindow();
  setupTray();
  startRectPolling();
  globalShortcut.register('CommandOrControl+Shift+O', toggleOverlay);
  globalShortcut.register('CommandOrControl+Shift+D', triggerOverlayDemo);
  // Test-only hook: scripts/win/e2e-main.cjs requires this exact module (not a stub) so it needs a way to
  // reach the real windows/handlers it just created. Inert unless BRAWL_E2E is set.
  if (process.env.BRAWL_E2E) {
    (globalThis as Record<string, unknown>).__brawlE2E = {
      getControl: () => control,
      getOverlay: () => overlay,
      get overlayIgnoresMouseEvents() {
        return overlayIgnoresMouseEvents;
      },
      // Forces a reroll:true resend of the *real*, capture-derived last OverlayState -- for PLAN.md item
      // 3's forced reroll-box check when no frame's natural engine verdict is RE-ROLL. Returns false (no
      // send) if no real state has been relayed yet.
      forceReroll: () => {
        if (!lastOverlayState) return false;
        overlay?.webContents.send(CHANNELS.overlayState, { ...lastOverlayState, reroll: true, bestId: null });
        return true;
      },
      triggerOverlayDemo,
      stopOverlayDemo,
      getDemoBackdropBounds: () => demoBackdrop?.getBounds() ?? null,
      captureDemoComposite,
    };
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (pollTimer) clearInterval(pollTimer);
});
