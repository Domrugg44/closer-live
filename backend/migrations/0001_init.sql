-- Closer data collector, first version: NBA games, moneyline odds history, final results.
-- Every row says when we learned it (first_seen_at / captured_at / finalized_at), so a future
-- model can be restricted to what was known at prediction time.

CREATE TABLE teams (
  id         INTEGER PRIMARY KEY,
  league     TEXT NOT NULL,              -- 'NBA'
  abbr       TEXT NOT NULL,
  full_name  TEXT NOT NULL,              -- as balldontlie names it, e.g. 'LA Clippers'
  bdl_id     INTEGER UNIQUE,             -- balldontlie team id
  UNIQUE (league, full_name)
);

CREATE TABLE games (
  id             INTEGER PRIMARY KEY,
  league         TEXT NOT NULL,
  season         INTEGER,
  start_time     TEXT NOT NULL,          -- ISO 8601 UTC tip-off time
  home_team_id   INTEGER NOT NULL REFERENCES teams(id),
  away_team_id   INTEGER NOT NULL REFERENCES teams(id),
  status         TEXT,                   -- scheduled | in_progress | final | postponed | ...
  status_detail  TEXT,                   -- provider text, e.g. '7:00 pm ET', '3rd Qtr', 'Final'
  postseason     INTEGER NOT NULL DEFAULT 0,
  bdl_game_id    INTEGER UNIQUE,         -- balldontlie game id
  odds_event_id  TEXT UNIQUE,            -- The Odds API event id, once matched
  first_seen_at  TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX games_by_start ON games (league, start_time);

-- Final scores. Written once; never updated or deleted.
CREATE TABLE game_results (
  game_id       INTEGER PRIMARY KEY REFERENCES games(id),
  home_score    INTEGER NOT NULL,
  away_score    INTEGER NOT NULL,
  source        TEXT NOT NULL,           -- 'balldontlie'
  finalized_at  TEXT NOT NULL            -- when we recorded it as final
);

-- Every distinct sportsbook price we have seen. Append-only: this is the line-movement history.
-- A row is added only when a book's price changes (book_updated_at differs), so unchanged prices
-- aren't stored twice. Linked to games through games.odds_event_id.
CREATE TABLE odds_snapshots (
  id               INTEGER PRIMARY KEY,
  odds_event_id    TEXT NOT NULL,
  commence_time    TEXT NOT NULL,        -- tip-off time as the odds provider reported it
  home_team        TEXT NOT NULL,        -- names as the odds provider wrote them
  away_team        TEXT NOT NULL,
  book             TEXT NOT NULL,        -- e.g. 'draftkings'
  market           TEXT NOT NULL,        -- 'h2h' = moneyline
  outcome          TEXT NOT NULL,        -- team name as written by the provider
  side             TEXT,                 -- 'home' | 'away' | 'draw'
  point            REAL,                 -- spread/total line (null for moneyline)
  price            INTEGER NOT NULL,     -- American odds, e.g. -150 / +130
  is_live          INTEGER NOT NULL,     -- 1 if captured after tip-off
  book_updated_at  TEXT,                 -- the book's own last-update time for this market
  captured_at      TEXT NOT NULL,        -- when we fetched it
  run_id           INTEGER REFERENCES ingestion_runs(id),
  UNIQUE (odds_event_id, book, market, outcome, book_updated_at)
);
CREATE INDEX odds_by_event ON odds_snapshots (odds_event_id, market, captured_at);

-- One row per collector run: what ran, whether it worked, and API budget used/remaining.
CREATE TABLE ingestion_runs (
  id                 INTEGER PRIMARY KEY,
  job                TEXT NOT NULL,      -- 'games' | 'odds'
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  ok                 INTEGER,
  rows_written       INTEGER NOT NULL DEFAULT 0,
  credits_used       INTEGER,            -- The Odds API x-requests-last
  credits_remaining  INTEGER,            -- The Odds API x-requests-remaining
  note               TEXT
);
CREATE INDEX runs_by_job ON ingestion_runs (job, started_at);

-- History can't be edited: the database itself refuses updates and deletes on these tables.
CREATE TRIGGER odds_snapshots_append_only_u BEFORE UPDATE ON odds_snapshots
BEGIN SELECT RAISE(ABORT, 'odds_snapshots is append-only'); END;
CREATE TRIGGER odds_snapshots_append_only_d BEFORE DELETE ON odds_snapshots
BEGIN SELECT RAISE(ABORT, 'odds_snapshots is append-only'); END;
CREATE TRIGGER game_results_final_u BEFORE UPDATE ON game_results
BEGIN SELECT RAISE(ABORT, 'game_results are final'); END;
CREATE TRIGGER game_results_final_d BEFORE DELETE ON game_results
BEGIN SELECT RAISE(ABORT, 'game_results are final'); END;
