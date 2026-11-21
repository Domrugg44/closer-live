// Prediction tracking, independent QC access, history backfill and budget status.
// Rules that matter (no edits, no late predictions, approvals for status changes) are enforced by
// the database triggers in migrations/0002_predictions.sql; this code only routes requests to them.
import { bdlSeasonPage } from "./providers.js";
import { liveGameGuard } from "./quality.js";
import { buildExplanation, loadExplainContext } from "./explain.js";

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
// latest captured price per game and side at or before `atIso`; DraftKings preferred at equal times (one query for all games)
async function pricesAt(env, gameIds, atIso) {
  const out = new Map();
  if (!gameIds.length) return out;
  const rows = (await env.DB.prepare(
    `SELECT g.id AS gid, o.side, o.price, o.book, o.captured_at FROM odds_snapshots o JOIN games g ON g.odds_event_id = o.odds_event_id
     WHERE g.id IN (SELECT value FROM json_each(?)) AND o.market = 'h2h' AND o.side IN ('home','away') AND o.captured_at <= ?
     ORDER BY o.captured_at DESC, (o.book = 'draftkings') DESC, o.book`
  ).bind(JSON.stringify(gameIds), atIso).all()).results;
  for (const r of rows) { const k = `${r.gid}:${r.side}`; if (!out.has(k)) out.set(k, r); }
  return out;
}
const PRED_MAX = 500;
// Validates every prediction first, then writes all accepted ones (prediction + explanation) in ONE batch.
// A constant number of database queries per request, whatever its size (Cloudflare free-plan query limit).
export async function submitPredictions(env, body) {
  const { model_version_id, kind, predictions } = body || {};
  if (!model_version_id || !["live", "backtest"].includes(kind) || !Array.isArray(predictions)) return { status: 400, body: { error: "model_version_id, kind ('live'|'backtest') and predictions[] are required" } };
  if (predictions.length > PRED_MAX) return { status: 400, body: { error: `at most ${PRED_MAX} predictions per request` } };
  const mv = await env.DB.prepare("SELECT status FROM model_versions WHERE id = ?").bind(model_version_id).first();
  if (!mv) return { status: 404, body: { error: "unknown model version" } };
  if (kind === "backtest" && mv.status !== "experimental") return { status: 409, body: { error: "backtest predictions are only accepted while a version is experimental" } };
  if (!["experimental", "testing", "validated"].includes(mv.status)) return { status: 409, body: { error: "unknown or rejected model version" } };

  const startedAt = nowIso(), startedMs = Date.parse(startedAt);
  const ctx = await loadExplainContext(env, predictions, startedAt);
  const ids = [...new Set(predictions.map((p) => p.game_id).filter(Number.isInteger))];
  const existing = new Set(ids.length ? (await env.DB.prepare(
    "SELECT game_id, market, side FROM predictions WHERE model_version_id = ? AND kind = ? AND game_id IN (SELECT value FROM json_each(?))"
  ).bind(model_version_id, kind, JSON.stringify(ids)).all()).results.map((r) => `${r.game_id}:${r.market}:${r.side}`) : []);
  const prices = kind === "live" ? await pricesAt(env, ids, startedAt) : new Map();
  const last = await env.DB.prepare("SELECT hash FROM predictions ORDER BY id DESC LIMIT 1").first();

  let prev = last ? last.hash : "";
  const results = [], stmts = [], accepted = [];
  for (const p of predictions) {
    const createdAt = startedAt; // one timestamp for the whole request; the chain order is the request order
    const prob = Number(p.probability), market = p.market || "moneyline";
    const refuse = (error) => results.push({ game_id: p.game_id, ok: false, error });
    if (!Number.isInteger(p.game_id) || !["home", "away"].includes(p.side) || !(prob > 0 && prob < 1) || p.inputs == null) { refuse("needs integer game_id, side home|away, 0<probability<1, inputs"); continue; }
    const key = `${p.game_id}:${market}:${p.side}`;
    if (existing.has(key)) { refuse("already predicted (predictions are permanent)"); continue; }
    if (kind === "live") {
      const problem = liveGameGuard(ctx.games.get(p.game_id), p.game_id, ctx.dq, startedMs);
      if (problem) { refuse(`refused by data safeguard: ${problem}`); continue; }
    }
    // M3: every prediction must carry a valid explanation (contributions add up; evidence verified)
    const ex = buildExplanation(ctx, { gameId: p.game_id, probability: prob, explanation: p.explanation, nowIso: createdAt });
    if (ex.error) { refuse(`explanation refused: ${ex.error}`); continue; }
    existing.add(key);
    const explanationRecord = { method: "additive_logit", base_logit: ex.base, contributions: ex.contributions, reasons: ex.reasons, evidence: ex.evidence, quality_stamp: ex.stamp, game_start_at_prediction: ex.gameStart };
    const explanationHash = await sha256(canon(explanationRecord));
    // fold the explanation's fingerprint into the inputs, so the prediction chain also covers the explanation
    const inputsJson = canon({ ...p.inputs, _explanation_hash: explanationHash }), inputsHash = await sha256(inputsJson);
    const px = kind === "live" ? prices.get(`${p.game_id}:${p.side}`) || null : null;
    const locked = [model_version_id, kind, p.game_id, market, p.side, prob, inputsHash, px ? px.price : null, px ? px.book : null, px ? px.captured_at : null, mv.status, createdAt];
    const hash = await sha256(prev + SEP + locked.map((v) => (v == null ? "" : String(v))).join(SEP));
    stmts.push(
      env.DB.prepare(
        `INSERT INTO predictions (model_version_id, kind, game_id, market, side, probability, inputs_json, inputs_hash, market_price, market_book, market_captured_at, model_status_at_time, created_at, prev_hash, hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(model_version_id, kind, p.game_id, market, p.side, prob, inputsJson, inputsHash, px ? px.price : null, px ? px.book : null, px ? px.captured_at : null, mv.status, createdAt, prev, hash),
      env.DB.prepare(
        `INSERT INTO prediction_explanations (prediction_id, method, base_logit, contributions_json, reasons_json, evidence_json, quality_stamp_json, game_start_at_prediction, explanation_hash, created_at)
         SELECT id, 'additive_logit', ?, ?, ?, ?, ?, ?, ?, ? FROM predictions WHERE hash = ?`
      ).bind(ex.base, JSON.stringify(ex.contributions), JSON.stringify(ex.reasons), JSON.stringify(ex.evidence), JSON.stringify(ex.stamp), ex.gameStart, explanationHash, createdAt, hash),
    );
    const r = { game_id: p.game_id, ok: true, hash, market_price: px ? px.price : null, reasons: ex.reasons };
    results.push(r); accepted.push(r);
    prev = hash;
  }
  if (stmts.length) {
    try {
      // one transaction: every accepted prediction and its explanation are written together, or none are
      await env.DB.batch(stmts);
    } catch (e) {
      const err = dbError(e);
      for (const r of accepted) { r.ok = false; r.error = `not saved (whole request rolled back, resubmit): ${err}`; delete r.hash; delete r.reasons; }
    }
  }
  const n = results.filter((r) => r.ok).length;
  return { status: n ? 201 : 422, body: { accepted: n, rejected: results.length - n, results } };
}

/* ---------------- reads for the pipeline and QC ---------------- */
export async function readPredictions(env, url) {
  const mv = url.searchParams.get("model_version_id");
  if (!mv) return { status: 400, body: { error: "model_version_id required" } };
  const kind = url.searchParams.get("kind");
  const rows = (await env.DB.prepare(
    `SELECT p.id, p.model_version_id, p.kind, p.game_id, p.market, p.side, p.probability, p.inputs_json, p.inputs_hash,
            p.market_price, p.market_book, p.market_captured_at, p.model_status_at_time, p.created_at, p.prev_hash, p.hash,
            g.start_time, g.season, o.outcome, o.brier, o.log_loss, o.closing_price, o.closing_no_vig, o.graded_at,
            e.base_logit, e.contributions_json, e.explanation_hash, s.result AS settlement
     FROM predictions p JOIN games g ON g.id = p.game_id LEFT JOIN prediction_outcomes o ON o.prediction_id = p.id
     LEFT JOIN prediction_explanations e ON e.prediction_id = p.id LEFT JOIN prediction_settlements s ON s.prediction_id = p.id
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
// M3 settlement: decide win / loss / void, or send to review. Runs before scoring.
//   void   : game postponed / canceled / abandoned, or rescheduled > 12 h from the time predicted for
//   review : final score implausible (e.g. an NBA tie), or no final score 36 h after start
//   win/loss: clean final score (the database re-checks it against the stored score)
async function settlePredictions(env) {
  const now = Date.now(), at = nowIso();
  const open = (await env.DB.prepare(
    `SELECT p.id, p.side, p.created_at, g.status, g.start_time, e.game_start_at_prediction AS start_pred,
            r.home_score, r.away_score
     FROM predictions p JOIN games g ON g.id = p.game_id
     LEFT JOIN prediction_explanations e ON e.prediction_id = p.id
     LEFT JOIN game_results r ON r.game_id = p.game_id
     LEFT JOIN prediction_settlements s ON s.prediction_id = p.id
     WHERE s.prediction_id IS NULL AND (r.game_id IS NOT NULL OR g.status IN ('postponed','canceled','abandoned') OR g.start_time < ?
       OR (e.game_start_at_prediction IS NOT NULL AND abs(julianday(g.start_time) - julianday(e.game_start_at_prediction)) * 24 > 12)) LIMIT 300`
  ).bind(new Date(now).toISOString()).all()).results;
  // decide every open prediction in memory, then write all settlements and reviews in one batch
  const stmts = [], kinds = [];
  for (const p of open) {
    const settle = (result, reason, hs = null, as = null) => { kinds.push("settle"); stmts.push(env.DB.prepare(
      "INSERT INTO prediction_settlements (prediction_id, result, reason, home_score, away_score, settled_by, settled_at) VALUES (?,?,?,?,?,'auto',?) ON CONFLICT(prediction_id) DO NOTHING"
    ).bind(p.id, result, reason, hs, as, at)); };
    const review = (issue) => { kinds.push("review"); stmts.push(env.DB.prepare(
      "INSERT INTO settlement_reviews (prediction_id, issue, opened_at) VALUES (?,?,?) ON CONFLICT(prediction_id, issue) DO NOTHING").bind(p.id, issue, at)); };
    if (["postponed", "canceled", "abandoned"].includes(p.status)) { settle("void", `game ${p.status}`); continue; }
    if (p.start_pred && Math.abs(Date.parse(p.start_time) - Date.parse(p.start_pred)) > 12 * 3600e3) { settle("void", `game rescheduled from ${p.start_pred} to ${p.start_time}`); continue; }
    if (p.home_score != null) {
      const bad = p.home_score === p.away_score || Math.min(p.home_score, p.away_score) < 50 || Math.max(p.home_score, p.away_score) > 200;
      if (bad) { review(`implausible final score ${p.away_score}-${p.home_score}`); continue; }
      const won = p.side === "home" ? p.home_score > p.away_score : p.away_score > p.home_score;
      settle(won ? "win" : "loss", "final score", p.home_score, p.away_score); continue;
    }
    if (now - Date.parse(p.start_time) > 36 * 3600e3) review("no final score 36 hours after start");
  }
  let settled = 0, reviews = 0, error = null;
  if (stmts.length) {
    try {
      const res = await env.DB.batch(stmts);
      res.forEach((r, i) => { const c = (r.meta && r.meta.changes) || 0; if (kinds[i] === "settle") settled += c; else reviews += c; });
    } catch (e) { error = dbError(e); /* nothing written; retried next run */ }
  }
  return { settled, reviews, error };
}

export async function gradePredictions(env, startRun, endRun) {
  const sres = await settlePredictions(env);
  // score (Brier, log loss, closing line) only real wins and losses; voids and reviews are excluded
  // three queries in total: the pending list, every closing line they need, and one batch of outcomes
  const pending = (await env.DB.prepare(
    `SELECT p.id, p.side, p.probability, g.start_time, g.odds_event_id, r.home_score, r.away_score FROM predictions p
     JOIN games g ON g.id = p.game_id JOIN game_results r ON r.game_id = p.game_id
     JOIN prediction_settlements s ON s.prediction_id = p.id AND s.result IN ('win','loss')
     LEFT JOIN prediction_outcomes o ON o.prediction_id = p.id WHERE o.prediction_id IS NULL LIMIT 300`
  ).all()).results;
  if (!pending.length && !sres.settled && !sres.reviews && !sres.error) return;
  const id = await startRun(env, "grade");
  // closing line = last pregame snapshot per side from the same book (DraftKings first, then alphabetical)
  const events = [...new Set(pending.map((p) => p.odds_event_id).filter(Boolean))];
  const closing = new Map(); // event -> book -> {home, away}
  if (events.length) {
    const rows = (await env.DB.prepare(
      `SELECT odds_event_id AS ev, book, side, price FROM (
         SELECT o.odds_event_id, o.book, o.side, o.price, ROW_NUMBER() OVER (PARTITION BY o.odds_event_id, o.book, o.side ORDER BY o.captured_at DESC) AS rn
         FROM odds_snapshots o JOIN games g ON g.odds_event_id = o.odds_event_id
         WHERE o.odds_event_id IN (SELECT value FROM json_each(?)) AND o.market = 'h2h' AND o.captured_at < g.start_time AND o.side IN ('home','away'))
       WHERE rn = 1`
    ).bind(JSON.stringify(events)).all()).results;
    for (const r of rows) {
      const b = closing.get(r.ev) || new Map(); closing.set(r.ev, b);
      const x = b.get(r.book) || {}; x[r.side] = r.price; b.set(r.book, x);
    }
  }
  const stmts = [], at = nowIso();
  for (const p of pending) {
    const y = (p.side === "home" ? p.home_score > p.away_score : p.away_score > p.home_score) ? 1 : 0;
    const q = Math.min(Math.max(p.probability, 1e-6), 1 - 1e-6);
    let closePrice = null, closeBook = null, noVig = null;
    const books = closing.get(p.odds_event_id);
    if (books) {
      const usable = [...books.entries()].filter(([, x]) => x.home != null && x.away != null)
        .sort(([a], [b]) => (b === "draftkings") - (a === "draftkings") || a.localeCompare(b));
      if (usable.length) {
        const [book, x] = usable[0], mine = x[p.side], other = x[p.side === "home" ? "away" : "home"];
        closePrice = mine; closeBook = book; const a = american(mine), b = american(other); noVig = a / (a + b);
      }
    }
    stmts.push(env.DB.prepare("INSERT INTO prediction_outcomes (prediction_id, outcome, brier, log_loss, closing_price, closing_book, closing_no_vig, graded_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(prediction_id) DO NOTHING")
      .bind(p.id, y, (p.probability - y) ** 2, -(y * Math.log(q) + (1 - y) * Math.log(1 - q)), closePrice, closeBook, noVig, at));
  }
  let rows = 0, err = sres.error ? `settlement batch failed: ${sres.error}` : null;
  if (stmts.length) {
    try { rows = (await env.DB.batch(stmts)).reduce((s, r) => s + ((r.meta && r.meta.changes) || 0), 0); }
    catch (e) { err = (err ? err + "; " : "") + `scoring batch failed: ${dbError(e)}`; }
  }
  await endRun(env, id, { ok: !err, rows, note: `${sres.settled} settled, ${sres.reviews} sent to review, ${rows} scored${err ? `; ${err}` : ""}` });
}

/* ---------------- scheduled: free history backfill (balldontlie), a few pages per run ---------------- */
export async function backfillStep(env, startRun, endRun, pages = 2) {
  // newest season first: live predictions depend on the current season's full schedule
  const q = await env.DB.prepare("SELECT season, next_cursor FROM backfill_queue WHERE done = 0 ORDER BY season DESC LIMIT 1").first();
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
  const dq = (await env.DB.prepare("SELECT check_name, issues FROM data_quality WHERE status = 'fail'").all()).results;
  if (dq.length) alerts.push(`Data quality failing: ${dq.map((r) => `${r.check_name} (${r.issues})`).join(", ")}; see /quality`);
  return { status: 200, body: {
    budget_usd_per_month: cap,
    paid_services: paid, paid_total_usd: paidTotal,
    odds_api: { plan_credits: planCredits, used_this_month: used.u, calls_this_month: used.n, remaining: rem ? rem.r : null, projected_month_use: projected },
    failed_runs_24h: fails.n, last_collector_run: lastRun.t, alerts,
  } };
}
