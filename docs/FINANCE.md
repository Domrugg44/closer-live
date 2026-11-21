# Closer financial controls

**Provisional operating budget: $50 per month**, for paid sports data and AI API usage combined.
Set by the CEO on 2026-11-21. Changing the cap requires CEO approval.

## Rules
1. **No purchase, plan upgrade, trial that turns paid, or new paid service without explicit CEO approval**, given in writing, in the conversation or an issue.
2. Every paid service must be listed in `PAID_SERVICES_JSON` (backend/wrangler.toml) with its monthly cost **before** it's used. The status page then counts it against the cap.
3. No account used by Closer holds a payment method unless the CEO adds one. Free tiers without a card **can't** bill. They stop working at their limit instead.
4. Every automated job that calls a metered API has its own hard limit in code and records its usage.
5. Future AI agents get a per-agent monthly cap. The agent's code checks the cap before each call, and the provider account also gets a spend limit wherever one is offered (e.g. the Anthropic Console's workspace limits).

## Current costs (verified 2026-11-21)

| Service | Plan | Monthly cost | Hard limit | How it's enforced |
|---|---|---|---|---|
| Cloudflare Workers + D1 | Free | **$0** | Free-tier quotas | No card on file; requests past the quota fail, they aren't billed |
| The Odds API | Starter (free) | **$0** | 500 credits/month | Provider's free cap, plus our guard: ≤ 12 calls/day, stop below 25 credits |
| balldontlie | Free | **$0** | 5 requests/minute | Provider rate limit; we make about 3 calls per 30-minute run |
| GitHub (Pages, Actions, repos) | Free | **$0** | Free minutes for public repos | No paid features enabled |
| Anthropic API | Not used | **$0** | n/a | No key exists; a spend limit must be set before any agent uses it |
| **Total** | | **$0 / $50** | | |

## Expected costs (estimates, not commitments)

| Possible item | Estimate | When | Needs approval |
|---|---|---|---|
| The Odds API 20K plan, one month (history backfill) | about $30 one time | Only if a model passes Gate A and needs a market comparison (docs/DATA.md) | Yes |
| The Odds API 20K plan, ongoing (more frequent or live odds) | about $30/month | Phase 4+ | Yes |
| Cloudflare Workers Paid | $5/month | Only if free quotas are exceeded | Yes |
| First AI agent (QC daily briefing, small model) | under $1 to about $2/month at list prices | Phase 4 | Yes |

## Monitoring and alerts
- **Status page:** `https://closer-data.closer-data.workers.dev/budget` shows the cap, paid services, Odds API credits used and remaining, projected monthly use, failed runs, and active alerts.
- **Daily alert check** (`.github/workflows/alerts.yml`): if the status page reports an alert, GitHub opens or updates an issue labeled `closer-alert`, and GitHub emails the repository owner. The alerts are:
  - Odds API credits below 75
  - projected monthly use above 90% of the plan
  - 2 or more failed collector runs in 24 hours
  - no collector run for 2 hours
  - paid services above 80% of the cap
