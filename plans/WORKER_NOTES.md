# Worker notes

Launch: `npm run win:dev` from WSL, press **Test mode**, pick a screenshot (draft-r1c2, draft-r2c1, then `gameplay` for the ability panel).

## Acceptance
- Round 1 panel highlights 6 points' worth of pills; round 2 shows round 1's as bought + 6 new: MET in code/tests (`abilityPanel.test.ts`) and in e2e `ability-panel-appears` (overlay pills == control-window pills, 4 pills = 6 points on demo hero). Not looked at by eye by me.
- No UNLOCK badge/unlock state anywhere (overlay panel, control window, order list): MET (removed from `AbilityPanel.tsx`, CSS, `stepsFor`).
- Panel names the round's points ("Round N: X points", 6/6/5/5/10): MET in code; not looked at by eye.
- Points per round, Infernus (highlighted pills, cost sum): R1 Napalm T1+T2, Afterburn T1+T2 = 6; R2 Flame Dash T1, Afterburn T3 = 6; R3 Napalm T3 = 5; R4 Flame Dash T2, Concussive T1+T2 = 5; R5 Flame Dash T3, Concussive T3 = 10. Total 32, no overspend. Rule (`pillRounds`): follow the standard order strictly, a pill that doesn't fit waits (points carry over), leftovers after the order ends go tier 1s, then 2s, then 3s in bar order.
- Look, 15 s, control window agrees: unchanged apart from removing the badge and adding the title line.
- Advice within ~0.5 s: MET in the harness for frame switches (252-476 ms, mean ~333, latest full run; earlier this round 549-691). Cold first draft of a match not measured separately (see below); visible-session numbers not measured.
- Visible-session latency table (req. 8): NOT DONE. I only measured with the harness (`win:e2e`, invisible, BRAWL_E2E), so it is not the visible-session number the spec asks for.
- Advice picks/scores unchanged: MET (no recogniser/engine change; `npm run check` incl. frame-reads test passes; e2e boxes/scores checks pass).
- Tier List, Ability order list etc. still there: MET (nothing removed).
- Real match: not tested.

## Latency (harness, invisible BRAWL_E2E run of `win:e2e`, ms from the frame switch to the overlay showing the new cards)
Five switches, before -> after: 549/561/562/622/691 -> 476/377/304/253/252 (a second run of the same code: 683/560/498/248/438 and 687/313/515/376/448). Method: `switch-5x` in `scripts/win/e2e-main.cjs` polls the overlay every 50 ms after `setFrame`.
What changed (advice identical: 27/27 fixtures, frame-reads test, all e2e checks pass): (1) one video draw per frame instead of seven (each `drawImage` from video was ~10 ms, copy 72 -> ~20 ms); (2) the page waits for a new video frame instead of a fixed 120 ms pause, and the worker requests the next frame when it starts reading (two-frame check finds it waiting); (3) hero bar reads only the 5 slots advice uses and skips masked pixels (Node: 350-490 -> 120-230 ms on the demo frames, same self hero and enemies on all 5 frames).
Not measured: a cold first draft of a match (the harness's `advice-choice1` timing starts after the dummy already showed choice1, so it is not a cold read), and any visible session with the window on screen. Estimate only: cards ~150 ms + bar ~150 ms + pipeline. One full run this round failed `testmode-off` (`overlayVisible=true`) and passed on two reruns of `--only testmode` and on the next full run; cause not found.
