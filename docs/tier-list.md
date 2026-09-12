# Street Brawl tier list

The app's second tab grades every hero and every draftable item S, A, B or C from the last 30 days of
Street Brawl. The code is `src/brawl/tierlist.ts`, reading
`public/data/analytics/brawl/tier-list.json`.

## How a grade is worked out

Each subject has two numbers, both shown under its entry in the app:

* **Win rate** — wins over matches, pulled toward the population win rate by a 500-match prior. Every
  row in the snapshot has thousands of games, so the prior changes nothing today; it keeps a thin
  sample from grading S off a lucky streak.
* **Usage** — the share of hero-games the subject appeared in. Usage spans an order of magnitude
  between the most and least drafted, so the log of it is what gets standardised.

Both are turned into standard scores across the population and mixed, win rate at 70% and usage at
30%. Win rate is the outcome and carries most of the weight. Usage is what the population thinks,
which catches subjects whose win rate is flattered or punished by who plays them.

The mix is standardised once more and cut into grades at 1.15 (S), 0.35 (A) and -0.6 (B); everything
below that is C. Over a roughly normal population those cuts land about 13% S, 25% A and 35% B.

Heroes are graded against the rest of the roster. Items are graded against the other items of their
own draft tier, since the tier decides which round a card can be offered in.

## Rebuilding the snapshot

`npm run fetch-data -- --brawl-tierlist` rebuilds `analytics/brawl/tier-list.json` on its own: one
hero-stats request plus a sum over the per-hero files already on disk, instead of the ~1400 requests
a full `--brawl` run costs.

The rebuild reuses the window those per-hero files were fetched with, so usage stays the share of the
same games the item counts came from. To move the window forward, run the full `npm run fetch-data`.
