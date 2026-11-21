"""Closer independent Quality Control (docs/VALIDATION.md, standard v1.0).

Runs on GitHub Actions with the QC token, which is separate from the model pipeline's token.
For every model version it:
  1. re-checks the fingerprint chain over ALL predictions,
  2. recomputes the standard's metrics itself from logged predictions and stored final scores,
  3. compares against baselines B1/B2 built from stored results only,
  4. records a QC evaluation (pass/fail + reasons). It can never change a model's status:
     that needs the CEO, using the evaluation as evidence.

Usage:  python qc/evaluate.py [--dry-run] [--model MODEL_VERSION_ID]
Env:    CLOSER_API_BASE (default: the live collector), CLOSER_QC_TOKEN (required)
"""
from __future__ import annotations

import argparse
import hashlib
import os
import subprocess
import sys

import numpy as np
import requests

sys.path.insert(0, os.path.dirname(__file__))
import metrics as M  # noqa: E402
from baselines import Baselines  # noqa: E402

STANDARD = "1.0"
SEP = "\x1f"
GATE_A = {"min_games": 2000, "min_seasons": 2, "ece_max": 0.03, "slope": (0.80, 1.20)}
GATE_B = {"min_games": 300, "ece_max": 0.05, "slope": (0.80, 1.20), "max_drift": 0.010}
MONITOR = {"window": 200, "ece_max": 0.07}
VALUE = {"min_games": 500}


def js_str(v) -> str:
    """Match the Worker's String(v) for the values we hash."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    return str(v)


def verify_chain(preds: list[dict]) -> list[str]:
    problems, prev = [], ""
    for p in preds:
        locked = [p["model_version_id"], p["kind"], p["game_id"], p["market"], p["side"], p["probability"], p["inputs_hash"],
                  p["market_price"], p["market_book"], p["market_captured_at"], p["model_status_at_time"], p["created_at"]]
        if p["prev_hash"] != prev:
            problems.append(f"prediction {p['id']}: does not link to the previous prediction")
        h = hashlib.sha256((p["prev_hash"] + SEP + SEP.join(js_str(v) for v in locked)).encode()).hexdigest()
        if h != p["hash"]:
            problems.append(f"prediction {p['id']}: fingerprint does not match its contents")
        prev = p["hash"]
    return problems


class Api:
    def __init__(self, base: str, token: str):
        self.base, self.s = base.rstrip("/"), requests.Session()
        self.s.headers["Authorization"] = f"Bearer {token}"

    def get(self, path, **params):
        r = self.s.get(self.base + path, params=params, timeout=60)
        r.raise_for_status()
        return r.json()

    def post(self, path, body):
        r = self.s.post(self.base + path, json=body, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"{path}: {r.status_code} {r.text[:200]}")
        return r.json()


def score(rows: list[dict], base: Baselines) -> dict:
    y = np.array([r["outcome"] for r in rows], dtype=float)
    p = np.array([r["probability"] for r in rows], dtype=float)
    b1 = np.array([base.prob_for(r["game_id"], r["side"], "B1") for r in rows])
    b2 = np.array([base.prob_for(r["game_id"], r["side"], "B2") for r in rows])
    ll, ll1, ll2 = M.log_loss_each(y, p), M.log_loss_each(y, b1), M.log_loss_each(y, b2)
    a, s = M.calibration_slope(y, p) if len(set(y)) > 1 else (float("nan"), float("nan"))
    d2 = M.paired_bootstrap_diff(ll, ll2)
    return {
        "n": len(rows), "seasons": sorted({r["season"] for r in rows}),
        "log_loss": float(ll.mean()), "brier": M.brier(y, p), "accuracy": M.accuracy(y, p),
        "ece": M.ece(y, p), "cal_intercept": a, "cal_slope": s,
        "baselines": {"B1": {"log_loss": float(ll1.mean()), "brier": M.brier(y, b1)},
                      "B2": {"log_loss": float(ll2.mean()), "brier": M.brier(y, b2)}},
        "diff_vs_B2_log_loss": {"mean": d2[0], "ci95": [d2[1], d2[2]]},
    }


def gate_a(m: dict) -> list[str]:
    f = []
    if m["n"] < GATE_A["min_games"]: f.append(f"needs >= {GATE_A['min_games']} games (has {m['n']})")
    if len(m["seasons"]) < GATE_A["min_seasons"]: f.append(f"needs >= {GATE_A['min_seasons']} holdout seasons (has {len(m['seasons'])})")
    if not m["log_loss"] < m["baselines"]["B1"]["log_loss"]: f.append("log loss not better than B1")
    if not m["diff_vs_B2_log_loss"]["ci95"][1] < 0: f.append("log loss not better than B2 with 95% confidence")
    if not m["brier"] < min(m["baselines"]["B1"]["brier"], m["baselines"]["B2"]["brier"]): f.append("Brier not better than both baselines")
    if not m["ece"] <= GATE_A["ece_max"]: f.append(f"ECE {m['ece']:.3f} > {GATE_A['ece_max']}")
    lo, hi = GATE_A["slope"]
    if not lo <= m["cal_slope"] <= hi: f.append(f"calibration slope {m['cal_slope']:.2f} outside {lo}-{hi}")
    return f


def gate_b(m: dict, backtest_ll: float | None) -> list[str]:
    f = []
    if m["n"] < GATE_B["min_games"]: f.append(f"needs >= {GATE_B['min_games']} live games (has {m['n']})")
    if not m["log_loss"] < min(m["baselines"]["B1"]["log_loss"], m["baselines"]["B2"]["log_loss"]): f.append("log loss not better than B1 and B2")
    if backtest_ll is None: f.append("no passing backtest evaluation to compare drift against")
    elif m["log_loss"] - backtest_ll > GATE_B["max_drift"]: f.append(f"log loss drifted {m['log_loss'] - backtest_ll:+.3f} from backtest (> {GATE_B['max_drift']})")
    if not m["ece"] <= GATE_B["ece_max"]: f.append(f"ECE {m['ece']:.3f} > {GATE_B['ece_max']}")
    lo, hi = GATE_B["slope"]
    if not lo <= m["cal_slope"] <= hi: f.append(f"calibration slope {m['cal_slope']:.2f} outside {lo}-{hi}")
    return f


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="compute and print, but do not record evaluations")
    ap.add_argument("--model", help="only this model version id")
    args = ap.parse_args()
    token = (os.environ.get("CLOSER_QC_TOKEN") or "").strip()
    if not token:
        print("CLOSER_QC_TOKEN is not set", file=sys.stderr)
        return 2
    api = Api(os.environ.get("CLOSER_API_BASE", "https://closer-data.closer-data.workers.dev"), token)
    try:
        commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=os.path.dirname(__file__)).stdout.strip() or "local"
    except Exception:
        commit = "local"
    evaluator = f"qc-evaluate@{commit}"
    report, exit_code = [f"# Closer QC report (standard v{STANDARD})", ""], 0

    chain = api.get("/admin/chain")["predictions"]
    problems = verify_chain(chain)
    report.append(f"**Prediction fingerprint chain:** {len(chain)} predictions, " + ("intact ✅" if not problems else f"**{len(problems)} problems ❌**"))
    report += [f"- {p}" for p in problems[:20]]
    if problems:
        exit_code = 1

    games = api.get("/admin/results")["games"]
    models = requests.get(api.base + "/models", timeout=60).json()["models"]
    if args.model:
        models = [m for m in models if m["id"] == args.model]
    if not models:
        report.append("\nNo model versions registered yet; nothing to evaluate.")
    for mv in models:
        report.append(f"\n## {mv['id']} ({mv['status']})")
        if mv["status"] == "rejected":
            report.append("Rejected: no further evaluation.")
            continue
        detail = api.get("/admin/predictions", model_version_id=mv["id"])["predictions"]
        cutoff = mv.get("trained_through")
        graded = {k: [p for p in detail if p["kind"] == k and p["outcome"] is not None] for k in ("backtest", "live")}
        stage = "backtest" if mv["status"] == "experimental" else ("forward" if mv["status"] == "testing" else "monitor")
        rows = graded["backtest"] if stage == "backtest" else graded["live"]
        if stage == "monitor":
            rows = rows[-MONITOR["window"]:]
        report.append(f"Stage: {stage}; graded predictions: {len(rows)}")
        if not rows:
            report.append("Nothing graded yet.")
            continue
        try:
            base = Baselines(games, cutoff)
        except ValueError as e:
            report.append(f"Cannot build baselines: {e}")
            continue
        # out-of-sample check: every backtest game must start after the training cutoff
        leaks = [r for r in rows if mv.get("trained_through") and r["start_time"] <= mv["trained_through"]]
        m = score(rows, base)
        if stage == "backtest":
            failures = gate_a(m)
            if not mv.get("trained_through"):
                failures.append("model did not declare trained_through, so out-of-sample can't be checked")
            if leaks:
                failures.append(f"{len(leaks)} predicted games are inside the training period")
        elif stage == "forward":
            failures = gate_b(m, mv.get("passed_backtest_log_loss"))
        else:
            failures = []
            if m["log_loss"] > m["baselines"]["B2"]["log_loss"]: failures.append("rolling log loss worse than B2")
            if m["ece"] > MONITOR["ece_max"]: failures.append(f"rolling ECE {m['ece']:.3f} > {MONITOR['ece_max']}")
        passed = not failures and not problems
        latest = mv.get("latest_qc") or {}
        report.append(f"log loss {m['log_loss']:.4f} (B1 {m['baselines']['B1']['log_loss']:.4f}, B2 {m['baselines']['B2']['log_loss']:.4f}); "
                      f"Brier {m['brier']:.4f}; ECE {m['ece']:.3f}; slope {m['cal_slope']:.2f}; accuracy {m['accuracy']:.3f}")
        report.append("Result: " + ("PASS ✅" if passed else "not passed: " + "; ".join(failures)))
        if latest.get("stage") == stage and latest.get("n_games") == m["n"]:
            report.append("(already evaluated at this sample size; not re-recorded)")
            continue
        if not args.dry_run:
            r = api.post("/admin/qc/evaluations", {"model_version_id": mv["id"], "stage": stage, "n_games": m["n"], "metrics": m,
                                                    "passed": 1 if passed else 0, "failures": "; ".join(failures) or None,
                                                    "standard_version": STANDARD, "evaluator": evaluator})
            report.append(f"Recorded QC evaluation #{r['id']}.")

    text = "\n".join(report)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(text + "\n")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
