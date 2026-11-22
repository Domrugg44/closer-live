# Closer roadmap

*Last updated 2026-11-22.*

**Phases** are the big stages of the project. **Milestones** (M1, M2, …) are the steps inside the current phase.

## All phases at a glance

| Phase | What it is | Status |
|---|---|---|
| 1 | The website: live scores, picks, pick tracking | ✅ Done |
| 2 | Data foundation: cloud collector saving games, scores and odds (Cloudflare) | ✅ Done |
| **3** | **Prediction intelligence:** a real model, explained predictions, honest grading | ⏳ **Current** |
| 4 | The product: the website on Closer's own predictions, licensed data, hosting ready for paying members | Not started (part of the website built early, see below) |
| 5+ | Injury and lineup data, more sports and bet types, then AI agents | Later |

## Phase 3: prediction intelligence (approved 2026-11-21, budget **$0**)

**Centerpiece:** the explainable prediction record. Every prediction states *why* (an exact breakdown
of the probability into contributions), *which data supported it* (linked source records, their age,
and a data-quality stamp), and *how similar predictions have performed* (computed by QC, with
confidence ranges and "not enough history yet" below 30 cases).

| # | Milestone | Status |
|---|---|---|
| M1 | Data validation and freshness safeguards (12 automated checks, `/quality` page, hourly alerts, live-prediction guard) | ✅ Done 2026-11-21 |
| M2 | Historical dataset 2021–2026 (free backfill) + rest, back-to-back and travel context | ⏳ Built; download ~80% done. Paused 2026-11-22 by the database read-limit outage (fixed); resumes after the 7 PM ET reset, finishes overnight |
| M3 | Explainable prediction record + settlement (win/loss/push/void, pending review) | ✅ Done 2026-11-21 |
| **M4** | **NBA model v1** (closer-elo): transparent team ratings + home court, rest, travel; tuned on 2021–2023, scored once on 2024–2025 | ⏳ Built and rehearsed. **Exam 2026-11-23** once the history finishes; if it passes and the CEO approves, live testing (300 games, about 6–7 weeks) |
| M5 | "Similar predictions" track record on each pick, computed by QC | ❌ Not built |
| M6 | Market comparison: closing line value, QC value gate | ❌ Not built |
| M7 | Automatic daily model picks + active/completed prediction feeds | ❌ Not built (the Experimental engine is a stopgap) |
| M9 | Sport-neutral foundations, with NBA as the reference | Woven through |

**Next steps, in order:** finish the history (overnight) → M4 exam (2026-11-23) → build M7 → M5 → M6.
Phase 4 can start once those are built; it doesn't need to wait for the 6–7 week live test.

**Changes to stay at $0:**
- No paid historical odds backfill. The value gate uses forward predictions, which are priced free.
- M8 (injuries and lineups) moves out of Phase 3. There's no free licensed source; it returns if one appears or the budget changes.
- The pipeline schedule runs on GitHub Actions' free minutes.

**Decisions recorded:** tune on 2021–2023, score once on the 2024–2025 holdout. Public explanations show
factor groups and their size, never raw model parameters.

## Done early (website work originally planned for Phase 4), 2026-11-21 to 2026-11-22

- New app: Dashboard, Picks, Live games, Slip and Results, in the Instrument style. The main link opens it.
- Picks: open vs in progress (locked at kickoff); each open pick re-checked against the current line (at our number / better / still a play / pass); the slip uses the number you can get now.
- "The case for this pick": real numbers (form, line movement, injuries, player game logs), green when they support the pick, red when they don't.
- **Fresh 0–0 record (2026-11-21):** the 55 unchecked starter picks were archived (`data/archive/`), and every new Closer pick must pass a data check (`tools/add-pick.ps1`).
- **Closer Engine (Experimental):** automatic picks every 3 hours from three simple checks, clearly labeled and tracked in their own record.
- Plain-language guides: what "Experimental" means, and what every color and label means.

## What's left for Phase 4

1. Show the **model's** picks on the site (needs M4 to pass, plus M7).
2. **Replace ESPN with licensed data** before charging members (about $30/month; CEO chose $0 for now, see docs/DATA.md).
3. **Hosting and member accounts** for a paid product (the site is on free, public GitHub Pages today).

## Open decisions for the CEO

- Approve the NBA model for live testing, if it passes its exam.
- Licensed data (The Odds API, about $30/month) before paid memberships.
- Hosting and accounts plan before any paid launch.

## Sports coverage plan (CEO goal, recorded 2026-11-22)

Closer will cover every major sport, not just the NBA. Each sport gets its **own model**, and each one must
pass the same steps as the NBA model before its picks count: history download → exam on games it has never
seen → live test on real games → Validated. Until then, a sport can only appear as Experimental.
**Sports seasons set the pace:** a live test needs games being played. Not covered (CEO decision): WNBA.

| Sport | Season (live-test window) | Kind of model | Status | Earliest realistic live test |
|---|---|---|---|---|
| **NBA** | Oct – Jun | Team ratings | **M4 exam 2026-11-23** | Now (Nov 2026 – Jan 2027) |
| **College basketball** | Nov – early Apr | Team ratings (360+ teams, lots of mismatches) | Planned | This winter (Jan – Mar 2027) |
| **NHL** | Oct – Jun | Team ratings, low scoring (goals) | Planned | This winter / spring 2027 |
| **Soccer** (EPL first, then MLS, Champions League) | EPL Aug – May; MLS Feb – Dec | Goals model; three outcomes (win/draw/loss) | Planned | Spring 2027 (EPL) |
| **UFC / MMA** | Year-round, about 40 events | Fighter ratings (individual) | Planned | Any time |
| **Tennis** | Year-round (Jan – Nov) | Player ratings by surface (individual) | Planned | Any time |
| **NFL** | Sep – Feb | Team ratings; few games (17 a team), so it needs more seasons of history | Planned | 2027 season (Sep 2027) |
| **College football** | Late Aug – Jan | Team ratings, huge talent gaps | Planned | 2027 season (Aug 2027) |
| *MLB (suggested)* | Late Mar – Oct | Team ratings + starting pitcher | To decide | Spring 2027 |
| *Golf (suggested)* | Jan – Aug (+ fall) | Player ratings across a whole field (harder) | To decide | 2027 |
| *Boxing (suggested)* | Year-round, fewer big fights | Fighter ratings | To decide | Any time |
| *Motorsports: F1 / NASCAR (suggested)* | F1 Mar – Dec; NASCAR Feb – Nov | Driver ratings across a field (harder) | To decide | 2027 |
| *Esports (suggested)* | Year-round | Team ratings | To decide, low priority | Any time |

**Notes for when we add sports:**
- **Data licensing is checked per sport before building.** Some popular free datasets (for example some tennis
  and UFC collections) are for non-commercial use only and can't be used in a paid product. Odds for all of
  these sports are available from The Odds API (paid plans).
- **Individual sports** (UFC, tennis, boxing, golf) rate the athlete, not a team. Soccer has draws, so it uses a
  different kind of model than basketball or football.
- **Suggested order, by when each season allows a live test:** NBA (now) → college basketball and NHL (this
  winter) → soccer, UFC and tennis (any time) → MLB (spring/summer 2027) → NFL and college football (2027 fall)
  → golf, boxing, motorsports, esports (later).

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
| Website: active picks refresh automatically; finished picks move to the daily record and history | app (done early); model picks need M7 | ✅ for site picks |
| Time zones: store UTC, display local | existing | ✅ |

## Later phases
- **Phase 4:** website on the new data (active picks, daily record, explanation panel); replace ESPN display data; plan private hosting before any paid launch.
- **Phase 5+:** licensed injury and lineup data (with budget approval), more markets and sports, then AI agents.
