"""v2 market generator: physical BTC paths + calibrated option-market layer. Offline.

Physical models (all drift-NEUTRALIZED, then an explicit drift scenario is added):
  boot_all    : stationary block bootstrap of REAL 2020-01..2026-10 hourly OHLC, mean block 30 days
  boot_recent : same, REAL 2023-01..2026-10 only (current ETF-era regime)
  gjr_capped  : the sandbox's own GJR-FHS (frozen params) with shock winsorizing + variance cap
Option layer (v2-calibration.json): ATM14 IV = vrp * m0 * HAR(RV) forecast * exp(u) * fear(r24),
SSVI smile fitted to the real 2026-10-15 Binance chain, tick-tight spreads that widen in stress.

market() returns exactly the arrays the sandbox's strategy_engine.simulate_path expects, so the
user's V1 engine runs on v2 worlds UNCHANGED.
"""
import json
import math

import numpy as np
import pandas as pd
from numba import njit

from common import ROAST, mm

YEAR = 8760.0
S0 = 77928.47673913  # same start spot as the frozen sandbox example
CAL = json.loads((ROAST / "v2-calibration.json").read_text(encoding="utf-8"))
INNOV = np.load(ROAST / "results/v2-innovations.npy")
SMILE = CAL["smile_snapshot_2026_10_15"]
WORLD_DEFAULT = {"model": "boot_all", "drift": 0.0, "vrp": 1.0, "rho": SMILE["rho"], "eta": SMILE["eta"],
                 "term": SMILE["term_coef"], "fear": 1.0, "spread_base": .01, "stress_spreads": True, "iv_noise": 1.0, "iv_fast_noise": 0.0}


class Source:
    """Real hourly features for the bootstraps, loaded once."""
    def __init__(self, history):
        self.f = history["features"]
        self.t = history["times"]
        self.follow = history["following"]

    def window(self, start, end=None):
        t = self.t
        keep = t >= pd.Timestamp(start, tz="UTC").timestamp()
        if end:
            keep &= t < pd.Timestamp(end, tz="UTC").timestamp()
        idx = np.where(keep)[0]
        f = self.f[idx].copy()
        follow = self.follow[idx].copy()
        follow[-1] = False
        f[:, 0] -= f[:, 0].mean()  # drift-neutral: remove the sample's own trend
        f[:, 2] = np.maximum(f[:, 2], f[:, 0] - f[:, 1])
        f[:, 3] = np.minimum(f[:, 3], f[:, 0] - f[:, 1])
        return f, follow


@njit(cache=True)
def circular_indices(n, length, mean_block, seed):
    """Politis-Romano stationary bootstrap WITH wrap-around: every source hour is equally likely.

    (The sandbox's non-circular version under-samples hours after gaps/series start; with 30-day
    blocks that alone manufactures a -12%/yr drift from a demeaned source.)
    """
    np.random.seed(seed)
    out = np.empty(length, dtype=np.int64)
    j = np.random.randint(n)
    for t in range(length):
        if t > 0:
            if np.random.random() < 1.0 / mean_block:
                j = np.random.randint(n)
            else:
                j = (j + 1) % n
        out[t] = j
    return out


@njit(cache=True)
def fhs_capped(raw, indices, hist_h, omega, alpha, gamma, beta, initial_h, mu_hist, mu_new, zmean, zstd, zcap, hcap):
    out = np.empty((len(indices), 4))
    h = initial_h
    for t in range(len(indices)):
        j = indices[t]
        z = ((raw[j, 0] - mu_hist) / math.sqrt(hist_h[j]) - zmean) / zstd
        z = min(max(z, -zcap), zcap)
        scale = math.sqrt(h / hist_h[j]) / zstd
        r = mu_new + math.sqrt(h) * z
        ro = raw[j, 1] * scale
        up = max(raw[j, 2] * scale, r - ro, 0.0)
        down = min(raw[j, 3] * scale, r - ro, 0.0)
        out[t, 0], out[t, 1], out[t, 2], out[t, 3] = r, ro, up, down
        eps = r - mu_new
        h = omega + (alpha + gamma * (eps < 0)) * eps * eps + beta * h
        h = min(max(h, 1e-14), hcap)
    return out


def physical(model, hours, seed, drift, ctx):
    total = hours + 721
    mu = drift / YEAR
    if model in ("boot_all", "boot_recent"):
        f, follow = ctx["boot_all"] if model == "boot_all" else ctx["boot_recent"]
        idx = circular_indices(len(f), total, 720.0, seed)
        x = f[idx].copy()
        x[:, 0] += mu
        x[:, 2] = np.maximum(x[:, 2], x[:, 0] - x[:, 1])
        x[:, 3] = np.minimum(x[:, 3], x[:, 0] - x[:, 1])
        return x
    if model == "gjr_capped":
        c, raw, follows, h = ctx["gjr"]
        idx = mm.stationary_indices(len(raw), total, 1, follows, seed)
        hcap = (2.5 / math.sqrt(YEAR)) ** 2  # 250% annualized hourly-vol ceiling
        return fhs_capped(raw, idx, h, c["omega_log_variance"], c["alpha"], c["gamma"], c["beta"], h[idx[0]],
                          c["mu_log_return_hourly"], mu, c["residual_mean"], c["residual_std"], 8.0, hcap)
    raise ValueError(model)


@njit(cache=True)
def ar1(innov_draws, phi, intercept, u0):
    u = np.empty(len(innov_draws))
    u[0] = u0
    for i in range(1, len(u)):
        u[i] = intercept + phi * u[i - 1] + innov_draws[i]
    return u


def option_layer(f, seed, world):
    r = f[:, 0]
    logs = np.cumsum(r)
    scale = math.log(S0) - logs[720]
    close = np.exp(logs + scale)
    opening = np.exp(logs - r + scale + f[:, 1])
    high = np.maximum(np.maximum(opening * np.exp(f[:, 2]), opening), close)
    low = np.minimum(np.minimum(opening * np.exp(f[:, 3]), opening), close)
    n = len(r)
    r2 = r * r
    c = np.r_[0, np.cumsum(r2)]
    feats = []
    for w in (24, 168, 720):
        s = np.empty(n)
        s[:w - 1] = c[w - 1] * (w / max(w - 1, 1))  # warmup only (never traded)
        s[w - 1:] = c[w:] - c[:-w]
        feats.append(np.sqrt(np.maximum(s, 1e-12) * YEAR / w))
    b = CAL["har"]["beta"]
    F = np.exp(b[0] + b[1] * np.log(feats[0]) + b[2] * np.log(feats[1]) + b[3] * np.log(feats[2]) + CAL["har"]["resid_var"])
    lvl = CAL["iv_level"]
    two = lvl["two_component"]
    rng = np.random.default_rng(np.random.SeedSequence([seed, 11]))
    z = INNOV[rng.integers(0, len(INNOV), n)] / INNOV.std()  # fat-tailed shape of real innovations, unit variance
    # persistent (tradable) component: matches the REAL residual ACF at 24h-168h
    s_inn = two["slow_std"] * math.sqrt(1 - two["phi_slow"] ** 2)
    u0 = two["slow_std"] * rng.standard_normal()
    u = ar1(world["iv_noise"] * s_inn * z, two["phi_slow"], 0.0, world["iv_noise"] * u0)
    if world["iv_fast_noise"] > 0:  # optional stress: non-tradable mark noise treated as tradable
        z2 = INNOV[rng.integers(0, len(INNOV), n)] / INNOV.std()
        f_inn = two["fast_std"] * math.sqrt(1 - two["phi_fast"] ** 2)
        u = u + ar1(world["iv_fast_noise"] * f_inn * z2, two["phi_fast"], 0.0, 0.0)
    r24 = np.zeros(n)
    r24[24:] = np.exp(logs[24:] - logs[:-24]) - 1
    fear = np.exp(world["fear"] * np.maximum(-r24 - .03, 0) + .3 * world["fear"] * np.maximum(r24 - .03, 0))
    atm = world["vrp"] * lvl["m0"] * F * np.exp(u) * fear
    atm = np.clip(atm, .08, 4.0)
    # RV20 exactly as the sandbox computes it (480h sample std, annualized) for V1's IV/RV gate
    sr = np.r_[0, np.cumsum(r)]
    rv20 = np.full(n, np.nan)
    vals = ((c[480:] - c[:-480]) - (sr[480:] - sr[:-480]) ** 2 / 480) / 479
    rv20[479:] = np.sqrt(np.maximum(vals, 1e-14) * YEAR)
    # Spreads: tick-tight like the real 2026 book, widening with stress (crash size, IV jump)
    ivjump = np.zeros(n)
    ivjump[24:] = np.log(atm[24:] / atm[:-24])
    rng_s = np.random.default_rng(np.random.SeedSequence([seed, 12]))
    spread = world["spread_base"] * np.exp(.25 * rng_s.standard_normal(n))
    if world["stress_spreads"]:
        spread = spread + .6 * np.maximum(np.abs(r24) - .03, 0) + .3 * np.maximum(ivjump, 0)
    spread = np.minimum(spread, .6)
    rng_a = np.random.default_rng(np.random.SeedSequence([seed, 13]))
    p_out = np.where(np.abs(r24) >= .10, .25, .001)
    available = rng_a.random(n) >= p_out
    rng_e = np.random.default_rng(np.random.SeedSequence([seed, 14]))
    entry_random = rng_e.random((n, 2))
    exit_random = rng_e.random((n, 2))
    return close, high, low, atm, rv20, spread, available, entry_random, exit_random


def context(history, frozen_gjr):
    src = Source(history)
    return {"boot_all": src.window("2020-01-01"), "boot_recent": src.window("2023-01-01"), "gjr": frozen_gjr}


def market(world, hours, seed, ctx):
    w = dict(WORLD_DEFAULT, **world)
    f = physical(w["model"], hours, seed, w["drift"], ctx)
    if not np.isfinite(f).all():
        raise RuntimeError("non-finite physical path")
    return f, option_layer(f, seed, w), (w["term"], w["rho"], w["eta"])

