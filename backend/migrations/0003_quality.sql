-- M1: automated data validation and freshness safeguards.
-- data_quality holds the latest result of each check (updated every collector run);
-- data_quality_events is the permanent log of every change in a check's status.

CREATE TABLE data_quality (
  check_name   TEXT PRIMARY KEY,
  severity     TEXT NOT NULL CHECK (severity IN ('warn','fail')),   -- how serious an issue is
  status       TEXT NOT NULL CHECK (status IN ('pass','warn','fail')),
  issues       INTEGER NOT NULL,
  sample_json  TEXT,            -- up to 5 example problem rows
  description  TEXT NOT NULL,
  checked_at   TEXT NOT NULL
);

CREATE TABLE data_quality_events (
  id           INTEGER PRIMARY KEY,
  check_name   TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  issues       INTEGER NOT NULL,
  sample_json  TEXT,
  at           TEXT NOT NULL
);
CREATE INDEX dq_events_by_time ON data_quality_events (at);

CREATE TRIGGER dq_events_no_update BEFORE UPDATE ON data_quality_events BEGIN SELECT RAISE(ABORT, 'quality history is permanent'); END;
CREATE TRIGGER dq_events_no_delete BEFORE DELETE ON data_quality_events BEGIN SELECT RAISE(ABORT, 'quality history is permanent'); END;
