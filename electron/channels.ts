// IPC channel names shared by main and preload, so a typo in one shows up at compile time in both.
export const CHANNELS = {
  getGameRect: 'get-game-rect',
  gameRect: 'game-rect',
  overlayState: 'overlay-state',
  captureDenied: 'capture-denied',
} as const;
