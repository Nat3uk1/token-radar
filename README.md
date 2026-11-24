# Launch Radar

An entry for make.fun's **Build the best token launch radar**
([token-radar-01](https://make.fun/bounties/token-radar-01)).

[![competition](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounties/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Nat3uk1/token-radar/rank.svg)](https://make.fun/bounties/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Nat3uk1/token-radar/reward.svg)](https://make.fun/bounties/token-radar-01)

It reads one sealed DefiLlama snapshot (758 protocols, as of 2026-11-14) and
ranks the protocols that record no token by what a launch would plausibly be
worth, with the evidence for the model printed on the page and a costed farm
plan for every row.

## The model (radar-3)

**Implied value = value if a token launches × token odds.** Both halves are
fitted on the snapshot and tested on data the fit never saw:

1. **Launch value** is a size curve, not a multiple: ln cap = 16.38 +
   0.365 (±0.12 bootstrap) × ln(TVL / $100M) plus a category effect shrunk
   toward the curve by 16 pseudo-observations, fitted on the 87 traded
   tokens with a usable cap and a listing date. Value per dollar of TVL
   falls as TVL grows, which is what the traded record shows.
2. **Terms are kept only if they earn it.** 7-day TVL growth, age and chain
   count were each added to the curve and tested two ways — leave-one-out
   and walk-forward (earlier listings price later ones). All three failed
   to lower the miss in both tests, so none is used. The final model's
   typical held-out miss is ×2.99 (leave-one-out) and ×2.62 (walk-forward),
   against ×4.48 / ×4.66 for a flat median multiple.
3. **Token odds** come from the peers' record: a logistic fit on the 645
   dated protocols (age, size, and their category's token share) gives the
   share recording a token by any age, and a row's odds are the share of
   the remainder that arrives within 24 months. Walk-forward Brier 0.204
   against 0.271 for the base rate alone. The odds are a record, not a
   forecast; the page never says a token will launch.
4. **Ranges, not points.** Every implied value carries the fit's
   leave-one-out spread as P25–P75 and P10–P90 bands. Measured back against
   the held-out caps, the bands hold 52% (stated 50%) and 82% (stated 80%)
   of the time, and ranks are shown as ranges across 200 bootstrap refits.

**Farm verdicts are costed.** Each row's plan is nine tagged steps with a
dollar cost and a time on every step. The verdict runs the arithmetic:
modelled drop (implied × 7% drop share × deposit ÷ (TVL + deposit)) less
the plan's fees and a 2%-a-year capital charge, against a $25-an-hour bar,
with the deposit sized per plan — the smallest, up to $25,000, that clears
it. At the default scenario 77 of 198 rows are FARM, 44 MARGINAL, 77 SKIP;
the biggest protocols mostly SKIP, because $25,000 buys too little of their
drop to pay for itself. The reader can move the drop share and horizon and
watch every verdict re-run.

**Everything is accounted for.** The dashboard's accounting strip places
all 758 protocols in exactly one group (198 ranked, 87 priced comparables,
329 token-recorded with no usable cap, 144 set aside as bridges, staking
wrappers, exchanges or versioned duplicates), and a self-check row
recomputes the board in the browser — row count, rank order, totals and a
checksum — against what `main.ts` wrote.

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
- `lib/model.ts` — the snapshot parser, the fitted launch and odds models
  with their held-out evaluation, the conformal bands, the farm-plan
  writer and the board builder.
- `dashboard/` — the offline dashboard: the board, the evidence and
  accounting panels, a traded-tokens view that prices each comparable
  blind, and a per-protocol detail with the value waterfall, the nearest
  priced peers and the verdict arithmetic.
- `screenshots/` — the board, a protocol detail, and the farm filter.
- `vendor/makefun-board.ts` — the kit's dossier builder, unmodified.

Nothing here is financial advice. A protocol records no token, which is
not proof it has none.
