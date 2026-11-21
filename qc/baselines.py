"""Baselines every model must beat (docs/VALIDATION.md section 2), built only from stored results.

B1 home rate:    the home team's win rate in games before the training cutoff.
B2 record model: logistic model on (home season-to-date win% - away season-to-date win%),
                 fitted on games before the cutoff, using only games completed before each game.
"""
from __future__ import annotations

from collections import defaultdict

import numpy as np

from metrics import fit_logistic


def season_to_date_diffs(games: list[dict]) -> dict[int, float]:
    """For every game id: home win% minus away win%, using only earlier games of the same season.
    A team with no games yet counts as .500."""
    out: dict[int, float] = {}
    rec: dict[tuple, list[int]] = defaultdict(lambda: [0, 0])  # (season, team) -> [wins, games]
    for g in sorted(games, key=lambda r: (r["start_time"], r["game_id"])):
        s = g["season"]
        h, a = rec[(s, g["home_team_id"])], rec[(s, g["away_team_id"])]
        wp = lambda r: r[0] / r[1] if r[1] else 0.5
        out[g["game_id"]] = wp(h) - wp(a)
        home_won = 1 if g["home_score"] > g["away_score"] else 0
        h[0] += home_won
        h[1] += 1
        a[0] += 1 - home_won
        a[1] += 1
    return out


class Baselines:
    def __init__(self, games: list[dict], cutoff: str | None):
        self.games = {g["game_id"]: g for g in games}
        self.diff = season_to_date_diffs(games)
        train = [g for g in games if cutoff is None or g["start_time"] < cutoff]
        if len(train) < 100:
            raise ValueError(f"only {len(train)} completed games before the cutoff; need at least 100 for baselines")
        y = np.array([1 if g["home_score"] > g["away_score"] else 0 for g in train], dtype=float)
        self.home_rate = float(y.mean())
        self.b2 = fit_logistic(np.array([self.diff[g["game_id"]] for g in train]), y)
        self.n_train = len(train)

    def home_prob(self, game_id: int, which: str) -> float:
        if which == "B1":
            return self.home_rate
        a, b = self.b2
        return float(1 / (1 + np.exp(-(a + b * self.diff[game_id]))))

    def prob_for(self, game_id: int, side: str, which: str) -> float:
        ph = self.home_prob(game_id, which)
        return ph if side == "home" else 1 - ph
