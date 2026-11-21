# Closer roadmap

## Phase 3: prediction intelligence (approved 2026-11-21, budget **$0**)

**Centerpiece:** the explainable prediction record. Every prediction states *why* (an exact breakdown
of the probability into contributions), *which data supported it* (linked source records, their age,
and a data-quality stamp), and *how similar predictions have performed* (computed by QC, with
confidence ranges and "not enough history yet" below 30 cases).

| # | Milestone | Status |
|---|---|---|
| M1 | Data validation and freshness safeguards (11 automated checks, `/quality` page, alerts, live-prediction guard) | ✅ done 2026-11-21 |
| M2 | Historical dataset 2021–2026 (free backfill) + free derived context: rest, back-to-backs, travel | ✅ built 2026-11-21; backfill finishing (about 18 h) |
| M3 | Explainable prediction record + settlement states (win/loss/push/void, pending review) | ✅ done 2026-11-21 |
| M4 | Baseline model v1: transparent rating model, tuned on 2021–2023, holdout 2024–2025 | built and rehearsed 2026-11-21; tuning runs once 2021–2023 history finishes loading |
| M5 | "Similar predictions" track record, computed by QC | |
| M6 | Market comparison, closing line value, QC value gate; licensed score cross-check (The Odds API scores, within the free plan) | |
| M7 | Automated daily pipeline (GitHub Actions in the private repo, free) + active/completed prediction APIs | |
| M9 | Sport-neutral foundations (adapters, generic markets), with NBA as the reference; no other sports built | woven through |

**Changes to stay at $0:**
- No paid historical odds backfill. The value gate uses forward predictions, which are priced free.
- M8 (injuries and lineups) moves out of Phase 3. There's no free licensed source; it returns if one appears or the budget changes.
- The pipeline schedule runs on GitHub Actions' free minutes.

**Decisions recorded:** tune on 2021–2023, score once on the 2024–2025 holdout. Public explanations show
factor groups and their size, never raw model parameters.

## Automated prediction lifecycle (requirement added 2026-11-21)

Pregame predictions are **never changed**. Game information updates continuously, but the prediction made
before tip-off stays locked. Live in-game predictions, if added later, are a separate prediction type with
their own models, timestamps and validation.

| Step | Where it's built | Status |
|---|---|---|
| Monitor game status and scores every 30 minutes | collector | ✅ |
| Lock predictions at tip-off; never edit | database rules | ✅ |
| Refuse predictions on stale, postponed, duplicate or unhealthy data | M1 guard | ✅ |
| Detect postponements, cancellations, overdue results, stuck statuses, outages | M1 checks | ✅ |
| Settle as win / loss / push / void, with a pending-review queue for suspect results | M3 | ✅ |
| Void predictions on postponed or canceled games; handle reschedules (store the start time each prediction was made for) | M3 | ✅ |
| Generate predictions automatically for each upcoming slate, before tip-off | M7 | planned |
| Public "active predictions" and "completed / daily record" data | M7 | planned |
| Website: active picks refresh automatically; finished picks move to the daily record and history | **Phase 4** (website) | planned |
| Time zones: store UTC, display local | existing | ✅ |

## Later phases
- **Phase 4:** website on the new data (active picks, daily record, explanation panel); replace ESPN display data; plan private hosting before any paid launch.
- **Phase 5+:** licensed injury and lineup data (with budget approval), more markets and sports, then AI agents.
