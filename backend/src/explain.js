// M3: the explainable prediction record.
// A prediction must arrive with an explanation whose contributions add up EXACTLY to its probability,
// and with evidence links the server verifies (exist, older than the prediction). The data-quality
// stamp and the plain-English reasons are produced here, by the server, never by the model.

const MAX_CONTRIB = 30, MAX_EVIDENCE = 200;
export const GROUPS = ["baseline", "team strength", "home court", "rest & schedule", "travel", "recent form", "market", "other"];
const sig = (z) => 1 / (1 + Math.exp(-z));
const pts = (x) => (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(1);

// Build the stored explanation, or return { error } explaining why it's refused.
export async function buildExplanation(env, { gameId, probability, explanation, nowIso }) {
  const e = explanation;
  if (!e || typeof e !== "object") return { error: "explanation required" };
  if (e.method !== "additive_logit") return { error: "explanation.method must be 'additive_logit'" };
  const base = Number(e.base_logit);
  if (!Number.isFinite(base)) return { error: "explanation.base_logit must be a number" };
  const cs = Array.isArray(e.contributions) ? e.contributions : null;
  if (!cs || !cs.length || cs.length > MAX_CONTRIB) return { error: `explanation.contributions must have 1-${MAX_CONTRIB} items` };
  for (const c of cs) {
    if (typeof c.factor !== "string" || !c.factor || c.factor.length > 40) return { error: "each contribution needs a factor name (max 40 chars)" };
    if (!GROUPS.includes(c.group)) return { error: `contribution '${c.factor}': group must be one of ${GROUPS.join(", ")}` };
    if (!Number.isFinite(Number(c.logit))) return { error: `contribution '${c.factor}': logit must be a number` };
    if (c.detail != null && (typeof c.detail !== "string" || c.detail.length > 120)) return { error: `contribution '${c.factor}': detail max 120 chars` };
  }
  const total = base + cs.reduce((s, c) => s + Number(c.logit), 0);
  if (Math.abs(sig(total) - probability) > 1e-6)
    return { error: `explanation doesn't add up: base + contributions gives ${sig(total).toFixed(6)}, prediction says ${probability}` };

  // evidence: verified against stored data, ages computed here
  const ev = Array.isArray(e.evidence) ? e.evidence : [];
  if (!ev.length || ev.length > MAX_EVIDENCE) return { error: `explanation.evidence must have 1-${MAX_EVIDENCE} items` };
  const game = await env.DB.prepare("SELECT id, status, start_time, updated_at FROM games WHERE id = ?").bind(gameId).first();
  if (!game) return { error: "unknown game" };
  const now = Date.parse(nowIso), age = (t) => Math.round((now - Date.parse(t)) / 60000);
  const verified = [];
  for (const x of ev) {
    if (x.type === "results_through") {
      // "the model used every final score recorded before this time"
      if (typeof x.ref !== "string" || !(Date.parse(x.ref) <= now)) return { error: "results_through must be a time at or before now" };
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM game_results WHERE finalized_at <= ?").bind(x.ref).first();
      verified.push({ type: x.type, ref: x.ref, as_of: x.ref, age_minutes: age(x.ref), count: n.n });
    } else if (x.type === "game_result") {
      const r = await env.DB.prepare("SELECT g.start_time, r.finalized_at FROM game_results r JOIN games g ON g.id = r.game_id WHERE r.game_id = ?").bind(+x.ref).first();
      if (!r) return { error: `evidence game_result ${x.ref}: no final score stored` };
      if (!(r.start_time < game.start_time) || !(Date.parse(r.finalized_at) <= now)) return { error: `evidence game_result ${x.ref}: not available before this prediction` };
      verified.push({ type: x.type, ref: +x.ref, as_of: r.finalized_at, age_minutes: age(r.finalized_at) });
    } else if (x.type === "odds_snapshot") {
      const o = await env.DB.prepare("SELECT o.captured_at, o.book, o.side, o.price, g.id AS gid FROM odds_snapshots o LEFT JOIN games g ON g.odds_event_id = o.odds_event_id WHERE o.id = ?").bind(+x.ref).first();
      if (!o) return { error: `evidence odds_snapshot ${x.ref}: not found` };
      if (!(Date.parse(o.captured_at) <= now)) return { error: `evidence odds_snapshot ${x.ref}: captured after the prediction` };
      if (o.gid !== gameId) return { error: `evidence odds_snapshot ${x.ref}: belongs to a different game` };
      verified.push({ type: x.type, ref: +x.ref, as_of: o.captured_at, age_minutes: age(o.captured_at), book: o.book, side: o.side, price: o.price });
    } else if (x.type === "context" || x.type === "schedule") {
      if (+x.ref !== gameId) return { error: `evidence ${x.type}: must refer to the predicted game` };
      verified.push({ type: x.type, ref: gameId, as_of: game.updated_at, age_minutes: age(game.updated_at) });
    } else {
      return { error: `unknown evidence type '${x.type}' (allowed: results_through, game_result, odds_snapshot, context, schedule)` };
    }
  }

  // server-written data-quality stamp
  const dq = (await env.DB.prepare("SELECT check_name, status FROM data_quality WHERE status <> 'pass'").all()).results;
  const stamp = {
    game_status: game.status, game_confirmed_at: game.updated_at, game_confirmed_age_minutes: age(game.updated_at),
    active_failures: dq.filter((d) => d.status === "fail").map((d) => d.check_name),
    active_warnings: dq.filter((d) => d.status === "warn").map((d) => d.check_name),
    stamped_at: nowIso,
  };

  // server-written reasons: walk from the starting point through each contribution, in order
  let z = base;
  const reasons = [`Starting point: ${(sig(base) * 100).toFixed(1)}%`];
  for (const c of cs) {
    const before = sig(z); z += Number(c.logit);
    reasons.push(`${c.factor}: ${pts(sig(z) - before)} pts${c.detail ? ` (${c.detail})` : ""} → ${(sig(z) * 100).toFixed(1)}%`);
  }
  const contributions = cs.map((c) => ({ factor: c.factor, group: c.group, logit: Number(c.logit), detail: c.detail ?? null }));
  return { ok: true, base, contributions, reasons, evidence: verified, stamp, gameStart: game.start_time };
}

// Public view: factor GROUPS and their size (never raw factors or parameters), sources, freshness, settlement.
export async function publicExplanation(env, url) {
  const id = +url.searchParams.get("prediction_id");
  if (!id) return { status: 400, body: { error: "prediction_id required" } };
  const r = await env.DB.prepare(
    `SELECT p.id, p.model_version_id, p.kind, p.game_id, p.side, p.probability, p.market_price, p.market_book, p.created_at, p.hash,
            m.status AS model_status, e.base_logit, e.contributions_json, e.evidence_json, e.quality_stamp_json, e.game_start_at_prediction,
            s.result, s.reason AS settle_reason, s.home_score, s.away_score, s.settled_at,
            h.abbr AS home, a.abbr AS away
     FROM predictions p JOIN model_versions m ON m.id = p.model_version_id
     JOIN games g ON g.id = p.game_id JOIN teams h ON h.id = g.home_team_id JOIN teams a ON a.id = g.away_team_id
     LEFT JOIN prediction_explanations e ON e.prediction_id = p.id
     LEFT JOIN prediction_settlements s ON s.prediction_id = p.id WHERE p.id = ?`
  ).bind(id).first();
  if (!r) return { status: 404, body: { error: "prediction not found" } };
  const out = {
    prediction: { id: r.id, game: `${r.away} @ ${r.home}`, side: r.side, team: r.side === "home" ? r.home : r.away, probability: r.probability,
      model: r.model_version_id, model_status: r.model_status, kind: r.kind, logged_at: r.created_at, game_start: r.game_start_at_prediction,
      market_price_at_prediction: r.market_price, market_book: r.market_book, fingerprint: r.hash },
    settlement: r.result ? { result: r.result, reason: r.settle_reason, score: r.home_score != null ? `${r.away} ${r.away_score} – ${r.home} ${r.home_score}` : null, settled_at: r.settled_at } : { result: "pending" },
    track_record: { status: "coming in M5", note: "How similar predictions have performed will appear here once QC computes it." },
  };
  if (r.base_logit == null) return { status: 200, body: { ...out, explanation: null, note: "This prediction was logged before explanations existed." } };
  // group the contributions in the order they first appear, and show each group's effect in percentage points
  const cs = JSON.parse(r.contributions_json), groups = [];
  for (const c of cs) { let g = groups.find((x) => x.group === c.group); if (!g) groups.push((g = { group: c.group, logit: 0 })); g.logit += c.logit; }
  let z = r.base_logit;
  const why = [{ step: "starting point", probability: +(sig(z) * 100).toFixed(1) }];
  for (const g of groups) { const b = sig(z); z += g.logit; why.push({ step: g.group, effect_pts: +((sig(z) - b) * 100).toFixed(1), probability: +(sig(z) * 100).toFixed(1) }); }
  const ev = JSON.parse(r.evidence_json), byType = {};
  for (const x of ev) { const t = (byType[x.type] ||= { type: x.type, items: 0, newest_age_minutes: null, oldest_age_minutes: null, records: 0 });
    t.items++; t.records += x.count || 1;
    t.newest_age_minutes = t.newest_age_minutes == null ? x.age_minutes : Math.min(t.newest_age_minutes, x.age_minutes);
    t.oldest_age_minutes = t.oldest_age_minutes == null ? x.age_minutes : Math.max(t.oldest_age_minutes, x.age_minutes); }
  return { status: 200, body: { ...out, explanation: { why, data_used: Object.values(byType), data_quality_at_prediction: JSON.parse(r.quality_stamp_json) } } };
}
