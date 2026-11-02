"""Offline stochastic BTC markets. No network or account access.

Time resolution is one HOUR. No claim of five-second execution fidelity.
"""
import json
import math
from pathlib import Path
import numpy as np
import pandas as pd
from numba import njit
from scipy.optimize import minimize
from scipy.special import gammaln

ROOT = Path(__file__).resolve().parent
SPOT = ROOT / "data/btc_spot_1h.csv"
YEAR_HOURS = 8760
LAMBDA = .94 ** (1 / 24)


def load_history():
    if not SPOT.is_file():
        raise FileNotFoundError("Public spot data missing; run python prepare_data.py first.")
    d = pd.read_csv(SPOT)
    t = d.open_epoch_sec.to_numpy(dtype=np.int64)
    c = d.close.to_numpy(float)
    previous = np.r_[np.nan, c[:-1]]
    continuous = np.r_[False, np.diff(t) == 3600]
    r = np.log(c / previous)
    ro = np.log(d.open.to_numpy(float) / previous)
    up = np.log(d.high.to_numpy(float) / d.open.to_numpy(float))
    down = np.log(d.low.to_numpy(float) / d.open.to_numpy(float))
    valid = continuous & np.isfinite(r)
    features = np.column_stack((r[valid], ro[valid], up[valid], down[valid]))
    times = t[valid]
    following = np.r_[np.diff(times) == 3600, False]
    return {"features": features, "times": times, "following": following, "data": d}


@njit(cache=True)
def filter_variance(x, contiguous, omega, alpha, gamma, beta, initial):
    h = np.empty(len(x))
    h[0] = initial
    for i in range(1, len(x)):
        if not contiguous[i - 1]:
            h[i] = initial
        else:
            h[i] = omega + (alpha + gamma * (x[i - 1] < 0)) * x[i - 1] ** 2 + beta * h[i - 1]
        h[i] = max(h[i], 1e-12)
    return h


@njit(cache=True)
def nll_core(x, cont, omega, alpha, gamma, beta, nu, initial, constant):
    h = initial
    loss = 0.0
    for i in range(len(x)):
        if i > 0:
            if cont[i - 1]:
                h = omega + (alpha + gamma * (x[i - 1] < 0)) * x[i - 1] ** 2 + beta * h
            else:
                h = initial
        if h <= 1e-14:
            return 1e30
        loss += .5 * math.log(h) - constant + .5 * (nu + 1) * math.log1p(x[i] ** 2 / ((nu - 2) * h))
    return loss


def calibrate_price(history, output):
    cut = int(pd.Timestamp("2025-01-01", tz="UTC").timestamp())
    selected = history["times"] < cut
    f = history["features"][selected]
    times = history["times"][selected]
    cont = np.r_[np.diff(times) == 3600, False]
    mu = float(f[:, 0].mean())
    variance_scale = float(np.mean((f[:, 0] - mu) ** 2))
    x = (f[:, 0] - mu) / math.sqrt(variance_scale)
    initial = 1.0
    def objective(p):
        w, a, g, b, nu = p
        const = gammaln((nu + 1) / 2) - gammaln(nu / 2) - .5 * math.log((nu - 2) * math.pi)
        return nll_core(x, cont, w, a, g, b, nu, initial, const)
    results = []
    for start in ((initial * .01, .05, .02, .93, 5), (initial * .03, .08, .04, .86, 4)):
        results.append(minimize(objective, start, method="SLSQP", bounds=[(1e-8, initial), (0, .5), (0, .5), (.2, .999), (2.1, 40)], constraints=[{"type": "ineq", "fun": lambda p: .999 - p[1] - .5 * p[2] - p[3]}], options={"maxiter": 150, "ftol": 1e-7}))
    successful = [x for x in results if x.success and np.isfinite(x.fun)]
    if not successful:
        raise RuntimeError("GJR likelihood calibration did not converge; no silent hand-picked replacement.")
    best = min(successful, key=lambda x: x.fun)
    omega, alpha, gamma, beta, nu = map(float, best.x)
    h = filter_variance(x, cont, omega, alpha, gamma, beta, initial) * variance_scale
    z = (f[:, 0] - mu) / np.sqrt(h)
    result = {"training": "2020-2024, excluding returns across missing hours", "rows": len(f), "holdout_not_used_for_fit": "2025-2026-10", "mu_log_return_hourly": mu, "empirical_annual_log_drift_not_a_forecast": mu * YEAR_HOURS, "omega_log_variance": omega * variance_scale, "alpha": alpha, "gamma": gamma, "beta": beta, "nu_student_t_for_likelihood_only": nu, "persistence_symmetric_reference": alpha + gamma / 2 + beta, "residual_mean": float(z.mean()), "residual_std": float(z.std()), "initial_log_variance": variance_scale, "negative_log_likelihood_normalized_returns": float(best.fun), "optimizer_success": bool(best.success), "optimizer_iterations": int(best.nit), "notes": ["FHS simulation resamples empirical standardized shocks, not Gaussian shocks.", "Asymmetric persistence expression assumes symmetric residual signs; empirical sign-weighted persistence also checked.", "No fit targets strategy returns."]}
    z0 = (z - z.mean()) / z.std()
    empirical_persistence = beta + alpha * np.mean(z0 ** 2) + gamma * np.mean(z0 ** 2 * (z0 < 0))
    result["persistence_empirical_reference"] = float(empirical_persistence)
    if empirical_persistence >= 1:
        result["fhs_stationarity_warning"] = "Empirical innovation moment makes FHS variance nonstationary; simulation diagnostics must flag this."
    Path(output).write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result, f, cont, h


@njit(cache=True)
def stationary_indices(n, length, mean_block, follows, seed):
    np.random.seed(seed)
    result = np.empty(length, dtype=np.int64)
    j = np.random.randint(n)
    for t in range(length):
        if t == 0 or np.random.random() < 1 / mean_block or not follows[j]:
            j = np.random.randint(n)
        else:
            j += 1
        result[t] = j
    return result


@njit(cache=True)
def fhs_features(raw, indices, hist_h, omega, alpha, gamma, beta, initial_h, mu_hist, mu_new, zmean, zstd):
    out = np.empty((len(indices), 4))
    h = initial_h
    for t in range(len(indices)):
        j = indices[t]
        z = ((raw[j, 0] - mu_hist) / math.sqrt(hist_h[j]) - zmean) / zstd
        scale = math.sqrt(h / hist_h[j]) / zstd
        r = mu_new + math.sqrt(h) * z
        ro = raw[j, 1] * scale
        up = raw[j, 2] * scale
        down = raw[j, 3] * scale
        # Changes of mean/normalization must not make OHLC internally inconsistent.
        up = max(up, r - ro, 0.0)
        down = min(down, r - ro, 0.0)
        out[t, 0], out[t, 1], out[t, 2], out[t, 3] = r, ro, up, down
        eps = r - mu_new
        h = omega + (alpha + gamma * (eps < 0)) * eps * eps + beta * h
        h = max(h, 1e-14)
    return out


def generate_market(model, raw, follows, hist_h, calibration, hours, seed, mean_block=72, drift="empirical"):
    total = hours + 721  # 720 warmup hours + initial account point + trading horizon
    block = mean_block if model == "stationary" else 1
    idx = stationary_indices(len(raw), total, block, follows, seed)
    mu = calibration["mu_log_return_hourly"] if drift == "empirical" else 0.0
    if model == "stationary":
        features = raw[idx].copy()
        if drift == "zero":
            shift = calibration["mu_log_return_hourly"]
            features[:, 0] -= shift
            features[:, 2] = np.maximum(features[:, 2], features[:, 0] - features[:, 1])
            features[:, 3] = np.minimum(features[:, 3], features[:, 0] - features[:, 1])
    elif model == "gjr_fhs":
        features = fhs_features(raw, idx, hist_h, calibration["omega_log_variance"], calibration["alpha"], calibration["gamma"], calibration["beta"], hist_h[idx[0]], calibration["mu_log_return_hourly"], mu, calibration["residual_mean"], calibration["residual_std"])
    else:
        raise ValueError(model)
    if not np.isfinite(features).all():
        raise RuntimeError("Nonfinite simulated market; no clipping and hiding numerical blow-up.")
    return features


def diagnostics(features, horizon=2160):
    r = features[-horizon:, 0]
    logs = np.r_[0, np.cumsum(r)]
    daily = logs[24:] - logs[:-24]
    s = np.exp(logs)
    def acf(x, lag):
        return float(np.corrcoef(x[lag:], x[:-lag])[0, 1])
    return {"hourly_sd": float(np.std(r)), "hourly_q001": float(np.quantile(r, .001)), "hourly_q01": float(np.quantile(r, .01)), "hourly_q99": float(np.quantile(r, .99)), "hourly_q999": float(np.quantile(r, .999)), "daily_q01": float(np.quantile(daily, .01)), "daily_q99": float(np.quantile(daily, .99)), "abs_acf1": acf(abs(r), 1), "abs_acf24": acf(abs(r), 24), "sq_acf1": acf(r * r, 1), "sq_acf24": acf(r * r, 24), "sq_acf168": acf(r * r, 168), "max_drawdown": float(np.max(1 - s / np.maximum.accumulate(s))), "end_log_return": float(logs[-1])}
