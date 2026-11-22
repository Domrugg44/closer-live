-- 0007: indexes so the collector's frequent checks stay cheap as history grows.
-- On 2026-11-22 the duplicate-games quality check (a self-join with no matching index) was reading
-- ~290,000 rows per run, about 14 million a day, past the free plan's 5 million rows/day, and the
-- database was blocked until the daily reset. With these indexes each lookup touches only the same
-- matchup's few games.
CREATE INDEX IF NOT EXISTS games_matchup ON games (home_team_id, away_team_id, start_time);
CREATE INDEX IF NOT EXISTS games_status_start ON games (status, start_time);
