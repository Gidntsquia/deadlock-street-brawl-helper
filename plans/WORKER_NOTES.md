# Worker notes

Launch: `npm run win:dev` from WSL, press **Test mode**, pick a screenshot (draft-r1c2, draft-r2c1, then `gameplay` for the ability panel).

## Acceptance
- Round 1 panel highlights 6 points' worth of pills; round 2 shows round 1's as bought + 6 new: MET in code/tests (`abilityPanel.test.ts`) and in e2e `ability-panel-appears` (overlay pills == control-window pills, 4 pills = 6 points on demo hero). Not looked at by eye by me.
- No UNLOCK badge/unlock state anywhere (overlay panel, control window, order list): MET (removed from `AbilityPanel.tsx`, CSS, `stepsFor`).
- Panel names the round's points ("Round N: X points", 6/6/5/5/10): MET in code; not looked at by eye.
- Points per round, Infernus (highlighted pills, cost sum): R1 Napalm T1+T2, Afterburn T1+T2 = 6; R2 Flame Dash T1, Afterburn T3 = 6; R3 Napalm T3 = 5; R4 Flame Dash T2, Concussive T1+T2 = 5; R5 Flame Dash T3, Concussive T3 = 10. Total 32, no overspend. Rule (`pillRounds`): follow the standard order strictly, a pill that doesn't fit waits (points carry over), leftovers after the order ends go tier 1s, then 2s, then 3s in bar order.
- Look, 15 s, control window agrees: unchanged apart from removing the badge and adding the title line.
- Advice within ~0.5 s: NOT MET. Best measured 549-691 ms on switches, 632-813 ms first draft (see below).
- Visible-session latency table (req. 8): NOT DONE. I only measured with the harness (`win:e2e`, invisible, BRAWL_E2E), so it is not the visible-session number the spec asks for.
- Advice picks/scores unchanged: MET (no recogniser/engine change; `npm run check` incl. frame-reads test passes; e2e boxes/scores checks pass).
- Tier List, Ability order list etc. still there: MET (nothing removed).
- Real match: not tested.

## Latency (harness, ms; previous round in brackets)
first draft 632-813 [863]; switches 549/561/562/622/691 [722/609/701/632/698]. One of three e2e runs this session failed `switch-5x` (two choice1 switches timed out at 2 s) — the known capture-timing flake.
Where the time goes (measured on the demo frames in Node): first draft of a match: hero bar read ~700 ms + cards ~200 ms. Later switches (bar reused via fingerprint): cards 170-250 ms, everything else (meta, inventory) 1-2 ms; the rest is capture/frame-copy/IPC/render pipeline. Tried shrinking the hero-bar shortlist (8 -> 3/5/6) to halve the bar read: it misread slots on draft-r1c2 (0 hero ids) even at 5, so reverted; accuracy kept. Getting the first draft under 0.5 s needs a faster hero-bar matcher (e.g. exact-preserving pruning), not done.
