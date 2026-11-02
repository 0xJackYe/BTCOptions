"""Run offline Monte Carlo research and write transparent, reproducible artifacts."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import platform
import time
import numpy as np
import pandas as pd
from market_models import ROOT, LAMBDA, load_history, calibrate_price, generate_market, diagnostics
from strategy_engine import simulate_path

METRICS = ["end_nav", "holding_benchmark_nav", "total_return", "excess_return", "max_drawdown", "max_mm_ae", "opened_legs", "closed_legs", "potential_intrahour_liquidations", "failed_exit_hours", "all_fees", "realized_option_pnl", "gross_premiums", "end_btc", "end_wallet_usdt", "spot_buys", "spot_sells", "cash_or_inventory_rejections", "margin_rejections", "invariant_violations", "terminal_option_liability", "initial_nav", "cash_reserve_breach_hours", "option_pnl_including_terminal_liability", "inventory_rebalance_pnl_vs_hold"]
SCENARIOS = {
    "base": {"iv": 1, "spread": 1, "miss": 0},
    "low_iv": {"iv": .85, "spread": 1, "miss": 0},
    "high_iv": {"iv": 1.15, "spread": 1, "miss": 0},
    "wide_spread": {"iv": 1, "spread": 2, "miss": 0},
    "execution_stress": {"iv": 1, "spread": 2, "miss": .15},
    "zero_drift": {"iv": 1, "spread": 1, "miss": 0, "drift": "zero"},
}


def clean(x):
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, list):
        return [clean(v) for v in x]
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.floating, float)):
        return float(x) if np.isfinite(x) else None
    return x


def prepare_market(features, iv_config, seed, S0=77928.47673913):
    r = features[:, 0]
    logs = np.cumsum(r)
    scale = math.log(S0) - logs[720]
    if np.max(logs + scale) > 650 or np.min(logs + scale) < -650:
        raise ValueError("Model produced numerical price explosion; do not silently discard as profitable/safe.")
    close = np.exp(logs + scale)
    opening = np.exp(logs - r + scale + features[:, 1])
    high = np.maximum(np.maximum(opening * np.exp(features[:, 2]), opening), close)
    low = np.minimum(np.minimum(opening * np.exp(features[:, 3]), opening), close)
    ewma_var = np.empty(len(r))
    ewma_var[0] = np.mean(r[:480] ** 2)  # warmup only, never an active-period input
    for i in range(1, len(r)):
        ewma_var[i] = LAMBDA * ewma_var[i - 1] + (1 - LAMBDA) * r[i] ** 2
    ewma = np.sqrt(ewma_var * 8760)
    sr = np.r_[0, np.cumsum(r)]
    sr2 = np.r_[0, np.cumsum(r * r)]
    rv20 = np.full(len(r), np.nan)
    vals = ((sr2[480:] - sr2[:-480]) - (sr[480:] - sr[:-480]) ** 2 / 480) / 479
    rv20[479:] = np.sqrt(np.maximum(vals, 1e-14) * 8760)
    r24 = np.zeros(len(r))
    r24[24:] = np.exp(logs[24:] - logs[:-24]) - 1
    coeff = iv_config["model"]["coefficients"]
    dynamics = iv_config["model"]["residual_dynamics"]
    # Independent random channels make every past prefix invariant to a longer
    # requested horizon, future shock edits, or a different future bin count.
    rng_iv = np.random.default_rng(np.random.SeedSequence([seed, 1]))
    rng_spread = np.random.default_rng(np.random.SeedSequence([seed, 2]))
    rng_available = np.random.default_rng(np.random.SeedSequence([seed, 3]))
    rng_entry = np.random.default_rng(np.random.SeedSequence([seed, 4]))
    rng_exit = np.random.default_rng(np.random.SeedSequence([seed, 5]))
    # Empirical innovations sampled conditional on the sign/size rank of current
    # spot shock. Bins preserve some observed leverage coupling, not a normal law.
    iv_hist = pd.read_csv(ROOT / "calibration/atm-joint-innovations.csv").dropna(subset=["u_innovation", "r1"])
    scores = iv_hist.r1.rank(method="first", pct=True).to_numpy()
    pools = [iv_hist.u_innovation.to_numpy()[(scores > j / 5) & (scores <= (j + 1) / 5)] for j in range(5)]
    normalized = r / np.sqrt(np.maximum(np.r_[ewma_var[0], ewma_var[:-1]], 1e-14))
    # Fixed normal quantile bin boundaries are just a rank-coupling proxy; empirical
    # innovation values remain un-normalized. Sensitivities expose pricing risk.
    bins = np.searchsorted(np.array([-.841621, -.253347, .253347, .841621]), normalized)
    innovations = np.empty(len(r))
    innovation_uniform = rng_iv.random(len(r))
    for j, pool in enumerate(pools):
        mask = bins == j
        innovations[mask] = pool[np.minimum((innovation_uniform[mask] * len(pool)).astype(int), len(pool) - 1)]
    u = np.empty(len(r))
    u[0] = dynamics["u_longrun_mean"]
    for i in range(1, len(r)):
        u[i] = dynamics["u_intercept"] + dynamics["u_phi"] * u[i - 1] + innovations[i]
    log_atm = coeff["intercept"] + coeff["beta_log_rv"] * np.log(np.maximum(ewma, 1e-8)) + coeff["negative_r24_coef"] * np.minimum(r24, 0) + coeff["positive_r24_coef"] * np.maximum(r24, 0) + u
    if np.max(abs(log_atm)) > 100:
        raise ValueError("IV dynamic model numerical extrapolation failure.")
    atm = np.exp(log_atm)
    # Quantile-calibrated spread with a common per-hour factor; depth shortage
    # draws are stress assumptions, not estimates of matching-engine fill rates.
    execution = iv_config["execution"]
    ps = execution["spread"]
    quantiles = np.array([ps[k] for k in ("p5", "p10", "p25", "p50", "p75", "p90", "p95", "p99")])
    spread = np.interp(rng_spread.random(len(r)), [.05, .10, .25, .50, .75, .90, .95, .99], quantiles)
    availability = rng_available.random(len(r)) >= execution["invalid_or_no_quote_fraction"]
    # 'availability' means synthetic quote usable, not an inferred outage rate.
    entry_random = rng_entry.random((len(r), 2))
    exit_random = rng_exit.random((len(r), 2))
    return close, high, low, atm, rv20, spread, availability, entry_random, exit_random


def summarize(frame):
    n = len(frame)
    rng = np.random.default_rng(20261102)
    excess = frame.excess_return.to_numpy()
    boot = np.mean(excess[rng.integers(0, n, (1000, n))], axis=1)
    worst = np.sort(frame.total_return.to_numpy())[:max(1, math.ceil(.05 * n))]
    return {"paths": n, "median_total_return": frame.total_return.median(), "mean_total_return": frame.total_return.mean(), "total_return_p05": frame.total_return.quantile(.05), "total_return_p95": frame.total_return.quantile(.95), "probability_of_loss_model_conditional": (frame.total_return < 0).mean(), "mean_excess_return": excess.mean(), "median_excess_return": np.median(excess), "probability_outperform_hold_model_conditional": (excess > 0).mean(), "mean_excess_return_mc95_interval_only": np.quantile(boot, [.025, .975]).tolist(), "terminal_return_cvar95": worst.mean(), "median_max_drawdown": frame.max_drawdown.median(), "max_drawdown_p95": frame.max_drawdown.quantile(.95), "fraction_paths_potential_intrahour_liquidation": (frame.potential_intrahour_liquidations > 0).mean(), "mean_opened_legs": frame.opened_legs.mean(), "fraction_no_trades": (frame.opened_legs == 0).mean(), "mean_fees": frame.all_fees.mean(), "mean_realized_option_pnl": frame.realized_option_pnl.mean(), "max_observed_mm_ae": frame.max_mm_ae.max(), "sum_invariant_violations": frame.invariant_violations.sum(), "tail_sample_count": len(worst), "probability_note": "Fractions and intervals are conditional on fixed generators and assumptions, NOT calibrated future probabilities or total model uncertainty."}


def validate_models(raw, follows, h, calib, history, seed, paths=128):
    start = int(pd.Timestamp("2025-01-01", tz="UTC").timestamp())
    held = history["features"][history["times"] >= start]
    # Holdout has no missing hourly bars, verified by source manifest.
    obs = diagnostics(held, horizon=len(held))
    dd90 = [diagnostics(held[i:i + 2160], 2160)["max_drawdown"] for i in range(0, len(held) - 2160 + 1, 720)]
    obs["max_drawdown"] = float(np.median(dd90))
    rows = []
    results = {}
    for model in ("stationary", "gjr_fhs"):
        stats = []
        for i in range(paths):
            f = generate_market(model, raw, follows, h, calib, 2160, seed + 100000 + i)
            stats.append(diagnostics(f, 2160))
        for metric in obs:
            if metric == "end_log_return":
                continue  # different holdout horizon, do not compare total returns
            values = np.array([x[metric] for x in stats])
            lo, mid, hi = np.quantile(values, [.025, .5, .975])
            covered = lo <= obs[metric] <= hi
            rows.append({"model": model, "metric": metric, "holdout_observed": obs[metric], "simulation_p025": lo, "simulation_median": mid, "simulation_p975": hi, "compatible": bool(covered)})
        matched = [x for x in rows if x["model"] == model]
        fraction = np.mean([x["compatible"] for x in matched])
        results[model] = {"compatible_metrics": sum(x["compatible"] for x in matched), "total_metrics": len(matched), "fraction": float(fraction), "exploratory_gate_pass": bool(fraction >= .80), "gate": "Pre-specified descriptive gate: >=80% holdout diagnostics inside simulated 90d 95% envelopes. Not a formal distributional proof.", "failed_metrics": [x["metric"] for x in matched if not x["compatible"]]}
    return {"status": "holdout_diagnostic_not_guarantee_of_realism", "holdout": "2025-2026-10 excluded from price fit", "model_results": results, "metrics": rows, "notes": ["Hourly/daily return tails and absolute/squared return ACF checked.", "90d drawdowns compare like horizons; overlapping holdout windows are descriptive.", "A failed generator remains visible and its strategy output must not be treated as validated market evidence."]}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--paths", type=int, default=256)
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--seed", type=int, default=20261102)
    ap.add_argument("--validation-paths", type=int, default=128)
    ap.add_argument("--out", default="results")
    args = ap.parse_args()
    if args.paths < 2 or args.days < 7 or args.validation_paths < 2:
        raise ValueError("Need >=2 paths, >=2 validation paths and >=7 days; small runs are smoke tests only.")
    out = ROOT / args.out
    out.mkdir(exist_ok=True, parents=True)
    history = load_history()
    calib, raw, follows, h = calibrate_price(history, out / "price-calibration.json")
    ivc = json.loads((ROOT / "calibration/ssvi-calibration.json").read_text(encoding="utf-8"))
    if ivc["surface_model"]["finite_grid_violation_count"] != 0:
        raise ValueError("Refuse known static-arbitrage surface.")
    print("price calibration and SSVI loaded", flush=True)
    validation = validate_models(raw, follows, h, calib, history, args.seed, args.validation_paths)
    (out / "model-validation.json").write_text(json.dumps(clean(validation), indent=2), encoding="utf-8")
    print("holdout validation", json.dumps(validation["model_results"]), flush=True)
    rows, traces, failed = [], [], []
    surface = ivc["surface_model"]
    started = time.time()
    for model in ("stationary", "gjr_fhs"):
        for path in range(args.paths):
            path_seed = args.seed + path * 31
            try:
                f = generate_market(model, raw, follows, h, calib, args.days * 24, path_seed)
                market = prepare_market(f, ivc, path_seed + 7)
                for scenario, settings in SCENARIOS.items():
                    active_market = market
                    if settings.get("drift") == "zero":
                        zf = generate_market(model, raw, follows, h, calib, args.days * 24, path_seed, drift="zero")
                        active_market = prepare_market(zf, ivc, path_seed + 7)
                    metrics, daily = simulate_path(*active_market, surface["term_coef"], surface["rho"], surface["eta"], settings["iv"], settings["spread"], settings["miss"])
                    if not np.isfinite(metrics).all():
                        raise ValueError("nonfinite accounting result")
                    rows.append({"model": model, "path": path, "seed": path_seed, "scenario": scenario, **dict(zip(METRICS, metrics))})
                    if path < 5 and scenario == "base":
                        for day, nav in enumerate(daily):
                            traces.append({"model": model, "path": path, "day": day, "nav": nav, "benchmark": 1000 + .01 * market[0][720 + min(day * 24, args.days * 24)]})
            except (ValueError, OverflowError, ZeroDivisionError) as error:
                failed.append({"model": model, "path": path, "seed": path_seed, "error": str(error)})
            if (path + 1) % 32 == 0:
                print(json.dumps({"model": model, "completed": path + 1, "of": args.paths, "elapsed_s": round(time.time() - started, 1), "failed": len(failed)}), flush=True)
    df = pd.DataFrame(rows)
    if len(df) == 0:
        raise RuntimeError("No successful simulation; inspect model.")
    df.to_csv(out / "path-results.csv", index=False)
    pd.DataFrame(traces).to_csv(out / "sample-nav-paths.csv", index=False)
    summaries = [{"model": model, "scenario": scenario, **summarize(g)} for (model, scenario), g in df.groupby(["model", "scenario"])]
    pd.DataFrame(summaries).to_csv(out / "scenario-summary.csv", index=False)
    result = {"status": "offline_hourly_research_sandbox_NOT_real_execution_backtest", "seed": args.seed, "paths_per_model": args.paths, "horizon_days": args.days, "initial_spot": 77928.47673913, "initial_strategy_btc": .01, "initial_usdt": 1000, "core_btc_excluded": .09, "models": ["stationary raw OHLC blocks mean72h", "GJR-t likelihood + empirical filtered historical shocks"], "model_validation": validation["model_results"], "scenarios": SCENARIOS, "summary": summaries, "numerical_failures": failed, "elapsed_seconds": time.time() - started, "limitations": ["Hourly variant: no claim of 5-second monitoring, IOC/FOK queue matching, or intrahour event order.", "Signals submit fixed-strike limit entry for earliest next-hour fill; a conservative research modification.", "Synthetic future weekly Friday08UTC expiries and $1000 strike grid; future venue listings not known.", "Current ordinary-account margin approximated; spot excluded from option AE; exchange engines may differ.", "H/L potential-liquidation bound and adverse risk fill are deliberately conservative, not a probability-calibrated exchange liquidation simulator.", "Normal strategy exits72h before expiry; failure fallback settlement uses simulated hour close as proxy, not actual final30min average.", "IV fit uses2023 public quotes, not independently identified by spot; static SSVI constraints do not establish joint dynamic no-arbitrage or future market adequacy.", "Empirical IV innovations can contain contract-switch artifacts; spread/quote-quality samples do not identify true outage or matching probabilities.", "Base assumes fills at synthetic quote when eligible; execution stress15% missing fill is an assumption, not an estimated failure rate.", "Every scenario for a given model/path reuses the SAME spot/IV/liquidity random path; only explicit scenario multipliers differ.", "Empirical positive historical drift is not a forecast; zero-drift/block-length sensitivities should also be inspected.", "Model-conditional Monte Carlo fractions do not guarantee future returns or risk probabilities; number of paths does not remove model error."], "live_account_access": False, "orders_placed": False}
    (out / "results.json").write_text(json.dumps(clean(result), ensure_ascii=False, indent=2), encoding="utf-8")
    import scipy
    import numba
    sources = [ROOT / x for x in ("market_models.py", "strategy_engine.py", "run_sandbox.py")]
    inputs = [ROOT / "data/btc_spot_1h.csv", ROOT / "calibration/ssvi-calibration.json", ROOT / "calibration/atm-joint-innovations.csv"]
    manifest = {"seed": args.seed, "paths_per_model": args.paths, "days": args.days, "python": platform.python_version(), "numpy": np.__version__, "pandas": pd.__version__, "scipy": scipy.__version__, "numba": numba.__version__, "market_models": result["models"], "source_sha256": {x.name: hashlib.sha256(x.read_bytes()).hexdigest() for x in sources}, "input_sha256": {x.name: hashlib.sha256(x.read_bytes()).hexdigest() for x in inputs}, "no_network_or_private_account_access": True}
    (out / "run-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(clean({"out": str(out), "failures": len(failed), "base": [x for x in summaries if x["scenario"] == "base"]}), ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
