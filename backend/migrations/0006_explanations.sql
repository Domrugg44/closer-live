-- M3: the explainable prediction record, and settlement (win / loss / void) with a review queue.

-- Why the model predicted what it did, which data supported it, and the data-quality stamp at that moment.
-- One row per prediction, written in the same request as the prediction and never changed.
CREATE TABLE prediction_explanations (
  prediction_id            INTEGER PRIMARY KEY REFERENCES predictions(id),
  method                   TEXT NOT NULL CHECK (method IN ('additive_logit')),
  base_logit               REAL NOT NULL,          -- starting point, on the log-odds scale
  contributions_json       TEXT NOT NULL,          -- [{factor, group, logit, detail}] summing with base_logit to the prediction
  reasons_json             TEXT NOT NULL,          -- plain-English lines built from fixed templates (server-side)
  evidence_json            TEXT NOT NULL,          -- [{type, ref, as_of, age_minutes}] verified by the server
  quality_stamp_json       TEXT NOT NULL,          -- written by the server: game status, last confirmation, active warnings
  game_start_at_prediction TEXT NOT NULL,          -- the start time the prediction was made for (reschedules -> void)
  explanation_hash         TEXT NOT NULL,          -- SHA-256 of the canonical explanation; also folded into the prediction's inputs_hash
  created_at               TEXT NOT NULL
);

-- Final settlement of each prediction. Written once.
CREATE TABLE prediction_settlements (
  prediction_id   INTEGER PRIMARY KEY REFERENCES predictions(id),
  result          TEXT NOT NULL CHECK (result IN ('win','loss','push','void')),
  reason          TEXT NOT NULL,
  home_score      INTEGER,
  away_score      INTEGER,
  settled_by      TEXT NOT NULL CHECK (settled_by IN ('auto','ceo')),
  review_id       INTEGER,                         -- set when settled after a review
  settled_at      TEXT NOT NULL
);

-- Predictions that can't be settled automatically (suspicious score, overdue result, rescheduled game...).
CREATE TABLE settlement_reviews (
  id              INTEGER PRIMARY KEY,
  prediction_id   INTEGER NOT NULL REFERENCES predictions(id),
  issue           TEXT NOT NULL,
  opened_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX one_open_review_per_issue ON settlement_reviews (prediction_id, issue);

CREATE TRIGGER pe_no_update BEFORE UPDATE ON prediction_explanations BEGIN SELECT RAISE(ABORT, 'explanations are permanent'); END;
CREATE TRIGGER pe_no_delete BEFORE DELETE ON prediction_explanations BEGIN SELECT RAISE(ABORT, 'explanations are permanent'); END;
CREATE TRIGGER ps_no_update BEFORE UPDATE ON prediction_settlements BEGIN SELECT RAISE(ABORT, 'settlements are permanent'); END;
CREATE TRIGGER ps_no_delete BEFORE DELETE ON prediction_settlements BEGIN SELECT RAISE(ABORT, 'settlements are permanent'); END;
CREATE TRIGGER sr_no_update BEFORE UPDATE ON settlement_reviews BEGIN SELECT RAISE(ABORT, 'review records are permanent'); END;
CREATE TRIGGER sr_no_delete BEFORE DELETE ON settlement_reviews BEGIN SELECT RAISE(ABORT, 'review records are permanent'); END;

-- A CEO settlement must cite an open review of that same prediction.
CREATE TRIGGER ps_ceo_needs_review BEFORE INSERT ON prediction_settlements
WHEN NEW.settled_by = 'ceo' AND NOT EXISTS (SELECT 1 FROM settlement_reviews r WHERE r.id = NEW.review_id AND r.prediction_id = NEW.prediction_id)
BEGIN SELECT RAISE(ABORT, 'a manual settlement must cite a review of this prediction'); END;

-- A win/loss must agree with the stored final score (moneyline: did the predicted side win?).
CREATE TRIGGER ps_matches_score BEFORE INSERT ON prediction_settlements
WHEN NEW.result IN ('win','loss') AND (NEW.result = 'win') IS NOT (
  SELECT (p.side = 'home' AND r.home_score > r.away_score) OR (p.side = 'away' AND r.away_score > r.home_score)
  FROM predictions p JOIN game_results r ON r.game_id = p.game_id WHERE p.id = NEW.prediction_id)
BEGIN SELECT RAISE(ABORT, 'win/loss must match the recorded final score'); END;
