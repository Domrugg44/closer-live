# Closer security and repository structure

## Repositories

| Repository | Visibility | Contains | Must never contain |
|---|---|---|---|
| `Domrugg44/closer-live` | **Public** (required for free GitHub Pages) | Website, data collector, database schema, prediction log, validation standard, QC code, docs | API keys, tokens, model code or parameters, licensed raw data |
| `Domrugg44/closer-models` | **Private** | Proprietary model code, features, parameters, training notebooks | API keys, tokens (use `.env`), licensed raw data files |

Model code goes **only** in `closer-models`. The public side receives published predictions and QC
results, never the algorithm. Before paid launch, consider moving the website to Cloudflare Pages,
which works with private repositories (docs/FINANCE.md lists costs; it's free).

## Secrets inventory (where each one lives; values are never in git)

| Secret | Used by | Stored in | Rotate by |
|---|---|---|---|
| `ODDS_API_KEY` | collector | Cloudflare Worker secret | new key at the-odds-api.com, then `npx wrangler secret put ODDS_API_KEY` |
| `BDL_API_KEY` | collector | Cloudflare Worker secret | new key at app.balldontlie.io, then `wrangler secret put BDL_API_KEY` |
| `PREDICTION_WRITE_TOKEN` | model pipeline | Cloudflare secret + `closer-models/.env` (git-ignored) | generate a new random token, update both places |
| `QC_TOKEN` | QC on GitHub Actions | Cloudflare secret + GitHub Actions secret `CLOSER_QC_TOKEN` | generate a new token, update both places |
| Wrangler login | CEO deploys and approvals | Wrangler's local OAuth store | `npx wrangler logout` / login |
| GitHub CLI login | git and GitHub automation | Windows credential manager | `gh auth logout` / login |
| Local test tokens | local testing only | `backend/.dev.vars` (git-ignored) | regenerate anytime |

## Protections in place
- `.gitignore` in every repo blocks `.env`, `.dev.vars`, keys and virtual environments; `.env.example` files show the names, never the values.
- GitHub **secret scanning and push protection are on** for `closer-live`, so pushes with known key formats are blocked.
- A full-history scan on 2026-11-21 found no keys or tokens in `closer-live`.
- Two separate tokens with different powers. The model token can't write QC results or change statuses; the QC token can't submit predictions. Status changes need the CEO's own Cloudflare login and a database-checked approval.
- The website never holds a secret. Its public read endpoints serve no inputs, parameters or tokens.
- Branch rule on `closer-live/main`: no force-pushes or deletions.

## If a secret leaks
Rotate it immediately (table above), check the collector's `/health` and `/budget`, and review recent
`ingestion_runs` and `predictions` for activity you don't recognize.
