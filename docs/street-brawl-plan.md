# Street Brawl advisor: plan

## What Street Brawl is (as of 2026-09, from deadlock.wiki / tracklock / the API's `generic-data.street_brawl`)

* 4v4, 4 lanes, best of 5 rounds (`score_to_win: 3`), 3-minute rounds (4.5 min when "urgent"), no shop.
* Souls are fixed per round: 5600 / 7400 / 9400 / 11600 / 14000. Every player is on the same budget.
* Before each round there is a 50 s buy phase (6 s pre-buy in round 1) with **three draft sets of three items shown one after
  the other ("choice 1 of 3" … "3 of 3"); you pick one from each set**, so 3 items per round, 15 by game end. **One reroll per round** of a single set (random-hero queue gets an
  extra reroll in rounds 1-3).
* The draft escalates by round. Round 1 sets are tier 1 / 2 / 3 (`normal_mod_tier`), each with a chance to be bumped a tier
  ("rare", `rare_mod_tier`) and a chance to be **enhanced** (same item, better numbers). Per-round weights are in
  `item_draft_rounds_per_game_round`.
* **23 legendary items** (tier 5, cost 9999, `shopable: false`, e.g. Ancient Shield, Apex Combat, Shrink Ray) exist only here.
  They are already in `items.json` with icons, but the generator currently drops them as non-shopable.
* Offers are biased toward items that synergise with your hero and that counter the enemy heroes.

## What data exists

* `/v1/analytics/item-stats` and `item-permutation-stats` accept `game_mode=street_brawl`. Infernus, last 30 days:
  172 items with data, most-bought item 32k matches, 17 of the 23 legendaries with ≥ 200 matches. Enough for the current
  scoring function to transfer.
* `item-stats` also takes `enemy_hero_ids`, which gives "what wins against hero X" and is the counter term.
* Match metadata has no record of what was **offered**, only what was picked. Validation can only check agreement with
  top-player final item sets, not per-decision accuracy.
* No API exposes the live draft, so reading the screen is the only way to get the three offers automatically.

## Architecture: three independent layers

### 1. Data (`scripts/fetch-data.mjs`)
* Add `--game-mode street_brawl`: `analytics/brawl/<hero>.json` (item-stats, pair permutation-stats, plus item-stats
  per common enemy hero, top ~15 enemies). Same rank split (all / badge ≥ 90).
* Snapshot `generic-data.street_brawl` (round budgets, tier weights) to `brawl-config.json`.
* Stop filtering tier-5 items for the brawl catalog.

### 2. Decision engine (`src/brawl/`), pure and testable
`rankOffer({ hero, round, owned, enemies, offer: [a,b,c] }) → [{ item, score, why }]`, reusing `score(i)` from
`generator/build.ts` with these changes:
* Drop cost efficiency and buy-time terms (everything is free, order is fixed by round). Keep pop, shrunk win-lift, kit fit,
  active-item cap.
* **Synergy** with `owned` from brawl pair stats (already implemented for normal mode).
* **Counter**: win-lift of the item when `enemies` are on the other team, from the enemy-filtered item-stats.
* **Enhanced** flag: multiply the stat value by the enhanced factor (to be measured from screenshots; the API does not
  publish it).
* No per-slot caps in Brawl (confirmed in game); the 4-active-item cap still applies.
* **Reroll advice**: compare the best score in a set with the expected best-of-3 from the round's tier pool; recommend
  the reroll on the weakest set when the gap exceeds a threshold. One reroll per round, so recommend at most once.
* CLI: `npm run brawl -- --hero 1 --round 2 --owned "Extra Charge,Mystic Burst" --offer "Boundless Spirit,Titanic Magazine,Shrink Ray"`.
* Validation: agreement of the engine's greedy picks (simulated drafts from the tier pools) with high-badge final
  item sets in brawl games, same style as the existing held-out checks.

### 3. Screen reader (the new part)
Recommended: **in-browser, no new runtime**.
* `navigator.mediaDevices.getDisplayMedia()` on the PC that runs the game; sample a frame every ~400 ms onto a canvas.
* Detect the draft screen (fixed layout during the buy phase: 3 columns × 3 cards, timer). Locate the 9 card icons by
  anchoring on the layout at the user's resolution; store per-resolution anchors as a small table.
* Identify items by **icon template matching** against the 251 local item webp icons (perceptual hash + normalised
  cross-correlation on a 32×32 crop). No OCR needed for identity. Enhanced / rare badge detected by colour of the card
  frame; tesseract.js OCR only as a fallback on the item name.
* Hero: chosen in the app (one tap). Enemies: OCR the scoreboard once at round 1, or manual entry of four heroes.
* Output: Document Picture-in-Picture window (always-on-top) showing the three sets with the recommended card highlighted
  and a one-line reason; also a manual mode where the user taps the three icons if capture fails.
* Note: this reads pixels only and never sends input to the game, so it is in the same category as a stream overlay.

Alternative if the browser path proves too slow or brittle: a small Windows-side Python helper (mss + OpenCV) pushing
detected item ids over a local websocket to the app. Keep the engine identical so the swap is only the capture layer.
WSL2 cannot capture the Windows desktop, so any helper must run on Windows.

## Phases

| # | Deliverable | Depends on |
|---|---|---|
| 0 | 8-10 screenshots of the draft screen at your resolution (include enhanced, rare, legendary, and the scoreboard) | you |
| 1 | Brawl analytics fetch + `brawl-config.json` | nothing |
| 2 | `src/brawl/` engine + CLI + verify checks | 1 |
| 3 | Icon recogniser tested offline against the phase-0 screenshots (fixture test, target ≥ 95 % of 9 cards per frame) | 0 |
| 4 | Brawl tab in the app: hero pick, capture start, PiP overlay, manual fallback | 2, 3 |
| 5 | Enemy counters + reroll advice + validation numbers in README | 4 |

## Status (2026-09-05)
* Recogniser runs in a Web Worker with coarse-to-fine matching (~250 ms per frame instead of ~2.7 s on the main thread). Picks and the owned list are read from the inventory grid on the draft screen; the overlay opens with the capture.
* Phone display: the Brawl tab publishes the advice to a random topic on ntfy.sh and `public/phone.html` subscribes to it, so Deadlock can run in exclusive fullscreen where no overlay can show. Pairing is a QR code or an 8-letter code; no local server or port forwarding (the earlier WSL2 relay needed both and was too hard to set up).
* Phases 1-4 built: data, engine + CLI, recogniser (27/27 fixture cards, 87/90 screen labels at 2560×1440), Brawl
  tab with capture and Document-PiP overlay. The capture syncs round, choice and the enemy team (hero portraits
  matched against card art; the side with the selected hero is the player's). Not read from the screen: rerolls
  remaining (set by hand; decremented by the Re-rolled button). Round 5's digit template is hand-drawn.
* Held-out (user's Infernus games, 201 picks so far): engine 70 %, popularity-only 71 %, random 50 %. The engine's
  kit-fit / active terms mostly penalise the user's active and mobility picks (Silencer, Inhibitor, Stamina Mastery,
  Lightning Scroll); not retuned on one player's games.
* The enhanced multiplier (×1.25 on stat value) is still a guess; the API publishes no enhanced numbers.
* Resolution: anchors measured at 2560×1440 (100 % UI scale); other 16:9 sizes are scaled, untested.
* Whether Brawl keeps the 4-per-slot and active-item caps.
* The enhanced-item stat multiplier (measure from tooltips in the screenshots).
