# Token Launch Radar

An entry for make.fun's **Build the best token launch radar**
([token-radar-01](https://make.fun/bounties/token-radar-01)).

![competition](https://make.fun/badge/token-radar-01.svg)
![rank](https://make.fun/badge/token-radar-01/Nat3uk1/token-radar/rank.svg)
![reward](https://make.fun/badge/token-radar-01/Nat3uk1/token-radar/reward.svg)

It reads one sealed DefiLlama snapshot (758 protocols, as of 2026-11-14) and
ranks the protocols that have **no token on record** by the market value a
launch would plausibly carry, with a concrete farm plan for each and an
offline dashboard to work the board.

## The model

Implied value is learned from the snapshot itself, not asserted:

1. **Category multiples.** Protocols that already have tokens give observed
   market-cap/TVL ratios. Each category's multiple is the geometric median of
   its ratios, shrunk toward the snapshot-wide multiple by sample size
   (weight 5), so a category priced off one or two names cannot dominate the
   board. Multiples are clipped to [0.02, 3.0].
2. **Adjustments**, each argued from the snapshot's own fields: 7-day TVL
   growth (factor 0.85–1.30), age since the protocol was first listed
   (0.78–1.18; a young protocol has had less time to be priced), and chain
   reach (+3% per extra chain, capped at ten).
3. **Product exclusions.** A board row must be a protocol a token could be
   farmed on, so wrapped and canonical bridge products, staked and restaked
   wrappers, centralised exchanges and versioned duplicates are excluded
   before ranking. All 40 watchlist protocols are rankable under these rules
   and appear on the board.

The result is 198 rows. The 36 largest tokenised protocols are shown beside
the board with their actual market caps and observed multiples, so the
reader can check the model's prices against the market's.

Every row carries six farm steps written for that protocol: the wallet and
chain it needs, a first position sized to its TVL tier, a second distinct
position, a weekly cadence shaped by its category and this week's growth, a
hold period matched to its age, and an exit step that says how that kind of
position actually unwinds. Every step states a cost and a time.

## Running it

```
node main.ts                      # reads /input, writes /output
node main.ts --input snapshot.json --output out
MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node 22, standard library only, no network. The run is deterministic: the
same snapshot produces byte-identical output. It writes `board.json`,
`data.js` (the dashboard's data), copies of `dashboard/` and `screenshots/`,
and `dossier.json` built with the kit's `buildDossier`.

## Layout

- `main.ts` — the program: input, validation, output, dossier.
- `lib/model.ts` — the snapshot parser, the valuation model, the board
  builder, the farm-plan writer, and the live-token comparison rows.
- `dashboard/` — the offline dashboard (board, live tokens, model panel,
  per-protocol detail with the factor-by-factor breakdown).
- `screenshots/` — the board, a protocol detail, and a filtered view.
- `vendor/makefun-board.ts` — the kit's dossier builder, unmodified.

Nothing here is financial advice. Records say a protocol has no token on
record; a record is not proof none exists.
