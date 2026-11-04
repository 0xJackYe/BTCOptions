"""Fresh-draw stochastic BTC markets, fitted without strategy-return inputs.

The two primary models draw new Gaussian diffusion, volatility innovations and
compound-Poisson double-exponential jumps. Historical returns are only used to
estimate parameters. ``bootstrap_reference`` is explicitly a resampling control.

These are approximate physical-measure models, NOT a fitted option-pricing law.
No simulated return, jump or volatility is economically capped. Floating-point
domain failures raise rather than clipping a path or quietly dropping it.
"""
import base64
import copy
import json
import math
import numbers
from pathlib import Path
import zlib

import numpy as np
import pandas as pd
from numba import njit
from scipy.optimize import least_squares

YEAR = 8760.0
WARMUP = 720
SUBSTEPS = 8
MODELS = ("regime_jump", "sv_jump", "bootstrap_reference")
TRAIN_END = int(pd.Timestamp("2024-01-01", tz="UTC").timestamp())


class NumericalMarketError(ValueError):
    """A retained, reportable numerical model failure; never a dropped sample."""


def _finite_float(x, name):
    if isinstance(x, (bool, np.bool_)) or not isinstance(x, numbers.Real) or not math.isfinite(x):
        raise ValueError(name + " must be a finite real")
    return float(x)


def _integer(x, name, minimum=0):
    if isinstance(x, (bool, np.bool_)) or not isinstance(x, numbers.Integral) or x < minimum:
        raise ValueError(name + " must be an integer >= " + str(minimum))
    return int(x)


def _runs(times):
    out = np.ones(len(times), dtype=np.int64)
    for i in range(1, len(times)):
        out[i] = out[i-1] + 1 if times[i]-times[i-1] == 3600 else 1
    return out


def _vol_observations(r, times):
    """Past-only 24h RV used as an observable proxy for latent log volatility."""
    s = pd.Series(r*r).rolling(24, min_periods=24).mean().shift(1).to_numpy()
    s[_runs(times) < 25] = np.nan
    floor = .02**2/YEAR  # log observation regularizer, NOT a generated-vol cap
    regularized = np.count_nonzero(np.isfinite(s) & (s < floor))
    return .5*np.log(np.maximum(s*YEAR, floor*YEAR)), int(regularized)


def _jump_observations(r, times):
    """4-sigma jump proxy, with predictable EWMA scale; approximate separation."""
    v = float(np.var(r))
    initial = v
    out = np.empty(len(r))
    decay = math.exp(math.log(.5)/24.)
    for i in range(len(r)):
        if i and times[i]-times[i-1] != 3600:
            v = initial
        out[i] = math.sqrt(max(v, 1e-14))
        v = decay*v+(1-decay)*r[i]*r[i]
    hit = np.abs(r) > 4*out
    return hit, out


def _fit_model(x, r, times, hit, states, nstates, diff_scale):
    x = x + math.log(diff_scale)
    valid = np.isfinite(x)
    mu = np.array([np.mean(x[valid & (states == s)]) for s in range(nstates)])
    paired = valid[:-1] & valid[1:] & (np.diff(times) == 3600)
    prev = x[:-1]-mu[states[:-1]]
    nxt = x[1:]-mu[states[1:]]
    phi_raw = float(np.dot(prev[paired], nxt[paired])/max(np.dot(prev[paired], prev[paired]), 1e-12))
    # Estimation family constraint: stable, nonnegative AR persistence.
    phi = float(np.clip(phi_raw, .001, .9995))
    residual = nxt[paired]-phi*prev[paired]
    jump_neg = np.where(hit[:-1], np.maximum(-r[:-1], 0), 0)[paired]
    jump_pos = np.where(hit[:-1], np.maximum(r[:-1], 0), 0)[paired]
    design = np.column_stack((jump_neg-jump_neg.mean(), jump_pos-jump_pos.mean()))
    cojump_raw, *_ = np.linalg.lstsq(design, residual, rcond=None)
    # Positive cojump family, coefficients are log-vol change / log-price jump.
    cojump = np.clip(cojump_raw, 0., 50.)
    unexplained = residual-design@cojump
    eta = []
    for s in range(nstates):
        e = unexplained[states[:-1][paired] == s]
        eta.append(float(max(np.std(e, ddof=1), 1e-5)))
    standardized_price = r[:-1][paired]/np.exp(x[:-1][paired])*math.sqrt(YEAR)
    no_jump = ~hit[:-1][paired]
    rho_raw = float(np.corrcoef(standardized_price[no_jump], unexplained[no_jump])[0, 1])
    rho = float(np.clip(np.nan_to_num(rho_raw), -.95, .95))
    transitions = np.zeros((nstates, nstates), dtype=float)
    for a, b in zip(states[:-1][paired], states[1:][paired]):
        transitions[a, b] += 1
    # Jeffreys smoothing; no minimum regime lifetime is imposed.
    transition = transitions+.5
    transition /= transition.sum(axis=1, keepdims=True)
    exposures = np.array([np.count_nonzero(valid & (states == s)) for s in range(nstates)])
    counts = np.array([np.count_nonzero(valid & (states == s) & hit) for s in range(nstates)])
    negative = np.maximum(-r[hit & (r < 0)], 0)
    positive = np.maximum(r[hit & (r > 0)], 0)
    fallback = float(np.median(np.abs(r[hit]))) if np.any(hit) else float(4*np.std(r))
    means = [float(a.mean()) if len(a) else fallback for a in (negative, positive)]
    # eta>2 ensures finite first/second price moments for individual exp jumps.
    jump_eta = [max(2.01, 1/max(m, 1e-6)) for m in means]
    effective_n = max(2., np.count_nonzero(paired)*(1-phi)/(1+phi))
    return {
        "mu_log_annual_vol": mu.tolist(), "phi": phi, "phi_unconstrained": phi_raw,
        "eta_logvol": eta, "rho_price_vol": rho, "rho_unconstrained": rho_raw,
        "cojump_negative": float(cojump[0]), "cojump_positive": float(cojump[1]),
        "cojump_unconstrained": cojump_raw.tolist(),
        "transition": transition.tolist(), "transition_counts": transitions.tolist(),
        "jump_rate_per_hour": (counts/np.maximum(exposures, 1)).tolist(),
        "jump_counts": counts.tolist(), "exposure_hours": exposures.tolist(),
        "jump_p_negative": float((len(negative)+.5)/(len(negative)+len(positive)+1)),
        "jump_negative_count": len(negative), "jump_positive_count": len(positive),
        "jump_eta_negative": jump_eta[0], "jump_eta_positive": jump_eta[1],
        "effective_logvol_observations": effective_n,
        "n_paired": int(np.count_nonzero(paired)),
        "logvol_std": float(np.std(x[valid])),
    }


def _two_factor_acf(x, times):
    """Fit only training log-RV persistence; no validation/PnL target enters."""
    series = pd.Series(x, index=times).reindex(np.arange(times[0], times[-1]+1, 3600))
    lags = np.array([1, 6, 24, 72, 168, 336, 720], dtype=int)
    acf = np.array([series.autocorr(int(k)) for k in lags])
    valid = np.isfinite(acf)
    if np.count_nonzero(valid) < 4:
        raise ValueError("Insufficient training persistence information for two-factor volatility")
    def errors(q):
        w, slow, fast = q
        return (w*slow**lags+(1-w)*fast**lags-acf)[valid]
    result = least_squares(errors, [.5, .999, .93],
        bounds=([.0001, .95, .001], [.9999, .99999, .95]), max_nfev=1000)
    if not result.success:
        raise ValueError("Training-only two-timescale volatility ACF fit failed")
    w, slow, fast = map(float, result.x)
    return {"weight_slow": w, "phi_slow": slow, "phi_fast": fast,
        "target_logvol_variance": float(np.nanvar(x, ddof=1)),
        "training_acf": {str(k): float(v) if np.isfinite(v) else None for k, v in zip(lags, acf)},
        "acf_fit_rmse": float(np.sqrt(np.mean(errors(result.x)**2))),
        "fit_cutoff_exclusive": "2024-01-01T00:00:00+00:00",
        "fit_bounds": {"weight_slow": [.0001, .9999], "phi_slow": [.95, .99999], "phi_fast": [.001, .95]},
        "selection_note": "Structure revised after a market-memory diagnostic; 2024 is used selection data, not an untouched holdout. Coefficients fitted exclusively on2020-2023."}


def _two_factor_moments(p):
    """Normalize baseline E[sigma^2], including centered Poisson vol-cojumps.

    Cojumps enter only the fast factor. Their stationary second moment is
    subtracted before assigning fast Gaussian variance. Their exact exponential
    moment, rather than a Gaussian approximation, enters the level adjustment.
    """
    t = p["two_factor"]
    rate, pn = p["jump_rate_per_hour"][0], p["jump_p_negative"]
    en, ep = p["jump_eta_negative"], p["jump_eta_positive"]
    # A distribution-family constraint makes E[exp(2*logvol)] finite. It does
    # not truncate any generated return, jump or volatility observation.
    raw = [p["cojump_negative"], p["cojump_positive"]]
    p["cojump_negative"] = min(raw[0], .45*en)
    p["cojump_positive"] = min(raw[1], .45*ep)
    cn, cp = p["cojump_negative"], p["cojump_positive"]
    t["cojump_constraint_adjusted"] = bool(cn != raw[0] or cp != raw[1])
    slow_var = t["weight_slow"]*t["target_logvol_variance"]
    fast_target = (1-t["weight_slow"])*t["target_logvol_variance"]
    jump_innovation_variance = 2*rate*(pn*(cn/en)**2+(1-pn)*(cp/ep)**2)
    jump_stationary_variance = jump_innovation_variance/(1-t["phi_fast"]**2)
    fast_gaussian_var = max(0., fast_target-jump_stationary_variance)
    log_mgf_jump = 0.
    decay = 1.
    while decay > 1e-12:
        an, ap = 2*decay*cn/en, 2*decay*cp/ep
        log_mgf_jump += rate*(pn*an*an/(1-an)+(1-pn)*ap*ap/(1-ap))
        decay *= t["phi_fast"]
    t.update({"slow_gaussian_variance": slow_var,
        "fast_gaussian_variance": fast_gaussian_var,
        "fast_cojump_stationary_variance": jump_stationary_variance,
        "gaussian_eta_slow": math.sqrt(slow_var*(1-t["phi_slow"]**2)),
        "gaussian_eta_fast": math.sqrt(fast_gaussian_var*(1-t["phi_fast"]**2)),
        "logvol_variance_budget_excess": max(0., jump_stationary_variance-fast_target),
        "stationary_log_mgf_cojump_at2": log_mgf_jump,
        "stationary_annual_diffusion_variance": t["annual_diffusion_variance_target"]})
    p["mu_log_annual_vol"] = [.5*(math.log(t["annual_diffusion_variance_target"])
        -2*slow_var-2*fast_gaussian_var-log_mgf_jump)]
    return p


def fit(history, out_path):
    """Fit only 2020-2023; no policy parameters, option PnL or 2024+ inputs.

    history uses market_models.load_history() fields features and times. The
    bootstrap control's public training array is compressed inside the JSON so
    generate() needs no hidden file or mutable global data.
    """
    f = np.asarray(history["features"], dtype=float)
    times = np.asarray(history["times"], dtype=np.int64)
    if f.ndim != 2 or f.shape != (len(times), 4) or not np.isfinite(f).all():
        raise ValueError("history must contain finite [N,4] OHLC features and N times")
    mask = (times >= int(pd.Timestamp("2020-01-01", tz="UTC").timestamp())) & (times < TRAIN_END)
    f, times = f[mask], times[mask]
    if len(f) < 1000 or np.any(np.diff(times) <= 0):
        raise ValueError("Need >=1000 sorted distinct training hours in 2020-2023")
    mu_r = float(f[:, 0].mean())
    r = f[:, 0]-mu_r
    hit, _ = _jump_observations(r, times)
    x, floored = _vol_observations(r, times)
    if np.count_nonzero(np.isfinite(x)) < 500 or np.var(r) <= 1e-12:
        raise ValueError("Training market lacks identifiable volatility")
    # Match total unconditional hourly variance, allocating exp-jump second
    # moments first and the remainder to diffusion. This is a moments fit.
    neg = -r[hit & (r < 0)]
    pos = r[hit & (r > 0)]
    jump_second = 2*(len(neg)*np.mean(neg)**2 if len(neg) else 0)
    jump_second += 2*(len(pos)*np.mean(pos)**2 if len(pos) else 0)
    jump_second /= len(r)
    if jump_second >= .95*np.var(r):
        raise ValueError("Jump/diffusion moment decomposition not identifiable; no silent fallback")
    diff_scale = math.sqrt((np.var(r)-jump_second)/np.nanmean(np.exp(2*x)/YEAR))
    threshold = float(np.nanmedian(x))
    regimes = (np.nan_to_num(x, nan=threshold) > threshold).astype(np.int64)
    configurations = {
        "regime_jump": _fit_model(x, r, times, hit, regimes, 2, diff_scale),
        "sv_jump": _fit_model(x, r, times, hit, np.zeros(len(r), np.int64), 1, diff_scale),
    }
    sv = configurations["sv_jump"]
    sv["volatility_dynamics"] = "two_factor; legacy phi/eta slots retained only for one-factor ablation"
    sv["two_factor"] = _two_factor_acf(x, times)
    baseline_jump_annual_variance = YEAR*2*sv["jump_rate_per_hour"][0]*(
        sv["jump_p_negative"]/sv["jump_eta_negative"]**2
        +(1-sv["jump_p_negative"])/sv["jump_eta_positive"]**2)
    diffusion_target = float(np.var(r)*YEAR-baseline_jump_annual_variance)
    if diffusion_target <= 0:
        raise ValueError("Two-factor jump/diffusion variance budget is not identifiable")
    sv["two_factor"].update({"annual_diffusion_variance_target": diffusion_target,
        "baseline_annual_jump_variance": baseline_jump_annual_variance,
        "baseline_total_annual_logreturn_variance_target": float(np.var(r)*YEAR)})
    _two_factor_moments(sv)
    ends = np.r_[np.where(np.diff(times) != 3600)[0], len(times)-1]
    encoded = base64.b64encode(zlib.compress(np.asarray(f, dtype="<f8").tobytes(), 9)).decode("ascii")
    config = {
        "version": "fresh-draw-physical-frontier-v2-training-two-timescale-sv",
        "training": {"start_utc": pd.Timestamp(times[0], unit="s", tz="UTC").isoformat(),
            "end_exclusive_utc": "2024-01-01T00:00:00+00:00", "rows": len(f),
            "last_observation_utc": pd.Timestamp(times[-1], unit="s", tz="UTC").isoformat()},
        "not_used_for_fit": {"2024": "market validation only", "2025_2026": "already inspected legacy diagnostic, not virgin holdout"},
        "models": configurations,
        "observed": {"annual_log_drift_not_forecast": mu_r*YEAR,
            "annual_realized_vol": float(np.std(r)*math.sqrt(YEAR)),
            "jump_proxy_count": int(hit.sum()), "jump_variance_fraction": float(jump_second/np.var(r)),
            "diffusion_scale_adjustment": diff_scale, "log_observation_floors": floored,
            "regime_logvol_threshold": threshold},
        "bootstrap_reference": {"features_zlib_base64": encoded, "dtype": "<f8", "shape": list(f.shape),
            "segment_ends_inclusive": ends.tolist(), "mean_block_hours": 168.,
            "source_mean_log_return": mu_r},
        "assumptions": [
            "Two parametric models draw novel Gaussian shocks and unbounded exponential jumps; not empirical-FHS returns.",
            "Observable 24h RV and its median split are proxies, not a fully estimated hidden-state likelihood.",
            "4 predictable-EWMA-sigma threshold approximately separates jumps from diffusion.",
            "Stable AR persistence fitted in [.001,.9995]; rho in [-.95,.95]; nonnegative cojump slopes in[0,50].",
            "Exponential jump rates >2.01 constrain the distribution family to finite first/second price moments, NOT realized jump sizes.",
            "No generated return/volatility cap; numerical failures raise and must be counted, never dropped.",
            "Parameter uncertainty is approximate local/Dirichlet/Gamma estimation uncertainty, not full structural model uncertainty.",
            "sv_jump slow/fast logvol persistence is fitted to training-only multi-lag RV24 ACF; regime_jump retains the one-factor structural control.",
            "sv_jump cojump slopes <=.45*jump_eta ensure finite stationary volatility second moment; this is an explicit parameter-family constraint, not a return cap.",
            "sv_jump Gaussian variance allocation and exact stationary cojump exponential moments normalize baseline E[sigma^2] to the training return variance budget.",
            "sv_jump slow initial factor is stationary Gaussian; fast cojump factor starts at matched Gaussian moments before discarded720h warmup.",
            "8 substeps plus conditional marginal Brownian-bridge extrema; jump times are discretized to substep boundaries.",
            "Bridge high/low marginal draws are independent conditional on endpoints, not a joint tick-path reconstruction or ordering guarantee.",
            "Drift is conditional mean LOG return/year, with compound-Poisson mean compensation; not an arithmetic martingale.",
            "Bootstrap reference uses segmentwise circular continuation, making a uniform stationary source distribution despite gaps.",
        ],
    }
    path = Path(out_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((json.dumps(config, ensure_ascii=False, indent=2)+"\n").encode("utf-8"))
    return config


def _sample_parameters(base, rng, uncertain):
    p = copy.deepcopy(base)
    if not uncertain:
        return p
    eff = max(2., p["effective_logvol_observations"])
    p["mu_log_annual_vol"] = (np.array(p["mu_log_annual_vol"])
        +rng.normal(0., p["logvol_std"]/math.sqrt(eff), len(p["mu_log_annual_vol"]))).tolist()
    u = np.clip(p["phi"]/.9995, 1e-5, 1-1e-5)
    p["phi"] = float(.9995/(1+math.exp(-(math.log(u/(1-u))+rng.normal(0, .15)))))
    p["eta_logvol"] = (np.array(p["eta_logvol"])*np.exp(rng.normal(0, 1/math.sqrt(2*eff), len(p["eta_logvol"])))).tolist()
    p["rho_price_vol"] = float(.95*math.tanh(np.arctanh(p["rho_price_vol"]/.95*.999999)
        +rng.normal(0, 1/math.sqrt(max(4, p["n_paired"]-3)))))
    p["transition"] = [rng.dirichlet(np.array(row)+.5).tolist() for row in p["transition_counts"]]
    p["jump_rate_per_hour"] = [float(rng.gamma(n+.5, 1/(exposure+1)))
        for n, exposure in zip(p["jump_counts"], p["exposure_hours"])]
    p["jump_p_negative"] = float(rng.beta(p["jump_negative_count"]+.5, p["jump_positive_count"]+.5))
    for side in ("negative", "positive"):
        rate = p["jump_eta_"+side]
        count = p["jump_"+side+"_count"]
        p["jump_eta_"+side] = 2.01+(rate-2.01)*math.exp(rng.normal(0, 1/math.sqrt(max(2, count))))
    for side in ("negative", "positive"):
        p["cojump_"+side] *= math.exp(rng.normal(0, .15))
    if "two_factor" in p:
        t = p["two_factor"]
        level_offset = p["mu_log_annual_vol"][0]-base["mu_log_annual_vol"][0]
        for key, lower, upper in (("phi_slow", .95, .99999), ("phi_fast", .001, .95)):
            ratio = np.clip((t[key]-lower)/(upper-lower), 1e-5, 1-1e-5)
            t[key] = float(lower+(upper-lower)/(1+math.exp(-(math.log(ratio/(1-ratio))+rng.normal(0, .10)))))
        ratio = np.clip(t["weight_slow"], 1e-5, 1-1e-5)
        t["weight_slow"] = float(1/(1+math.exp(-(math.log(ratio/(1-ratio))+rng.normal(0, .10)))))
        t["target_logvol_variance"] *= math.exp(rng.normal(0, 1/math.sqrt(2*eff)))
        t["annual_diffusion_variance_target"] *= math.exp(2*level_offset)
        _two_factor_moments(p)
    return p


@njit(cache=True)
def _regime_path(uniforms, transition, initial):
    result = np.empty(len(uniforms), dtype=np.int64)
    state = initial
    for i in range(len(uniforms)):
        result[i] = state
        if transition.shape[0] == 2:
            state = 0 if uniforms[i] < transition[state, 0] else 1
    return result


@njit(cache=True)
def _core(regimes, diff_z, vol_z, bridge_u, jump_steps, negative_jumps, positive_jumps, mu, phi, eta, rho, rates,
          pneg, eneg, epos, cneg, cpos, x0, drift):
    n = len(regimes)
    out = np.empty((n, 4))
    vols = np.empty(n)
    x = x0
    for i in range(n):
        s = regimes[i]
        if abs(x) > 300:
            raise ValueError("Log volatility outside floating-point model domain; retain as numerical failure")
        vol = math.exp(x)
        vols[i] = vol
        mean_jump = rates[s]*((1-pneg)/epos-pneg/eneg)
        sub_mean = (drift/YEAR-mean_jump)/SUBSTEPS
        sub_scale = vol/math.sqrt(YEAR*SUBSTEPS)
        value, hi, lo, z = 0., 0., 0., 0.
        for k in range(SUBSTEPS):
            j = jump_steps[i, k]
            before_jump = value+sub_mean+sub_scale*diff_z[i, k]
            d = before_jump-value
            high_bridge = .5*(value+before_jump+math.sqrt(d*d-2*sub_scale*sub_scale*math.log(bridge_u[i, k, 0])))
            low_bridge = .5*(value+before_jump-math.sqrt(d*d-2*sub_scale*sub_scale*math.log(bridge_u[i, k, 1])))
            value = before_jump+j
            z += diff_z[i, k]
            hi = max(hi, high_bridge, value)
            lo = min(lo, low_bridge, value)
        out[i, 0], out[i, 1], out[i, 2], out[i, 3] = value, 0., hi, lo
        next_s = regimes[i+1] if i+1 < n else s
        innovation = rho*z/math.sqrt(SUBSTEPS)+math.sqrt(1-rho*rho)*vol_z[i]
        x = mu[next_s]+phi*(x-mu[s])+eta[s]*innovation
        x += cneg*(negative_jumps[i]-rates[s]*pneg/eneg)
        x += cpos*(positive_jumps[i]-rates[s]*(1-pneg)/epos)
    return out, vols


@njit(cache=True)
def _core_two(diff_z, fast_z, slow_z, bridge_u, jump_steps, negative_jumps,
              positive_jumps, mu, phi_slow, phi_fast, eta_slow, eta_fast, rho,
              rate, pneg, eneg, epos, cneg, cpos, slow0, fast0, drift):
    n = len(diff_z)
    out = np.empty((n, 4))
    vols, slow_path, fast_path = np.empty(n), np.empty(n), np.empty(n)
    slow, fast = slow0, fast0
    mean_jump = rate*((1-pneg)/epos-pneg/eneg)
    sub_mean = (drift/YEAR-mean_jump)/SUBSTEPS
    for i in range(n):
        x = mu+slow+fast
        if abs(x) > 300:
            raise ValueError("Two-factor log volatility exceeds floating-point domain; count failure")
        vol = math.exp(x)
        vols[i], slow_path[i], fast_path[i] = vol, slow, fast
        sub_scale = vol/math.sqrt(YEAR*SUBSTEPS)
        value, hi, lo, z = 0., 0., 0., 0.
        for k in range(SUBSTEPS):
            before_jump = value+sub_mean+sub_scale*diff_z[i, k]
            d = before_jump-value
            hb = .5*(value+before_jump+math.sqrt(d*d-2*sub_scale*sub_scale*math.log(bridge_u[i, k, 0])))
            lb = .5*(value+before_jump-math.sqrt(d*d-2*sub_scale*sub_scale*math.log(bridge_u[i, k, 1])))
            value = before_jump+jump_steps[i, k]
            z += diff_z[i, k]
            hi, lo = max(hi, hb, value), min(lo, lb, value)
        out[i, 0], out[i, 1], out[i, 2], out[i, 3] = value, 0., hi, lo
        slow = phi_slow*slow+eta_slow*slow_z[i]
        fast = phi_fast*fast+eta_fast*(rho*z/math.sqrt(SUBSTEPS)+math.sqrt(1-rho*rho)*fast_z[i])
        fast += cneg*(negative_jumps[i]-rate*pneg/eneg)
        fast += cpos*(positive_jumps[i]-rate*(1-pneg)/epos)
    return out, vols, slow_path, fast_path


def _rng(seed, model, channel):
    return np.random.default_rng(np.random.SeedSequence([seed, model, channel]))


@njit(cache=True)
def _bootstrap_indices(uniforms, starts, successor, mean_block, first):
    result = np.empty(len(uniforms), dtype=np.int64)
    j = first
    for i in range(len(uniforms)):
        if i and uniforms[i] < 1/mean_block:
            j = starts[i]
        elif i:
            j = successor[j]
        result[i] = j
    return result


def _bootstrap(config, n, seed, drift):
    b = config["bootstrap_reference"]
    raw = np.frombuffer(zlib.decompress(base64.b64decode(b["features_zlib_base64"])), dtype=b["dtype"]).reshape(b["shape"])
    successor = np.arange(1, len(raw)+1, dtype=np.int64)
    start = 0
    for end in b["segment_ends_inclusive"]:
        successor[end] = start
        start = end+1
    first = int(_rng(seed, 3, 0).integers(len(raw)))
    starts = _rng(seed, 3, 1).integers(0, len(raw), n, dtype=np.int64)
    uniforms = _rng(seed, 3, 2).random(n)
    idx = _bootstrap_indices(uniforms, starts, successor, b["mean_block_hours"], first)
    f = raw[idx].copy()
    f[:, 0] += drift/YEAR-b["source_mean_log_return"]
    f[:, 2] = np.maximum(f[:, 2], np.maximum(f[:, 0]-f[:, 1], 0))
    f[:, 3] = np.minimum(f[:, 3], np.minimum(f[:, 0]-f[:, 1], 0))
    v = float(np.var(raw[:, 0]))
    vols = np.empty(n)
    for i in range(n):
        vols[i] = math.sqrt(v*YEAR)
        v = .97*v+.03*(f[i, 0]-drift/YEAR)**2
    return f, {"annual_vol": vols, "regime": np.zeros(n, np.int64),
        "jump_count": np.zeros(n, np.int64), "jump_log_return": np.zeros(n),
        "new_parametric_draws": False, "reference_source_indices": idx}


def generate(model, config, hours, seed, drift=0., parameter_uncertainty=True):
    """Return (OHLC log features[hours+721,4], latent/diagnostics dict).

    Separate random channels, including the initial state and parameter draw,
    make past prefixes independent of requested future horizon. Drift is annual
    mean log return, not expected arithmetic return or a risk-neutral rate.
    """
    if model not in MODELS:
        raise ValueError("Unknown physical model: "+str(model))
    hours = _integer(hours, "hours", 1)
    seed = _integer(seed, "seed")
    drift = _finite_float(drift, "drift")
    if not isinstance(parameter_uncertainty, (bool, np.bool_)):
        raise ValueError("parameter_uncertainty must be bool")
    n = hours+WARMUP+1
    if model == "bootstrap_reference":
        features, latent = _bootstrap(config, n, seed, drift)
    else:
        model_code = 1 if model == "regime_jump" else 2
        p = _sample_parameters(config["models"][model], _rng(seed, model_code, 0), parameter_uncertainty)
        transition = np.array(p["transition"])
        mu = np.array(p["mu_log_annual_vol"])
        eta = np.array(p["eta_logvol"])
        initial_rng = _rng(seed, model_code, 1)
        initial_uniform = initial_rng.random()
        initial_normal = initial_rng.standard_normal()
        if len(mu) == 2:
            pi0 = transition[1, 0]/(transition[1, 0]+transition[0, 1])
            initial = 0 if initial_uniform < pi0 else 1
        else:
            initial = 0
        regimes = _regime_path(_rng(seed, model_code, 2).random(n), transition, initial)
        x0 = mu[initial]+eta[initial]/math.sqrt(1-p["phi"]**2)*initial_normal
        rates = np.array(p["jump_rate_per_hour"])
        counts = _rng(seed, model_code, 3).poisson(rates[regimes])
        events = int(counts.sum())
        neg = _rng(seed, model_code, 4).random(events) < p["jump_p_negative"]
        exp_unit = _rng(seed, model_code, 5).exponential(1., events)
        marks = np.where(neg, -exp_unit/p["jump_eta_negative"], exp_unit/p["jump_eta_positive"])
        slots = _rng(seed, model_code, 6).integers(0, SUBSTEPS, events)
        event_hours = np.repeat(np.arange(n), counts)
        jump_steps = np.zeros((n, SUBSTEPS))
        np.add.at(jump_steps, (event_hours, slots), marks)
        negative_jumps = np.bincount(event_hours, weights=np.maximum(-marks, 0), minlength=n)
        positive_jumps = np.bincount(event_hours, weights=np.maximum(marks, 0), minlength=n)
        diff_z = _rng(seed, model_code, 7).standard_normal((n, SUBSTEPS))
        vol_z = _rng(seed, model_code, 8).standard_normal(n)
        bridge_u = 1-_rng(seed, model_code, 9).random((n, SUBSTEPS, 2))
        try:
            if model == "sv_jump" and "two_factor" in p:
                t = p["two_factor"]
                slow0 = math.sqrt(t["slow_gaussian_variance"])*initial_normal
                fast0 = math.sqrt(t["fast_gaussian_variance"]+t["fast_cojump_stationary_variance"])*initial_rng.standard_normal()
                slow_z = _rng(seed, model_code, 10).standard_normal(n)
                features, vols, slow_path, fast_path = _core_two(diff_z, vol_z, slow_z,
                    bridge_u, jump_steps, negative_jumps, positive_jumps, mu[0],
                    t["phi_slow"], t["phi_fast"], t["gaussian_eta_slow"], t["gaussian_eta_fast"],
                    p["rho_price_vol"], rates[0], p["jump_p_negative"], p["jump_eta_negative"],
                    p["jump_eta_positive"], p["cojump_negative"], p["cojump_positive"], slow0, fast0, drift)
            else:
                features, vols = _core(regimes, diff_z, vol_z, bridge_u, jump_steps, negative_jumps,
                    positive_jumps, mu, p["phi"], eta,
                    p["rho_price_vol"], rates, p["jump_p_negative"], p["jump_eta_negative"],
                    p["jump_eta_positive"], p["cojump_negative"], p["cojump_positive"], x0, drift)
        except ValueError as exc:
            raise NumericalMarketError(str(exc)) from exc
        latent = {"annual_vol": vols, "regime": regimes, "jump_count": counts,
            "jump_log_return": jump_steps.sum(axis=1), "new_parametric_draws": True,
            "sampled_parameters": p, "substeps_per_hour": SUBSTEPS,
            "brownian_bridge_marginal_extrema": True,
            "bridge_extrema_joint_order_not_reconstructed": True}
        if model == "sv_jump" and "two_factor" in p:
            latent["slow_logvol_factor"] = slow_path
            latent["fast_logvol_factor"] = fast_path
    if not np.isfinite(features).all():
        raise NumericalMarketError("Nonfinite generated OHLC; no sample discarded")
    logs = np.cumsum(features[:, 0])
    relative = logs-logs[WARMUP]
    if np.max(np.abs(relative)) > 650:
        raise NumericalMarketError("Generated price exceeds exponentiation domain; count this failed path")
    latent.update({"model": model, "seed": seed, "warmup_hours": WARMUP,
        "requested_hours": hours, "annual_mean_log_drift": drift,
        "parameter_uncertainty": bool(parameter_uncertainty),
        "no_return_or_volatility_cap": True, "numerical_failure": False})
    return features, latent
