// Prediction tracking, independent QC access, history backfill and budget status.
// Rules that matter (no edits, no late predictions, approvals for status changes) are enforced by
// the database triggers in migrations/0002_predictions.sql; this code only routes requests to them.
import { bdlSeasonPage } from "./providers.js";

const nowIso = () => new Date().toISOString();
const SEP = "\u001f";

/* ---------------- helpers ---------------- */
async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// stable JSON (sorted keys) so the same inputs always hash the same
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v ?? null);
}
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// Two separate credentials: the model pipeline can't act as QC, and QC can't submit predictions.
export function scopeOf(req, env) {
  const h = req.headers.get("authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!tok || tok.length < 32) return null;
  // secrets set by piping text may carry a trailing line break; compare the trimmed values
  const model = (env.PREDICTION_WRITE_TOKEN || "").trim(), qc = (env.QC_TOKEN || "").trim();
  if (model.length >= 32 && timingSafeEqual(tok, model)) return "model";
  if (qc.length >= 32 && timingSafeEqual(tok, qc)) return "qc";
  return null;
}
const dbError = (e) => String((e && e.message) || e).replace(/^D1_ERROR:\s*/, "").replace(/: SQLITE_CONSTRAINT.*$/, "").slice(0, 200);

/* ---------------- model pipeline: register a version ---------------- */
export async function registerModel(env, body) {
  const { model, version, league, market, description, code_ref, params, trained_through } = body || {};
  if (!/^[a-z0-9-]{2,40}$/.test(model || "") || !/^\d+\.\d+\.\d+$/.test(version || "")) return { status: 400, body: { error: "model must be lowercase letters/digits/dashes; version must be x.y.z" } };
  if (!league || !market || !code_ref || params == null) return { status: 400, body: { error: "league, market, code_ref and params are required" } };
  const id = `${model}@${version}`;
  try {
    await env.DB.prepare("INSERT INTO model_versions (id, model, version, league, market, description, code_ref, params_json, trained_through, registered_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(id, model, version, league, market, description ?? null, code_ref, canon(params), trained_through ?? null, nowIso()).run();
    return { status: 201, body: { id, status: "experimental" } };
  } catch (e) {
    return { status: 409, body: { error: dbError(e) } };
  }
}

/* ---------------- model pipeline: submit predictions ---------------- */
async function priceAt(env, gameId, side, atIso) {
  // latest captured price for this side at or before the prediction time; DraftKings preferred
  return await env.DB.prepare(
    `SELECT o.price, o.book, o.captured_at FROM odds_snapshots o JOIN games g ON g.odds_event_id = o.odds_event_id
     WHERE g.id = ? AND o.market = 'h2h' AND o.side = ? AND o.captured_at <= ?
     ORDER BY o.captured_at DESC, (o.book = 'draftkings') DESC LIMIT 1`
  ).bind(gameId, side, atIso).first();
}
export async function submitPredictions(env, body) {
  const { model_version_id, kind, predictions } = body || {};
  if (!model_version_id || !["live", "backtest"].includes(kind) || !Array.isArray(predictions)) return { status: 400, body: { error: "model_version_id, kind ('live'|'backtest') and predictions[] are required" } };
  if (predictions.length > 500) return { status: 400, body: { error: "at most 500 predictions per request" } };
  const mv = await env.DB.prepare("SELECT status FROM model_versions WHERE id = ?").bind(model_version_id).first();
  if (!mv) return { status: 404, body: { error: "unknown model version" } };
  const results = [];
  for (const p of predictions) {
    const createdAt = nowIso();
    const prob = Number(p.probability);
    if (!Number.isInteger(p.game_id) || !["home", "away"].includes(p.side) || !(prob > 0 && prob < 1) || p.inputs == null) {
      results.push({ game_id: p.game_id, ok: false, error: "needs integer game_id, side home|away, 0<probability<1, inputs" });
      continue;
    }
    const inputsJson = canon(p.inputs), inputsHash = await sha256(inputsJson);
    const px = kind === "live" ? await priceAt(env, p.game_id, p.side, createdAt) : null;
    const last = await env.DB.prepare("SELECT hash FROM predictions ORDER BY id DESC LIMIT 1").first();
    const prev = last ? last.hash : "";
    const locked = [model_version_id, kind, p.game_id, p.market || "moneyline", p.side, prob, inputsHash, px ? px.price : null, px ? px.book : null, px ? px.captured_at : null, mv.status, createdAt];
    const hash = await sha256(prev + SEP + locked.map((v) => (v == null ? "" : String(v))).join(SEP));
    try {
      await env.DB.prepare(
        `INSERT INTO predictions (model_version_id, kind, game_id, market, side, probability, inputs_json, inputs_hash, market_price, market_book, market_captured_at, model_status_at_time, created_at, prev_hash, hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(model_version_id, kind, p.game_id, p.market || "moneyline", p.side, prob, inputsJson, inputsHash, px ? px.price : null, px ? px.book : null, px ? px.captured_at : null, mv.status, createdAt, prev, hash).run();
      results.push({ game_id: p.game_id, ok: true, hash, market_price: px ? px.price : null });
    } catch (e) {
      results.push({ game_id: p.game_id, ok: false, error: dbError(e) });
    }
  }
  const accepted = results.filter((r) => r.ok).length;
  return { status: accepted ? 201 : 422, body: { accepted, rejected: results.length - accepted, results } };
}

/* ---------------- reads for the pipeline and QC ---------------- */
export async function readPredictions(env, url) {
  const mv = url.searchParams.get("model_version_id");
  if (!mv) return { status: 400, body: { error: "model_version_id required" } };
  const kind = url.searchParams.get("kind");
  const rows = (await env.DB.prepare(
    `SELECT p.id, p.model_version_id, p.kind, p.game_id, p.market, p.side, p.probability, p.inputs_json, p.inputs_hash,
            p.market_price, p.market_book, p.market_captured_at, p.model_status_at_time, p.created_at, p.prev_hash, p.hash,
            g.start_time, g.season, o.outcome, o.brier, o.log_loss, o.closing_price, o.closing_no_vig, o.graded_at
     FROM predictions p JOIN games g ON g.id = p.game_id LEFT JOIN prediction_outcomes o ON o.prediction_id = p.id
     WHERE p.model_version_id = ? AND (? IS NULL OR p.kind = ?) ORDER BY p.id`
  ).bind(mv, kind, kind).all()).results;
  return { status: 200, body: { model_version_id: mv, predictions: rows } };
}
// full prediction chain (every model), so QC can re-check the fingerprints
export async function readChain(env) {
  const rows = (await env.DB.prepare("SELECT id, model_version_id, kind, game_id, market, side, probability, inputs_hash, market_price, market_book, market_captured_at, model_status_at_time, created_at, prev_hash, hash FROM predictions ORDER BY id").all()).results;
  return { status: 200, body: { predictions: rows } };
}
export async function readResults(env) {
  const rows = (await env.DB.prepare(
    `SELECT g.id AS game_id, g.season, g.start_time, g.postseason, g.home_team_id, g.away_team_id, r.home_score, r.away_score
     FROM games g JOIN game_results r ON r.game_id = g.id WHERE g.league = 'NBA' ORDER BY g.start_time`
  ).all()).results;
  return { status: 200, body: { games: rows } };
}
export async function recordQc(env, body) {
  const { model_version_id, stage, n_games, metrics, passed, failures, standard_version, evaluator } = body || {};
  if (!model_version_id || !["backtest", "forward", "monitor", "value"].includes(stage) || !Number.isInteger(n_games) || metrics == null || ![0, 1, true, false].includes(passed) || !standard_version || !evaluator)
    return { status: 400, body: { error: "model_version_id, stage, n_games, metrics, passed, standard_version, evaluator required" } };
  try {
    const r = await env.DB.prepare("INSERT INTO qc_evaluations (model_version_id, stage, n_games, metrics_json, passed, failures, standard_version, evaluator, evaluated_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id")
      .bind(model_version_id, stage, n_games, canon(metrics), passed ? 1 : 0, failures ?? null, standard_version, evaluator, nowIso()).first();
    return { status: 201, body: { id: r.id } };
  } catch (e) {
    return { status: 409, body: { error: dbError(e) } };
  }
}
// public: model registry + latest QC verdicts (no inputs, no proprietary parameters)
export async function listModels(env) {
  const rows = (await env.DB.prepare(
    `SELECT m.id, m.model, m.version, m.league, m.market, m.description, m.status, m.trained_through, m.registered_at,
            (SELECT COUNT(*) FROM predictions p WHERE p.model_version_id = m.id AND p.kind = 'live') AS live_predictions,
            (SELECT json_extract(q.metrics_json, '$.log_loss') FROM qc_evaluations q WHERE q.model_version_id = m.id
               AND q.stage = 'backtest' AND q.passed = 1 ORDER BY q.id DESC LIMIT 1) AS passed_backtest_log_loss,
            (SELECT json_object('stage', q.stage, 'n_games', q.n_games, 'passed', q.passed, 'failures', q.failures, 'evaluated_at', q.evaluated_at)
               FROM qc_evaluations q WHERE q.model_version_id = m.id ORDER BY q.id DESC LIMIT 1) AS latest_qc
     FROM model_versions m ORDER BY m.registered_at`
  ).all()).results.map((r) => ({ ...r, latest_qc: r.latest_qc ? JSON.parse(r.latest_qc) : null }));
  return { status: 200, body: { models: rows } };
}

/* ---------------- scheduled: grade predictions from final scores ---------------- */
const american = (o) => (o > 0 ? 100 / (o + 100) : -o / (-o + 100));
export async function gradePredictions(env, startRun, endRun) {
  const pending = (await env.DB.prepare(
    `SELECT p.id, p.side, p.probability, g.start_time, g.odds_event_id FROM predictions p
     JOIN games g ON g.id = p.game_id JOIN game_results r ON r.game_id = p.game_id
     LEFT JOIN prediction_outcomes o ON o.prediction_id = p.id WHERE o.prediction_id IS NULL LIMIT 200`
  ).all()).results;
  if (!pending.length) return;
  const id = await startRun(env, "grade");
  let rows = 0, errors = 0;
  for (const p of pending) {
    try {
      const won = await env.DB.prepare(
        `SELECT CASE WHEN (? = 'home' AND r.home_score > r.away_score) OR (? = 'away' AND r.away_score > r.home_score) THEN 1 ELSE 0 END AS w
         FROM predictions p JOIN game_results r ON r.game_id = p.game_id WHERE p.id = ?`
      ).bind(p.side, p.side, p.id).first();
      const y = won.w, q = Math.min(Math.max(p.probability, 1e-6), 1 - 1e-6);
      let closePrice = null, closeBook = null, noVig = null;
      if (p.odds_event_id) {
        // closing line = last pregame snapshot per side from the same book (DraftKings first)
        const c = await env.DB.prepare(
          `SELECT book, MAX(CASE WHEN side = ? THEN price END) AS mine, MAX(CASE WHEN side <> ? THEN price END) AS other FROM (
             SELECT book, side, price, ROW_NUMBER() OVER (PARTITION BY book, side ORDER BY captured_at DESC) AS rn
             FROM odds_snapshots WHERE odds_event_id = ? AND market = 'h2h' AND captured_at < ? AND side IN ('home','away'))
           WHERE rn = 1 GROUP BY book HAVING mine IS NOT NULL AND other IS NOT NULL ORDER BY (book = 'draftkings') DESC LIMIT 1`
        ).bind(p.side, p.side, p.odds_event_id, p.start_time).first();
        if (c) { closePrice = c.mine; closeBook = c.book; const a = american(c.mine), b = american(c.other); noVig = a / (a + b); }
      }
      await env.DB.prepare("INSERT INTO prediction_outcomes (prediction_id, outcome, brier, log_loss, closing_price, closing_book, closing_no_vig, graded_at) VALUES (?,?,?,?,?,?,?,?)")
        .bind(p.id, y, (p.probability - y) ** 2, -(y * Math.log(q) + (1 - y) * Math.log(1 - q)), closePrice, closeBook, noVig, nowIso()).run();
      rows++;
    } catch (e) { errors++; }
  }
  await endRun(env, id, { ok: errors === 0, rows, note: `${rows} graded${errors ? `, ${errors} failed` : ""}` });
}

/* ---------------- scheduled: free history backfill (balldontlie), a few pages per run ---------------- */
export async function backfillStep(env, startRun, endRun, pages = 2) {
  const q = await env.DB.prepare("SELECT season, next_cursor FROM backfill_queue WHERE done = 0 ORDER BY season LIMIT 1").first();
  if (!q) return;
  const id = await startRun(env, "backfill");
  let cursor = q.next_cursor, rows = 0, seen = 0, done = 0;
  try {
    for (let i = 0; i < pages; i++) {
      const page = await bdlSeasonPage(env, q.season, cursor);
      seen += page.data.length;
      rows += await storeFinalGames(env, page.data);
      cursor = page.next_cursor;
      if (!cursor) { done = 1; break; }
    }
    await env.DB.prepare("UPDATE backfill_queue SET next_cursor = ?, pages_done = pages_done + ?, games_seen = games_seen + ?, done = ?, updated_at = ? WHERE season = ?")
      .bind(cursor ? String(cursor) : null, pages, seen, done, nowIso(), q.season).run();
    await endRun(env, id, { ok: true, rows, note: `season ${q.season}: ${seen} games read${done ? ", season complete" : ""}` });
  } catch (e) {
    await endRun(env, id, { ok: false, rows, note: `season ${q.season}: ${String(e.message || e).slice(0, 250)}` });
  }
}
// Batched store of finished historical games and their scores (results are write-once).
async function storeFinalGames(env, list) {
  const now = nowIso(), stmts = [];
  const teams = new Map();
  for (const g of list) { teams.set(g.home_team.id, g.home_team); teams.set(g.visitor_team.id, g.visitor_team); }
  for (const t of teams.values())
    stmts.push(env.DB.prepare("INSERT INTO teams (league, abbr, full_name, bdl_id) VALUES ('NBA', ?, ?, ?) ON CONFLICT(bdl_id) DO NOTHING").bind(t.abbreviation, t.full_name, t.id));
  for (const g of list) {
    const state = g.status_state || (g.status === "Final" ? "final" : null);
    stmts.push(env.DB.prepare(
      `INSERT INTO games (league, season, start_time, home_team_id, away_team_id, status, status_detail, postseason, bdl_game_id, first_seen_at, updated_at)
       VALUES ('NBA', ?, ?, (SELECT id FROM teams WHERE bdl_id = ?), (SELECT id FROM teams WHERE bdl_id = ?), ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bdl_game_id) DO NOTHING`
    ).bind(g.season ?? null, g.datetime || g.date + "T00:00:00.000Z", g.home_team.id, g.visitor_team.id, state, g.status ?? null, g.postseason ? 1 : 0, g.id, now, now));
    if (state === "final" && g.home_team_score != null && g.visitor_team_score != null && (g.home_team_score > 0 || g.visitor_team_score > 0))
      stmts.push(env.DB.prepare("INSERT INTO game_results (game_id, home_score, away_score, source, finalized_at) SELECT id, ?, ?, 'balldontlie-backfill', ? FROM games WHERE bdl_game_id = ? ON CONFLICT(game_id) DO NOTHING")
        .bind(g.home_team_score, g.visitor_team_score, now, g.id));
  }
  let changed = 0;
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await env.DB.batch(stmts.slice(i, i + 50));
    changed += res.reduce((s, r) => s + ((r.meta && r.meta.changes) || 0), 0);
  }
  return changed;
}

/* ---------------- public: budget and usage ---------------- */
export async function budgetStatus(env) {
  const now = new Date(), monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const dayOfMonth = (now - new Date(monthStart)) / 864e5;
  const used = (await env.DB.prepare("SELECT COALESCE(SUM(credits_used),0) AS u, COUNT(*) AS n FROM ingestion_runs WHERE job = 'odds' AND started_at >= ?").bind(monthStart).first());
  const rem = await env.DB.prepare("SELECT credits_remaining AS r, started_at FROM ingestion_runs WHERE job = 'odds' AND credits_remaining IS NOT NULL ORDER BY started_at DESC LIMIT 1").first();
  const fails = await env.DB.prepare("SELECT COUNT(*) AS n FROM ingestion_runs WHERE ok = 0 AND started_at >= ?").bind(new Date(Date.now() - 864e5).toISOString()).first();
  const lastRun = await env.DB.prepare("SELECT MAX(started_at) AS t FROM ingestion_runs WHERE job = 'games'").first();
  let paid = [];
  try { paid = JSON.parse(env.PAID_SERVICES_JSON || "[]"); } catch (e) { paid = []; }
  const cap = +env.MONTHLY_BUDGET_USD || 50;
  const paidTotal = paid.reduce((s, p) => s + (+p.monthly_usd || 0), 0);
  const planCredits = +env.ODDS_PLAN_CREDITS || 500;
  const projected = dayOfMonth > 0.5 ? Math.round((used.u / dayOfMonth) * daysInMonth) : null;
  const alerts = [];
  if (rem && rem.r < 75) alerts.push(`Odds API credits low: ${rem.r} left this month`);
  if (projected != null && projected > planCredits * 0.9) alerts.push(`Projected odds credit use ${projected} is near the ${planCredits}-credit plan limit`);
  if (fails.n >= 2) alerts.push(`${fails.n} collector runs failed in the last 24 hours`);
  if (lastRun.t && Date.now() - Date.parse(lastRun.t) > 2 * 3600e3) alerts.push(`No collector run since ${lastRun.t}`);
  if (paidTotal > cap * 0.8) alerts.push(`Paid services ($${paidTotal}/mo) are above 80% of the $${cap} budget`);
  return { status: 200, body: {
    budget_usd_per_month: cap,
    paid_services: paid, paid_total_usd: paidTotal,
    odds_api: { plan_credits: planCredits, used_this_month: used.u, calls_this_month: used.n, remaining: rem ? rem.r : null, projected_month_use: projected },
    failed_runs_24h: fails.n, last_collector_run: lastRun.t, alerts,
  } };
}
