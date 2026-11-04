"""Calibrate the v2 option-market layer on REAL data only. Offline.

1. HAR-RV forecast of the next-14-day realized vol, fitted on real BTCUSDT hourly 2020-01..2026-10.
2. ATM IV = m0 * HAR forecast * exp(u), u ~ AR(1). m0 / u fitted on the REAL 2023 Binance ATM IV
   series reconstructed from the sandbox's own published regression residuals.
3. SSVI smile (rho, eta, term) fitted to the REAL Binance chain snapshot of 2026-10-15.
4. Crash check: IV response of the calibrated model on real crash days.
Writes roast/v2-calibration.json.
"""
import json
import math

import numpy as np
import pandas as pd
from scipy.optimize import least_squares

from common import ROAST, SANDBOX, se

YEAR = 8760.0


def real_hourly():
    d = pd.read_csv(SANDBOX / "data/btc_spot_1h.csv").set_index("open_epoch_sec").sort_index()
    cal = np.arange(d.index.min(), d.index.max() + 1, 3600)
    d = d.reindex(cal)
    lr = np.log(d.close / d.close.shift(1))
    return d, lr


def har_features(r2):
    """r2: hourly squared log returns (NaN->0). Features known at END of each hour (inclusive)."""
    c = np.r_[0, np.cumsum(r2)]
    n = len(r2)
    out = np.full((n, 3), np.nan)
    for j, w in enumerate((24, 168, 720)):
        s = np.full(n, np.nan)
        s[w - 1:] = c[w:] - c[:-w]
        out[:, j] = np.sqrt(np.maximum(s, 1e-12) * YEAR / w)
    return out


def fit_har(lr, start="2020-02-01"):
    r2 = np.nan_to_num(lr.to_numpy() ** 2)
    x = har_features(r2)
    c = np.r_[0, np.cumsum(r2)]
    n = len(r2)
    fwd = np.full(n, np.nan)
    fwd[:n - 336] = np.sqrt((c[337:] - c[1:n - 335]) * YEAR / 336)  # hours i+1..i+336
    t = lr.index.to_numpy()
    sel = (t >= pd.Timestamp(start, tz="UTC").timestamp()) & np.isfinite(fwd) & np.isfinite(x).all(1)
    idx = np.where(sel)[0][::24]
    X = np.column_stack([np.ones(len(idx)), np.log(x[idx])])
    y = np.log(fwd[idx])
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    s2 = float(np.var(resid, ddof=X.shape[1]))
    return {"beta": beta.tolist(), "resid_var": s2, "samples": int(len(idx)), "r2": float(1 - resid.var() / y.var()),
            "features": ["const", "log RV24h", "log RV7d", "log RV30d"], "target": "log RV next 336h"}, x


def har_vol(x, har):
    """sqrt(E[RV^2]) under a lognormal forecast error."""
    b = np.asarray(har["beta"])
    m = b[0] + np.log(x) @ b[1:]
    return np.exp(m + har["resid_var"])


def reconstruct_2023_iv(d, lr):
    ivc = json.loads((SANDBOX / "calibration/ssvi-calibration.json").read_text(encoding="utf-8"))
    co = ivc["model"]["coefficients"]
    lam = .94 ** (1 / 24)
    var = lr.pow(2).ewm(alpha=1 - lam, adjust=False, min_periods=480).mean()
    var[lr.rolling(480).count() < 480] = np.nan
    ewma = np.sqrt(var * YEAR).shift(1)
    r24 = d.close.shift(1) / d.close.shift(25) - 1
    x = pd.read_csv(SANDBOX / "calibration/atm-joint-innovations.csv").dropna(subset=["u"]).sort_values("available_epoch")
    e = x.available_epoch.to_numpy()
    logiv = (co["intercept"] + co["beta_log_rv"] * np.log(ewma.reindex(e).to_numpy())
             + co["negative_r24_coef"] * np.minimum(r24.reindex(e).to_numpy(), 0)
             + co["positive_r24_coef"] * np.maximum(r24.reindex(e).to_numpy(), 0) + x.u.to_numpy())
    return e, np.exp(logiv)


def fit_smile(term_guess=0.045):
    snap = json.loads((SANDBOX.parent.parent / "analysis/put-20261030/snapshot.json").read_text(encoding="utf-8"))
    S, now = float(snap["btc_index_price"]), snap["server_now_ms"]
    rows = []
    for o in snap["options"]:
        h = (o["expiry_ms"] - now) / 3.6e6
        K = float(o["strike_price"])
        put = o["side"] == "PUT"
        if not (5 * 24 <= h <= 75 * 24) or not ((put and K < S) or (not put and K > S)):
            continue
        if float(o["bid_price"]) <= 0 or abs(float(o["delta"])) < .02:
            continue
        rows.append((h, K, float(o["mark_iv"])))
    a = np.array(rows)
    hours = np.unique(a[:, 0])
    # near-ATM IV per expiry (from all quotes, both sides)
    atm = {}
    for h in hours:
        q = [(abs(math.log(float(o["strike_price"]) / S)), float(o["mark_iv"])) for o in snap["options"]
             if abs((o["expiry_ms"] - now) / 3.6e6 - h) < 1e-6]
        atm[h] = float(np.mean([v for _, v in sorted(q)[:4]]))

    def atm14_for(h, term, rho, eta):
        lo, hi = .05, 3.0
        target = atm[h]
        for _ in range(60):
            mid = (lo + hi) / 2
            if se.surface_iv(S, S * math.exp(se.RATE * h / YEAR), h, mid, term, rho, eta) < target:
                lo = mid
            else:
                hi = mid
        return (lo + hi) / 2

    def errors(p):
        rho, eta = p
        out = []
        for h, K, iv in a:
            a14 = atm14_for(h, term_guess, rho, eta)
            out.append(se.surface_iv(S, K, h, a14, term_guess, rho, eta) - iv)
        return np.array(out)
    sol = least_squares(errors, [-.2, 1.0], bounds=([-.95, .05], [.95, 1.8]))
    rho, eta = map(float, sol.x)
    # ATM term exponent from per-expiry near-ATM IVs: sigma(T) = sigma14 * (T/14d)^term
    hs = np.array(sorted(atm))
    A = np.column_stack([np.ones(len(hs)), np.log(hs / 336)])
    coef, *_ = np.linalg.lstsq(A, np.log([atm[h] for h in hs]), rcond=None)
    rmse = float(np.sqrt(np.mean(errors(sol.x) ** 2)))
    ok_arb = eta * (1 + abs(rho)) < 4 and eta * eta * (1 + abs(rho)) < 4
    return {"rho": rho, "eta": eta, "term_coef": float(coef[1]), "atm14_at_snapshot": float(math.exp(coef[0])),
            "fit_rows": int(len(a)), "iv_rmse_vol_pts": 100 * rmse, "gatheral_jacquier_sufficient_conditions": bool(ok_arb),
            "atm_by_expiry_days": {f"{h / 24:.1f}": v for h, v in sorted(atm.items())}, "spot": S}


def main():
    d, lr = real_hourly()
    har, x = fit_har(lr)
    F = har_vol(x, har)
    t = lr.index.to_numpy()
    e, iv = reconstruct_2023_iv(d, lr)
    pos = pd.Index(t).get_indexer(e - 3600)  # features from the last CLOSED hour before availability
    z = np.log(iv) - np.log(F[pos])
    ok = np.isfinite(z)
    e, iv, z, pos = e[ok], iv[ok], z[ok], pos[ok]
    log_m0 = float(np.mean(z))
    u = z - log_m0
    consecutive = np.diff(e) == 3600
    X = np.column_stack([np.ones(consecutive.sum()), u[:-1][consecutive]])
    ar, *_ = np.linalg.lstsq(X, u[1:][consecutive], rcond=None)
    innov = u[1:][consecutive] - X @ ar
    # Two-component residual: the AR(1) above matches lag 1 but NOT the real persistence (ACF 0.57 at 24h,
    # 0.35 at 168h). Fit ACF(L) = w*phi_s^L + (1-w)*phi_f^L on the real hourly residual, lags 1..168.
    zser = pd.Series(u, index=e).reindex(np.arange(e[0], e[-1] + 1, 3600))
    lags = np.arange(1, 169)
    acf = np.array([zser.autocorr(int(L)) for L in lags])

    def acf_err(q):
        w, ps, pf = q
        return w * ps ** lags + (1 - w) * pf ** lags - acf
    two = least_squares(acf_err, [.6, .996, .8], bounds=([0, .9, 0], [1, .99999, .99]))
    w, phi_s, phi_f = map(float, two.x)
    var_u = float(np.nanvar(u, ddof=1))
    # forward realized for the 2023 sample -> real VRP measurements
    r2 = np.nan_to_num(lr.to_numpy() ** 2)
    c = np.r_[0, np.cumsum(r2)]
    fwd = np.sqrt((c[pos + 337] - c[pos + 1]) * YEAR / 336)
    model_iv = np.exp(log_m0) * F[pos]
    smile = fit_smile()
    # Real VRP on the 2026-10-15 chain: near-ATM 15.6-day IV vs realized vol over the hours that followed
    snap = json.loads((SANDBOX.parent.parent / "analysis/put-20261030/snapshot.json").read_text(encoding="utf-8"))
    S_snap, t_snap = float(snap["btc_index_price"]), snap["server_now_ms"] // 1000
    near = sorted((o for o in snap["options"] if o["symbol"].startswith("BTC-261030-")), key=lambda o: abs(float(o["strike_price"]) - S_snap))[:4]
    p0 = pd.Index(t).get_indexer([t_snap // 3600 * 3600])[0]
    after = lr.to_numpy()[p0 + 1:]
    after = after[np.isfinite(after)]
    snapshot_vrp = {"atm_iv_15_6d": float(np.mean([float(o["mark_iv"]) for o in near])),
                    "realized_vol_after": float(np.sqrt(np.mean(after ** 2) * YEAR)), "hours_after": int(len(after)),
                    "rv30_before": float(np.sqrt(np.nanmean(lr.to_numpy()[p0 - 720:p0] ** 2) * YEAR))}
    # crash response of the calibrated ATM model (u=0) on real days
    events = {}
    for name, day in (("2020-03-12 covid", "2020-03-12"), ("2021-05-19", "2021-05-19"), ("2022-06-13 3AC", "2022-06-13"),
                      ("2022-11-09 FTX", "2022-11-09"), ("2024-08-05 yen carry", "2024-08-05"), ("2025-10-10 liquidations", "2025-10-10")):
        t0 = int(pd.Timestamp(day, tz="UTC").timestamp())
        i0 = pd.Index(t).get_indexer([t0 - 24 * 3600])[0]
        i1 = pd.Index(t).get_indexer([t0 + 23 * 3600])[0]
        if i0 < 0 or i1 < 0:
            continue
        seg = F[i0:i1 + 1]
        events[name] = {"btc_24h_move_max_drop": float(np.min(d.close.to_numpy()[i0 + 24:i1 + 1] / d.close.to_numpy()[i0:i1 + 1 - 24]) - 1),
                        "model_atm_iv_before": float(np.exp(log_m0) * seg[0]), "model_atm_iv_peak": float(np.exp(log_m0) * np.nanmax(seg)),
                        "peak_ratio": float(np.nanmax(seg) / seg[0])}
    out = {
        "status": "v2 research calibration on real data; not an exchange pricing model",
        "har": har,
        "iv_level": {"log_m0": log_m0, "m0": math.exp(log_m0), "source": "real 2023-05..10 Binance ATM~14d IV reconstructed from sandbox residuals",
                     "u_phi": float(ar[1]), "u_intercept": float(ar[0]), "u_innovation_std": float(innov.std(ddof=1)),
                     "u_std": float(u.std(ddof=1)), "hours": int(len(e)),
                     "two_component": {"w_slow": w, "phi_slow": phi_s, "phi_fast": phi_f,
                                       "slow_std": math.sqrt(w * var_u), "fast_std": math.sqrt((1 - w) * var_u),
                                       "acf_fit_rmse": float(np.sqrt(np.mean(acf_err(two.x) ** 2))),
                                       "real_acf": {str(L): float(acf[L - 1]) for L in (1, 6, 24, 72, 168)},
                                       "note": "slow part = persistent, tradable IV richness/cheapness; fast part mostly ATM-contract-switch noise in marks (not tradable), off by default"}},
        "real_2023_vrp": {"iv_mean": float(iv.mean()), "fwd_rv_mean": float(fwd.mean()), "iv_minus_fwd_rv_mean": float((iv - fwd).mean()),
                          "median_iv_over_fwd_rv": float(np.median(iv / fwd)), "mean_iv2_minus_rv2": float((iv ** 2 - fwd ** 2).mean()),
                          "model_iv_mean_u0": float(model_iv.mean()), "model_minus_real_iv_mean": float((model_iv - iv).mean()),
                          "corr_log_model_real": float(np.corrcoef(np.log(model_iv), np.log(iv))[0, 1])},
        "smile_snapshot_2026_10_15": smile,
        "snapshot_2026_10_15_vrp": snapshot_vrp,
        "crash_response_u0": events,
    }
    np.save(ROAST / "results/v2-innovations.npy", innov)
    (ROAST / "v2-calibration.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()

