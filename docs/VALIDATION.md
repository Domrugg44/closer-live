# Closer model validation standard

**Version 1.0, adopted 2026-11-21.** This standard decides when a prediction model may call itself
"Validated". Changing it requires CEO approval. The change, and its reason, are recorded in git history.

It is written for win-probability models (e.g. NBA moneyline). Other markets will get their own
section before any model for them is promoted.

---

## 1. Statuses

| Status | Meaning | What the public may see |
|---|---|---|
| **Experimental** | In development: the code, data and parameters may still change. | Nothing, or clearly labeled "Experimental, untested". No probabilities presented as reliable. |
| **Testing** | A **frozen** version (exact code commit and parameters) that passed the backtest gate. It is now making real predictions, logged before each game starts. | Its predictions, labeled "In testing, not yet validated". |
| **Validated (Forecast)** | Passed the backtest and forward gates, an independent QC evaluation, and CEO approval. Its probabilities are shown to be accurate and well calibrated. | Probabilities, with a link to its QC report. |
| **Rejected** | Failed a gate, was retired, or was demoted. Its record is kept forever. | Its historical record, labeled "Rejected". |

**Value-confirmed** is a separate flag a Validated model can earn (§ 5). Only value-confirmed models
may be described with words like "edge", "value" or "+EV".

**Any change to a model's code, features, parameters or training data makes a new version.** A new
version starts at Experimental, so Testing results never carry over to a changed model.

## 2. Baselines a model must beat

| Baseline | Definition |
|---|---|
| **B1: Home rate** | Every game gets the home team's historical win rate from the training seasons. |
| **B2: Record model** | A logistic model on the difference in the two teams' season-to-date win percentage, plus home court, using only games before the prediction. |
| **M: Market** (when odds exist) | The no-vig probability from the last captured pregame moneyline. Reported, and required only for the value gate. |

## 3. Gate A: backtest (Experimental → Testing)

All of these must hold:

1. **Out-of-sample:** evaluated on at least **2 full seasons** (≥ 2,000 games) that were never used for fitting or tuning. These holdout seasons are scored **once**. A model that is changed after seeing holdout results becomes a new version and needs a new holdout.
2. **Walk-forward:** each game is predicted using only information available before that game's tip-off (see § 7, Leakage rules).
3. **Accuracy:** lower **log loss** than **both** B1 and B2. The 95% confidence interval of the difference vs B2 (paired bootstrap over games, 2,000 resamples) must lie entirely below zero.
4. **Calibration:** expected calibration error (**ECE**, 10 equal-count bins) **≤ 0.03**, and calibration slope (logistic fit of outcome on the logit of the prediction) between **0.80 and 1.20**.
5. **Brier score** lower than both B1 and B2 (reported with confidence intervals).
6. **QC leakage checklist** (§ 7) signed off.

## 4. Gate B: forward test (Testing → Validated (Forecast))

1. **Sample:** at least **300 games** predicted live, each **logged before tip-off** by the prediction log (§ 8). In the NBA that is about 6 to 7 weeks.
2. **Integrity:** 100% of predictions logged before their game started; the log's fingerprint chain intact; the model version unchanged for the whole test.
3. **Accuracy:** forward log loss lower than B1 and B2 on the same games, and no more than **0.010** worse than the model's own Gate A log loss. Larger drift means it doesn't generalize.
4. **Calibration:** forward ECE **≤ 0.05** (a looser limit for the smaller sample), with the slope still between 0.80 and 1.20.
5. **Independent QC evaluation** passed (§ 6), then **CEO approval** recorded.

## 5. Value gate: Validated → Value-confirmed

1. At least **500** forward predictions with a captured pregame price.
2. **Closing line value:** mean (closing no-vig probability − no-vig probability at prediction time) on the sides the model favors is **> 0**, with a 95% confidence interval excluding 0.
3. Log loss compared with the market (M) is **reported**. Being better than the market isn't required, but must not be claimed unless shown.
4. ROI is reported with a confidence interval. **ROI alone never confirms value**, because it's too noisy.

## 6. Independent Quality Control

The system that builds a model **can't approve, grade or score its own predictions.**

| Role | Can | Can't |
|---|---|---|
| **Model pipeline** (Python, private `closer-models` repo, using the prediction token) | register new versions (always Experimental); submit predictions | change any status; write QC evaluations or outcomes; edit or delete any prediction |
| **QC process** (code in the Cloudflare collector, separate from the model code) | grade outcomes from final scores; compute every metric from the logged predictions and results itself; write QC evaluations | change a status |
| **CEO** (Cloudflare account login) | approve or deny a status change, using QC evaluation evidence | promote to Validated without a passing QC evaluation (the database refuses) |

The database enforces this. Status changes need a recorded approval. Validated needs a passing
QC evaluation for that exact version. Predictions and outcomes can't be edited or deleted, and a
"live" prediction is refused if its game has already started.

## 7. Leakage rules (QC checklist)

- [ ] Every input used for a game has a timestamp earlier than that game's prediction time.
- [ ] Season-to-date stats are computed only from games completed before the prediction.
- [ ] Closing lines, final scores and box scores are never inputs, only outcomes.
- [ ] Rosters, ratings and injuries are taken as they stood on the prediction date.
- [ ] Holdout seasons were never used for fitting, tuning or feature selection.
- [ ] Splits are by time; nothing is shuffled across time.
- [ ] Each prediction stores its exact inputs and their fingerprint (`inputs_hash`), so it can be reproduced.

## 8. Ongoing monitoring (Validated and Testing models)

QC re-evaluates every night on new outcomes. Over the most recent **200 games**, a model is flagged
for review if its log loss is worse than B2 or its ECE is above **0.07**. QC can only **flag** it;
demotion or rejection is a CEO decision. Every status change is permanent and recorded.

## 9. Approval process (in order)

1. The pipeline registers version `model@x.y.z` (Experimental) and submits backtest predictions.
2. QC computes Gate A metrics itself from those predictions and stored results, and records a QC evaluation.
3. The CEO reviews the evaluation and approves **Testing** (or **Rejected**), and it's recorded.
4. The pipeline submits live predictions before each tip-off. QC grades them nightly.
5. Once Gate B's sample is reached, QC records a forward evaluation. The CEO approves **Validated** (the database checks that the QC evaluation passed) or **Rejected**.
6. The value gate follows the same pattern, through the `value_confirmed` evaluation stage.
