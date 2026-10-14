#!/bin/sh
# The engine's explanation for the three labelled calls (s2 d006 must take enhanced Transcendent Cooldown, s2 d007 must
# re-roll, s7 d023 must take Burst Fire).
npm run -s brawl -- --hero 1 --round 5 --owned "Counterspell" --enemies "Viscous" --set "Ricochet, Healing Tempo, Transcendent Cooldown+" --explain
npm run -s brawl -- --hero 1 --round 5 --owned "Counterspell" --enemies "Viscous" --set "Lightning Scroll, Ricochet+, Runed Gauntlets" --explain
npm run -s brawl -- --hero 1 --round 2 --owned "Inhibitor,Toxic Bullets" --enemies "Mirage,Lash,Rat King" --set "Burst Fire, Alchemical Fire, Rapid Recharge" --explain
