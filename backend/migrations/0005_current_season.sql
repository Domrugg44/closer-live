-- M2: also backfill the current season (2026-27) so live context (rest, travel, first game of season)
-- is computed from the full schedule, not just the days since the collector started.
INSERT INTO backfill_queue (season) VALUES (2026) ON CONFLICT(season) DO NOTHING;
