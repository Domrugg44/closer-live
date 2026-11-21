-- Prediction tracking, model registry and independent QC (see docs/VALIDATION.md).
-- Rules are enforced by the database itself, not just by code:
--   * predictions, outcomes, QC evaluations and status changes can't be edited or deleted
--   * a live prediction is refused once its game has started
--   * a model's status changes only through a recorded CEO approval, and
--     "testing"/"validated" require a passing QC evaluation of that exact version

CREATE TABLE model_versions (
  id               TEXT PRIMARY KEY,          -- 'nba-ml-elo@1.0.0'
  model            TEXT NOT NULL,
  version          TEXT NOT NULL,
  league           TEXT NOT NULL,             -- 'NBA'
  market           TEXT NOT NULL,             -- 'moneyline'
  description      TEXT,
  code_ref         TEXT NOT NULL,             -- git commit of the model code (private repo)
  params_json      TEXT NOT NULL,             -- frozen parameters
  trained_through  TEXT,                      -- last date of data used for fitting (ISO)
  status           TEXT NOT NULL DEFAULT 'experimental'
                   CHECK (status IN ('experimental','testing','validated','rejected')),
  registered_at    TEXT NOT NULL,
  UNIQUE (model, version)
);

CREATE TABLE qc_evaluations (
  id                INTEGER PRIMARY KEY,
  model_version_id  TEXT NOT NULL REFERENCES model_versions(id),
  stage             TEXT NOT NULL CHECK (stage IN ('backtest','forward','monitor','value')),
  n_games           INTEGER NOT NULL,
  metrics_json      TEXT NOT NULL,            -- log loss, Brier, ECE, slope, CIs, baselines
  passed            INTEGER NOT NULL CHECK (passed IN (0,1)),
  failures          TEXT,                     -- which criteria failed, plain text
  standard_version  TEXT NOT NULL,            -- version of docs/VALIDATION.md applied
  evaluator         TEXT NOT NULL,            -- e.g. 'qc-github-actions@<commit>'
  evaluated_at      TEXT NOT NULL
);

CREATE TABLE model_status_changes (
  id                 INTEGER PRIMARY KEY,
  model_version_id   TEXT NOT NULL REFERENCES model_versions(id),
  from_status        TEXT NOT NULL,
  to_status          TEXT NOT NULL CHECK (to_status IN ('testing','validated','rejected')),
  reason             TEXT NOT NULL,
  approved_by        TEXT NOT NULL CHECK (approved_by = 'ceo'),
  qc_evaluation_id   INTEGER REFERENCES qc_evaluations(id),
  changed_at         TEXT NOT NULL
);

CREATE TABLE predictions (
  id                    INTEGER PRIMARY KEY,
  model_version_id      TEXT NOT NULL REFERENCES model_versions(id),
  kind                  TEXT NOT NULL CHECK (kind IN ('live','backtest')),
  game_id               INTEGER NOT NULL REFERENCES games(id),
  market                TEXT NOT NULL,         -- 'moneyline'
  side                  TEXT NOT NULL CHECK (side IN ('home','away')),
  probability           REAL NOT NULL CHECK (probability > 0 AND probability < 1),
  inputs_json           TEXT NOT NULL,         -- exact inputs used
  inputs_hash           TEXT NOT NULL,         -- SHA-256 of inputs_json
  market_price          INTEGER,               -- American odds available when predicted (live only)
  market_book           TEXT,
  market_captured_at    TEXT,
  model_status_at_time  TEXT NOT NULL,
  created_at            TEXT NOT NULL,         -- set by the server, never by the model
  prev_hash             TEXT NOT NULL,
  hash                  TEXT NOT NULL UNIQUE,  -- SHA-256 chain over every prediction
  UNIQUE (model_version_id, kind, game_id, market, side)
);
CREATE INDEX predictions_by_model ON predictions (model_version_id, kind, created_at);
CREATE INDEX predictions_by_game ON predictions (game_id);

CREATE TABLE prediction_outcomes (
  prediction_id      INTEGER PRIMARY KEY REFERENCES predictions(id),
  outcome            INTEGER NOT NULL CHECK (outcome IN (0,1)),   -- 1 = predicted side won
  brier              REAL NOT NULL,
  log_loss           REAL NOT NULL,
  closing_price      INTEGER,                  -- last pregame price we captured for that side
  closing_book       TEXT,
  closing_no_vig     REAL,                     -- no-vig closing probability for that side
  graded_at          TEXT NOT NULL
);

-- Free history backfill (balldontlie), processed a few pages per scheduled run.
CREATE TABLE backfill_queue (
  season        INTEGER PRIMARY KEY,
  next_cursor   TEXT,
  pages_done    INTEGER NOT NULL DEFAULT 0,
  games_seen    INTEGER NOT NULL DEFAULT 0,
  done          INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT
);
INSERT INTO backfill_queue (season) VALUES (2021), (2022), (2023), (2024), (2025);

------------------------------------------------------------------ rules ---

-- model versions: only status may change, and only through a recorded approval
CREATE TRIGGER mv_frozen BEFORE UPDATE OF id, model, version, league, market, code_ref, params_json, trained_through, registered_at ON model_versions
BEGIN SELECT RAISE(ABORT, 'model versions are frozen; register a new version instead'); END;
CREATE TRIGGER mv_no_delete BEFORE DELETE ON model_versions
BEGIN SELECT RAISE(ABORT, 'model versions are permanent'); END;
CREATE TRIGGER mv_new_is_experimental BEFORE INSERT ON model_versions WHEN NEW.status <> 'experimental'
BEGIN SELECT RAISE(ABORT, 'new model versions must start as experimental'); END;
CREATE TRIGGER mv_status_needs_approval BEFORE UPDATE OF status ON model_versions
WHEN NOT EXISTS (SELECT 1 FROM model_status_changes c WHERE c.model_version_id = NEW.id AND c.to_status = NEW.status
                 AND c.id = (SELECT MAX(id) FROM model_status_changes WHERE model_version_id = NEW.id))
BEGIN SELECT RAISE(ABORT, 'status can only change through an approved status change'); END;

-- status changes: valid transitions, evidence required, then applied automatically
CREATE TRIGGER sc_valid BEFORE INSERT ON model_status_changes
WHEN NEW.from_status IS NOT (SELECT status FROM model_versions WHERE id = NEW.model_version_id)
  OR NOT ((NEW.from_status = 'experimental' AND NEW.to_status IN ('testing','rejected'))
       OR (NEW.from_status = 'testing'      AND NEW.to_status IN ('validated','rejected'))
       OR (NEW.from_status = 'validated'    AND NEW.to_status = 'rejected'))
BEGIN SELECT RAISE(ABORT, 'invalid status transition'); END;
CREATE TRIGGER sc_testing_needs_qc BEFORE INSERT ON model_status_changes
WHEN NEW.to_status = 'testing' AND NOT EXISTS (SELECT 1 FROM qc_evaluations q WHERE q.id = NEW.qc_evaluation_id
     AND q.model_version_id = NEW.model_version_id AND q.stage = 'backtest' AND q.passed = 1)
BEGIN SELECT RAISE(ABORT, 'testing requires a passing backtest QC evaluation of this version'); END;
CREATE TRIGGER sc_validated_needs_qc BEFORE INSERT ON model_status_changes
WHEN NEW.to_status = 'validated' AND NOT EXISTS (SELECT 1 FROM qc_evaluations q WHERE q.id = NEW.qc_evaluation_id
     AND q.model_version_id = NEW.model_version_id AND q.stage = 'forward' AND q.passed = 1)
BEGIN SELECT RAISE(ABORT, 'validated requires a passing forward QC evaluation of this version'); END;
CREATE TRIGGER sc_apply AFTER INSERT ON model_status_changes
BEGIN UPDATE model_versions SET status = NEW.to_status WHERE id = NEW.model_version_id; END;
CREATE TRIGGER sc_no_update BEFORE UPDATE ON model_status_changes BEGIN SELECT RAISE(ABORT, 'status history is permanent'); END;
CREATE TRIGGER sc_no_delete BEFORE DELETE ON model_status_changes BEGIN SELECT RAISE(ABORT, 'status history is permanent'); END;

-- QC evaluations are permanent
CREATE TRIGGER qc_no_update BEFORE UPDATE ON qc_evaluations BEGIN SELECT RAISE(ABORT, 'QC evaluations are permanent'); END;
CREATE TRIGGER qc_no_delete BEFORE DELETE ON qc_evaluations BEGIN SELECT RAISE(ABORT, 'QC evaluations are permanent'); END;

-- predictions: permanent; live ones only before tip-off; backtests only while experimental; never for rejected models
CREATE TRIGGER pr_no_update BEFORE UPDATE ON predictions BEGIN SELECT RAISE(ABORT, 'predictions are permanent'); END;
CREATE TRIGGER pr_no_delete BEFORE DELETE ON predictions BEGIN SELECT RAISE(ABORT, 'predictions are permanent'); END;
CREATE TRIGGER pr_live_before_start BEFORE INSERT ON predictions
WHEN NEW.kind = 'live' AND NOT ((SELECT start_time FROM games WHERE id = NEW.game_id) > NEW.created_at)
BEGIN SELECT RAISE(ABORT, 'game already started; live predictions must be logged before tip-off'); END;
CREATE TRIGGER pr_backtest_experimental BEFORE INSERT ON predictions
WHEN NEW.kind = 'backtest' AND (SELECT status FROM model_versions WHERE id = NEW.model_version_id) <> 'experimental'
BEGIN SELECT RAISE(ABORT, 'backtest predictions are only accepted while a version is experimental'); END;
CREATE TRIGGER pr_not_rejected BEFORE INSERT ON predictions
WHEN (SELECT status FROM model_versions WHERE id = NEW.model_version_id) IS NOT 'experimental'
 AND (SELECT status FROM model_versions WHERE id = NEW.model_version_id) IS NOT 'testing'
 AND (SELECT status FROM model_versions WHERE id = NEW.model_version_id) IS NOT 'validated'
BEGIN SELECT RAISE(ABORT, 'unknown or rejected model version'); END;

-- outcomes: permanent, and must match the stored final score
CREATE TRIGGER po_matches_result BEFORE INSERT ON prediction_outcomes
WHEN NEW.outcome IS NOT (SELECT CASE WHEN (p.side = 'home' AND r.home_score > r.away_score)
                                       OR (p.side = 'away' AND r.away_score > r.home_score) THEN 1 ELSE 0 END
                         FROM predictions p JOIN game_results r ON r.game_id = p.game_id WHERE p.id = NEW.prediction_id)
BEGIN SELECT RAISE(ABORT, 'outcome must match the recorded final score'); END;
CREATE TRIGGER po_no_update BEFORE UPDATE ON prediction_outcomes BEGIN SELECT RAISE(ABORT, 'outcomes are permanent'); END;
CREATE TRIGGER po_no_delete BEFORE DELETE ON prediction_outcomes BEGIN SELECT RAISE(ABORT, 'outcomes are permanent'); END;
