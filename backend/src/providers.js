// Talks to the data providers. API keys come from Cloudflare secrets (env), never from the website.
// When MOCK=1 (local testing only) it returns obviously fake games and prices instead of calling anyone.

const num = (v) => (v == null || v === "" || isNaN(+v) ? null : +v);

// balldontlie: NBA games for the given ET dates (YYYY-MM-DD). Free tier, 5 requests/minute.
export async function bdlGames(env, dates) {
  if (env.MOCK === "1") return mockBdlGames();
  const out = [];
  let cursor = null;
  for (let page = 0; page < 3; page++) {
    const qs = dates.map((d) => "dates[]=" + encodeURIComponent(d)).join("&") + "&per_page=100" + (cursor ? "&cursor=" + cursor : "");
    const r = await fetch("https://api.balldontlie.io/v1/games?" + qs, { headers: { Authorization: env.BDL_API_KEY } });
    if (!r.ok) throw new Error(`balldontlie HTTP ${r.status}`);
    const j = await r.json();
    out.push(...(j.data || []));
    cursor = j.meta && j.meta.next_cursor;
    if (!cursor) break;
  }
  return out;
}

// balldontlie: one page (up to 100) of a past season's games, for the free history backfill.
export async function bdlSeasonPage(env, season, cursor) {
  if (env.MOCK === "1") return mockSeasonPage(season, cursor);
  const qs = `seasons[]=${encodeURIComponent(season)}&per_page=100` + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
  const r = await fetch("https://api.balldontlie.io/v1/games?" + qs, { headers: { Authorization: env.BDL_API_KEY } });
  if (!r.ok) throw new Error(`balldontlie HTTP ${r.status}`);
  const j = await r.json();
  return { data: j.data || [], next_cursor: (j.meta && j.meta.next_cursor) || null };
}

// The Odds API: NBA moneylines (h2h) from US books. Costs 1 credit per call (1 market x 1 region).
export async function oddsMoneylines(env) {
  if (env.MOCK === "1") return mockOdds();
  const url = "https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?regions=us&markets=h2h&oddsFormat=american&dateFormat=iso";
  const r = await fetch(url, { headers: { "x-api-key": env.ODDS_API_KEY } });
  const usage = { remaining: num(r.headers.get("x-requests-remaining")), used: num(r.headers.get("x-requests-used")), last: num(r.headers.get("x-requests-last")) };
  if (!r.ok) { const e = new Error(`The Odds API HTTP ${r.status}`); e.usage = usage; throw e; }
  return { events: await r.json(), usage };
}

/* ---------------- local test data (MOCK=1 only) ----------------
   Fictional teams and prices so the pipeline can be tested without accounts.
   "LA Placeholders" vs "Los Angeles Placeholders" deliberately tests team-name matching. */
const T = {
  tst: { id: 9001, abbreviation: "TST", full_name: "Testville Testers" },
  mck: { id: 9002, abbreviation: "MCK", full_name: "Mockton Mocks" },
  lap: { id: 9003, abbreviation: "LAP", full_name: "LA Placeholders" },
};
const minutes = (m) => new Date(Date.now() + m * 60000);
const etDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
function mockStarts() {
  // fixed per hour so repeated runs line up: an upcoming game, a live game, a finished game
  const hour = new Date(); hour.setUTCMinutes(0, 0, 0);
  return { upcoming: new Date(hour.getTime() + 3 * 3600e3), live: new Date(hour.getTime() - 3600e3), final: new Date(hour.getTime() - 26 * 3600e3) };
}
function mockBdlGames() {
  const s = mockStarts();
  const g = (id, start, home, away, state, status, hs, vs) => ({ id, date: etDay(start), datetime: start.toISOString(), season: 2026, status, status_state: state, period: state === "final" ? 4 : state === "in_progress" ? 2 : 0, time: "", postseason: false, home_team_score: hs, visitor_team_score: vs, home_team: home, visitor_team: away });
  return [
    g(990001, s.upcoming, T.tst, T.mck, "scheduled", "7:00 pm ET", 0, 0),
    g(990002, s.live, T.lap, T.tst, "in_progress", "2nd Qtr", 51, 48),
    g(990003, s.final, T.mck, T.lap, "final", "Final", 112, 104),
  ];
}
function mockSeasonPage(season, cursor) {
  // 3 fictional finished games per page, 2 pages per season
  const page = cursor ? 2 : 1, base = Date.UTC(season, 10, 1) + (page - 1) * 3 * 864e5;
  const pairs = [[T.tst, T.mck], [T.mck, T.lap], [T.lap, T.tst]];
  const data = pairs.map(([home, away], i) => {
    const start = new Date(base + i * 864e5);
    return { id: 800000 + season * 10 + page * 3 + i, date: etDay(start), datetime: start.toISOString(), season, status: "Final", status_state: "final", period: 4, time: "Final", postseason: false,
      home_team_score: 100 + i * 3, visitor_team_score: 98 + page * 2, home_team: home, visitor_team: away };
  });
  return { data, next_cursor: page === 1 ? "mock-cursor-2" : null };
}
function mockOdds() {
  const s = mockStarts();
  const bucket = Math.floor(Date.now() / (30 * 60000)); // prices change every 30 minutes
  const upd = new Date(bucket * 30 * 60000).toISOString();
  const ev = (id, start, home, away, base) => ({
    id, sport_key: "basketball_nba", commence_time: start.toISOString(), home_team: home, away_team: away,
    bookmakers: ["mockbook_one", "mockbook_two"].map((key, i) => ({
      key, title: key, last_update: upd,
      markets: [{ key: "h2h", last_update: upd, outcomes: [
        { name: home, price: base - 5 * (bucket % 3) - 10 * i },
        { name: away, price: -base + 15 + 5 * (bucket % 3) },
      ] }],
    })),
  });
  return {
    events: [
      ev("mock-evt-upcoming", s.upcoming, "Testville Testers", "Mockton Mocks", -150),
      ev("mock-evt-live", s.live, "Los Angeles Placeholders", "Testville Testers", -130),
    ],
    usage: { remaining: 480, used: 20, last: 1 },
  };
}
