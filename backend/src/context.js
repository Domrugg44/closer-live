// M2: schedule-derived game context (rest, back-to-backs, recent load, travel, time-zone change).
// Computed by the game_team_context view from earlier scheduled games only (see migrations/0004_context.sql).

const COLS = "c.game_id, c.season, c.start_time, c.team_id, t.abbr AS team, c.opponent_id, c.is_home, ve.name AS venue, c.prev_game_start, c.rest_days, c.back_to_back, c.first_game_of_season, c.games_last_7d, c.travel_km, c.tz_shift_hours";
const FROM = "FROM game_team_context c JOIN teams t ON t.id = c.team_id LEFT JOIN venues ve ON ve.venue_id = c.venue_id";

// public: context for one game (both teams), used by explanations
export async function gameContext(env, url) {
  const gid = +url.searchParams.get("game_id");
  if (!gid) return { status: 400, body: { error: "game_id required" } };
  const rows = (await env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE c.game_id = ? ORDER BY c.is_home DESC`).bind(gid).all()).results;
  return { status: 200, body: { game_id: gid, teams: rows } };
}

// model/QC: context for a whole season (or a date range), for training and backtests
export async function seasonContext(env, url) {
  const season = url.searchParams.get("season");
  const from = url.searchParams.get("from"), to = url.searchParams.get("to");
  if (!season && !(from && to)) return { status: 400, body: { error: "season, or from and to (ISO), required" } };
  const where = season ? "c.season = ?" : "c.start_time >= ? AND c.start_time < ?";
  const args = season ? [+season] : [from, to];
  const rows = (await env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE ${where} ORDER BY c.start_time, c.game_id, c.is_home DESC`).bind(...args).all()).results;
  return { status: 200, body: { rows } };
}
