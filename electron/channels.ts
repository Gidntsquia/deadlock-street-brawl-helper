// IPC channel names shared by main and preload, so a typo in one shows up at compile time in both.
export const CHANNELS = {
  getGameRect: 'get-game-rect',
  gameRect: 'game-rect',
  overlayState: 'overlay-state',
  // Test-mode video only: the overlay tells main a set's plates are drawn (main logs `video.advice`).
  captureDenied: 'capture-denied',
  // Test mode (dummy "Deadlock" window): invoke to read/toggle/switch frame, and a push of the state to the
  // control window whenever it changes (including the dummy being closed or a real game taking over).
  testModeGet: 'test-mode-get',
  testModeSet: 'test-mode-set',
  testModeFrame: 'test-mode-frame',
  testModeState: 'test-mode-state',
  // Test mode video (manual check only): open a picked video in the dummy, play, pause, seek, close.
  // Whether the control window should be capturing the game right now: main.ts probes for the draft screen with a
  // tiny screen-region read and only turns capture on while it is up. The control window reports back when it is done.
  captureStateGet: 'capture-state-get',
  captureState: 'capture-state',
  captureIdle: 'capture-idle',
  // Detect now (F8 / button / tray): renderer -> main invoke to start a try, main -> renderer push to run it (any
  // source); renderer -> main when a try missed (capture goes off and stays off) and when a capture start worked or failed.
  detectNow: 'detect-now',
  detectRun: 'detect-run',
  detectMiss: 'detect-miss',
  captureResult: 'capture-result',
  // Debug: the frame capture sees at a Detect now press, saved as a PNG next to the app's data.
  detectKeyState: 'detect-key-state',
  // The one problem that stops the app (exclusive fullscreen, window too small, capture denied, F8 taken), or null.
  problem: 'problem',
  problemGet: 'problem-get',
  // What the first-run check reads (window found, size, borderless, black capture), and the tray entry that reopens it.
  env: 'env',
  envGet: 'env-get',
  firstRunOpen: 'first-run-open',
  detectKeyGet: 'detect-key-get',
  platformWarning: 'platform-warning',
  // Tray menu "Debug panel" entry: main -> control window, toggles the hidden Debug panel.
  // Debug-mode recording and the session report. The page says whether debug mode is on, hands over the crops of the
  // draft on screen and then its record; the report lists the sessions and marks drafts wrong.
  // Loading screen ("Joining the fight as..."): main grabs the hero name box and pushes its pixels to the control window.
  loadingName: 'loading-name',
  // Round banner: the probe read a new ROUND number, main pushes it to the control window (OCR warm-up, state machine).
  roundStart: 'round-start',
  // Item stats for a custom ability order the stored data lacks: page asks, main fetches once and caches under userData.
  // The name reader (Windows OCR helper, electron/nameReader.ts): the page asks main to read a prepared text crop, and
  // main pushes the reader's state (starting / ready / failed) whenever it changes.
  readText: 'read-text',
  // A MessagePort straight from the frame worker to main for those reads (the page's thread is busy with frames, and a
  // read relayed through it waited 20 to 100 ms): the page asks, main answers with the port, the page hands it on.
  ocrPortGet: 'ocr-port-get',
  ocrPort: 'ocr-port',
  readerStateGet: 'reader-state-get',
  readerState: 'reader-state',
  // Custom title strip buttons: renderer -> main.
  windowMinimize: 'window-minimize',
  windowClose: 'window-close',
} as const;

// Dev tooling only (debug panel, session recorder, test-mode video, the F8 frame dump, the overlay draw ack). A production
// build defines `__DEV_TOOLS__` false, so these names and values are not in it; code that uses them sits behind the flag.
const DEV_CHANNEL_NAMES = {
  overlayDrawn: 'overlay-drawn',
  testModeVideo: 'test-mode-video',
  debugToggle: 'debug-toggle',
  debugState: 'debug-state',
  sessionFrame: 'session-frame',
  sessionDraft: 'session-draft',
  sessionList: 'session-list',
  sessionMark: 'session-mark',
  saveDebugFrame: 'save-debug-frame',
} as const;
export const DEV_CHANNELS = (__DEV_TOOLS__ ? DEV_CHANNEL_NAMES : {}) as typeof DEV_CHANNEL_NAMES;
