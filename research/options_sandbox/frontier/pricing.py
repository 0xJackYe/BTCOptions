"""Causal research quote layer, separate from physical price generators.

HAR fit uses 2020-2023 prices only. IV level/persistence use reconstructed
2023 public observations. Smile is a frozen public 2026-11-03 cross-section.
This is not a calibrated joint risk-neutral dynamics or a real matching engine.
"""
import json
import math
from pathlib import Path
import sys

import numpy as np
import pandas as pd
from scipy.optimize import least_squares
from numba import njit

ROOT = Path(__file__).resolve().parent
SANDBOX = ROOT.parent
sys.path.insert(0, str(SANDBOX))
YEAR = 8760.
S0 = 76998.59043478


def fit(history, output):
    d = history["data"].set_index("open_epoch_sec").sort_index()
    clock = np.arange(d.index.min(), d.index.max()+1, 3600)
    close = d.close.reindex(clock)
    lr = np.log(close/close.shift(1))
    x = np.column_stack([np.sqrt(lr.pow(2).rolling(w).mean()*YEAR) for w in (24, 168, 720)])
    fwd = np.sqrt(lr.pow(2).rolling(336).mean().shift(-336)*YEAR).to_numpy()
    cut = int(pd.Timestamp("2024-01-01", tz="UTC").timestamp())
    mask = (clock+336*3600 < cut) & np.isfinite(x).all(1) & np.isfinite(fwd)
    idx = np.flatnonzero(mask)[::24]
    X = np.column_stack([np.ones(len(idx)), np.log(x[idx])])
    y = np.log(fwd[idx])
    beta = np.linalg.lstsq(X, y, rcond=None)[0]
    resid = y-X@beta
    s2 = float(np.var(resid, ddof=4))
    forecast = np.exp(beta[0]+np.log(x)@beta[1:]+s2)
    old = json.loads((SANDBOX/"calibration/ssvi-calibration.json").read_text(encoding="utf-8"))
    co = old["model"]["coefficients"]
    observations = pd.read_csv(SANDBOX/"calibration/atm-joint-innovations.csv").dropna(subset=["u"])
    ewma = np.sqrt(lr.pow(2).ewm(alpha=1-.94**(1/24), adjust=False, min_periods=480).mean()*YEAR).shift(1)
    r24 = close.shift(1)/close.shift(25)-1
    e = observations.available_epoch.to_numpy(dtype=np.int64)
    index = pd.Index(clock)
    pos = index.get_indexer(e)
    known = index.get_indexer(e-3600)
    valid = (pos >= 0) & (known >= 0) & (e < cut)
    e, pos, known = e[valid], pos[valid], known[valid]
    uu = observations.u.to_numpy()[valid]
    logiv = (co["intercept"]+co["beta_log_rv"]*np.log(ewma.to_numpy()[pos])
             +co["negative_r24_coef"]*np.minimum(r24.to_numpy()[pos], 0)
             +co["positive_r24_coef"]*np.maximum(r24.to_numpy()[pos], 0)+uu)
    z = logiv-np.log(forecast[known])
    ok = np.isfinite(z)
    z, e = z[ok], e[ok]
    offset = float(z.mean())
    u = z-offset
    us = pd.Series(u, index=e).reindex(np.arange(e.min(), e.max()+1, 3600))
    lags = np.array([1, 6, 12, 24, 48, 72, 120, 168])
    acf = np.array([us.autocorr(int(l)) for l in lags])
    def error(p):
        return p[0]*p[1]**lags+(1-p[0])*p[2]**lags-acf
    sol = least_squares(error, [.55, .997, .85], bounds=([0, .9, 0], [1, .99999, .99]))
    if not sol.success:
        raise RuntimeError("IV persistence fit failed")
    w, slow, fast = map(float, sol.x)
    variance = float(np.var(u, ddof=1))
    current = json.loads((SANDBOX/"calibration/sell-20261103/current-ssvi-calibration.json").read_text(encoding="utf-8"))
    config = {"price_fit_period": "2020-2023, next14d targets end before2024; missing windows excluded",
        "har_beta": beta.tolist(), "har_residual_variance": s2, "har_samples": len(idx),
        "har_r2_in_sample": float(1-np.var(resid)/np.var(y)),
        "iv_source": "2023 public ATM IV reconstructed from stored residuals, known-price inputs lagged",
        "iv_samples": len(z), "log_iv_level": offset,
        "slow_phi": slow, "slow_std": math.sqrt(w*variance),
        "fast_phi": fast, "fast_std": math.sqrt((1-w)*variance),
        "acf_lags": lags.tolist(), "observed_acf": acf.tolist(),
        "surface": current["surface_model"], "surface_asof": current["data_asof"], "S0": S0,
        "assumptions": ["Slow component is tradable IV state; fast measurement component off in base",
            "Fresh normal IV innovations; independent of price except current realized-vol and fear coupling",
            "Pricing-level multipliers, skew flip, spreads and fill failures are sensitivities, not empirical future probabilities",
            "Only one current smile cross-section; no temporal certification or joint P/Q no-arbitrage proof"]}
    Path(output).write_text(json.dumps(config, indent=2), encoding="utf-8")
    return config


@njit(cache=True)
def _ar(z, phi, std, u0):
    u = np.empty(len(z))
    u[0] = u0
    scale = std*math.sqrt(1-phi*phi)
    for i in range(1, len(z)):
        u[i] = phi*u[i-1]+scale*z[i]
    return u


def market(features, config, seed, level=1., spread_scale=1., fast_noise=0.):
    r = features[:, 0]
    n = len(r)
    logs = np.cumsum(r)
    anchor = math.log(config["S0"])-logs[720]
    if np.max(np.abs(logs+anchor)) > 650:
        raise RuntimeError("Numerical price explosion; path cannot be discarded")
    close = np.exp(logs+anchor)
    opening = np.exp(logs-r+anchor+features[:, 1])
    high = np.maximum(np.maximum(opening*np.exp(features[:, 2]), opening), close)
    low = np.minimum(np.minimum(opening*np.exp(features[:, 3]), opening), close)
    cs = np.r_[0., np.cumsum(r*r)]
    vol = []
    for w in (24, 168, 720):
        v = np.full(n, np.sqrt(np.mean(r[:w]**2)*YEAR))
        v[w-1:] = np.sqrt(np.maximum((cs[w:]-cs[:-w])/w, 1e-16)*YEAR)
        vol.append(v)
    b = config["har_beta"]
    forecast = np.exp(b[0]+sum(b[j+1]*np.log(vol[j]) for j in range(3))
                      +config["har_residual_variance"])
    rng0 = np.random.default_rng(np.random.SeedSequence([seed, 101]))
    rng1 = np.random.default_rng(np.random.SeedSequence([seed, 102]))
    u0 = rng0.normal(0, config["slow_std"])
    u = _ar(rng1.standard_normal(n), config["slow_phi"], config["slow_std"], u0)
    if fast_noise:
        rf0 = np.random.default_rng(np.random.SeedSequence([seed, 103]))
        rf1 = np.random.default_rng(np.random.SeedSequence([seed, 104]))
        u += fast_noise*_ar(rf1.standard_normal(n), config["fast_phi"], config["fast_std"],
                            rf0.normal(0, config["fast_std"]))
    r24 = np.zeros(n)
    r24[24:] = np.exp(logs[24:]-logs[:-24])-1
    fear = np.exp(np.maximum(-r24-.03, 0)+.3*np.maximum(r24-.03, 0))
    atm = level*np.exp(config["log_iv_level"])*forecast*np.exp(u)*fear
    if not np.isfinite(atm).all() or np.max(atm) > 100:
        raise RuntimeError("IV extrapolation failure; no silent cap or path exclusion")
    sr = np.r_[0., np.cumsum(r)]
    rv20 = np.full(n, np.nan)
    v = ((cs[480:]-cs[:-480])-(sr[480:]-sr[:-480])**2/480)/479
    rv20[479:] = np.sqrt(np.maximum(v, 1e-16)*YEAR)
    rsp = np.random.default_rng(np.random.SeedSequence([seed, 105]))
    ivjump = np.zeros(n)
    ivjump[24:] = np.maximum(np.log(atm[24:]/atm[:-24]), 0)
    spread = spread_scale*(.01*np.exp(.25*rsp.standard_normal(n))
                           +.6*np.maximum(abs(r24)-.03, 0)+.3*ivjump)
    rav = np.random.default_rng(np.random.SeedSequence([seed, 106]))
    available = rav.random(n) >= np.where(abs(r24) >= .1, .25, .001)
    re = np.random.default_rng(np.random.SeedSequence([seed, 107]))
    rx = np.random.default_rng(np.random.SeedSequence([seed, 108]))
    return (close, high, low, atm, rv20, spread, available,
            re.random((n, 2)), rx.random((n, 2)))


if __name__ == "__main__":
    from market_models import load_history
    ROOT.joinpath("results").mkdir(exist_ok=True)
    fit(load_history(), ROOT/"results/pricing-calibration.json")
