# Deadlock Street Brawl Helper 🥊

<p align="center">
  <img alt="The Street Brawl advisor reading a live draft: three ranked cards with the enhanced Reactive Barrier marked TAKE" src="docs/brawl-overlay.png">
</p>

A draft advisor for [Deadlock](https://store.steampowered.com/app/1422450/Deadlock/)'s
Street Brawl mode. It reads the draft screen while you play, identifies the
three cards being offered, and ranks them. It also tells you whether
re-rolling is worth it. The advice shows up in a small window on top of the
game, or on your phone.

This was split out of [deadlock-optimal-build-finder](https://github.com/Gidntsquia/deadlock-optimal-build-finder),
which covers regular (non-Brawl) item builds.

## Quickstart 🚀

Requires Node 18+.

```
git clone https://github.com/Gidntsquia/deadlock-street-brawl-helper
cd deadlock-street-brawl-helper
npm install
npm run fetch-data   # Downloads heroes/items/abilities + Brawl analytics into public/data/.
npm run dev          # Open http://localhost:5173
```

Click **Capture game screen + overlay** and select the Deadlock window.
IMPORTANT: the game has to be in borderless windowed mode for the overlay to
show on top of it. If you want to use exclusive fullscreen, click **Phone
display** and scan the QR code with your phone instead.

Other commands:

```
npm run brawl -- --hero 1 --round 2 --owned "Extra Charge" --enemies "Lash,Seven" \
    --set "Improved Spirit,Enchanter's Emblem,Swift Striker"   # Draft advice without the screen reader
npm run icon-index    # Rebuild public/data/brawl-icons.json after fetching item images
```

## Features 🔬

- The cards, round number, enemy heroes, and the items you've already picked
  are all read from the screen. Nothing is sent to the game.
- The overlay works in Chrome and Edge. Firefox can't do always-on-top
  windows, so use the phone display there.
- No backend, everything runs in the browser.

## Documentation 📚

More background in the original project's wiki:

- [Street Brawl Advisor](https://github.com/Gidntsquia/deadlock-optimal-build-finder/wiki/Street-Brawl-Advisor) — card scoring, re-roll math, the CLI
- [Screen Reader](https://github.com/Gidntsquia/deadlock-optimal-build-finder/wiki/Screen-Reader) — how cards, round numbers, hero portraits and picks are recognized
- [Overlay and Phone Display](https://github.com/Gidntsquia/deadlock-optimal-build-finder/wiki/Overlay-and-Phone-Display) — screen capture, Picture-in-Picture, ntfy.sh

## License 📄

MIT — see [LICENSE](LICENSE).
