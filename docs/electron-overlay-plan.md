# Electron overlay plan

Goal: turn the browser app into a packaged Windows app that draws the recommended card's highlight
box directly on the Deadlock window, with no picker dialog, no alt-tabbing, and no manually placed
floating window.

The recognition (`src/brawl/recognise.ts`, `worker.ts`), scoring (`engine.ts`) and React UI stay as
they are. The new work is a native shell around them plus a coordinate pipeline the browser sandbox
never exposed.

## Target architecture

Two Electron `BrowserWindow`s sharing one renderer bundle (the existing Vite build):

| Window | Purpose | Flags |
|---|---|---|
| Control | The current UI: hero picker, advice panel, tier list | normal window |
| Overlay | Draws only the highlight boxes and "TAKE" label at true screen coordinates | `transparent`, `frame: false`, `alwaysOnTop`, click-through, sized to cover the Deadlock window |

The main process (Node) does what the browser could not: finds the Deadlock window, reads its screen
rect, and tracks it as it moves or resizes.

## Phases

### 1. Electron scaffold (½ day)

- Add `electron`, `electron-builder`, and `vite-plugin-electron` (or `electron-vite`).
- Keep `npm run dev` as the web mode. Add `dev:electron` and `dist`.
- `electron/main.ts`: create the control window, loading the Vite dev server in dev and
  `dist/index.html` in production.
- `electron/preload.ts`: `contextBridge` exposing a small typed API
  (`getGameRect`, `setOverlayBounds`, `onGameRect`, `sendOverlayState`).
  `contextIsolation: true`, `nodeIntegration: false`.
- Milestone: the existing app runs unchanged inside Electron.

### 2. Capture without the picker (½ day)

- Replace `getDisplayMedia` in `src/components/BrawlView.tsx` (currently line ~100) with
  `desktopCapturer.getSources({ types: ['window'] })` in main, matched on window title "Deadlock".
  The renderer calls `getUserMedia` with `chromeMediaSourceId`.
- Downstream is the same `MediaStream`, so the frame loop and worker protocol are untouched.
- Use `session.setDisplayMediaRequestHandler` so no picker dialog is shown.
- Auto-start capture when the Deadlock window is found; stop when it closes.
- Milestone: capture starts on launch with no clicks.

### 3. Game window rect tracking (1 day, the new piece)

- Add `koffi` (prebuilt FFI, no node-gyp) and call from main:
  `EnumWindows`/`FindWindowW`, `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`, `IsIconic`.
- Poll at ~4 Hz. Emit `game-rect` to the renderer only on change.
- Handle: minimised, closed, moved, resized, per-monitor DPI
  (`screen.getDisplayMatching`, `screen.screenToDipRect`).
- Milestone: a test overlay window follows the game window as you drag it.

### 4. Overlay window (1 day)

- Create with `{ transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
  focusable: false, hasShadow: false }`, then `setIgnoreMouseEvents(true, { forward: true })` and
  `setAlwaysOnTop(true, 'screen-saver')`.
- Bounds = game rect from phase 3, updated on every `game-rect` event.
- New renderer route `#/overlay` rendering a full-window `<canvas>`. It receives
  `{ reads, bestId, frameW, frameH }` from the control window via an IPC relay in main and draws
  `strokeRect(x * W / frameW, y * H / frameH, edge * W / frameW, ...)`.
- Move the box-drawing code already in the preview canvas into a shared `src/brawl/draw.ts` used by
  both the preview and the overlay.
- Show the overlay only while a draft is detected (`reads.some(r => r.present)`); hide it otherwise
  so nothing lingers over gameplay.
- Milestone: the green box and "TAKE" appear on the actual card in game.

### 5. Remove the browser workarounds (½ day)

- Remove the Document Picture-in-Picture / `window.open` overlay path (`BrawlView.tsx` ~72-80) and
  the mirrored preview canvas when running in Electron. Keep them behind an `isElectron` check only
  if the web build is still wanted for LAN use; otherwise delete.
- Add a global hotkey (`globalShortcut`) to toggle the overlay, and a tray icon with Quit.

### 6. Packaging (½ day)

- `electron-builder`: NSIS installer plus a portable exe for Windows. Snapshot data in `public/`
  bundles as-is.
- Optional: `electron-updater` against GitHub Releases.
- README: replace the "pick the window" steps. Borderless Windowed stays a documented requirement.

## Risks and decisions

- **Fullscreen exclusive is still unsupported.** No overlay can sit above exclusive fullscreen.
  Same limit as today.
- **VAC risk is unchanged.** The app reads pixels through OS window capture and never touches the
  game process. No injection, no memory reads.
- **Build on Windows, not WSL2.** `desktopCapturer`, the Win32 rect calls and transparent windows
  only behave on real Windows. Run `dev:electron` and packaging from a Windows terminal with Node
  installed there.
- **Coordinate math.** The captured frame is the client area; `DWMWA_EXTENDED_FRAME_BOUNDS` is the
  visible frame. In borderless mode these coincide, which is why borderless is required for accurate
  boxes.
- **Install size** is roughly 180 MB. Accepted with the Electron choice.

## Estimate

About 4 working days. Phases 1 and 2 are low risk. Phase 3 (DPI, multi-monitor) is where surprises
are most likely.
