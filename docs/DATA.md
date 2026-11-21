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

## Automated data quality checks (M1)

They run every 30 minutes with the collector. Results are at `https://closer-data.closer-data.workers.dev/quality`, and every
status change is logged permanently. Failures are added to the daily alert email.

| Check | Severity | Catches |
|---|---|---|
| `result_overdue` | fail | game started more than 5 h ago (last 7 days) with no final score, and not postponed or canceled |
| `status_stuck` | warn | still "scheduled" more than 45 min after start |
| `postponed_or_canceled` | warn | postponed, canceled, suspended, delayed or abandoned games within ±3 days |
| `score_implausible` | fail | NBA tie, or a score under 50 or over 200 |
| `duplicate_games` | fail | two records for the same matchup within 3 h |
| `odds_missing_or_stale` | warn | game within 3 h whose newest odds are missing or more than 7 h old |
| `odds_unmatched` | warn | odds events that couldn't be matched to a game |
| `odds_price_implausible` | warn | prices that aren't valid American odds |
| `collector_heartbeat` | fail | no successful refresh in 75 min |
| `history_incomplete` | warn | a backfilled season with fewer than 1,230 regular-season results |
| `start_moved_after_prediction` | warn | a game rescheduled to start at or before a live prediction's time |

**Prediction safeguard:** a live prediction is refused unless the game is `scheduled`, was confirmed by the
collector within the last 90 minutes, the collector heartbeat is healthy, and the game isn't part of a duplicate.

## Derived game context (M2)

The `game_team_context` view gives one row per team per game. Every value comes from **earlier scheduled games only** (their times and places are known in advance), never from results, so it's safe to use at prediction time.

| Field | Meaning |
|---|---|
| `rest_days` | whole days off since the team's previous game (US Eastern dates); 0 = back-to-back |
| `back_to_back` | 1 if the previous game was the day before |
| `first_game_of_season` | 1 if there's no earlier game this season |
| `games_last_7d` | games in the 7 days before this one |
| `travel_km` | great-circle distance from the previous game's arena to this one |
| `tz_shift_hours` | time-zone change since the previous game (+ = moved east) |

Arenas (`venues`) are public facts with date ranges (the Clippers moved to Intuit Dome on 2024-08-15).
**Verification:** `qc/check_context.py` recomputes everything independently in Python. The first run had **0 mismatches across 850 team-games**, and the nightly QC repeats it for the current season.
**Limitation:** a game's venue is the home team's arena; neutral sites (international games, NBA Cup finals) aren't flagged yet.

## Known limitations
- The free "closing line" is our last snapshot at least 30 minutes before tip-off (the schedule runs every 30 minutes).
- History before 2026-11-21 has results only, no odds.
- No injury, lineup or player-availability data yet. That needs a licensed feed (a later phase, with budget approval).
