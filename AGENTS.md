# AGENTS.md — Deadlock Street Brawl Helper

Repo constitution for planner / worker / evaluator agents. Overrides generic stack defaults.

## Stack (do not switch)

- npm (not Bun/pnpm), Node 20+ locally, Node 24 in CI. Vite 8 + React 19 + TypeScript 6, plain CSS in `src/index.css`.
- Lint: oxlint (`.oxlintrc.json`). Format: Prettier. Tests: vitest. Typecheck: `tsc -b` over
  `tsconfig.app.json` / `tsconfig.node.json` / `tsconfig.electron.json` / `tsconfig.scripts.json`
  (all `strict`); the last one covers `scripts/*.ts` (the CLI, the recogniser, and their tests).
- Desktop: Electron 33 + electron-builder + koffi (Win32 window rect). Windows-only at runtime. Launch and
  verify with the `win:*` npm scripts from WSL (see below) — they sync to and run from a native Windows path
  because koffi and Electron don't work reliably over `\\wsl$\`. `npm run dev:electron` run directly inside
  WSL boots Linux Electron under WSLg instead of Windows Electron: `findGameWindow`/capture always return
  null there, and `main.ts` logs `platform.unsupported` (surfaced in the status line) when
  `process.platform !== 'win32'`. Running `dev:electron` from an actual Windows terminal, inside the synced
  Windows copy, also works.
- Data: static JSON + webp under `public/data/`, produced by `scripts/fetch-data.mjs` from deadlock-api.com.
  No backend, no database, no secrets, no `.env`.

## Commands

- `npm run check` — lint + typecheck + prettier --check + vitest; CI runs this before deploy.
- `npm run brawl:see -- --fixtures` — recogniser accuracy on `scripts/fixtures/` (must stay 27/27).
- `npm run brawl -- --hero 1 --round 2 --set "…"` — engine CLI without the screen reader.
- `npm run fetch-data` — full brawl refresh (~1400 requests, ~9 min). Do not run casually; a weekly
  GitHub Action does it.
- `npm run win:setup` — once per machine; installs Node on the Windows side via winget (may prompt UAC).
- `npm run win:sync` — rsyncs the repo to `/mnt/c/Users/<user>/brawl-helper-win` and builds there. Never
  `rsync --delete` over that copy's `node_modules`; it's gitignored and stays out of this repo.
- `npm run win:dev` — the actual way to run the app from WSL: syncs, then launches real Windows
  `electron.exe` from the Windows copy.
- `npm run win:e2e [-- --only <case1,case2>]` — drives real Windows `electron.exe` end to end (boot,
  capture-denied, capture-found/recover, overlay, frames) and writes `logs/win-e2e.json`. Opens real windows
  on the desktop for ~1-2 min (a full default run takes ~100-110s; the harness's own hard timeout is 180s,
  raised from 90s once `frames`/`overlay` were added — see the gotcha below). Don't touch a window it didn't
  create. `--only selftest-fail` is a deliberately failing case that proves the harness can fail — it never
  runs as part of the default full run.
- `npm run win:demo -- choice1|choice2` — no real Deadlock window needed: opens an app-owned demo backdrop
  showing a real draft-screen screenshot (`public/demo/choice1.png`/`choice2.png`), runs it through the real
  recognise/advise/draw pipeline (same code path Ctrl+Shift+D uses when a live game triggers it), and saves
  the overlay's own composited output to `logs/win-demo.png`. Refuses to run if a real "Deadlock" window is
  already open (same guard as `win:e2e`). Verify with `npx tsx scripts/win/check-demo-png.ts logs/win-demo.png`
  (`frame-visible: true`, `green-on-best: true`) or by opening the PNG.

## Manual checks (the harness can't cover these)

Do these by hand on real Windows with a real Deadlock client at least once per release, since nothing
in `win:e2e`/`win:demo` drives the actual game:

- Start Deadlock in both **Borderless Windowed** and real **Fullscreen** (Video settings). The overlay
  must actually appear on top of the game in borderless; in true fullscreen exclusive mode it may not
  (this is a Windows/game limitation, not something the app can fix — confirm the app at least doesn't
  crash or mis-detect the window in that mode).
- Trigger Ctrl+Shift+D while the real game is running and _not_ in a draft: confirm it shows the 10s
  sample-advice demo without disturbing an already-running real capture, and that it never captures the
  real Deadlock window's live pixels for the demo (only ever the app's own backdrop PNG).
- Play (or replay) a real Street Brawl draft end to end and confirm the advice box tracks the actual
  draft screen, re-roll banner appears when expected, and the box genuinely feels click-through (clicks
  through the overlay reach the game underneath, no accidental focus steal).

## Conventions

- Logging goes through `src/log.ts` (JSON lines to console). No bare `console.*` in `src/` or `electron/`.
- Commit messages: imperative sentence, no type prefix (see `git log`). Pushing to main is pre-approved.
- Persisted UI state (hero, tab, round, enemies) goes through `src/hooks/usePersisted.ts`
  (`localStorage` under the `brawl.` key prefix, validated with a type guard on read — no Zod here).
- `<App/>` and `<OverlayApp/>` are wrapped in `src/components/ErrorBoundary.tsx` (in `main.tsx`); it
  logs `ui.error` via `src/log.ts` and shows a Reload button instead of a blank page.
- Electron IPC channel names live in `electron/channels.ts`, imported by both `main.ts` and
  `preload.ts` — add new channels there, not as string literals.
- `electron/main.ts`'s display-media handler must never fall back to an arbitrary capture source when
  the Deadlock window isn't found; it denies the request and tells the renderer via the
  `capture-denied` channel instead.
- Never edit `public/data/**` or `scripts/fixtures/**` by hand except `manifest.json` metadata.
- Do not change scoring constants in `src/brawl/engine.ts` without updating the tests and the wiki page.
- Layout anchors in the recogniser are for 2560×1440; other 16:9 sizes scale. No fixtures exist for other
  resolutions.
- User docs live in the GitHub wiki; README is quickstart only. `plans/` is gitignored planner state.
- The game window is matched by exact title `Deadlock` (`electron/main.ts`, `electron/gameWindow.ts`), never
  by substring: the app's own window is "Deadlock Street Brawl Helper".
- `screenshots/` is gitignored reference material (full draft frames the user supplies); it is not a fixture
  directory and nothing in tests may depend on it.
- `scripts/win/frames/` is the tracked full-frame set for the Windows harness (two real draft screenshots +
  hand-measured `labels.json`), unlike `screenshots/` above which stays gitignored and untested-against.
- Component tests (anything rendering React, e.g. `<BrawlView/>`) live under `src/components/__tests__/`
  and run in `jsdom` via `vite.config.ts`'s `test.environmentMatchGlobs`; the rest of the suite (`src/brawl`,
  `electron`, `scripts`) stays on the default Node environment. Don't add a global jsdom environment.
- `OverlayState` (`src/brawl/draw.ts`) is the full contract between the control window and the Electron
  overlay: card reads, the re-roll flag/rect, and the `advice` panel data (names, not ids — the overlay has
  no item/ability catalog). Extend it there, not with ad hoc IPC payloads.
- koffi callback params (e.g. `EnumWindows`) need a real prototype via `koffi.proto(...)`, not a bare
  `'void *'` — the latter silently enumerates zero windows instead of throwing (see `electron/gameWindow.ts`).
- Never pass `detached: true` to `child_process.spawn('powershell.exe', ...)` on Windows: the child exits
  almost immediately (code 0, no window, no side effects) instead of running. Plain (non-detached) spawn
  blocks correctly; kill it explicitly instead of relying on OS-level detachment
  (see `scripts/win/e2e-main.cjs`).
- `.ps1` files must stay ASCII-only (no em dashes/curly quotes): Windows PowerShell 5.1's default script
  encoding mangles non-ASCII bytes into parser errors.
- `electron-dist/main.js` is built as ESM (package.json has `"type": "module"`); load it from a CommonJS
  script with dynamic `import(pathToFileURL(...).href)`, not `require()`.
- `electron/preload.ts` must build to CommonJS (`electron-dist/preload.cjs`, forced via a Vite lib build in
  `vite.config.ts`) — Electron's sandboxed preload loader rejects an ESM preload. Electron does emit a `preload-error` event for
  this, but nothing logged it before; `logPreloadErrors()` in `electron/main.ts` now logs it as
  `preload.error`. The visible symptom is `window.brawlAPI` staying `undefined`.
- Harness ordering: in `e2e-main.cjs`'s `frames` case, hero/round/choice are set **before** the fake window is
  spawned. Changing the Round/Choice selects clears the accepted cards and the worker never re-sends a set it
  already accepted, so setting them after capture starts leaves advice null for that frame.
- `fake-deadlock.ps1` scales its screenshot once into a 1280x720 bitmap (`BackgroundImage`); do not go back to
  scaling inside a PowerShell `Paint` handler (slow repaints left the window blank on screen).
- Under `BRAWL_E2E` both the control window and the overlay run at opacity 0 and the fake window sits at the
  bottom of the z-order, so a harness run never covers the person's other windows. The `frames` case saves
  what capture received to `logs/win-e2e-frame-<name>.png`.
- The harness never screen-grabs the desktop (`CopyFromScreen` etc.); only the window titled "Deadlock" may be
  captured, including by diagnostic scripts.
- `scripts/win/e2e-main.cjs`'s `waitFor(fn, timeoutMs)` resolves on the first **truthy** return of `fn()`.
  Polling for a numeric threshold (not just existence) needs the `> N` check done inside the callback, or it
  resolves on the first small-but-truthy value.
- PowerShell console output written from inside a WinForms event handler (e.g. `Add_Shown`), redirected
  through a pipe to a Node child process, is not reliably flushed per line by `Write-Output`/`Write-Host`.
  Use `[Console]::Out.WriteLine(...)` then `[Console]::Out.Flush()` (see `fake-deadlock.ps1`).
- `BrawlView.tsx` logs `capture.attempt` before every `getDisplayMedia` call (success or failure) and
  `capture.start` only after a successful attempt + `video.play()`. Anything that needs to observe denied
  attempts (e.g. e2e retry-loop checks) must count `capture.attempt`, not `capture.start`.
- The e2e fake window (`fake-deadlock.ps1`) and, under `BRAWL_E2E`, the control window
  (`electron/main.ts`) never steal focus or come to the front — `SW_SHOWNOACTIVATE`/`SetWindowPos(HWND_BOTTOM)`
  and `showInactive()` respectively. This doesn't affect capture: `desktopCapturer`/`getDisplayMedia` read a
  window's pixels by handle regardless of z-order or visibility.
- `scripts/win/frames/labels.json`'s `boxes` are frame px at the source PNGs' own 2000x1125 resolution, not
  at whatever resolution the fake window's capture ends up at. `fake-deadlock.ps1 -Image` stretches the PNG
  to fill the whole (16:9) client area, so the harness scales label boxes by `capturedFrameW / 2000` before
  comparing against `window.__overlayDrawn` (frame px in the _captured_ frame's own resolution) — see
  `runFramesCase` in `scripts/win/e2e-main.cjs`.
- `fake-deadlock.ps1`'s window is `FormBorderStyle = 'None'` (borderless): desktopCapturer/getDisplayMedia
  (Windows Graphics Capture) captures a window's _full bounds_ including title bar/border chrome, not just
  its client area. With a title bar, the captured frame came back non-16:9 (e.g. 1282x758 for a 1280x720
  client) and every fixed-layout anchor in the recogniser was silently offset — a real Deadlock window is
  presumably borderless already, so this was a harness-only artifact, not a real-world recogniser problem.
- Closing one fake-deadlock.ps1 window and opening the next (as the `frames` harness case does per labelled
  frame) invalidates the old window's WGC capture handle ("target source has been closed") and stops the
  video track. `BrawlView.tsx`'s game-rect effect retries `startCapture()` whenever the game window is
  present and `capture === 'off'`, regardless of `denied` (not just after a getDisplayMedia denial) — this
  covers that case too, since a stale-track stop never sets `denied`. Don't gate that retry on `denied`
  again; it was the root cause of a capture that never recovered after the first window swap.
- `video.srcObject`/`videoWidth` are not a reliable "is capture actually running" signal in the harness:
  `stopCapture()` never clears `srcObject`, so a dead, frozen `<video>` keeps reporting its last-known
  size forever. Poll a fresh `capture.attempt` console line count instead (see `waitForCaptureOn` /
  `captureStartTotal` in `scripts/win/e2e-main.cjs`).
- `drawReads` (`src/brawl/draw.ts`) returns the rects it actually stroked (`DrawnRect[]`, frame px, tagged
  `card`/`best`/`reroll`); `OverlayApp.tsx` stashes the latest list on `window.__overlayDrawn`, gated by
  `window.brawlAPI.isE2E` (from `electron/preload.ts`, `BRAWL_E2E=1`) so it's a no-op outside the harness.
- The e2e-only forced-reroll hook lives on `__brawlE2E.forceReroll()` in `electron/main.ts`: it resends the
  last real, capture-derived `OverlayState` with `reroll:true`/`bestId:null` — never a fabricated state —
  for PLAN.md item 3's `reroll-box` check when no frame naturally verdicts RE-ROLL.
- `scripts/win/e2e-main.cjs`'s hard timeout is 180s (`main()`'s `setTimeout`), not 90s — a full default run
  (all cases) takes ~100-110s once `frames`/`overlay` are included, and the old 90s ceiling cut the run off
  mid-teardown, which cascaded into spurious failures on whichever case happened to be running last (not a
  real bug in that case). Raise it again if more cases are added and full runs start bumping the new ceiling.
- `win:demo`'s and `win:e2e`'s `overlay` case both must wait for a real ranked-best signal
  (`.brawl-card.best` in the control window / `.overlay-panel` text containing an actual card name), not
  just for _some_ status text to render — status text (hero/round/ability line) appears immediately, well
  before the worker's two-frame accept debounce (`worker.ts`) resolves cards into a ranked pick. Waiting on
  the earlier signal produces a real-looking but blank screenshot / a false pass on stale text.
- `webContents.capturePage()` flattens a `transparent: true` `BrowserWindow` to an opaque bitmap (no alpha),
  confirmed with `sharp` (`hasAlpha: false` on the output despite the window being transparent). To composite
  a transparent overlay's real content over another layer, read the overlay's own `<canvas>` element's
  `toDataURL('image/png')` instead (via `executeJavaScript`) — that's a real per-pixel-alpha rasterisation,
  not a window screenshot. See `captureDemoComposite()` in `electron/main.ts`.
