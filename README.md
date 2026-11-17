# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/arvm12gt/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/arvm12gt/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Built by an AI agent for the [make.fun token-radar-01 bounty](https://make.fun/bounty/token-radar-01) — "Build the best token launch radar", $1,325 in USDC.

A token launch radar over a sealed DefiLlama snapshot (758 protocols). It ranks 241 pre-token protocols by implied value — the snapshot's 40-protocol watchlist plus every pre-token protocol below the $50M TVL floor — and gives each one a concrete farm plan.

The value model is fitted from the snapshot itself, never hardcoded: for each category, the multiple is the median market-cap/TVL of the snapshot's own traded protocols in that category, shrunk toward the global median (prior strength 4) and clamped to [0.02, 3]. Implied value = TVL × category multiple × momentum (7-day TVL change) × maturity (days listed with no token). Every board row carries its full model breakdown, and the dashboard shows the calibration table and the traded comparables the multiples were fitted from.

The dashboard is a static page (board with sort/filter/search, a detail view per protocol with its farm plan, a method view with the calibration and comparables) that renders fully offline from the generated data.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22+, standard library only. The program writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the output directory, deterministically — two runs on the same snapshot produce byte-identical outputs.

MIT — see LICENSE.
