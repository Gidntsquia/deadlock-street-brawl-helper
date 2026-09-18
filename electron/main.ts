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
import { fileURLToPath } from 'node:url';
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

function loadRoute(win: BrowserWindow, route: string) {
  if (DEV_SERVER_URL) win.loadURL(`${DEV_SERVER_URL}${route}`);
  else win.loadFile(path.join(__dirname, '../dist/index.html'), { hash: route.replace(/^#/, '') });
}

function createControlWindow() {
  control = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.setAlwaysOnTop(true, 'screen-saver');
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

/** Shows the overlay with a fake advice state for 10s so the user can check it lands over the game
 *  without waiting for (or being in) a real draft. Triggered by Ctrl+Shift+D or the tray menu. */
function triggerOverlayDemo() {
  if (!overlay) return;
  if (!overlay.isVisible()) {
    if (lastRect) overlay.setBounds(toDipBounds(lastRect));
    else {
      const { workArea } = screen.getPrimaryDisplay();
      overlay.setBounds(workArea);
    }
    overlay.showInactive();
  }
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.moveTop();
  overlay.webContents.send(CHANNELS.overlayDemo);
  log('electron-main', 'info', 'overlay.demo');
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

function setupIpc() {
  ipcMain.handle(CHANNELS.getGameRect, () => lastRect);
  // Relay: the control window computes advice from its capture and forwards state for the overlay to draw.
  ipcMain.on(CHANNELS.overlayState, (_event, state) => {
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
      { label: 'Overlay demo', click: triggerOverlayDemo },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function toggleOverlay() {
  if (!overlay) return;
  if (overlay.isVisible()) overlay.hide();
  else if (lastRect) overlay.showInactive();
}

app.whenReady().then(() => {
  setupDisplayMediaHandler();
  setupIpc();
  createControlWindow();
  createOverlayWindow();
  setupTray();
  startRectPolling();
  globalShortcut.register('CommandOrControl+Shift+O', toggleOverlay);
  globalShortcut.register('CommandOrControl+Shift+D', triggerOverlayDemo);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (pollTimer) clearInterval(pollTimer);
});
