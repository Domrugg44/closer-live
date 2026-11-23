// Closer data collector (Cloudflare Worker).
// Scheduled jobs save NBA games, moneyline price history and final scores to the D1 database.
// The fetch handler serves read-only JSON for the website, plus token-protected /admin routes
// for the model pipeline and QC (see predictions.js and docs/VALIDATION.md).
import { bdlGames, oddsMoneylines } from "./providers.js";
import { scopeOf, registerModel, submitPredictions, readPredictions, readChain, readResults, recordQc, listModels, gradePredictions, backfillStep, budgetStatus } from "./predictions.js";
import { runQualityChecks, qualityStatus } from "./quality.js";
import { gameContext, seasonContext } from "./context.js";
import { publicExplanation } from "./explain.js";

const nowIso = () => new Date().toISOString();
const etDate = (offsetDays = 0, from = Date.now()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(from + offsetDays * 864e5));
// team names differ between providers ("LA Clippers" vs "Los Angeles Clippers")
const normTeam = (s) => String(s || "").toLowerCase().replace(/^la\s/, "los angeles ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

async function startRun(env, job) {
  const r = await env.DB.prepare("INSERT INTO ingestion_runs (job, started_at) VALUES (?, ?) RETURNING id").bind(job, nowIso()).first();
  return r.id;
}
async function endRun(env, id, f) {
  await env.DB.prepare("UPDATE ingestion_runs SET finished_at=?, ok=?, rows_written=?, credits_used=?, credits_remaining=?, note=? WHERE id=?")
    .bind(nowIso(), f.ok ? 1 : 0, f.rows || 0, f.used ?? null, f.remaining ?? null, f.note ?? null, id).run();
}

/* ---------- job: games and final scores (balldontlie) ---------- */
async function syncGames(env, dates) {
  const id = await startRun(env, "games");
  let rows = 0;
  try {
    const list = await bdlGames(env, dates);
    const now = nowIso(), teamIds = {};
    const teamId = async (t) => {
      if (teamIds[t.id]) return teamIds[t.id];
      const r = await env.DB.prepare("INSERT INTO teams (league, abbr, full_name, bdl_id) VALUES ('NBA', ?, ?, ?) ON CONFLICT(bdl_id) DO UPDATE SET abbr=excluded.abbr, full_name=excluded.full_name RETURNING id")
        .bind(t.abbreviation, t.full_name, t.id).first();
      return (teamIds[t.id] = r.id);
    };
    for (const g of list) {
      const home = await teamId(g.home_team), away = await teamId(g.visitor_team);
      const state = g.status_state || (g.status === "Final" ? "final" : null);
      const row = await env.DB.prepare(
        `INSERT INTO games (league, season, start_time, home_team_id, away_team_id, status, status_detail, postseason, bdl_game_id, first_seen_at, updated_at)
         VALUES ('NBA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bdl_game_id) DO UPDATE SET start_time=excluded.start_time, status=excluded.status, status_detail=excluded.status_detail, updated_at=excluded.updated_at
         RETURNING id`
      ).bind(g.season ?? null, g.datetime || g.date + "T00:00:00.000Z", home, away, state, g.status ?? null, g.postseason ? 1 : 0, g.id, now, now).first();
      rows++;
      if (state === "final" && g.home_team_score != null && g.visitor_team_score != null) {
        const r = await env.DB.prepare("INSERT INTO game_results (game_id, home_score, away_score, source, finalized_at) VALUES (?, ?, ?, 'balldontlie', ?) ON CONFLICT(game_id) DO NOTHING")
          .bind(row.id, g.home_team_score, g.visitor_team_score, now).run();
        rows += r.meta.changes || 0;
      }
    }
    await endRun(env, id, { ok: true, rows, note: `${list.length} games for ${dates.join(", ")}` });
  } catch (e) {
    await endRun(env, id, { ok: false, rows, note: String(e.message || e).slice(0, 300) });
  }
}

/* ---------- when to spend an odds credit ----------
   One call returns every NBA game, so we call only at useful moments:
   once each morning (from 10 am ET) and when any game reaches 6 h, 2 h or 30 min before tip-off. */
const WINDOWS_MIN = [360, 120, 30];
async function oddsDue(env) {
  const now = Date.now();
  const upcoming = (await env.DB.prepare("SELECT start_time FROM games WHERE league='NBA' AND start_time > ? AND start_time < ? AND (status IS NULL OR status IN ('scheduled','delayed'))")
    .bind(new Date(now).toISOString(), new Date(now + 20 * 3600e3).toISOString()).all()).results;
  if (!upcoming.length) return { due: false, reason: "no NBA games in the next 20 hours" };
  const last = await env.DB.prepare("SELECT started_at FROM ingestion_runs WHERE job='odds' AND ok=1 ORDER BY started_at DESC LIMIT 1").first();
  const lastT = last ? Date.parse(last.started_at) : 0;
  const etHour = +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date(now));
  if (etHour >= 10 && (!last || etDate(0, lastT) !== etDate(0, now))) return { due: true, reason: "morning snapshot" };
  for (const g of upcoming) {
    const s = Date.parse(g.start_time);
    for (const w of WINDOWS_MIN) {
      const t = s - w * 60000;
      if (now >= t && lastT < t) return { due: true, reason: `${w} min before a ${g.start_time} tip-off` };
    }
  }
  return { due: false, reason: "no snapshot window reached" };
}

/* ---------- budget guard: never run the odds account dry ---------- */
async function oddsBudget(env) {
  const dailyMax = +env.ODDS_DAILY_MAX || 12, minRemaining = +env.ODDS_MIN_REMAINING || 25;
  const dayStart = new Date(Date.now() - 24 * 3600e3).toISOString();
  const today = await env.DB.prepare("SELECT COUNT(*) AS n FROM ingestion_runs WHERE job='odds' AND started_at > ?").bind(dayStart).first();
  if (today.n >= dailyMax) return { ok: false, reason: `daily cap reached (${today.n}/${dailyMax} calls in 24 h)` };
  const rem = await env.DB.prepare("SELECT credits_remaining AS r FROM ingestion_runs WHERE job='odds' AND credits_remaining IS NOT NULL ORDER BY started_at DESC LIMIT 1").first();
  if (rem && rem.r < minRemaining) return { ok: false, reason: `only ${rem.r} credits left (keeping ${minRemaining} in reserve)` };
  return { ok: true };
}

/* ---------- job: moneyline snapshot (The Odds API) ---------- */
async function snapshotOdds(env, why) {
  const id = await startRun(env, "odds");
  let rows = 0;
  try {
    const { events, usage } = await oddsMoneylines(env);
    const now = nowIso(), nowMs = Date.now();
    const teams = (await env.DB.prepare("SELECT id, full_name FROM teams WHERE league='NBA'").all()).results;
    const byName = Object.fromEntries(teams.map((t) => [normTeam(t.full_name), t.id]));
    const stmts = [];
    for (const ev of events) {
      const h = byName[normTeam(ev.home_team)], a = byName[normTeam(ev.away_team)];
      if (h && a) {
        // link this odds event to at most ONE game (the closest in time), never one already linked;
        // done on its own so a bad game record (e.g. a duplicate) can't stop prices from being saved
        try {
          await env.DB.prepare(
            `UPDATE games SET odds_event_id = ? WHERE id = (
               SELECT id FROM games WHERE odds_event_id IS NULL AND home_team_id = ? AND away_team_id = ?
                 AND abs(julianday(start_time) - julianday(?)) * 24 < 12
               ORDER BY abs(julianday(start_time) - julianday(?)) LIMIT 1)
             AND NOT EXISTS (SELECT 1 FROM games WHERE odds_event_id = ?)`
          ).bind(ev.id, h, a, ev.commence_time, ev.commence_time, ev.id).run();
        } catch (e) { /* left unmatched; the odds_unmatched quality check reports it */ }
      }
      const live = Date.parse(ev.commence_time) <= nowMs ? 1 : 0;
      for (const b of ev.bookmakers || []) for (const m of b.markets || []) for (const o of m.outcomes || []) {
        const side = o.name === ev.home_team ? "home" : o.name === ev.away_team ? "away" : "draw";
        stmts.push(env.DB.prepare(
          `INSERT INTO odds_snapshots (odds_event_id, commence_time, home_team, away_team, book, market, outcome, side, point, price, is_live, book_updated_at, captured_at, run_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
        ).bind(ev.id, ev.commence_time, ev.home_team, ev.away_team, b.key, m.key, o.name, side, o.point ?? null, Math.round(o.price), live, m.last_update || b.last_update || null, now, id));
      }
    }
    for (let i = 0; i < stmts.length; i += 50) {
      const res = await env.DB.batch(stmts.slice(i, i + 50));
      rows += res.reduce((s, r, j) => s + (stmts[i + j] && r.meta && r.meta.changes ? r.meta.changes : 0), 0);
    }
    await endRun(env, id, { ok: true, rows, used: usage.last, remaining: usage.remaining, note: `${events.length} events; ${why}` });
  } catch (e) {
    await endRun(env, id, { ok: false, rows, used: e.usage && e.usage.last, remaining: e.usage && e.usage.remaining, note: String(e.message || e).slice(0, 300) });
  }
}

/* ---------- schedules (see wrangler.toml) ---------- */
async function runCron(cron, env) {
  if (cron === "15 10 * * *") {
    // nightly: re-read the last three days so late final scores are captured, then grade predictions
    await syncGames(env, [etDate(-3), etDate(-2), etDate(-1)]);
    await gradePredictions(env, startRun, endRun);
    await runQualityChecks(env, startRun, endRun, true); // nightly: every check, including the season-wide ones
    return;
  }
  // every 30 minutes: refresh yesterday, today and tomorrow, grade finished predictions,
  // advance the free history backfill, then take an odds snapshot if one is due
  await syncGames(env, [etDate(-1), etDate(0), etDate(1)]);
  await gradePredictions(env, startRun, endRun);
  await backfillStep(env, startRun, endRun);
  await runQualityChecks(env, startRun, endRun);
  const due = await oddsDue(env);
  if (!due.due) return;
  const budget = await oddsBudget(env);
  if (!budget.ok) {
    const id = await startRun(env, "odds-skipped");
    await endRun(env, id, { ok: true, note: `${due.reason}; skipped: ${budget.reason}` });
    return;
  }
  await snapshotOdds(env, due.reason);
}

/* ---------- read-only API for the website ---------- */
function json(env, body, status = 200) {
  return new Response(JSON.stringify(body, null, 1), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60", "access-control-allow-origin": env.ALLOWED_ORIGIN || "*" },
  });
}
async function handle(req, env) {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/admin/")) return handleAdmin(req, env, url);
  if (req.method !== "GET") return json(env, { error: "read-only" }, 405);
  if (url.pathname === "/models") { const r = await listModels(env); return json(env, r.body, r.status); }
  if (url.pathname === "/budget") { const r = await budgetStatus(env); return json(env, r.body, r.status); }
  if (url.pathname === "/quality") { const r = await qualityStatus(env); return json(env, r.body, r.status); }
  if (url.pathname === "/nba/context") { const r = await gameContext(env, url); return json(env, r.body, r.status); }
  if (url.pathname === "/explain") { const r = await publicExplanation(env, url); return json(env, r.body, r.status); }
  if (url.pathname === "/" || url.pathname === "/health") {
    const runs = (await env.DB.prepare("SELECT job, started_at, finished_at, ok, rows_written, credits_used, credits_remaining, note FROM ingestion_runs ORDER BY id DESC LIMIT 20").all()).results;
    const count = async (t) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n;
    return json(env, {
      service: "closer-data", mode: env.MOCK === "1" ? "MOCK (local test data)" : "live",
      counts: { teams: await count("teams"), games: await count("games"), game_results: await count("game_results"), odds_snapshots: await count("odds_snapshots") },
      recent_runs: runs,
    });
  }
  if (url.pathname === "/nba/games") {
    const date = url.searchParams.get("date") || etDate(0);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(env, { error: "date must be YYYY-MM-DD" }, 400);
    // an ET calendar day runs from about 04:00/05:00 UTC to the same time next day; use 10:00 UTC bounds to be safe for evening tip-offs
    const from = date + "T10:00:00.000Z", to = new Date(Date.parse(from) + 864e5).toISOString();
    const rows = (await env.DB.prepare(
      `SELECT g.id, g.start_time, g.status, g.status_detail, h.abbr AS home, a.abbr AS away, h.full_name AS home_name, a.full_name AS away_name,
              r.home_score, r.away_score, r.finalized_at, g.odds_event_id,
              (SELECT COUNT(*) FROM odds_snapshots o WHERE o.odds_event_id = g.odds_event_id) AS odds_rows
       FROM games g JOIN teams h ON h.id = g.home_team_id JOIN teams a ON a.id = g.away_team_id LEFT JOIN game_results r ON r.game_id = g.id
       WHERE g.league='NBA' AND g.start_time >= ? AND g.start_time < ? ORDER BY g.start_time`
    ).bind(from, to).all()).results;
    return json(env, { date, games: rows });
  }
  if (url.pathname === "/nba/odds") {
    const gid = +url.searchParams.get("game_id");
    if (!gid) return json(env, { error: "game_id required" }, 400);
    const g = await env.DB.prepare("SELECT odds_event_id FROM games WHERE id = ?").bind(gid).first();
    if (!g || !g.odds_event_id) return json(env, { game_id: gid, snapshots: [] });
    const rows = (await env.DB.prepare("SELECT book, market, side, outcome, price, point, is_live, book_updated_at, captured_at FROM odds_snapshots WHERE odds_event_id = ? ORDER BY captured_at, book, side")
      .bind(g.odds_event_id).all()).results;
    return json(env, { game_id: gid, snapshots: rows });
  }
  return json(env, { error: "not found" }, 404);
}

/* ---------- token-protected routes: model pipeline ("model") and QC ("qc") ---------- */
async function handleAdmin(req, env, url) {
  const scope = scopeOf(req, env);
  const send = (r) => new Response(JSON.stringify(r.body, null, 1), { status: r.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  if (!scope) return send({ status: 401, body: { error: "missing or invalid token" } });
  const body = req.method === "POST" ? await req.json().catch(() => null) : null;
  const route = `${req.method} ${url.pathname}`;
  const allow = {
    "POST /admin/models": ["model"],
    "POST /admin/predictions": ["model"],
    "GET /admin/predictions": ["model", "qc"],
    "GET /admin/chain": ["qc"],
    "GET /admin/results": ["model", "qc"],
    "GET /admin/context": ["model", "qc"],
    "POST /admin/qc/evaluations": ["qc"],
  }[route];
  if (!allow) return send({ status: 404, body: { error: "not found" } });
  if (!allow.includes(scope)) return send({ status: 403, body: { error: `the ${scope} token can't do ${route}` } });
  if (route === "POST /admin/models") return send(await registerModel(env, body));
  if (route === "POST /admin/predictions") return send(await submitPredictions(env, body));
  if (route === "GET /admin/predictions") return send(await readPredictions(env, url));
  if (route === "GET /admin/chain") return send(await readChain(env));
  if (route === "GET /admin/results") return send(await readResults(env));
  if (route === "GET /admin/context") return send(await seasonContext(env, url));
  return send(await recordQc(env, body));
}

// Local testing only (COUNT_QUERIES=1 in .dev.vars): count database calls per request, since
// Cloudflare's free plan limits queries per invocation (a batch counts as one).
function counted(env) {
  if (env.COUNT_QUERIES !== "1") return { env, n: () => null };
  let n = 0;
  const wrapStmt = (s) => new Proxy(s, { get: (t, k) => (k === "__raw" ? t : ["first", "all", "run", "raw"].includes(k) ? (...a) => { n++; return t[k](...a); }
    : k === "bind" ? (...a) => wrapStmt(t.bind(...a)) : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
  const db = new Proxy(env.DB, { get: (t, k) => (k === "prepare" ? (sql) => wrapStmt(t.prepare(sql))
    : k === "batch" ? (stmts) => { n++; return t.batch(stmts.map((s) => s.__raw || s)); } : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
  return { env: { ...env, DB: db }, n: () => n };
}

export default {
  async fetch(req, env) {
    const c = counted(env);
    try {
      const res = await handle(req, c.env);
      if (c.n() != null) { const h = new Headers(res.headers); h.set("x-db-queries", String(c.n())); return new Response(res.body, { status: res.status, headers: h }); }
      return res;
    } catch (e) { return json(env, { error: "server error" }, 500); }
  },
  async scheduled(event, env, ctx) {
    const c = counted(env);
    ctx.waitUntil(runCron(event.cron, c.env).then(() => { if (c.n() != null) console.log(`cron ${event.cron}: ${c.n()} database queries`); }));
  },
};
