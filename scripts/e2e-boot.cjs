// Headless, WSL/CI-runnable boot check for the Electron shell (no display, no Windows-only APIs).
// Proves preload loads and the built UI renders under `loadFile` — the two defects item 2 fixed.
// Run: npm run build:electron && npx electron scripts/e2e-boot.cjs --ozone-platform=headless --no-sandbox
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

app.disableHardwareAcceleration();
process.on('unhandledRejection', (r) => console.log('UNHANDLED:', r && r.message));

app.whenReady().then(async () => {
  let win;
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_req, cb) => {
      win.webContents.send('capture-denied');
      cb({});
    },
    { useSystemPicker: false },
  );
  win = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      preload: path.join(ROOT, 'electron-dist/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  let preloadError = null;
  win.webContents.on('preload-error', (_e, p, err) => {
    preloadError = err.message;
    console.log('PRELOAD-ERROR:', p, err.message);
  });
  await win.loadFile(path.join(ROOT, 'dist/index.html'));
  await new Promise((r) => setTimeout(r, 1500));

  const brawlApiType = await win.webContents.executeJavaScript('typeof window.brawlAPI');
  console.log('brawlAPI type:', brawlApiType);
  const bodyLength = await win.webContents.executeJavaScript('document.body.innerText.length');
  console.log('body length:', bodyLength);

  const ok = brawlApiType === 'object' && bodyLength > 50 && !preloadError;
  console.log(ok ? 'BOOT-OK' : 'BOOT-FAIL');
  app.quit();
  process.exitCode = ok ? 0 : 1;
});
