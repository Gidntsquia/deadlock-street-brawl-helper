# Deadlock Street Brawl Helper 🥊

<p align="center">
  <img alt="The draft advisor ranking the three cards of a Street Brawl set, with an enhanced Reactive Barrier marked TAKE" src="docs/brawl-overlay.png">
</p>

A draft advisor for [Deadlock](https://store.steampowered.com/app/1422450/Deadlock/)'s Street Brawl
mode. It reads the draft screen while you play, ranks the three cards you're offered, and says whether
the set is worth a re-roll. The advice shows up in a small window on top of the game. Scores are built
from 30 days of Street Brawl matches from [deadlock-api.com](https://deadlock-api.com).

There is also a Windows app that finds the Deadlock window on its own and draws the advice directly
over the draft screen, with no picker and no window to place.

## Quickstart 🚀

Requires [Node.js](https://nodejs.org) 20 or newer, and Chrome or Edge. The match data is already in
the repo and refreshes weekly.

```
git clone https://github.com/Gidntsquia/deadlock-street-brawl-helper
cd deadlock-street-brawl-helper
npm install
npm run dev   # Open http://localhost:5173 and leave this running
```

Then, with Deadlock open:

1. In Deadlock's settings, under Video, set Display Mode to **Borderless Windowed**.
2. In the app, click **Capture game screen + overlay** and pick the Deadlock window from the list.
3. Play a Street Brawl draft. The advice window follows the draft.

IMPORTANT: Firefox can't open always-on-top windows, so this only works in Chrome or Edge.

Other commands:

```
npm run brawl -- --hero 1 --round 2 --set "Improved Spirit,Enchanter's Emblem,Swift Striker"   # Advice without the screen reader
npm run fetch-data                 # Refresh the 30-day snapshot (~1400 requests, ~9 min)
npm run brawl:see -- --fixtures    # Card recogniser accuracy on the saved screenshots
npm run dist                       # Build the Windows app (run on Windows)
npm run win:dev                    # From WSL: run the Windows app from a synced copy
```

## Features 🔬

- The three cards, the round, the enemy team, and the items you've already picked are read from the
  screen. Nothing is sent to the game.
- Cards are ranked for your hero using how often each item is picked in Street Brawl, its win rate, and
  how well it scales that hero's abilities.
- Your hero is detected from the scoreboard and can be changed by hand.
- The enemy heroes on the scoreboard shift the ranking toward items that do well against them.
- Re-roll advice compares the best card on screen with what a fresh set is expected to offer, and the
  box moves to the Use Re-Roll button when a re-roll is the better call.
- The legendary items that only appear in Street Brawl are ranked with everything else.
- An ability upgrade order for your hero, with the step you're probably on highlighted. In the Windows
  app a picture of the ability points panel shows this round's points for about 15 seconds after the
  draft closes.
- A second tab grades every hero and every draftable item S, A, B or C.
- If the capture misses a card, you can enter the three yourself.
- A test mode in the Windows app opens a dummy Deadlock window with a real draft screenshot, so you can
  try the overlay without the game running.
- There is no backend. Your hero, tab, round and enemy picks are stored in the browser only.

## Documentation 📚

More details in the
[wiki](https://github.com/Gidntsquia/deadlock-street-brawl-helper/wiki):

- [Street Brawl Advisor](https://github.com/Gidntsquia/deadlock-street-brawl-helper/wiki/Street-Brawl-Advisor) — the mode's rules, card scoring, re-roll maths
- [Screen Reader](https://github.com/Gidntsquia/deadlock-street-brawl-helper/wiki/Screen-Reader) — how cards, tiers, labels and your picks are recognised
- [Overlay](https://github.com/Gidntsquia/deadlock-street-brawl-helper/wiki/Overlay) — screen capture and the always-on-top window
- [Windows App](https://github.com/Gidntsquia/deadlock-street-brawl-helper/wiki/Windows-App) — the packaged app, test mode, developing from WSL
- [Tier List](https://github.com/Gidntsquia/deadlock-street-brawl-helper/wiki/Tier-List) — how the S/A/B/C grades are worked out
- [Data Pipeline](https://github.com/Gidntsquia/deadlock-street-brawl-helper/wiki/Data-Pipeline) — what `fetch-data` downloads, and the 30-day window
- [Development](https://github.com/Gidntsquia/deadlock-street-brawl-helper/wiki/Development) — code layout, scripts, checks

## License 📄

[MIT](LICENSE). Match data and item art come from [deadlock-api.com](https://deadlock-api.com);
Deadlock is Valve's.
