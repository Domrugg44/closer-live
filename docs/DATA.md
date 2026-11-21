# Closer data sources and the historical odds decision

## Does Phase 3 need historical odds?

| Phase 3 step (docs/VALIDATION.md) | Needs past **results** | Needs past **odds** |
|---|---|---|
| Build the first model (e.g. Elo) | ✅ | ❌ |
| Gate A backtest: accuracy, calibration, beating B1 and B2 | ✅ | ❌ |
| Gate B forward test | ✅ (collected live) | ❌ |
| Value gate: closing line value vs the market | ✅ | ✅ (prices at prediction time and at close) |
| Optional market comparison in a backtest | ✅ | ✅ |

**Conclusion: Phase 3 doesn't need historical odds to reach "Validated (Forecast)".** Odds are needed
only for value claims, and those are judged on **forward** predictions, which our collector
already prices automatically at the moment each prediction is logged.

## Options compared

| | Free collection going forward (current) | One-time paid backfill |
|---|---|---|
| Cost | $0 | about $30 (one month of The Odds API 20K plan; historical lookups cost 10 credits per region per market) |
| What you get | Every NBA moneyline from 2026-11-21 onward, from about 9 US books, 4 or more snapshots per game day | NBA moneylines back to mid-2020 (featured markets), at the snapshot times we pick |
| Good for | Gate B, closing line value on forward picks, line movement | A market comparison in backtests before a model goes live |
| Limits | No history before 2026-11-21. "Closing line" means our last snapshot, which is up to about 30 minutes before tip-off, not the true final line. | Snapshot timing is approximate; money spent before we know a model is worth it |

## Recommendation (adopted pending CEO review)
1. **Keep free collection** (already running).
2. **Backfill past results for free.** balldontlie's free tier includes past seasons, so the collector now loads seasons 2021–2025 a few pages at a time (about 3 requests per 30-minute run, within the 5-per-minute limit). That's all Gate A needs.
3. **Don't buy the odds backfill now.** Reconsider it only if a model **passes Gate A**, and only if the CEO wants a backtested market comparison before the forward test. The purchase still needs CEO approval (docs/FINANCE.md).

## Sources in use

| Source | Data | License / terms | Notes |
|---|---|---|---|
| balldontlie (free) | NBA games, final scores, past seasons | Free tier; commercial terms to be reviewed before launch | 5 requests/minute |
| The Odds API (free Starter) | NBA moneylines from US books | Allows use inside apps and websites, including commercially; no resale or redistribution of the raw feed | 500 credits/month |
| ESPN public feed (website display only) | Live scores, box scores, DraftKings lines via ESPN | Unofficial, not licensed for commercial use | Must be replaced before the site makes money; never used for training |

## Known limitations
- The free "closing line" is our last snapshot at least 30 minutes before tip-off (the schedule runs every 30 minutes).
- History before 2026-11-21 has results only, no odds.
- No injury, lineup or player-availability data yet. That needs a licensed feed (a later phase, with budget approval).
