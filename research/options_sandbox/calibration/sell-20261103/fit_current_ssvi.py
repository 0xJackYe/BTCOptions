"""Market-only current SSVI calibration with grouped cross-validation.

No strategy is imported or evaluated. Uses the saved public snapshot only.
"""
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import least_squares
from scipy.special import ndtr

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parents[2]


def ssvi(parameters, strike, dte, rate, spot):
    logatm, term, rho, eta = parameters
    T = np.asarray(dte) / 365
    theta = math.exp(2 * logatm) * T * (np.asarray(dte) / 14) ** (2 * term)
    k = np.log(np.asarray(strike) / (spot * np.exp(np.asarray(rate) * T)))
    phi = eta / np.sqrt(theta * (1 + theta))
    x = phi * k
    w = .5 * theta * (1 + rho * x + np.sqrt((x + rho) ** 2 + 1 - rho * rho))
    return np.sqrt(w / T)


def prices(frame, iv, spot):
    T = frame.dte.to_numpy() / 365
    strike = frame.strike.to_numpy()
    rate = frame.rate.to_numpy()
    d1 = (np.log(spot / strike) + (rate + .5 * iv ** 2) * T) / (iv * np.sqrt(T))
    d2 = d1 - iv * np.sqrt(T)
    return np.where(frame.side.to_numpy() == "CALL", spot * ndtr(d1) - strike * np.exp(-rate * T) * ndtr(d2), strike * np.exp(-rate * T) * ndtr(-d2) - spot * ndtr(-d1))


def fit(frame, spot):
    # One equal-weight observation per expiry/strike; paired Call/Put never
    # get counted as independent IV observations or split between folds.
    g = frame.groupby("group_id", sort=True).agg(strike=("strike", "first"), dte=("dte", "first"), rate=("rate", "mean"), log_iv=("mark_iv", lambda x: np.mean(np.log(x))))
    def error(parameters):
        return np.log(ssvi(parameters, g.strike, g.dte, g.rate, spot)) - g.log_iv.to_numpy()
    results = []
    for atm, term, rho, eta in ((.39, -.04, -.3, .5), (.4, -.1, -.6, .8), (.4, .05, 0, 1), (.35, 0, -.1, .3)):
        results.append(least_squares(error, [math.log(atm), term, rho, eta], bounds=([math.log(.05), -.489999, -.95, .001], [math.log(2), .5, .95, 1.35]), loss="soft_l1", f_scale=.02, xtol=1e-12, ftol=1e-12, gtol=1e-12, max_nfev=1000))
    successful = [result for result in results if result.success]
    if not successful:
        raise RuntimeError("No market-only SSVI multistart converged")
    best = min(successful, key=lambda result: result.cost)
    return best.x, {"groups": len(g), "success": bool(best.success), "robust_log_iv_loss": float(best.cost), "nfev": int(best.nfev)}


def errors(frame, label):
    iv = frame[label + "_iv"]
    price = frame[label + "_price"]
    quote = (frame.bid > 0) & (frame.ask >= frame.bid)
    mid = .5 * (frame.loc[quote, "bid"] + frame.loc[quote, "ask"])
    abs_mid_error = (price[quote] - mid).abs() / mid
    signed_mid_error = price[quote] / mid - 1
    relative_iv = iv / frame.mark_iv - 1
    return {"rows": len(frame), "groups": int(frame.group_id.nunique()), "log_iv_rmse": float(np.sqrt(np.mean(np.log(iv / frame.mark_iv) ** 2))), "median_abs_relative_iv_error": float(np.median(np.abs(relative_iv))), "abs_relative_iv_error_p90": float(np.quantile(np.abs(relative_iv), .9)), "price_abs_relative_mid_error_p50": float(abs_mid_error.quantile(.5)), "price_abs_relative_mid_error_p90": float(abs_mid_error.quantile(.9)), "price_abs_relative_mid_error_p95": float(abs_mid_error.quantile(.95)), "price_signed_relative_mid_error_p50": float(signed_mid_error.quantile(.5)), "price_inside_recorded_bidask_fraction": float(price[quote].between(frame.loc[quote, "bid"], frame.loc[quote, "ask"]).mean()), "price_abs_relative_mark_error_p50": float(np.median((price - frame.mark_price).abs() / frame.mark_price)), "actual_mark_inside_recorded_bidask_fraction": float(frame.loc[quote, "mark_price"].between(frame.loc[quote, "bid"], frame.loc[quote, "ask"]).mean())}


def summarize(frame, label, spot):
    otm = ((frame.side == "CALL") & (frame.strike > spot)) | ((frame.side == "PUT") & (frame.strike < spot))
    distance = np.where(frame.side == "CALL", frame.strike / spot - 1, 1 - frame.strike / spot)
    return {"all_fit_scope": errors(frame, label), "abs_delta005_095": errors(frame[frame.delta.abs().between(.05, .95)], label), "otm_delta005_020": errors(frame[otm & frame.delta.abs().between(.05, .20)], label), "original_v1_delta_distance": errors(frame[otm & frame.delta.abs().between(.05, .15) & (distance >= .10) & (distance <= .25)], label)}


def static_checks(parameters, spot):
    logatm, term, rho, eta = parameters
    k = np.linspace(-.7, .7, 401)
    maturities = [1, 3, 7, 10, 14, 20, 30, 60, 90]
    checks = []
    prior_variance = None
    for dte in maturities:
        # Fixed forward log-moneyness for calendar checks, fixed strike grid for
        # butterfly checks. A single rate is used only for finite-grid diagnostics.
        rate = .0576
        strike = spot * np.exp(k + rate * dte / 365)
        iv = ssvi(parameters, strike, dte, rate, spot)
        variance = iv ** 2 * dte / 365
        t = dte / 365
        d1 = (-k + .5 * variance) / np.sqrt(variance)
        d2 = d1 - np.sqrt(variance)
        call = spot * ndtr(d1) - strike * math.exp(-rate * t) * ndtr(d2)
        slope = np.diff(call) / np.diff(strike)
        checks.append({"dte": dte, "increasing_call_edges": int((slope > 1e-9).sum()), "slope_below_discounted_minus1": int((slope < -math.exp(-rate * t) - 1e-9).sum()), "negative_convexity_points": int((np.diff(slope) < -1e-9).sum()), "calendar_total_variance_decrease_points": 0 if prior_variance is None else int((variance < prior_variance - 1e-10).sum())})
        prior_variance = variance
    return {"theta_increasing_exponent": float(1 + 2 * term), "eta_times_one_plus_absrho": float(eta * (1 + abs(rho))), "eta_squared_times_one_plus_absrho": float(eta ** 2 * (1 + abs(rho))), "sufficient_butterfly_bounds_under_4": bool(eta * (1 + abs(rho)) < 4 and eta ** 2 * (1 + abs(rho)) <= 4), "finite_grid_checks": checks, "limitations": "Static sufficient conditions and grid checks do not validate dynamic P/Q consistency or market fit outside observed DTE."}


def main():
    base = json.loads((ROOT / "current-cross-section-check.json").read_text(encoding="utf-8"))
    data = pd.read_csv(ROOT / "current-cross-section.csv")
    spot = base["spot_index"]
    # Scope chosen by market relevance, never by any strategy outcome.
    data = data[data.dte.between(10, 20) & data.mark_iv.between(.05, 2) & (np.log(data.strike / spot).abs() <= .35)].copy()
    data["expiry"] = data.symbol.str.split("-").str[1]
    data["group_id"] = data.expiry + "-" + data.strike.map(lambda x: f"{x:g}")
    groups = data[["group_id", "expiry", "strike"]].drop_duplicates().sort_values(["expiry", "strike"])
    groups["fold"] = groups.groupby("expiry").cumcount() % 5
    data["fold"] = data.group_id.map(groups.set_index("group_id").fold)
    data["oof_iv"] = np.nan
    fold_records = []
    for fold in range(5):
        train = data[data.fold != fold]
        test = data[data.fold == fold]
        assert not set(train.group_id) & set(test.group_id)
        parameters, metadata = fit(train, spot)
        data.loc[test.index, "oof_iv"] = ssvi(parameters, test.strike, test.dte, test.rate, spot)
        fold_records.append({"fold": fold, "train_groups": train.group_id.nunique(), "test_groups": test.group_id.nunique(), "parameters": {"atm14": math.exp(parameters[0]), "term_coef": parameters[1], "rho": parameters[2], "eta": parameters[3]}, **metadata})
    if data.oof_iv.isna().any():
        raise RuntimeError("Unscored out-of-group rows")
    data["oof_price"] = prices(data, data.oof_iv.to_numpy(), spot)
    oof_errors = summarize(data, "oof", spot)
    # Only after all out-of-group predictions are frozen fit the complete snapshot.
    parameters, fit_metadata = fit(data, spot)
    data["full_fit_iv"] = ssvi(parameters, data.strike, data.dte, data.rate, spot)
    data["full_fit_price"] = prices(data, data.full_fit_iv.to_numpy(), spot)
    data["actual_mark_iv_iv"] = data.mark_iv
    data["actual_mark_iv_price"] = prices(data, data.mark_iv.to_numpy(), spot)
    output = ROOT / "current-ssvi-cross-validation.csv"
    data.to_csv(output, index=False)
    result = {"status": "current_public_market_only_SSVI_fit_not_future_or_execution_validation", "data_asof": base["snapshot_utc"], "spot_index": spot, "atm14": math.exp(parameters[0]), "surface_model": {"term_coef": parameters[1], "rho": parameters[2], "eta": parameters[3], "formula": "w=theta/2*(1+rho*phi*k+sqrt((phi*k+rho)^2+1-rho^2)); phi=eta/sqrt(theta*(1+theta)); theta=atm14^2*T*(DTE/14)^(2*term_coef); k=ln(K/(S*exp(r*T)))"}, "fit_scope": {"dte": [10, 20], "mark_iv": [.05, 2], "max_abs_log_moneyness_spot": .35, "rows": len(data), "groups": data.group_id.nunique(), "expiries": sorted(data.expiry.unique().tolist()), "actual_dte": sorted(data.dte.unique().tolist()), "target": "equal-weight expiry/strike mean log markIV; soft_l1 f_scale=.02; no strategy inputs or PnL", "bounds": {"atm14": [.05, 2], "term_coef": [-.49, .5], "rho": [-.95, .95], "eta": [.001, 1.35]}}, "train_test_grouping": {"method": "5-fold deterministic strike-interleaved within each expiry", "group": "expiry+strike, paired Call/Put always same fold", "fold_assignment": "rank strike ascending within each expiry modulo 5", "time_holdout": False, "leaves_expiry_out": False, "folds": fold_records}, "errors": {"out_of_group": oof_errors, "full_snapshot_in_sample": summarize(data, "full_fit", spot)}, "static_checks": static_checks(parameters, spot), "fit_metadata": fit_metadata, "sourceSHA": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in ("current-cross-section.csv", "current-cross-section-check.json")}, "raw_public_input_sha256": base["input_sha256"], "limitations": ["One current cross-section, not future temporal validation; two observed maturities only.", "Grouped CV tests interpolation to missing strikes; it does not test held-out expiry, future smile dynamics or tails.", "Ticker requests are asynchronous to mark/index; only about65% of actual mark prices lie in the recorded broad-scope bid/ask.", "Fit target is markIV, not traded fills; bid/ask diagnostics are descriptive, not liquidity guarantees.", "No strategy imported, no profit objective, no fees/fills/risk limits optimized here.", "Historical 2023 SSVI is retained separately as a misspecified-model diagnostic."]}
    result["fit_scope"]["bounds"]["term_coef"][0] = -.489999
    result["full_fit_atm_over_frozen_2023_forecast"] = result["atm14"] / base["frozen_2023_atm14_prediction"]
    result["errors"]["actual_mark_iv_repricing_baseline"] = summarize(data, "actual_mark_iv", spot)
    result["sourceSHA"][Path(__file__).name] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    (ROOT / "current-ssvi-calibration.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({key: result[key] for key in ("data_asof", "atm14", "surface_model", "fit_scope", "errors", "static_checks")}, indent=2))


if __name__ == "__main__":
    main()
