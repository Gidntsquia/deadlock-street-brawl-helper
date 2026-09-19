// IPC channel names shared by main and preload, so a typo in one shows up at compile time in both.
export const CHANNELS = {
  getGameRect: 'get-game-rect',
  gameRect: 'game-rect',
  overlayState: 'overlay-state',
  captureDenied: 'capture-denied',
  // Test mode (dummy "Deadlock" window): invoke to read/toggle/switch frame, and a push of the state to the
  // control window whenever it changes (including the dummy being closed or a real game taking over).
  testModeGet: 'test-mode-get',
  testModeSet: 'test-mode-set',
  testModeFrame: 'test-mode-frame',
  testModeState: 'test-mode-state',
  platformWarning: 'platform-warning',
} as const;
