# token-radar-01-s2

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/bayyubenjamin/token-radar-01-s2/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/bayyubenjamin/token-radar-01-s2/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token launch radar, round 2: every value term fitted and tested blind twice.

- Board of 200 pre-token protocols (40 watchlist + 160 below the floor),
  ranked by a fitted implied value.
- Value model: implied = exp(a + b·ln TVL) × growth × maturity × odds.
  The comps curve is refit at runtime from the snapshot's traded protocols;
  odds is the fitted listing hazard by age (0.467 / 0.245 / 0.123 / 0.084).
- Every value term is tested blind twice: held-out comps fitted 2.05 vs
  flat 2.22 (5/5 seeds, recomputed in-page) and an independent Python
  cross-check (4/5); walk-forward 3/3 cutoffs; LOO fitted 2.11 vs flat
  2.28. Growth + maturity add no predictive gain on held-out comps and
  are kept bounded as ranking priors.
- Farm verdicts are costed: FARM 55 / THIN 94 / SKIP 51.

Run: `mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>`
