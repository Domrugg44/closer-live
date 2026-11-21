"""Independent cross-check of the database's game context (M2).

Recomputes rest days, back-to-backs, games in the last 7 days, travel and time-zone change from the
raw schedule with separate Python code, and compares every value with the game_team_context view.
Usage: python qc/check_context.py --season 2021   (env CLOSER_API_BASE, CLOSER_TOKEN = QC or model token)
"""
from __future__ import annotations

import argparse
import datetime as dt
import math
import os
import sys
from collections import defaultdict

import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
from gen_context_sql import VENUES  # noqa: E402  (same public arena facts; independent math below)


def et_date(iso: str) -> dt.date:
    return (dt.datetime.fromisoformat(iso.replace("Z", "+00:00")) - dt.timedelta(hours=5)).date()


def venue_for(abbr: str, day: str):
    for v in VENUES:
        if v[0] == abbr and (v[5] is None or day >= v[5]) and (v[6] is None or day < v[6]):
            return v
    return None


def km(a, b) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[2], a[3], b[2], b[3]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, required=True)
    args = ap.parse_args()
    base = os.environ.get("CLOSER_API_BASE", "https://closer-data.closer-data.workers.dev").rstrip("/")
    tok = (os.environ.get("CLOSER_TOKEN") or "").strip().lstrip("﻿")
    h = {"Authorization": f"Bearer {tok}"}
    view = requests.get(f"{base}/admin/context", params={"season": args.season}, headers=h, timeout=120).json()["rows"]
    games = [g for g in requests.get(f"{base}/admin/results", headers=h, timeout=120).json()["games"] if g["season"] == args.season]
    abbr = {r["team_id"]: r["team"] for r in view}

    by_team = defaultdict(list)
    for g in games:
        by_team[g["home_team_id"]].append((g["start_time"], g["game_id"], g["home_team_id"]))
        by_team[g["away_team_id"]].append((g["start_time"], g["game_id"], g["home_team_id"]))
    mine = {}
    for team, lst in by_team.items():
        lst.sort()
        for i, (st, gid, host) in enumerate(lst):
            v_now = venue_for(abbr[host], st[:10])
            if i == 0:
                mine[(gid, team)] = dict(rest_days=None, back_to_back=0, first_game_of_season=1, games_last_7d=0, travel_km=None, tz_shift_hours=None)
                continue
            pst, _, phost = lst[i - 1]
            v_prev = venue_for(abbr[phost], pst[:10])
            t = dt.datetime.fromisoformat(st.replace("Z", "+00:00"))
            n7 = sum(1 for s, _, _ in lst[:i] if t - dt.timedelta(days=7) <= dt.datetime.fromisoformat(s.replace("Z", "+00:00")) < t)
            gap = (et_date(st) - et_date(pst)).days
            mine[(gid, team)] = dict(rest_days=gap - 1, back_to_back=1 if gap == 1 else 0, first_game_of_season=0, games_last_7d=n7,
                                     travel_km=round(km(v_prev, v_now), 1), tz_shift_hours=v_now[4] - v_prev[4])

    checked, mismatches = 0, []
    for r in view:
        key = (r["game_id"], r["team_id"])
        if key not in mine:
            continue  # scheduled or unplayed games aren't in the results list
        checked += 1
        for f, val in mine[key].items():
            got = r[f]
            ok = (got is None and val is None) or (got is not None and val is not None and abs(float(got) - float(val)) < 0.15)
            if not ok:
                mismatches.append(f"game {r['game_id']} {r['team']} {f}: view={got} python={val}")
    b2b = sum(1 for v in mine.values() if v["back_to_back"])
    print(f"season {args.season}: {checked} team-games compared, {len(mismatches)} mismatches; back-to-backs found: {b2b}")
    for m in mismatches[:15]:
        print("  " + m)
    return 1 if mismatches or checked == 0 else 0


if __name__ == "__main__":
    sys.exit(main())
