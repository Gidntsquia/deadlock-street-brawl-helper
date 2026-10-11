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
- `npm run fetch-data` — full brawl refresh (~1400 requests, ~9 min), run by hand before a release; there is no
  scheduled refresh workflow. Assets come from `api.deadlock-api.com/v1/assets` (the old `assets.` host is gone).
- Release: push a `v*` tag; `.github/workflows/release.yml` builds the portable exe + NSIS installer on windows-latest
  and attaches them to the GitHub Release. No Pages deploy exists.
- `npm run win:setup` — once per machine; installs Node on the Windows side via winget (may prompt UAC).
- `npm run win:sync` — rsyncs the repo to `/mnt/c/Users/<user>/brawl-helper-win` and builds there. Never
  `rsync --delete` over that copy's `node_modules`; it's gitignored and stays out of this repo.
- `npm run win:dev` — the actual way to run the app from WSL: syncs, then launches real Windows
  `electron.exe` from the Windows copy.
- `npm run win:e2e [-- --only <case1,case2>]` — drives real Windows `electron.exe` end to end (boot,
  capture-denied, first-run panel, `Reading` before plates, advice time under 2.5 s, test mode: advice/boxes/frame switches/ability points panel/blank overlay) and writes
  `logs/win-e2e.json`. Cases are `boot`, `capture-denied`, `testmode`, `overlay-closed`. The
  ability panel runs 1.2 s in the harness (`BRAWL_TIP_MS`), not the real 15 s. Target: a full run under 30 s; the
  harness's own hard timeout is 40 s. It needs a >= 1080p desktop (see Overlay behaviour). Don't touch a window it didn't
  create. A real Deadlock may stay open: under `BRAWL_E2E` the app finds and captures only its own dummy (no dummy = no
  game, capture denied), and the run ends with `real-game-left-alone` when one was open. Under `BRAWL_E2E` the overlay does not forward real mouse moves
  (a game in front holds the cursor at the screen centre, which cleared the harness's hover); the harness's `sendInputEvent` moves still reach it. `--only selftest-fail` is a deliberately failing case that proves the harness can fail — it never
  runs as part of the default full run.
- `npm run win:demo -- choice1|choice2` — no real Deadlock window needed (one may be open; it is left alone): starts the app's own **test mode**
  (below) with that screenshot, runs it through the real find/capture/recognise/advise/draw path, and saves
  the overlay's own composited output to `logs/win-demo.png`. A real "Deadlock" window may be open; it is not touched. Verify with `npx tsx scripts/win/check-demo-png.ts logs/win-demo.png`
  (`frame-visible: true`, `plates-placed: true`, `teal-on-best: true`, `teal-on-non-best: false`; every offered card has a plate with its tier
  letter and `Score: <n>` above it; the item to take has a teal-filled plate and a 3 px teal circle outline, the others a charcoal plate with a thin teal border).
  It also writes `logs/win-demo.json` (what the overlay drew). Any `public/demo` frame name works, e.g. `win:demo -- draft-r2c3-reroll` -> `logs/win-demo-<name>.png` or by opening the PNG. Nothing is
  visible on the desktop while this runs: it sets `BRAWL_E2E=1` internally (to reach the `__brawlE2E` test
  hook), which keeps the dummy at the bottom of the z-order and the overlay at opacity 0. `logs/win-demo.png`
  (a real canvas rasterisation of the overlay, not a screen grab) is the only output. To see it live, use test
  mode in a normal `npm run win:dev` session.

## Which tests to run

`npm test` (vitest, ~340 tests, already the whole suite; the two real-frame worker tests can time out once under heavy machine load) takes ~2.5 min wall (the video truth replays dominate): run it after any code change; run one file with
`npx vitest run <file>`. `npm run check` before pushing. `npm run win:e2e` (~30 s, drives real Windows) only when
capture, overlay, worker or Electron code changed, and only once per session. Docs/comments: run nothing.
All e2e-needing checks belong in the single `testmode` pass in `scripts/win/e2e-main.cjs`, asserted against
that one session; do not add a new case or a second app launch.

## Debug mode, sessions, replay

Debug mode (`src/debugMode.ts`) is on in dev and in any `-rc` version (last rc is `0.4.0-rc.1`; `0.3.0` was final, debug off); the title bar shows `DEBUG`.
Ctrl+Shift+D (or the tray entry, channel `debugToggle`) toggles the Debug panel: Start/Stop capture, Detect now (F8 still
works without it), test mode, round/choice/re-rolls, enemies, owned, advice list, ability order, and the **session report**
(one row per draft with its crops, items, shown plates, advice ms, and `Mark wrong`). The main view has only the status
sentence, a one-sentence problem (`src/brawl/problems.ts`, also drawn on the overlay for 5 s), `Hero not read. Using <name>` and
the collapsed per-hero ability order editor (`AbilityOrderEditor.tsx`; `brawl.customOrders`, 12 rounds per hero, one per pill;
a valid one replaces the standard order in the ability panel, `abilityPanelFor`'s `custom`, evidence line `Your order`).
With debug on, `electron/sessionStore.ts` records the last 3 matches under `userData/sessions/m-<id>/dNNN/` (crops only, 300 MB
cap, oldest deleted first; never commit them). `npm run brawl:replay -- <session folder>` re-runs each draft through the real
worker and gate on a virtual clock and prints items, `?` count, changes, drop-outs, advice ms and `same as live` or `differs
from live`. `npm run brawl:fixture -- <session folder>` copies every marked-wrong, `?`-fallback or changed draft into
`scripts/fixtures/sessions/` with an `expect.json`; `session-fixtures.test.ts` replays them. That tool is the only way to add them.

## Loading-screen hero

While the game is foreground and capture is off, the probe tick also grabs the "Joining the fight as..." name box
(`loadingNameRect`, `probeLoadingName` in `electron/shopProbe.ts`; cream-on-dark test `looksLikeLoadingName`). A hit sends
the pixels over `loadingName` (at most 3 times per screen) to `BrawlView`, which reads them with the name reader (`readHeroName`), matches the
text to a hero name (`matchHeroName`, score >= 0.85: one wrong letter in "SHIP" once read as Shiv) and uses it only
when the portrait read fails, for that match (valid 60 min). A hand-picked hero (`pinned`)
beats both. Not verified on real Windows: only the one frame in `scripts/fixtures/loading/` is tested.

## Reading sign and the fallback

While the draft screen is up and no plates are drawn the overlay shows `Reading` (`OverlayState.reading`). Plates, take mark and
re-roll call appear together once every sure card has advice (`pushOverlay` waits for it) and are then frozen for the set. After
`FALLBACK_MS` (2.5 s) the sure cards are advised and the rest get grey `?` plates; take and re-roll only if the best sure card
beats `unknownCeiling`. The hero is used only when the read is sure (`chooseHero`): else the last sure hero of the match, else
the window's hero with the `Hero not read` line and no ability panel. Round 1 choice 1 empties the owned list.

## First run and problems

`FirstRun.tsx` shows three ticks (Borderless, window size, capture) with `Show me` (test mode); dismissal is remembered
(`brawl.firstRunDone`) and the tray entry `First-run check` reopens it. Borderless is read from the missing WS_CAPTION style;
exclusive fullscreen is told apart by the GDI probe region reading black 3 polls in a row. If the style cannot be read the line
is an instruction with no tick. Strings: no `!`, emoji, em dashes, arrows or middle dots in `src/`, `electron/` or README
(`scripts/__tests__/strings.test.ts`; the wiki is checked by hand).

## Overlay look (clearer overlay)

Only the advised card is teal. The other plates are charcoal with a 1 px grey border (`--overlay-grey`), grey badge and text, drawn at
`--overlay-dim` (0.6) opacity, and a `--overlay-veil` (black 35 %) circle sits over each non-advised card under the plates; hover and
`ScoreTip` still work on a veiled card. A `?` card is grey and veiled; with no best card and no re-roll nothing is veiled. An enhanced card
has a right-end cell `Enhanced +n` (`Enh +n` when plates would touch), n = `RankedOffer.enhancedBonus` (score minus the same card not
enhanced, carried as `OverlayAdviceCard.enhancedBonus`, `bonusesFromAdvice`), and the tooltip Enhanced row equals it (`breakdownRows`). Geometry
is shared in `plateGeometry` (`draw.ts`); the `Reading` sign sits above the middle plate by max(6 px, 0.35 plate height), below it if clamped.
A re-roll call is a filled teal `RE-ROLL` plate (card-plate size) centred above the button plus a 4 px teal outline, and all cards go grey and veiled.
`scripts/render-ux.ts` (with `scripts/lib/svgCtx.ts`) renders before/after pictures into `plans/eval-artifacts/ux-pass/`; it needs the old
drawing as `src/brawl/draw.before.ts` (`git show b4c0e95:src/brawl/draw.ts`, not committed). The overlay wiki page was updated for 0.4.0-rc.1.
The e2e debug checks follow `debugDefault`: off at start in a final version, on in dev or `-rc`; the harness then turns it on to reach test mode.

## Window and overlay look

The control window is frameless with an app-drawn 32 px strip (`TitleBar.tsx`, `-webkit-app-region: drag`; buttons `no-drag`, minimise/close over IPC), no menu bar. Size/position persist to `userData/window-state.json` (`electron/windowBounds.ts` validates; off-screen -> centred on the primary display; skipped under `BRAWL_E2E` and while test mode's temporary bounds are active). The identity (charcoal, teal `#2ec4b6`, warm off-white, <=4 px corners) lives once in `src/index.css` variables; `readTheme()` in `draw.ts` reads them for the canvas. The overlay draws a plate (tier letter + `Score: n`) above each card; hovering a plate shows `ScoreTip` (rows from `breakdownRows`, in `OverlayAdvice.rows`, summing to the score). The overlay stays click-through (`setIgnoreMouseEvents(true, {forward:true})`); hover is hit-tested in the overlay renderer and only while a draft shows. Under DPI scaling like 125 %, `getBounds` after `setBounds` differs by 1-2 px (rounding); the e2e allows that and checks for drift.

## Test mode

On a real desktop the dummy window opens at the left edge of the work area and the control window is resized to
fill the right side (`arrangeSideBySide`); closing test mode restores the control window's bounds. Under `BRAWL_E2E`
nothing is moved.

The control window's **Test mode (dummy Deadlock window)** button (`BrawlView.tsx`, state owned by
`startTestMode`/`stopTestMode` in `electron/main.ts`) opens a frameless dummy window titled exactly `Deadlock`,
sized 1920x1080 _physical_ px (the recogniser needs ~1080p to read the round/choice glyphs), showing one of
`public/demo/*.png`. The normal path runs against it; the **Screenshot** select switches the image live. A real Deadlock may stay
open: while test mode is on the game is the dummy, found by its own handle (`findTarget` in `main.ts`, the `only`
argument of `findGameWindow`), so the real game is never found, probed, captured or moved; turning test mode off
hands back to the real game. It closes only the window it opened. While on, the display-media handler serves only the dummy's own
`getMediaSourceId()` (desktopCapturer never lists the app's own windows, so it can't be found through the
source list) — nothing else can be captured. The old keyboard-shortcut demo and its tray entry no longer exist.

## Overlay behaviour (blank outside the draft)

- The overlay draws nothing, and its window is hidden (`syncOverlay` in `electron/main.ts`), unless the item draft
  screen is on the frame (`OverlayState.draft`) or the ability points panel (`OverlayState.panel`) is showing
  (`overlayHasContent`, `src/brawl/overlayContent.ts`). The panel is an HTML picture of the game's ability upgrade
  panel (`src/components/AbilityPanel.tsx`, data from `abilityPanelFor` in `src/brawl/abilities.ts`) for 15 s after
  the draft screen closes (`src/brawl/abilityPanelTimer.ts`, a pure state machine); a reopened draft ends it at once.
  It shows this round's standard points highlighted (Street Brawl gives 6/6/5/5/10 points in rounds 1-5; pills cost 1/2/5; `pillRounds` in `abilities.ts` follows the standard order, carries unspent points, and fills leftovers so all 32 are spent by round 5), earlier rounds' greyed with a check, later ones plain, with a "Round N: X points" title. Every ability starts unlocked in Street Brawl: there is no unlock advice anywhere.
- No yellow outline: Windows Graphics Capture draws one; `disable-features=AllowWgcWindowCapturer` (in
  `electron/main.ts` and both harnesses) falls back to Chromium's GDI window capturer, which has none. Keep that
  switch in all three places.
- `findGameWindow` caches the game's handle and only re-enumerates windows when it is gone; the cached path must
  still honour the `exclude` set (test mode's dummy is excluded by the poll that watches for a real game).
- Test mode's dummy is resized to 1920x1080 physical with `SetWindowPos` when the display is smaller (Electron
  clamps to the work area). Window capture still returns at most screen size, so on a display below ~1080p the
  recogniser cannot read the frame and the layout checks in `win:e2e` fail: run the harness on a >= 1080p desktop.

## Manual checks (the harness can't cover these)

Do these by hand on real Windows with a real Deadlock client at least once per release, since nothing
in `win:e2e`/`win:demo` drives the actual game:

- Start Deadlock in both **Borderless Windowed** and real **Fullscreen** (Video settings). The overlay
  must actually appear on top of the game in borderless; in true fullscreen exclusive mode it may not
  (this is a Windows/game limitation, not something the app can fix — confirm the app at least doesn't
  crash or mis-detect the window in that mode).
- Test mode on real Windows with no game open: press the button, confirm the dummy and overlay are visible and
  aligned at your display scaling, switch screenshots, turn it off. Close the overlay window and confirm no
  tray/menu entry or the test-mode button raises an error dialog.
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
- `scripts/win/frames/` holds the harness's hand-measured `labels.json` (boxes in px at the 2000x1125 frames
  `public/demo/choice1.png`/`choice2.png`) and two live frames in `live/`. The harness scales boxes by
  `capturedFrameW / 2000` before comparing against `window.__overlayDrawn`.
- Component tests (anything rendering React, e.g. `<BrawlView/>`) live under `src/components/__tests__/`
  and run in `jsdom` via `vite.config.ts`'s `test.environmentMatchGlobs`; the rest of the suite (`src/brawl`,
  `electron`, `scripts`) stays on the default Node environment. Don't add a global jsdom environment.
- `OverlayState` (`src/brawl/draw.ts`) is the full contract between the control window and the Electron
  overlay: card reads, the re-roll flag/rect, and the `advice` panel data (names, not ids — the overlay has
  no item/ability catalog). Extend it there, not with ad hoc IPC payloads.
- koffi callback params (e.g. `EnumWindows`) need a real prototype via `koffi.proto(...)`, not a bare
  `'void *'` — the latter silently enumerates zero windows instead of throwing (see `electron/gameWindow.ts`).
- Never pass `detached: true` to `child_process.spawn('powershell.exe', ...)` on Windows: the child exits at
  once (code 0, no side effects). Use a plain spawn and kill it explicitly.
- `electron-dist/main.js` is built as ESM (package.json has `"type": "module"`); load it from a CommonJS
  script with dynamic `import(pathToFileURL(...).href)`, not `require()`.
- `electron/preload.ts` must build to CommonJS (`electron-dist/preload.cjs`, forced via a Vite lib build in
  `vite.config.ts`): Electron's sandboxed preload loader rejects an ESM preload. `logPreloadErrors()` in
  `electron/main.ts` logs `preload.error`; the visible symptom is `window.brawlAPI` staying `undefined`.
- Under `BRAWL_E2E` the control window and the overlay run at opacity 0 and never take focus (`showInactive()`),
  and the dummy sits at `HWND_BOTTOM`, so a harness run never covers the person's other windows. Capture reads
  a window by handle regardless of z-order. A window with opacity < 1 is not offered to capture at all, so the
  dummy stays opaque; the harnesses disable `CalculateNativeWinOcclusion` so a covered window keeps rendering.
- The harness never screen-grabs the desktop (`CopyFromScreen` etc.); only the window titled "Deadlock" may be
  captured, including by diagnostic scripts.
- Window capture (WGC) captures a window's full bounds including title bar chrome; a framed window gives a
  non-16:9 frame and silently offsets every recogniser anchor. Test windows must be borderless.
- `e2e-main.cjs`'s `waitFor(fn, timeoutMs)` resolves on the first **truthy** return of `fn()`; do numeric
  threshold checks (`> N`) inside the callback. Its hard timeout is 40 s (`HARD_TIMEOUT_MS`); a hit cascades
  into spurious failures, so speed the harness up rather than raising it.
- `BrawlView.tsx` logs `capture.attempt` before every `getDisplayMedia` call and `capture.start` only after a
  successful attempt + `video.play()`. Count `capture.attempt` to observe denied attempts. `video.srcObject`/
  `videoWidth` are not a liveness signal: `stopCapture()` never clears `srcObject`.
- A closed capture target stops the video track without setting `denied`. `BrawlView.tsx` retries
  `startCapture()` every 2 s whenever a game rect is known and `capture === 'off'`, regardless of `denied`;
  don't gate that retry on `denied` (it once left capture dead after a window swap). `desktopCapturer` can
  also lag a newly found window by a moment.
- When a draft set counts as ready is decided by `src/brawl/draftGate.ts` (pure, stepped by the worker): the same
  three cards and the same ROUND/CHOICE labels must hold for 300 ms; the same cards under new labels (or labels
  going backwards) need 1.2 s; a set the player picked from (the pick shows up in the inventory grid; only readable
  at ~2000 px wide and up) is "spent" and never advised again. `FrameResult.live/picked/spent` carry this to the page,
  which drops its cards whenever `live` is false. The game swaps label, cards and grid a beat apart; the old
  two-frame accept advised old cards under the new label, half-swapped sets, and new cards under the stale label
  (`scripts/__tests__/worker-transitions.test.ts` replays those on real frames).
- The worker does no icon search on the cards any more (`squareReads` in `worker.ts`): the item is whatever the name lock says, and a slot whose name will not read becomes a grey `?` at 2.5 s. A changed name line under a lock is a hover (the hovered card grows and the game's tooltip, often with an item name in it, covers the next card's line): the lock and the advice stay. Only within 3 s of a re-roll (two name lines blank in one frame as the cards fade, or the re-roll count dropping; `rerollAt` in `worker.ts`) does a line that changes by more than 6 grid cells make the slot unsettled at once (`changed` on `GateFrame`) and a read of another item move the lock. Before the names land, the gate gets the set with a `?` per unread slot so the 300 ms settle runs alongside the OCR. The re-roll caption and the inventory grid are read on that provisional set too (the caption read carries over when the names fill it in), so the accept does not wait a frame for them; the same cards under new labels still wait the 1.2 s from the first frame that names them all (`cand.full`), so the grid can show the pick first. Before the accept, a name read that matches another slot's lock is the hover tooltip's title (a draft never offers one item twice): both slots are read again. Two ids under one name (Silencer has a disabled twin) keep only the first in `nameList`. `readDraftScreen`/`matchIcon` remain for the CLI, fixtures, inventory and hero reads (`matchIcon` tries a narrow search first). Older text below about icon guesses describes the icon-based design.
- Cards sit at fixed screen positions and print their exact item name: the worker pins every card read to
  `cardSquares` (`recognise.ts`, anchors x 0.95 icon edge, matches the hand-labelled circles) so the overlay never follows
  the icon search's step/scale wobble, and each slot's item comes from a **name lock** (`applyNames` in `worker.ts`): the
  item its name line (`cardNameCrop`, read by the name reader through `ocr.ts`, fuzzy match in `names.ts`) last read as, plus a pixel fingerprint
  of that line. While the line looks the same the slot is that item whatever the icon says; a changed line is re-read
  (~30 ms) and only a clear read of another item moves the lock; an icon that surely shows another item (re-roll) makes
  the slot unsettled at once. No set is accepted until every slot has its lock (`GateFrame.ready`), a shaky icon keeps
  its set out of the gate entirely, and after 1.5 s of failed reads the icon guess stands. The re-roll caption is also
  read before accept (and a later change needs two agreeing re-reads); the owned list reaches the page with the accepted
  set and not again while it stays up. Logs: `card.name` per read. `draftRegions` copies the name lines' ends as the last 6 boxes.
- Changing the Round/Choice selects clears the accepted cards, and the worker never re-sends a set it already
  accepted: set hero/round/choice before capture starts, or advice stays null for that frame.
- `drawReads` (`src/brawl/draw.ts`) returns the rects it stroked (`DrawnRect[]`, frame px, tagged
  `card`/`best`/`reroll`); `OverlayApp.tsx` stashes them on `window.__overlayDrawn` only when
  `window.brawlAPI.isE2E`.
- `__brawlE2E.forceReroll()` (`electron/main.ts`, e2e only) resends the last real, capture-derived
  `OverlayState` with `reroll:true`/`bestId:null` (never a fabricated state), for the `reroll-box` check.
- `win:demo` and `win:e2e`'s `testmode` case must wait for a real ranked-best signal (`.brawl-card.best` /
  `.overlay-panel` text with a card name), not for status text, which renders before the worker's two-frame
  accept resolves a pick.
- `webContents.capturePage()` flattens a transparent window to an opaque bitmap. To get the overlay with alpha,
  read its `<canvas>`'s `toDataURL('image/png')` via `executeJavaScript` (`captureTestComposite()` in
  `electron/main.ts`). Read drawn rects and panel scores in one call: two reads can straddle a state update.

## Detect now (F8) and the lobby status dot

- **Detect now** (F8 global hotkey, the `Detect now (F8)` button beside Start capture, tray entry) = `detectNow()` in
  `electron/main.ts`: clears the post-miss hold, forces `captureWanted`, and pushes `detect-run` to the control window,
  which treats the first worker result as the verdict (`runDetect`/`finishDetect` in `BrawlView.tsx`): draft -> normal
  path; not a draft -> status `No draft found`, capture off, `detect-miss` IPC (main holds capture off even in test
  mode/harness until the next press, window change or test-frame switch). Logs `detect.manual` (`hit|miss|failed`, ms).
  F8 is registered only while a game/dummy window exists (`electron/detectKey.ts`); a failed registration shows
  "F8 is in use by another program". e2e hooks: `__brawlE2E.detectNow()/forceCaptureOff()/getDot()/getF8()`.
- **Status dot**: drawn by the overlay (`drawDot` in `draw.ts`, `OverlayState.dot`, set by main, never by the control
  window) top-left, ~10 px at 1080p, 70 % opaque: teal watching / amber reading / grey capture failed. Shown per the
  pure state machine `src/brawl/lobbyDot.ts` (window found, no draft for 10 min or window lost/found = lobby; hidden
  while in a match or when Deadlock is not foreground; test mode/harness count as foreground). Hover line is
  `DOT_TEXT`; hit-tested in `OverlayApp.tsx`. `overlayHasContent` includes `dot`.
- Probe diagnostics: `draft.probe.miss` logs (on change only) `not-foreground` or `glyph-not-read`. A real miss cause
  found offline: at some widths (1312, 1600) a stray lit pixel from neighbouring UI stretched the CHOICE-1 glyph box;
  `readDigit` now retries ignoring one-pixel columns (`probe-scales.test.ts`).

## Performance design (keep the game fast)

- Capture is not on all session. `electron/main.ts` owns a capture state (`captureWanted`, `probeMode()`); the
  control window follows it via `getCaptureState`/`onCaptureState`. While the game is foreground and capture is
  off, main probes a tiny screen region (`electron/shopProbe.ts`, GDI `grabScreenRegion`) for the CHOICE glyph;
  a hit turns capture on. The renderer calls `captureIdle` after 4 s with no draft/tip. Probe mode is off under
  `BRAWL_E2E` and in test mode, so the harness never probes.
- Frames are region-only: `draftRegions` (`src/brawl/recognise.ts`) lists the rects the recogniser reads; the
  page copies just those and the worker pastes them into a reused buffer. `regions.test.ts` proves reads are
  identical to full frames. Do not reassign `canvas.width/height` per frame (reallocates); it cost ~100 ms.
- The worker persists across capture sessions (`reset`/`stop` messages); the name reader itself is warmed by main at app start (see Name reader).
- Timing (`src/perf.ts`, `process.metrics`) runs only in dev (`DEV_SERVER_URL` / `import.meta.env.DEV`).
- Speed (advice latency): matching uses summed-area tables (`integralOf`/`sampleFast` in `recognise.ts`, exact same
  reads as `sampleSquare`, ~2x faster); the worker is built and its icon index decoded when the app opens; the hero bar
  read (~0.7 s) is reused for the whole match while a pixel fingerprint of the bar still matches (`matchBar` in
  `worker.ts`); the control and dummy windows set `backgroundThrottling: false` so covered windows keep rendering.
  `scripts/__tests__/frame-reads.test.ts` pins the reads on the demo frames so speed work cannot change advice. The worker reads only the player's own portrait and the enemy four (`readLeanBar`; the three teammates come back as unread slots, and `enemiesFrom`/`selfHero` never use them), and hero correlation skips masked-out pixels (`nccMasked`, bit-identical). The page draws the video once per frame into one canvas and cuts the regions from it (each `drawImage` from the video costs ~10 ms whatever its size, so per-region draws were ~70 ms); it copies a draft frame only when the video has presented a new picture since the last copy (`requestVideoFrameCallback`, 150 ms fallback), and the worker asks for the next frame as soon as it starts reading one, so the two-frame check finds it waiting.
- Main lowers its own and child priority below normal (skipped under `BRAWL_E2E`).
- Not verified on real Windows: GDI probe with a real Deadlock (borderless and fullscreen). Check by hand.

## State machine and Order term

`src/brawl/brawlState.ts` is a pure Street Brawl state machine (round 1-5, choice 1-3, one re-roll, three card slots, owned
list, pick source `read|assumed|grid`); each transition is a named event with a test in `__tests__/brawlState.test.ts`.
`src/brawl/tracker.ts` runs it inside `worker.ts` as an **observer**: `draftGate.ts` still decides what is accepted and advised;
the machine counts reads per slot, re-rolls, resyncs and the pick source, which ride on `result` messages as `track` (`TrackOut`).
A standalone `track` message carries only `roundStart`. The page's worker listener exists only while capture is on, so the page
logs `round.start` itself in its `onRoundStart` handler (round banner probe in `electron/shopProbe.ts`, channel `roundStart`) and
`applyTrack` skips the worker's duplicate. The handler also posts `roundStart` to the worker, (`warmRead`).
`Resynced to round N choice M` is shown by `BrawlView`'s `resyncText` (5 s) ahead of `statusFor`; F8 forces it (`forceResync`).
e2e hooks: `__brawlE2E.roundStart(n)`; checks `round-start-warms-first`, `slots-read-once`, `f8-resync`, `frame-switch-resync`;
the advice limit is `ADVICE_LIMIT_MS` (1000) in `e2e-main.cjs`. `--slow 4` (processor affinity) does not yet meet it (about 2.7 s).
The Order term (`Order` row, `BRAWL_WEIGHTS.order`, `item_stats_by_order` in each hero's brawl json from
`npm run fetch-data -- --brawl-orders`) is **off by default**: set `BRAWL_ORDER_TERM=on` to use it (`npx tsx scripts/order-check.ts <hero id>`
measures ranking changes; Infernus is id 1: 0 of 9 drafts change). An order outside the stored set is fetched once in the app
(`electron/orderFetch.ts`, channel `orderStats`, cache `userData/order-stats/`, log `order.fetch`); offline gives no data.
The editor's default row shows the best blended order's matches and win rate; `Reset to default order` returns to it.
If `npm run check` fails with ENOTDIR on prettier, delete the stray file `node_modules/.cache/prettier`.

## Fast draft read (0.4.0 tracker)

- Provisional icon locks: `applyNames` gives a slot a lock from `quickGuess` (`recognise.ts`; fixed card square, no search, score >= 0.75, margin >= 0.1, no twin item) the moment its name line has ink. The advice goes out on that guess; OCR then confirms or overrules once `gate.live`. Settled frames skip card reads unless a lock is still provisional.
- A frame with two cards up gives `partialKey`, which starts the draft gate's 300 ms settle clock and pre-reads the hero bar and grid (`warmKey`), so the third card's frame accepts at once. `ready` stays false until all three locks exist, so no plate shows on a partial set.
- `stepTip` closes the ability panel's draft after `CLOSE_FRAMES`, or after `CLOSE_MIN_FRAMES` (3) frames spread over `CLOSE_MS` (1500), so a slow PC still closes it.
- `public/demo/_*.png` frames (e.g. `_choice1-two.png`, made by `scripts/make-landing-frame.ts`) are listed only under `BRAWL_E2E`; the harness uses them for the staged reveal.
- Harness at `--slow 4`: advice time starts before `setFrame`, the overlay is polled once during the hold, limits and timeouts scale by SLOW, and the panel expiry is measured with `pollAt`/`goneAt`.
- The ScoreTip shows `Order: no data` (no number) when the active ability order matches no stored order, whatever `BRAWL_ORDER_TERM` is.

## Video truth set (real gameplay, 1280x720)

`scripts/fixtures/video-truth/s0..s9/` are 10 stretches cut from one OBS recording (lossy webp crops, about 34 MB; frame time is `truth.video[0] + frameIndex/4`). Hand labels live in `scripts/video-truth/labels.json` (per set: items, `from`/`to` on screen, `readable` window, `covered` slots that a tooltip hides and may show `?`). `npx tsx scripts/video-truth.ts --truth-only` rewrites only the `truth.json` files from the labels; the full tool needs the source video. `npx tsx scripts/video-truth-report.ts` prints per-stretch violations and advice latency (about 3 min); `scripts/__tests__/video-truth.test.ts` fails on any. Rules in `scoreStretch` (`scripts/lib/videoTruth.ts`): R1 advised items equal a labelled set on screen; R2 a set readable 1 s or more is advised within 1.0 s (`ADVICE_BY`); R3 no advice drop-out while readable; R4 no advice when no set is on screen. Fix labels only when the video shows them wrong.
Worker rules found with it: a card circle with no content counts as empty (`cardEmpty`), two empty circles mean cards leaving or sliding in (advice dropped, no fallback); the fallback is 1.2 s when two names are OCR-confirmed and the third circle is full but unreadable (tooltip), else 2.5 s; a `?` set upgrades at once when the missing card reads.

Speed (advice at x4): a name read or caption read that lands before the set is accepted re-runs the last frame at once (`restep` in `worker.ts`, at most 3 per frame) instead of waiting for the next picture; the last card's clear icon stands on its first frame when the other two are name-confirmed. `replayDraft` waits for in-flight reads (`readsIdle`) each frame, so replays no longer depend on wall-clock OCR speed. `win:e2e -- --slow 4` is unusable as a measure while another job loads the host (load average above 10 gave 0.6 to 7 s for the same code).

## Name reader (Windows OCR)

- The three fixed text crops (card name line, loading-screen hero name, re-roll caption) are read by Windows.Media.Ocr in one
  hidden PowerShell child: `electron/nameReader.ts` spawns `electron/winocr-helper.ps1` (`windowsHide: true`, never
  `detached`; packaged next to the asar through `extraResources`), warms it with one dummy crop and logs `reader.ready`
  (start ms). Protocol: stdin line `<id> <w> <h> <base64 RGBA>`, stdout JSON line `{id, text, ms}`. One exit restarts it
  (`reader.exit`, `reader.restart`); a second exit or a failed start logs `reader.failed` and the reader stays down. No tesseract.js
  anywhere (`grep -ri tesseract package.json src electron` must stay empty).
- Path of a read: `ocr.ts` prepares the crop (pure JS: `prepareName` trims the line to its text run, pads 20 px and scales to
  > = 90 px tall; `prepareHero` as is; `prepareCaption` 4x) and hands it to the installed `TextReader`. In the app the worker
  > posts `ocr` to the page, the page calls `brawlAPI.readText` (channel `readText`), main asks the helper. Main pushes the reader's
  > state over `readerState` (`readerStateGet` on load); while it is failed (or off Windows) every read rejects with
  > `ReaderDownError`, the status line says `Name reader not running`, unread cards go grey `?`, the hero falls back to the
  > window/pinned hero and the caption digit uses `rerollGlyphIsOne` only. `readCardName`/`readHeroName`/`readRerollsRemaining` keep
  > their signatures; matching stays in `names.ts`/`matchHeroName`.
- Reader down in the worker: no icon guess and no name read, the reading clock restarts only for cards sliding in, and three
  full circles with no item get the `?` fallback at 2.5 s (`scripts/__tests__/reader-down.test.ts`, `replayDraft`'s
  `readerDown`). `win:e2e`'s `testmode` pass ends with `reader-down`: it kills the helper twice (`__brawlE2E.readerPid`)
  and expects state `failed`, the status line, three `unknown` plates on `choice2`, and no uncaught error.
- Node tools and tests: `scripts/lib/textReader.ts` (installed for vitest by `scripts/__tests__/setup-reader.ts`). `BRAWL_OCR`
  unset = recorded answers only from `scripts/fixtures/ocr-recorded/reads.json` (keyed by sha1 of kind, size and prepared
  pixels; a missing crop fails like a down reader); `record` = recordings first, the live helper through `powershell.exe` for
  the rest, new answers saved; `live` = always the helper, nothing saved (use it for `brawl:replay` on user sessions, whose crops
  are not recorded). Re-record after any change to a prepare function or a crop rect: `BRAWL_OCR=record npx vitest run` and
  `BRAWL_OCR=record npm run names:compare`. Any change to `prepareName` changes every key.
- Covered name lines (`coveredSlots` in `recognise.ts`): a hover tooltip panel sits beside the hovered card, left or right, over a
  neighbour's name line; the text then sits off centre in the line (`nameLineShape` within `textRun`, |off| >= `COVER_OFF` 0.3,
  ink >= 300). A covered line is not read and never changes the lock; a slot never seen uncovered gets the grey `?` after the
  normal fallback times and upgrades the moment it reads (a landed read re-runs the frame while the advised set has a `?`). A read
  equal to another slot's item is a tooltip title (both slots read again), and the `?` fallback waits up to 400 ms
  (`FALLBACK_READ_HOLD_MS`) for a read already on its way. Logs: `card.name` (`reader: 'winocr'`, `ms`, `score`),
  `card.name.unsure` (`no-item | empty | covered | reader-down`).
- Measure: `npm run names:compare -- --engine winocr|tesseract` writes `logs/name-compare-<engine>.json` (bar: 0 wrong, sure >= 95 %
  of uncovered labelled crops). `--engine tesseract` needs `npm i --no-save tesseract.js@7` for the run. Numbers and the unsure list
  are on the wiki page "Name reader". `scripts/__tests__/name-reads.test.ts` pins raw text and ids on the demo frames at three sizes,
  the loading frame and the caption fixtures (live too when `BRAWL_OCR=live`).
