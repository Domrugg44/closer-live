# Closer data collector

A small Cloudflare Worker + D1 database that sits next to the GitHub Pages site and quietly builds
the history a prediction model will need. Version 1 collects **NBA games, moneyline price history
from US sportsbooks, and final scores**. It does not predict anything.

## What it does

| Schedule | Job |
|---|---|
| Every 30 minutes | Refresh yesterday's, today's and tomorrow's NBA games and final scores (balldontlie). Then, only if one is due, take a moneyline snapshot (The Odds API). |
| Daily, 10:15 UTC | Re-read the last three days so late final scores are captured. |

**When an odds snapshot is due:** once each morning (from 10 am ET) and when any game reaches 6 h,
2 h or 30 min before tip-off. One call returns every NBA game, so this is about 4 to 12 credits a day.

**Budget guard:** at most 12 odds calls in any 24 hours (`ODDS_DAILY_MAX`), and it stops when fewer
than 25 credits remain (`ODDS_MIN_REMAINING`). Every call's credit use is recorded in `ingestion_runs`.
The Odds API free tier is 500 credits a month.

**History can't be edited:** the database refuses updates and deletes on `odds_snapshots` and
`game_results`. A price row is only added when a sportsbook's price actually changes.

**Read-only data for the website** (allowed only from `https://domrugg44.github.io`):
- `/health`: row counts and the last 20 collector runs
- `/nba/games?date=YYYY-MM-DD`: that day's games, final scores, and how many prices we hold
- `/nba/odds?game_id=N`: every saved moneyline price for a game, oldest first

## One-time setup

You do steps 1, 2 and 4 yourself, because they involve your accounts and keys. Never paste API keys into chat or code.

1. **Create three free accounts** (no card needed on these free tiers):
   - Cloudflare: https://dash.cloudflare.com/sign-up
   - The Odds API (Starter, free): https://the-odds-api.com
   - balldontlie (Free): https://app.balldontlie.io
2. **Log Wrangler into Cloudflare.** In a terminal in this `backend` folder run `npx wrangler login`, then approve in the browser.
3. **Create the database:** `npx wrangler d1 create closer-data`. Copy the `database_id` it prints into `wrangler.toml`, then run `npm run db:remote`.
4. **Add the keys as secrets.** Each command asks for the key with hidden typing:
   - `npx wrangler secret put ODDS_API_KEY`
   - `npx wrangler secret put BDL_API_KEY`
5. **Deploy:** `npm run deploy`. Then open `https://closer-data.<your-subdomain>.workers.dev/health`.

## Local testing (no accounts needed)

```
npm install
npm run db:local
npm run dev
```

`npm run dev` runs with `MOCK=1`: fictional teams ("Testville Testers", "Mockton Mocks",
"LA Placeholders") and fake prices, never real data. To fire a scheduled job by hand, open
`http://127.0.0.1:8787/__scheduled?cron=*/30+*+*+*+*`. `MOCK` is `0` in `wrangler.toml`, so test
data can't reach the real database.

## Data sources and terms
- **The Odds API** allows showing its data in apps and websites, including commercially, but not reselling or redistributing the raw feed. We store prices for our own analysis and show derived views.
- **balldontlie**: check its terms before any commercial launch.
