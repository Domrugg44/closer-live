"""Scoring metrics for win-probability forecasts (docs/VALIDATION.md).

Pure functions on numpy arrays: y = outcomes (1 = predicted side won), p = predicted probabilities.
"""
from __future__ import annotations

import numpy as np

EPS = 1e-12


def _clip(p: np.ndarray) -> np.ndarray:
    return np.clip(np.asarray(p, dtype=float), EPS, 1 - EPS)


def log_loss_each(y, p) -> np.ndarray:
    y = np.asarray(y, dtype=float)
    p = _clip(p)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def log_loss(y, p) -> float:
    return float(np.mean(log_loss_each(y, p)))


def brier(y, p) -> float:
    y = np.asarray(y, dtype=float)
    return float(np.mean((np.asarray(p, dtype=float) - y) ** 2))


def accuracy(y, p) -> float:
    y = np.asarray(y, dtype=float)
    return float(np.mean((np.asarray(p) >= 0.5) == (y == 1)))


def ece(y, p, bins: int = 10) -> float:
    """Expected calibration error with equal-count bins."""
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    order = np.argsort(p, kind="stable")
    total = 0.0
    for chunk in np.array_split(order, bins):
        if len(chunk):
            total += len(chunk) * abs(p[chunk].mean() - y[chunk].mean())
    return float(total / len(p))


def fit_logistic(x: np.ndarray, y: np.ndarray, iters: int = 50) -> tuple[float, float]:
    """Unpenalized logistic regression y ~ a + b*x by Newton's method. Returns (a, b)."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    X = np.column_stack([np.ones_like(x), x])
    w = np.zeros(2)
    for _ in range(iters):
        z = np.clip(X @ w, -35, 35)
        mu = 1 / (1 + np.exp(-z))
        g = X.T @ (y - mu)
        H = (X * (mu * (1 - mu))[:, None]).T @ X + 1e-9 * np.eye(2)
        step = np.linalg.solve(H, g)
        w += step
        if np.max(np.abs(step)) < 1e-10:
            break
    return float(w[0]), float(w[1])


def calibration_slope(y, p) -> tuple[float, float]:
    """Intercept and slope of the logistic fit of outcome on logit(prediction). Perfect = (0, 1)."""
    pc = _clip(p)
    return fit_logistic(np.log(pc / (1 - pc)), np.asarray(y, dtype=float))


def paired_bootstrap_diff(loss_a, loss_b, n_boot: int = 2000, seed: int = 0) -> tuple[float, float, float]:
    """Mean(loss_a - loss_b) with a 95% percentile CI from a paired bootstrap over games."""
    d = np.asarray(loss_a, dtype=float) - np.asarray(loss_b, dtype=float)
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(d), size=(n_boot, len(d)))
    means = d[idx].mean(axis=1)
    return float(d.mean()), float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def mean_ci(x, n_boot: int = 2000, seed: int = 0) -> tuple[float, float, float]:
    x = np.asarray(x, dtype=float)
    rng = np.random.default_rng(seed)
    means = x[rng.integers(0, len(x), size=(n_boot, len(x)))].mean(axis=1)
    return float(x.mean()), float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))
