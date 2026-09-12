# Deadlock Street Brawl Helper 🥊

<p align="center">
  <img alt="The Street Brawl advisor reading a live draft: three ranked cards with the enhanced Reactive Barrier marked TAKE" src="docs/brawl-overlay.png">
</p>

A draft advisor for [Deadlock](https://store.steampowered.com/app/1422450/Deadlock/)'s
Street Brawl mode. It reads the draft screen while you play, identifies the
three cards being offered, and ranks them. It also tells you whether
re-rolling is worth it. The advice shows up in a small window on top of the
game.

## Quickstart 🚀

Step-by-step, no experience required.

1. **Install Node.js.** Go to [nodejs.org](https://nodejs.org), download the
   version marked "LTS", and install it like any other program.
2. **Open a terminal.**
   - Windows: press the Start key, type `Terminal`, press Enter.
   - Mac: press Cmd+Space, type `Terminal`, press Enter.
3. **Copy-paste these lines into the terminal one at a time**, pressing Enter
   after each and waiting for it to finish before the next one:
   ```
   git clone https://github.com/Gidntsquia/deadlock-street-brawl-helper
   cd deadlock-street-brawl-helper
   npm install
   npm run fetch-data
   npm run dev
   ```
   (`npm install` sets things up, `fetch-data` downloads the game's card
   data, and `dev` starts the app — leave this last one running.)
4. **Open your browser** and go to
   [http://localhost:5173](http://localhost:5173).
5. **Set Deadlock to borderless windowed mode.** In Deadlock's settings,
   under Video, set Display Mode to "Borderless Windowed". This is required
   — the overlay can't sit on top of the game in fullscreen mode.
6. **Click "Capture game screen + overlay"** in the app, then pick the
   Deadlock window from the list that pops up.
7. Play a Street Brawl draft — the advice window will appear on top of the
   game automatically.

Only works in Chrome or Edge (not Firefox — it can't do always-on-top
windows). To stop the app later, go back to the terminal and press Ctrl+C.

Other commands (optional, run from a terminal in the project folder):

```
npm run brawl -- --hero 1 --round 2 --owned "Extra Charge" --enemies "Lash,Seven" \
    --set "Improved Spirit,Enchanter's Emblem,Swift Striker"   # Draft advice without the screen reader
npm run icon-index    # Rebuild public/data/brawl-icons.json after fetching item images
```

## Features 🔬

- The cards, round number, enemy heroes, and the items you've already picked
  are all read from the screen. Nothing is sent to the game.
- The overlay works in Chrome and Edge. Firefox can't do always-on-top
  windows.
- No backend, everything runs in the browser.

### Street Brawl Tier List 🏆

The second tab grades every hero and every draftable item S, A, B or C from
the last 30 days of Street Brawl. The grade mixes two numbers, both shown
under each entry: win rate counts for 70% and usage counts for 30%. Items are
graded against the other items of their own draft tier, since the tier decides
which round a card can be offered in.

Rebuild that snapshot on its own with `npm run fetch-data -- --brawl-tierlist`
— one request plus a sum over the per-hero files already on disk, rather than
the full `--brawl` refresh.

## Documentation 📚

More background in [docs/street-brawl-plan.md](docs/street-brawl-plan.md) — Brawl's rules, the
card scoring and re-roll math, and how the screen reader identifies cards.

## License 📄

MIT — see [LICENSE](LICENSE).
