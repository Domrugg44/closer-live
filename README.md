# Closer Live

Picks, props, a parlay slip and a live game feed (scores, stats, lines and injuries) in one page.

- **Site:** published by GitHub Pages from the `main` branch. `index.html` is the dashboard (main page); `classic.html` is the original app (picks, games, props, slip, record); `dashboard.html` redirects to the main page. Every push updates it within a minute or two.
- **Live data:** the page reads ESPN's public scoreboard and game summary feeds directly in the browser. Leagues with a game in progress refresh every 15 seconds; others every minute.
- **Picks and props:** stored in the `picks`, `props` and `ledger` arrays near the top of the script in `index.html`.
- **Prediction log (`data/record.json`):** append-only record of every prediction. Locked fields (game, market, line, odds at pick, timestamp, source, rating, note) are covered by a SHA-256 hash chain; only result fields are filled in later.
  - Sources: `manual` (hand-picked, no probability), `experimental` (untested model), `validated` (published backtest; none yet). Only `validated` entries may carry a probability.
  - Picks logged after their game started are flagged `loggedAfterStart` and excluded from verified stats.
  - Win rate and ROI show only after 100 graded picks (ROI counts only picks with recorded odds); closing line value after 50.
  - Add a pick: `powershell -File tools/add-pick.ps1 -League NFL -Game "MIA @ BUF" -EventId 401873070 -Start 2026-11-22T18:00Z -Kind spread -Team BUF -Line -16.5 -Odds -107 -Label "BUF -16.5"`
  - Check integrity: `powershell -File tools/verify-log.ps1 -BaseRef HEAD~1`. GitHub runs this on every change (`.github/workflows/verify-log.yml`), and the website re-checks the chain in each visitor's browser.
- **`tools/closer-feed.ps1`:** builds the saved game feed used by the Claude artifact version of the app. The website doesn't need it.

Model outputs, not guarantees. 21+ and in a legal state only. Gambling problem? Call 1-800-GAMBLER.
