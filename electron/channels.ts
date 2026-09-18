// IPC channel names shared by main and preload, so a typo in one shows up at compile time in both.
export const CHANNELS = {
  getGameRect: 'get-game-rect',
  gameRect: 'game-rect',
  overlayState: 'overlay-state',
  captureDenied: 'capture-denied',
  // Sent to the control window only (never the overlay, which just gets a normal overlayState relay once
  // the control window starts capturing the demo backdrop's real pixels) -- see PLAN.md item 4.
  overlayDemoStart: 'overlay-demo-start',
  overlayDemoStop: 'overlay-demo-stop',
  // Invoke-based, unlike the two above: BrawlView only registers its overlayDemoStart listener once it has
  // mounted (after loadCore()'s hero/item fetch resolves), so a demo triggered before that point is a
  // one-shot 'send' with nobody listening yet, silently lost forever. This lets a freshly-mounted BrawlView
  // ask "is a demo already pending?" and catch up instead of depending on winning that mount race.
  getPendingDemoFrame: 'get-pending-demo-frame',
  platformWarning: 'platform-warning',
} as const;
