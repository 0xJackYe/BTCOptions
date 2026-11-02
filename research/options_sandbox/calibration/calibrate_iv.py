"""Calibrate a research IV surface and quote frictions from saved public data.

No API keys, network requests, orders or website changes. The model is a small
2023 sample calibration, not the Binance pricing model or a profitability claim.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import least_squares
from scipy.special import ndtr

ROOT = Path(__file__).resolve().parent
DATA = ROOT.parent / "data"
ARCHIVES = DATA / "eoh-archives"
FEATURES = ["intercept", "beta_log_rv", "skew_coef", "curvature", "term_coef", "negative_r24_coef", "positive_r24_coef"]


def safe(value):
    if isinstance(value, dict):
        return {str(k): safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [safe(v) for v in value]
    if isinstance(value, (np.floating, float)):
        return float(value) if np.isfinite(value) else None
    if isinstance(value, np.integer):
        return int(value)
    return value


def quantile_dict(series):
    x = pd.to_numeric(series, errors="coerce").replace([np.inf, -np.inf], np.nan).dropna()
    return {"count": len(x), **{f"p{q}": float(x.quantile(q / 100)) if len(x) else None for q in (5, 10, 25, 50, 75, 90, 95, 99)}}


def matrix(data):
    lm = data["log_moneyness"].to_numpy()
    r24 = data["r24"].to_numpy()
    return np.column_stack([np.ones(len(data)), np.log(data["ewma_vol"]), lm, lm * lm, np.log(data["dte"] / 14), np.minimum(r24, 0), np.maximum(r24, 0)])


def fit(data):
    X = matrix(data)
    y = np.log(data["mark_iv"].to_numpy())
    weight = 1 / data.groupby("available_epoch")["symbol"].transform("size").to_numpy()
    root_weight = np.sqrt(weight)
    beta = np.linalg.lstsq(X * root_weight[:, None], y * root_weight, rcond=None)[0]
    return beta, y - X @ beta


def load():
    frames = []
    files = []
    for path in sorted(ARCHIVES.glob("*.zip")):
        checksum = path.with_name(path.name + ".CHECKSUM")
        expected = checksum.read_text().split()[0].lower()
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if expected != actual:
            raise ValueError(f"Checksum mismatch: {path.name}")
        frame = pd.read_csv(path, dtype={"hour": str})
        frames.append(frame)
        files.append({"file": path.name, "sha256": actual})
    if not frames:
        raise FileNotFoundError("No EOH archives found. Run prepare_data.py --options first, or set --data-dir.")
    data = pd.concat(frames, ignore_index=True)
    stamp = pd.to_datetime(data["date"] + " " + data["hour"].str.zfill(2) + ":00:00", utc=True) + pd.Timedelta(hours=1)
    data["available_epoch"] = stamp.astype("int64") // 10 ** 9
    data["available_date"] = stamp.dt.strftime("%Y-%m-%d")
    pieces = data.symbol.str.extract(r"^BTC-(\d{6})-([\d.]+)-([CP])$")
    expiration = pd.to_datetime(pieces[0], format="%y%m%d", utc=True) + pd.Timedelta(hours=8)
    data["dte"] = ((expiration.astype("int64") // 10 ** 9) - data["available_epoch"]) / 86400
    data["strike_n"] = pd.to_numeric(pieces[1], errors="coerce")
    data["side"] = pieces[2]
    spot = pd.read_csv(DATA / "btc_spot_1h.csv").set_index("open_epoch_sec").sort_index()
    calendar = np.arange(spot.index.min(), spot.index.max() + 1, 3600, dtype=np.int64)
    spot = spot.reindex(calendar)
    lr = np.log(spot["close"] / spot["close"].shift(1))
    hourly_lambda = .94 ** (1 / 24)
    variance = lr.pow(2).ewm(alpha=1 - hourly_lambda, adjust=False, min_periods=480).mean()
    variance[lr.rolling(480).count() < 480] = np.nan
    spot["ewma_vol"] = np.sqrt(variance * 8760).shift(1)
    spot["rv20"] = lr.rolling(480).std(ddof=1).shift(1) * np.sqrt(8760)
    spot["r24"] = spot["close"].shift(1) / spot["close"].shift(25) - 1
    spot["r1"] = lr.shift(1)
    spot["dlog_ewma"] = np.log(spot["ewma_vol"]).diff()
    merged = spot[["open", "ewma_vol", "rv20", "r24", "r1", "dlog_ewma"]].rename(columns={"open": "spot_proxy"}).reset_index(names="available_epoch")
    data = data.merge(merged, on="available_epoch", how="left", validate="many_to_one")
    data["log_moneyness"] = np.log(data["strike_n"] / data["spot_proxy"])
    data["abs_delta"] = data.delta.abs()
    data["spread"] = (data.best_ask_price - data.best_bid_price) / ((data.best_ask_price + data.best_bid_price) / 2)
    data["positive_quote"] = (data.best_bid_price > 0) & (data.best_ask_price >= data.best_bid_price)
    data["liquid_001"] = data.positive_quote & data.spread.le(.20) & data.best_bid_qty.ge(.05) & data.best_ask_qty.ge(.05)
    data["dte_bin"] = pd.cut(data.dte, [7, 10, 20, 35.000001], right=False, labels=["7_10", "10_20", "20_35"])
    data["delta_bin"] = pd.cut(data.abs_delta, [0, .05, .10, .15, .20, .35, .65, 1.000001], right=False, labels=["0_.05", ".05_.10", ".10_.15", ".15_.20", ".20_.35", ".35_.65", ".65_1"])
    return data, files


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    data, files = load()
    # Broad near/OTM surface: mark IVs are model marks, not executable prices.
    keep = data.dte.between(7, 35) & data.mark_iv.between(.05, 3) & data.ewma_vol.between(.05, 3) & data.log_moneyness.abs().le(.30) & data.abs_delta.between(.05, .95) & data.r24.notna()
    sample = data.loc[keep].copy()
    beta, residual = fit(sample)
    sample["log_iv_residual"] = residual
    per_hour = sample.groupby("available_epoch").agg(residual=("log_iv_residual", "median"), r1=("r1", "first"), r24=("r24", "first"), ewma_vol=("ewma_vol", "first"), rv20=("rv20", "first"), mark_iv_median=("mark_iv", "median"), rows=("symbol", "size"))
    per_hour["residual_previous"] = per_hour.residual.shift(1)
    consecutive = per_hour.index.to_series().diff().eq(3600)
    pairs = per_hour.loc[consecutive & per_hour.residual_previous.notna()]
    ar = np.linalg.lstsq(np.column_stack([np.ones(len(pairs)), pairs.residual_previous]), pairs.residual, rcond=None)[0]
    innovations = pairs.residual - ar[0] - ar[1] * pairs.residual_previous
    phi = float(ar[1])
    per_hour["u_innovation"] = np.nan
    per_hour.loc[pairs.index, "u_innovation"] = innovations
    per_hour.reset_index().to_csv(ROOT / "hourly-common-factor.csv", index=False)
    pairs_out = pairs[["r1", "r24", "ewma_vol", "residual"]].copy()
    pairs_out["u_innovation"] = innovations
    pairs_out.reset_index().to_csv(ROOT / "joint-innovations.csv", index=False)

    # Quote dispersion retains bad quote probabilities, not only selected tradable rows.
    stats = []
    scope = data[data.dte.between(7, 35) & data.abs_delta.between(.05, .65)]
    for keys, group in scope.groupby(["dte_bin", "side", "delta_bin"], observed=True):
        valid = group[group.positive_quote]
        row = dict(zip(["dte_bin", "side", "delta_bin"], [str(x) for x in keys]))
        row.update({"rows": len(group), "positive_quote_fraction": float(group.positive_quote.mean()), "passes_spread20_and_size5x_fraction": float(group.liquid_001.mean()), "invalid_or_no_quote_fraction": float(1 - group.positive_quote.mean()), "spread": quantile_dict(valid.spread), "bid_qty": quantile_dict(valid.best_bid_qty), "ask_qty": quantile_dict(valid.best_ask_qty), "mark_iv_over_ewma": quantile_dict(group.mark_iv / group.ewma_vol), "mark_iv_over_rv20": quantile_dict(group.mark_iv / group.rv20)})
        stats.append(row)
    # ATM/14d hourly proxy provides interpretable empirical VRP levels and persistence.
    atm = data[data.dte.between(10, 20) & data.mark_iv.between(.05, 3) & data.ewma_vol.between(.05, 3)].copy()
    atm["distance"] = atm.log_moneyness.abs() + .001 * (atm.dte - 14).abs()
    atm = atm.sort_values(["available_epoch", "distance", "symbol"]).drop_duplicates("available_epoch")
    atm = atm[atm.log_moneyness.abs().le(.05)].copy()
    atm["ratio_ewma"] = atm.mark_iv / atm.ewma_vol
    atm["ratio_rv20"] = atm.mark_iv / atm.rv20
    atm.to_csv(ROOT / "atm-hourly-observations.csv", index=False)
    atm["shock_bin"] = pd.cut(atm.r24, [-np.inf, -.03, -.01, .01, .03, np.inf], right=False, labels=["down_gt3pct", "down1_3pct", "flat_pm1pct", "up1_3pct", "up_gt3pct"])
    shock_stats = [{"shock_bin": str(key), "hours": len(group), "iv_ewma_ratio": quantile_dict(group.ratio_ewma), "iv": quantile_dict(group.mark_iv)} for key, group in atm.groupby("shock_bin", observed=True)]

    # Flat IV is an explicit safer baseline; add an independently constrained
    # SSVI shape rather than extrapolating an unconstrained polynomial smile.
    flat_indices = [0, 1, 4, 5, 6]
    flat_X = matrix(atm)[:, flat_indices]
    flat_beta_reduced = np.linalg.lstsq(flat_X, np.log(atm.mark_iv), rcond=None)[0]
    flat_beta = np.zeros(len(FEATURES))
    flat_beta[flat_indices] = flat_beta_reduced
    flat_residuals = np.log(atm.mark_iv.to_numpy()) - flat_X @ flat_beta_reduced
    flat_hours = pd.DataFrame({"available_epoch": atm.available_epoch.to_numpy(), "u": flat_residuals, "r1": atm.r1.to_numpy()}).sort_values("available_epoch")
    flat_hours["previous_u"] = flat_hours.u.shift(1)
    pair_mask = flat_hours.available_epoch.diff().eq(3600) & flat_hours.previous_u.notna()
    fp = flat_hours.loc[pair_mask]
    flat_ar = np.linalg.lstsq(np.column_stack([np.ones(len(fp)), fp.previous_u]), fp.u, rcond=None)[0]
    flat_innovation = fp.u - flat_ar[0] - flat_ar[1] * fp.previous_u
    flat_hours["u_innovation"] = np.nan
    flat_hours.loc[fp.index, "u_innovation"] = flat_innovation
    flat_hours.to_csv(ROOT / "atm-joint-innovations.csv", index=False)
    flat_phi = float(flat_ar[1])
    term = float(flat_beta[4])
    if term <= -.5:
        raise ValueError("Fitted term slope breaks increasing total variance; do not publish as safe baseline")
    flat_model = {"formula": "log(sigma14)=intercept+beta_log_rv*log(EWMAannualvol)+negative_r24_coef*min(R24,0)+positive_r24_coef*max(R24,0)+u; flat sigma(T)=sigma14*(DTE/14)^term_coef", "coefficients": dict(zip(FEATURES, flat_beta.tolist())), "residual_dynamics": {"u_phi": flat_phi, "u_intercept": float(flat_ar[0]), "u_longrun_mean": float(flat_ar[0] / (1 - flat_phi)), "u_innovation_std": float(flat_innovation.std(ddof=1)), "u_residual_std": float(flat_hours.u.std(ddof=1)), "innovation_correlation_same_hour_spot_return": float(np.corrcoef(flat_innovation, fp.r1)[0, 1]), "consecutive_pairs": len(fp), "innovation_empirical": quantile_dict(flat_innovation)}, "fit_hours": len(atm), "fit_log_iv_rmse": float(np.sqrt(np.mean(flat_residuals ** 2))), "EWMA_hourly_lambda": .94 ** (1 / 24), "innovation_source": "atm-joint-innovations.csv"}
    atm14 = atm.set_index("available_epoch").mark_iv * (14 / atm.set_index("available_epoch").dte) ** term
    shape = sample[sample.available_epoch.isin(atm14.index)].copy()
    shape["sigma14_proxy"] = shape.available_epoch.map(atm14)
    theta = shape.sigma14_proxy.to_numpy() ** 2 * (shape.dte.to_numpy() / 365) * (shape.dte.to_numpy() / 14) ** (2 * term)
    k = shape.log_moneyness.to_numpy()
    observed_log_ratio = np.log(shape.mark_iv.to_numpy() ** 2 * (shape.dte.to_numpy() / 365) / theta)
    shape_weight = np.sqrt(1 / shape.groupby("available_epoch").symbol.transform("size").to_numpy())
    def ssvi_ratio(rho, eta, theta_value, logk):
        phi_value = eta / np.sqrt(theta_value * (1 + theta_value))
        return .5 * (1 + rho * phi_value * logk + np.sqrt((phi_value * logk + rho) ** 2 + 1 - rho * rho))
    def shape_errors(params):
        return shape_weight * (np.log(ssvi_ratio(params[0], params[1], theta, k)) - observed_log_ratio)
    opt = least_squares(shape_errors, [-.10, .60], bounds=([-.95, .001], [.95, 1.35]), max_nfev=100, loss="soft_l1", f_scale=.05)
    rho, eta = [float(x) for x in opt.x]
    assert eta * eta * (1 + abs(rho)) < 4 and eta * (1 + abs(rho)) < 4
    ssvi = {"formula": "w(k,theta)=theta/2*(1+rho*phi*k+sqrt((phi*k+rho)^2+1-rho^2)); phi=eta/sqrt(theta*(1+theta)); sigma(K,T)=sqrt(w/T)", "theta_formula": "sigma14^2*T*(DTE/14)^(2*term_coef)", "logk_formula": "ln(K/F), F=S*exp(r*T); fit uses spot proxy and r=0", "rho": rho, "eta": eta, "term_coef": term, "rho_bound": .95, "eta_bound_used": 1.35, "eta_squared_times_one_plus_absrho": eta * eta * (1 + abs(rho)), "eta_times_one_plus_absrho": eta * (1 + abs(rho)), "increasing_total_variance_exponent": 1 + 2 * term, "fit_rows": len(shape), "fit_hours": shape.available_epoch.nunique(), "fit_success": bool(opt.success), "log_total_variance_ratio_rmse_equal_hour_weight": float(np.sqrt(shape_errors(opt.x) @ shape_errors(opt.x) / shape.available_epoch.nunique())), "note": "Bounded power-law SSVI shape fitted to 2023 mark-IV ratios, not to strategy profitability; constraints and finite-grid checks do not establish real-world market adequacy."}
    checks = []
    K = np.linspace(.50, 1.50, 301)
    lm = np.log(K)
    for sigma14 in [.2, .4, .8, 1.5]:
        prior_call = None
        for dte in [1, 7, 14, 30, 90]:
            T = dte / 365
            theta_value = sigma14 * sigma14 * T * (dte / 14) ** (2 * term)
            w = theta_value * ssvi_ratio(rho, eta, theta_value, lm)
            iv_shape = np.sqrt(w / T)
            d1 = (-lm + .5 * w) / np.sqrt(w)
            d2 = d1 - np.sqrt(w)
            call = ndtr(d1) - K * ndtr(d2)
            slopes = np.diff(call) / np.diff(K)
            checks.append({"sigma14": sigma14, "dte": dte, "increasing_call_edges": int((slopes > 1e-8).sum()), "slope_below_minus1_edges": int((slopes < -1 - 1e-8).sum()), "negative_convexity_points": int((np.diff(slopes) < -1e-7).sum()), "calendar_decrease_points": int((call < prior_call - 1e-8).sum()) if prior_call is not None else 0})
            prior_call = call
    ssvi["finite_grid_checks"] = checks
    ssvi["finite_grid_violation_count"] = sum(x["increasing_call_edges"] + x["slope_below_minus1_edges"] + x["negative_convexity_points"] + x["calendar_decrease_points"] for x in checks)
    assert ssvi["finite_grid_violation_count"] == 0

    train = sample[sample.available_date.lt("2023-09-01")]
    test = sample[sample.available_date.ge("2023-09-01")]
    train_beta, train_resid = fit(train)
    test_resid = np.log(test.mark_iv.to_numpy()) - matrix(test) @ train_beta
    def hourly_rmse(frame, errors):
        temp = pd.DataFrame({"epoch": frame.available_epoch.to_numpy(), "e2": np.asarray(errors) ** 2})
        return float(np.sqrt(temp.groupby("epoch").e2.mean().mean()))

    relevant = data[data.dte.between(10, 20) & data.abs_delta.between(.05, .20)]
    valid_quote = relevant[relevant.positive_quote]
    on5 = ((valid_quote.best_bid_price / 5 - np.round(valid_quote.best_bid_price / 5)).abs() < 1e-8) & ((valid_quote.best_ask_price / 5 - np.round(valid_quote.best_ask_price / 5)).abs() < 1e-8)
    output = {
        "status": "research_calibration_2023_public_data_not_exchange_pricing_model",
        "source": {"archives": len(files), "raw_rows": len(data), "archive_start": str(data.date.min()), "archive_end": str(data.date.max()), "all_checksums_verified": True, "historical_bid_iv_nonmissing": int(data.best_buy_iv.notna().sum()), "eoh_timestamp_policy": "date/hour plus 1h availability; spot open then is index proxy", "historical_rate": "not needed for mark-IV regression; no private data"},
        "model": {"formula": "log(sigma)=intercept+beta_log_rv*log(EWMAannualvol)+skew_coef*log(K/S)+curvature*log(K/S)^2+term_coef*log(DTE/14)+negative_r24_coef*min(R24,0)+positive_r24_coef*max(R24,0)+u", "coefficients": dict(zip(FEATURES, beta.tolist())), "unit_r24": "decimal 24h return, e.g. -.03, not percent or standardized shock", "EWMA_hourly_lambda": .94 ** (1 / 24), "EWMA_annual_hours": 8760, "residual_dynamics": {"u_phi": phi, "u_intercept": float(ar[0]), "u_longrun_mean": float(ar[0] / (1 - phi)) if abs(phi) < 1 else None, "u_innovation_std": float(innovations.std(ddof=1)), "u_innovation_empirical": quantile_dict(innovations), "u_residual_std": float(per_hour.residual.std(ddof=1)), "innovation_correlation_same_hour_spot_return": float(np.corrcoef(innovations, pairs.r1)[0, 1]), "consecutive_pairs": len(pairs)}, "fit_rows": len(sample), "fit_hours": sample.available_epoch.nunique(), "fit_log_iv_rmse_equal_hour_weight": hourly_rmse(sample, residual), "train_through": "2023-08-31", "validation_from": "2023-09-01", "train_coefficients": dict(zip(FEATURES, train_beta.tolist())), "train_log_iv_rmse": hourly_rmse(train, train_resid), "validation_log_iv_rmse": hourly_rmse(test, test_resid), "suggested_innovation_source": "joint-innovations.csv; common-factor innovations are stochastic, do not force IV/EWMA ratio above a strategy threshold"},
        "atm_14d_proxy": {"hours": len(atm), "max_log_moneyness_abs": .05, "mark_iv": quantile_dict(atm.mark_iv), "iv_over_ewma": quantile_dict(atm.ratio_ewma), "iv_over_rv20": quantile_dict(atm.ratio_rv20), "fraction_iv_below_ewma": float(atm.ratio_ewma.lt(1).mean()), "fraction_iv_below_1p2_ewma": float(atm.ratio_ewma.lt(1.2).mean()), "shock_groups": shock_stats},
        "execution_10_20d_delta005_020": {"rows": len(relevant), "positive_quote_fraction": float(relevant.positive_quote.mean()), "invalid_or_no_quote_fraction": float(1 - relevant.positive_quote.mean()), "passes_spread20_and_qty5x_fraction": float(relevant.liquid_001.mean()), "spread": quantile_dict(valid_quote.spread), "bid_qty": quantile_dict(valid_quote.best_bid_qty), "ask_qty": quantile_dict(valid_quote.best_ask_qty), "both_prices_on_5usdt_grid_fraction": float(on5.mean()), "grid_note": "Observed price grid, not proof of historical/current exchange tick rule."},
        "quote_groups": stats,
        "safe_atm_baseline_model": flat_model,
        "constrained_ssvi_shape": ssvi,
        "limitations": ["147 days in one 2023 regime, 12 whole dates and other hours missing; not 2026 IV/liquidity coverage", "Mark IV is exchange model mark and best_buy_iv is entirely absent; regression does not prove sellable IV", "Spot open is a proxy for option index; one-hour snapshots cannot reveal intra-hour sequence or latency", "A Gaussian AR1 residual alone may understate IV tail shocks; empirical innovation bootstrap and IV-stress sensitivity required", "Fitted shape is not automatically butterfly/calendar-arbitrage free; reject/correct option-price monotonicity/convexity violations in simulator", "No side coefficient so equal K/T receives same sigma, preserving model put-call parity; does not prove dynamic market calibration", "Quote rows weight different strike/tenor listings; regression gives each hour equal total weight but selection remains", "No quoted depth at zero/no-bid states means inability to close should be explicitly simulated, not treated as fair-value fill", "Physical BTC model and this market-pricing IV model are separate; IV richness must not be optimized for positive strategy results", "No perpetual-funding, historical borrowing, true queue priority, liquidations, account netting or multi-second execution data"]}
    (ROOT / "calibration.json").write_text(json.dumps(safe(output), ensure_ascii=False, indent=2), encoding="utf-8")
    implementation = {"status": "recommended_research_baseline_ATM_plus_constrained_SSVI_not_exchange_pricing", "source": output["source"], "model": flat_model, "surface_model": ssvi, "execution": output["execution_10_20d_delta005_020"], "quote_groups": stats, "limitations": output["limitations"]}
    (ROOT / "ssvi-calibration.json").write_text(json.dumps(safe(implementation), ensure_ascii=False, indent=2), encoding="utf-8")
    (ROOT / "archive-checksums.json").write_text(json.dumps(files, indent=2), encoding="utf-8")
    flat = []
    for row in stats:
        flat.append({**{k: v for k, v in row.items() if not isinstance(v, dict)}, **{f"spread_{k}": v for k, v in row["spread"].items()}})
    pd.DataFrame(flat).to_csv(ROOT / "quote-group-summary.csv", index=False)
    assert np.isfinite(beta).all() and len(pairs) > 100
    assert output["source"]["historical_bid_iv_nonmissing"] == 0
    print(json.dumps(safe({"source": output["source"], "model": output["model"], "atm": output["atm_14d_proxy"], "execution": output["execution_10_20d_delta005_020"]}), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DATA, help="Folder containing btc_spot_1h.csv and eoh-archives/")
    args = parser.parse_args()
    DATA = args.data_dir.resolve()
    ARCHIVES = DATA / "eoh-archives"
    main()
