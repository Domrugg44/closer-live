"""Unit tests for QC metrics, baselines and the fingerprint check. Run: python -m pytest qc -q"""
import hashlib
import math
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(__file__))
import metrics as M  # noqa: E402
from baselines import Baselines, season_to_date_diffs  # noqa: E402
from evaluate import SEP, gate_a, js_str, verify_chain, verify_explanations  # noqa: E402


def test_explanations_must_add_up():
    import json
    ok = {"id": 1, "probability": 1 / (1 + math.exp(-0.5)), "base_logit": 0.2, "contributions_json": json.dumps([{"logit": 0.3}])}
    bad = {"id": 2, "probability": 0.9, "base_logit": 0.2, "contributions_json": json.dumps([{"logit": 0.3}])}
    old = {"id": 3, "probability": 0.6, "base_logit": None}
    assert verify_explanations([ok, old]) == []
    assert len(verify_explanations([bad])) == 1


def test_log_loss_and_brier_known_values():
    assert M.log_loss([1, 0], [0.5, 0.5]) == pytest.approx(math.log(2))
    assert M.brier([1, 0], [1.0, 0.0]) == 0
    assert M.brier([1, 0], [0.5, 0.5]) == pytest.approx(0.25)


def test_calibrated_forecasts_score_well():
    rng = np.random.default_rng(1)
    p = rng.uniform(0.2, 0.8, 20000)
    y = (rng.uniform(size=p.size) < p).astype(float)
    assert M.ece(y, p) < 0.02
    a, s = M.calibration_slope(y, p)
    assert s == pytest.approx(1.0, abs=0.08) and a == pytest.approx(0.0, abs=0.05)


def test_overconfident_forecasts_are_caught():
    rng = np.random.default_rng(2)
    p_true = rng.uniform(0.3, 0.7, 20000)
    y = (rng.uniform(size=p_true.size) < p_true).astype(float)
    p_over = 1 / (1 + np.exp(-3 * np.log(p_true / (1 - p_true))))  # exaggerated confidence
    _, s = M.calibration_slope(y, p_over)
    assert s < 0.5 and M.ece(y, p_over) > 0.05


def test_bootstrap_ci_contains_true_difference():
    a = np.full(1000, 0.65)
    b = np.full(1000, 0.70)
    mean, lo, hi = M.paired_bootstrap_diff(a, b)
    assert mean == pytest.approx(-0.05) and lo <= mean <= hi


def _games(n_seasons=2, per=120):
    rng = np.random.default_rng(3)
    out, gid = [], 0
    for s in range(2020, 2020 + n_seasons):
        for i in range(per):
            gid += 1
            h, a = rng.choice(6, 2, replace=False)
            home_win = rng.uniform() < 0.58
            out.append({"game_id": gid, "season": s, "start_time": f"{s}-11-{1 + i // 10:02d}T{i % 10:02d}:00:00Z",
                        "home_team_id": int(h), "away_team_id": int(a), "home_score": 110 if home_win else 100, "away_score": 100 if home_win else 110})
    return out


def test_season_to_date_uses_only_earlier_games():
    g = _games(1, 3)
    d = season_to_date_diffs(g)
    assert d[g[0]["game_id"]] == 0.0  # first game of the season: both teams .500 by convention


def test_baselines_fit_and_need_enough_history():
    g = _games()
    b = Baselines(g, "2021-01-01")
    assert 0.4 < b.home_rate < 0.75
    assert 0 < b.home_prob(g[-1]["game_id"], "B2") < 1
    with pytest.raises(ValueError):
        Baselines(g, "2020-11-02")


def test_gate_a_rejects_small_or_uncalibrated_samples():
    m = {"n": 500, "seasons": [2024], "log_loss": 0.70, "brier": 0.25, "ece": 0.08, "cal_slope": 0.5,
         "baselines": {"B1": {"log_loss": 0.68, "brier": 0.24}, "B2": {"log_loss": 0.66, "brier": 0.23}},
         "diff_vs_B2_log_loss": {"mean": 0.04, "ci95": [0.01, 0.07]}}
    f = gate_a(m)
    assert len(f) >= 6


def test_js_number_formatting_matches_worker():
    assert js_str(0.62) == "0.62" and js_str(1.0) == "1" and js_str(-165) == "-165" and js_str(None) == ""


def test_chain_detects_tampering():
    def mk(i, prev, prob):
        p = {"id": i, "model_version_id": "m@1.0.0", "kind": "live", "game_id": i, "market": "moneyline", "side": "home",
             "probability": prob, "inputs_hash": "x", "market_price": None, "market_book": None, "market_captured_at": None,
             "model_status_at_time": "testing", "created_at": "2026-11-21T00:00:00Z", "prev_hash": prev}
        locked = [p[k] for k in ("model_version_id", "kind", "game_id", "market", "side", "probability", "inputs_hash",
                                 "market_price", "market_book", "market_captured_at", "model_status_at_time", "created_at")]
        p["hash"] = hashlib.sha256((prev + SEP + SEP.join(js_str(v) for v in locked)).encode()).hexdigest()
        return p
    a = mk(1, "", 0.6)
    b = mk(2, a["hash"], 0.55)
    assert verify_chain([a, b]) == []
    b["probability"] = 0.9
    assert any("does not match" in x for x in verify_chain([a, b]))
