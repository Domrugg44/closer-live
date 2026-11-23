// M1: automated data validation and freshness checks (run every collector cycle).
// Each check is a query that returns the rows that are wrong. Results go to data_quality
// (latest) and data_quality_events (permanent log of status changes). See docs/DATA.md.

const iso = (ms) => new Date(ms).toISOString();
const H = 3600e3, MIN = 60e3;

// Each check: name, severity when it finds problems, plain description, and a query builder.
export const CHECKS = [
  {
    name: "result_overdue", severity: "fail",
    description: "Games that started more than 5 hours ago (last 7 days) without a final score, and not postponed or canceled",
    q: (now) => [`SELECT g.id, g.start_time, g.status, h.abbr || ' vs ' || a.abbr AS teams FROM games g
        JOIN teams h ON h.id = g.home_team_id JOIN teams a ON a.id = g.away_team_id
        LEFT JOIN game_results r ON r.game_id = g.id
        WHERE g.league = 'NBA' AND g.start_time < ? AND g.start_time > ? AND r.game_id IS NULL
          AND COALESCE(g.status,'') NOT IN ('postponed','canceled','abandoned') LIMIT 200`, iso(now - 5 * H), iso(now - 7 * 24 * H)],
  },
  {
    name: "status_stuck", severity: "warn",
    description: "Games still marked scheduled more than 45 minutes after their start time (last 2 days)",
    q: (now) => [`SELECT id, start_time, status FROM games WHERE status = 'scheduled' AND start_time < ? AND start_time > ? LIMIT 200`,
      iso(now - 45 * MIN), iso(now - 48 * H)],
  },
  {
    name: "postponed_or_canceled", severity: "warn",
    description: "Games within 3 days either side that are postponed, canceled, suspended, delayed or abandoned (predictions on them must be voided or reviewed)",
    q: (now) => [`SELECT id, start_time, status FROM games WHERE status IN ('postponed','canceled','suspended','delayed','abandoned')
        AND start_time BETWEEN ? AND ? LIMIT 200`, iso(now - 72 * H), iso(now + 72 * H)],
  },
  {
    name: "score_implausible", severity: "fail",
    description: "Final scores from the last 7 days that can't be right for the NBA (a tie, or a team under 50 or over 200 points)",
    // recent games only (through the games_by_start index); older scores were checked when they arrived
    q: (now) => [`SELECT r.game_id, r.home_score, r.away_score FROM games g JOIN game_results r ON r.game_id = g.id
        WHERE g.league = 'NBA' AND g.start_time > ?
        AND (r.home_score = r.away_score OR r.home_score < 50 OR r.away_score < 50 OR r.home_score > 200 OR r.away_score > 200) LIMIT 200`, iso(now - 7 * 24 * H)],
  },
  {
    name: "duplicate_games", severity: "fail",
    description: "Two different game records for the same matchup within 3 hours of each other (games within 7 days of now)",
    // Only games near today matter for live predictions. Reads just this window's games through the existing
    // games_by_start index, then pairs them in memory. (An all-history self-join read ~290k rows per run and
    // pushed the database past the free plan's daily read limit on 2026-11-22.)
    q: (now) => [`WITH w AS MATERIALIZED (SELECT id, home_team_id, away_team_id, start_time FROM games
          WHERE league = 'NBA' AND start_time BETWEEN ? AND ?)
        SELECT a.id AS game_a, b.id AS game_b, a.start_time FROM w a JOIN w b
        ON b.home_team_id = a.home_team_id AND b.away_team_id = a.away_team_id AND b.id > a.id
        AND abs(julianday(a.start_time) - julianday(b.start_time)) * 24 < 3 LIMIT 200`, iso(now - 7 * 24 * H), iso(now + 7 * 24 * H)],
  },
  {
    name: "odds_missing_or_stale", severity: "warn",
    description: "Scheduled games starting within 3 hours whose newest odds snapshot is missing or older than 7 hours",
    q: (now) => [`SELECT g.id, g.start_time, (SELECT MAX(captured_at) FROM odds_snapshots o WHERE o.odds_event_id = g.odds_event_id) AS last_odds
        FROM games g WHERE g.status = 'scheduled' AND g.start_time BETWEEN ? AND ?
        AND (g.odds_event_id IS NULL OR (SELECT MAX(captured_at) FROM odds_snapshots o WHERE o.odds_event_id = g.odds_event_id) < ?) LIMIT 200`,
      iso(now), iso(now + 3 * H), iso(now - 7 * H)],
  },
  {
    name: "odds_unmatched", severity: "warn",
    description: "Odds events seen in the last 24 hours for games in the next 2 days that couldn't be matched to a game",
    q: (now) => [`SELECT DISTINCT o.odds_event_id, o.home_team, o.away_team, o.commence_time FROM odds_snapshots o
        WHERE o.captured_at > ? AND o.commence_time BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM games g WHERE g.odds_event_id = o.odds_event_id) LIMIT 200`, iso(now - 24 * H), iso(now), iso(now + 48 * H)],
  },
  {
    name: "odds_price_implausible", severity: "warn",
    description: "Prices captured in the last 24 hours that aren't valid American odds (between -100 and +100, or beyond +/-50000)",
    q: (now) => [`SELECT id, odds_event_id, book, side, price FROM odds_snapshots WHERE captured_at > ?
        AND ((price > -100 AND price < 100) OR price > 50000 OR price < -50000) LIMIT 200`, iso(now - 24 * H)],
  },
  {
    name: "collector_heartbeat", severity: "fail",
    description: "No successful games refresh in the last 75 minutes (data may be out of date)",
    q: (now) => [`SELECT MAX(started_at) AS last_ok FROM ingestion_runs WHERE job = 'games' AND ok = 1 HAVING MAX(started_at) IS NULL OR MAX(started_at) < ?`, iso(now - 75 * MIN)],
  },
  {
    name: "history_incomplete", severity: "warn", nightly: true,
    description: "Backfilled NBA seasons with fewer than 1,230 final scores (a full regular season)",
    q: () => [`SELECT b.season, (SELECT COUNT(*) FROM games g JOIN game_results r ON r.game_id = g.id WHERE g.season = b.season AND g.postseason = 0) AS regular_season_results
        FROM backfill_queue b WHERE b.done = 1 AND (SELECT COUNT(*) FROM games g JOIN game_results r ON r.game_id = g.id WHERE g.season = b.season AND g.postseason = 0) < 1230`],
  },
  {
    name: "season_schedule_gap", severity: "warn", nightly: true,
    description: "Teams whose first stored game of the latest season is more than 14 days after that season's first stored game (missing early-season schedule makes rest/travel context wrong)",
    q: () => [`WITH s AS (SELECT MAX(season) AS season FROM games WHERE league = 'NBA'),
        first_any AS (SELECT MIN(start_time) AS t FROM games, s WHERE games.season = s.season),
        prev_first AS (SELECT MIN(start_time) AS t FROM games, s WHERE games.season = s.season - 1),
        season_start AS (SELECT 'ALL TEAMS' AS abbr, f.t AS first_t, p.t AS season_first FROM first_any f, prev_first p
          WHERE p.t IS NOT NULL AND julianday(f.t) - julianday(p.t, '+1 year') > 21),
        per_team AS (SELECT team_id, MIN(start_time) AS first_t FROM (
          SELECT home_team_id AS team_id, start_time FROM games, s WHERE games.season = s.season
          UNION ALL SELECT away_team_id, start_time FROM games, s WHERE games.season = s.season) GROUP BY team_id)
        SELECT * FROM season_start
        UNION ALL
        SELECT t.abbr, p.first_t, f.t AS season_first FROM per_team p JOIN teams t ON t.id = p.team_id, first_any f
        WHERE julianday(p.first_t) - julianday(f.t) > 14 LIMIT 200`],
  },
  {
    name: "start_moved_after_prediction", severity: "warn",
    description: "Live predictions whose game was moved to start at or before the time the prediction was logged (needs review)",
    q: () => [`SELECT p.id AS prediction_id, p.game_id, p.created_at, g.start_time FROM predictions p JOIN games g ON g.id = p.game_id
        WHERE p.kind = 'live' AND g.start_time <= p.created_at LIMIT 200`],
  },
];

// Checks marked nightly scan whole seasons, so they run once a night (they track slow-moving things);
// the 30-minute runs skip them and their last result stays in place. Keeps daily reads well under the
// free plan's limit as history grows (see migrations/0007 and the 2026-11-22/23 notes in docs/DATA.md).
export async function runQualityChecks(env, startRun, endRun, nightly = false) {
  const RUN = CHECKS.filter((c) => nightly || !c.nightly);
  const now = Date.now(), at = iso(now);
  const runId = await startRun(env, "quality");
  let failing = 0, warning = 0;
  try {
    // previous statuses in one read, and every status write in one batch (free-plan query limit per run)
    const prevStatus = new Map((await env.DB.prepare("SELECT check_name, status FROM data_quality").all()).results.map((r) => [r.check_name, r.status]));
    const found = await env.DB.batch(RUN.map((c) => { const [sql, ...args] = c.q(now); return env.DB.prepare(sql).bind(...args); }));
    const writes = [];
    for (const [i, c] of RUN.entries()) {
      const rows = found[i].results || [];
      const status = rows.length ? c.severity : "pass";
      if (status === "fail") failing++;
      if (status === "warn") warning++;
      const sample = rows.length ? JSON.stringify(rows.slice(0, 5)) : null;
      const prev = prevStatus.get(c.name);
      writes.push(env.DB.prepare(
        `INSERT INTO data_quality (check_name, severity, status, issues, sample_json, description, checked_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(check_name) DO UPDATE SET severity=excluded.severity, status=excluded.status, issues=excluded.issues,
           sample_json=excluded.sample_json, description=excluded.description, checked_at=excluded.checked_at`
      ).bind(c.name, c.severity, status, rows.length, sample, c.description, at));
      if (prev !== status)
        writes.push(env.DB.prepare("INSERT INTO data_quality_events (check_name, from_status, to_status, issues, sample_json, at) VALUES (?,?,?,?,?,?)")
          .bind(c.name, prev ?? null, status, rows.length, sample, at));
    }
    await env.DB.batch(writes);
    await endRun(env, runId, { ok: true, note: `${RUN.length} checks${nightly ? " (nightly, all)" : ""}: ${failing} failing, ${warning} warning` });
  } catch (e) {
    await endRun(env, runId, { ok: false, note: String(e.message || e).slice(0, 250) });
  }
}

// public summary for the /quality page and the daily alert
export async function qualityStatus(env) {
  const rows = (await env.DB.prepare("SELECT check_name, severity, status, issues, sample_json, description, checked_at FROM data_quality ORDER BY status = 'pass', check_name").all()).results
    .map((r) => ({ ...r, sample: r.sample_json ? JSON.parse(r.sample_json) : [], sample_json: undefined }));
  const recent = (await env.DB.prepare("SELECT check_name, from_status, to_status, issues, at FROM data_quality_events ORDER BY id DESC LIMIT 20").all()).results;
  const failing = rows.filter((r) => r.status === "fail").map((r) => r.check_name);
  return { status: 200, body: { overall: failing.length ? "fail" : rows.some((r) => r.status === "warn") ? "warn" : rows.length ? "pass" : "not yet run", failing, checks: rows, recent_changes: recent } };
}

// Safeguard used before accepting a live prediction: the game must be cleanly scheduled,
// recently confirmed by the collector, and the pipeline itself must be healthy.
// Pure: takes the game row and the non-passing data_quality rows (loaded once per request).
export function liveGameGuard(g, gameId, dqNotPassing, nowMs = Date.now()) {
  if (!g) return "unknown game";
  if (g.status !== "scheduled") return `game status is '${g.status || "unknown"}', not scheduled`;
  if (!(Date.parse(g.start_time) > nowMs)) return "game already started";
  if (nowMs - Date.parse(g.updated_at) > 90 * MIN) return `game data is stale (last confirmed ${g.updated_at})`;
  const hb = dqNotPassing.find((d) => d.check_name === "collector_heartbeat");
  if (hb && hb.status === "fail") return "data pipeline is not current (collector heartbeat failing)";
  const bad = dqNotPassing.find((d) => d.check_name === "duplicate_games" && d.status === "fail");
  if (bad && bad.sample_json && new RegExp(`"game_[ab]":${gameId}[,}]`).test(bad.sample_json)) return "game has a duplicate record under review";
  return null;
}
