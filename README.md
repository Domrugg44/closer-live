# Closer Live

Picks, props, a parlay slip and a live game feed (scores, stats, lines and injuries) in one page.

- **Site:** published by GitHub Pages from `index.html` on the `main` branch. Every push updates it within a minute or two.
- **Live data:** the page reads ESPN's public scoreboard and game summary feeds directly in the browser. Leagues with a game in progress refresh every 15 seconds; others every minute.
- **Picks and props:** stored in the `picks`, `props` and `ledger` arrays near the top of the script in `index.html`.
- **`tools/closer-feed.ps1`:** builds the saved game feed used by the Claude artifact version of the app. The website doesn't need it.

Model outputs, not guarantees. 21+ and in a legal state only. Gambling problem? Call 1-800-GAMBLER.
