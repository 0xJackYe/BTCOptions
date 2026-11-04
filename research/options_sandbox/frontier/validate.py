"""Independent market-only validation of Frontier generators.

No strategy, option account, profits or parameter search is imported here.
Same-length nonoverlapping historical windows are compared with simulated
windows, using distribution distances rather than envelope coverage counts.
Randomness and realism are separate diagnostics, neither proves tradable edge.
"""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import wasserstein_distance

HERE = Path(__file__).resolve().parent
SANDBOX = HERE.parent
if str(SANDBOX) not in sys.path:
    sys.path.insert(0, str(SANDBOX))
from market_models import load_history  # noqa: E402

HOURS = 90 * 24
MODELS = ("regime_jump", "sv_jump", "bootstrap_reference")
METRICS = (
    "hourly_p01", "hourly_p99", "daily_p01", "daily_p99",
    "annualized_vol", "abs_acf1", "abs_acf24", "abs_acf168",
    "squared_acf1", "worst24h_return", "max_drawdown90",
    "jump_frequency_abs_hour_ge3pct",
)
# Units and deterministic floors are declared before looking at holdout data.
SCALE_FLOORS = dict(zip(METRICS, (
    .0005, .0005, .002, .002, .05, .02, .02, .02, .02, .02, .02, .0005,
)))
RESEARCH_GATES = {"mean_scaled_wasserstein_max": 1.,
                  "any_metric_scaled_wasserstein_max": 2.5,
                  "numerical_failures_max": 0}


def clean(value):
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, np.ndarray):
        return clean(value.tolist())
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return float(value) if np.isfinite(value) else None
    return value


def write_json(path, value):
    Path(path).write_bytes((json.dumps(clean(value), indent=2)+"\n").encode("utf-8"))


def _features(value):
    """Accept the agreed (features, latent) interface and simple test fixtures."""
    f = np.asarray(value[0] if isinstance(value, tuple) else value, dtype=float)
    if f.ndim != 2 or f.shape[1] != 4 or not np.isfinite(f).all():
        raise ValueError("Generator must return finite OHLC features [hours+721,4]")
    if np.any(f[:, 2] < np.maximum(f[:, 0]-f[:, 1], 0)-1e-10):
        raise ValueError("High cannot be below open or close")
    if np.any(f[:, 3] > np.minimum(f[:, 0]-f[:, 1], 0)+1e-10):
        raise ValueError("Low cannot be above open or close")
    return f


def assert_training_scope(config):
    """Fail closed on missing/late calibration metadata, including --config runs."""
    training = config.get("training", {})
    try:
        end = pd.Timestamp(training["end_exclusive_utc"])
        last = pd.Timestamp(training["last_observation_utc"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("Generator config must declare training cutoff and last observation") from error
    if end.tzinfo is None or last.tzinfo is None:
        raise ValueError("Training metadata must use timezone-aware UTC timestamps")
    cutoff = pd.Timestamp("2024-01-01", tz="UTC")
    if end > cutoff or last >= end:
        raise ValueError("2024+ observations cannot enter this market-only calibration")


def _acf(values, lag):
    left, right = values[lag:], values[:-lag]
    if np.std(left) == 0 or np.std(right) == 0:
        return 0.
    return float(np.corrcoef(left, right)[0, 1])


def market_metrics(features, hours=HOURS):
    """Exactly `hours` observed/simulated returns; warmup is not a data point."""
    f = _features(features)
    if hours < 192 or len(f) < hours:
        raise ValueError("Need at least 192 hourly returns and full horizon")
    r = f[-hours:, 0]
    logs = np.r_[0., np.cumsum(r)]
    daily = logs[24:]-logs[:-24]
    drawdown = 1-np.exp(logs-np.maximum.accumulate(logs))
    result = dict(zip(METRICS, (
        np.quantile(r, .01), np.quantile(r, .99),
        np.quantile(daily, .01), np.quantile(daily, .99),
        np.std(r, ddof=1)*math.sqrt(8760),
        _acf(abs(r), 1), _acf(abs(r), 24), _acf(abs(r), 168),
        _acf(r*r, 1), np.expm1(np.min(daily)), np.max(drawdown),
        np.mean(abs(np.expm1(r)) >= .03),
    )))
    if not np.isfinite(list(result.values())).all():
        raise ValueError("Market diagnostics overflowed; retain as numerical failure")
    return result


def historical_windows(history, start, end, hours=HOURS, align_first=False):
    """Calendar-anchored, nonoverlapping windows; skip any with missing bars.

    No forward fill or returns across a missing hour. align_first is used only
    for training, whose first valid return is one hour after the first candle.
    Holdout anchors are fixed UTC boundaries, not optimized market states.
    """
    times = np.asarray(history["times"], dtype=np.int64)
    values = np.asarray(history["features"], dtype=float)
    if times.ndim != 1 or values.shape != (len(times), 4):
        raise ValueError("History times/features shape mismatch")
    if len(times) and np.any(np.diff(times) <= 0):
        raise ValueError("History timestamps must be strictly increasing")
    first = int(pd.Timestamp(start, tz="UTC").timestamp())
    last = int(pd.Timestamp(end, tz="UTC").timestamp())
    if align_first and len(times):
        first = max(first, int(times[0]))
    rows, omitted = [], []
    for a in range(first, last-hours*3600+1, hours*3600):
        b = a+hours*3600
        idx = np.flatnonzero((times >= a) & (times < b))
        ok = len(idx) == hours
        if ok:
            t = times[idx]
            ok = t[0] == a and t[-1] == b-3600 and np.all(np.diff(t) == 3600)
        if not ok:
            omitted.append({"start_utc": pd.Timestamp(a, unit="s", tz="UTC").isoformat(),
                            "hours_found": len(idx), "required": hours})
            continue
        rows.append({"start_utc": pd.Timestamp(a, unit="s", tz="UTC").isoformat(),
                     "end_exclusive_utc": pd.Timestamp(b, unit="s", tz="UTC").isoformat(),
                     **market_metrics(values[idx], hours)})
    return rows, omitted


def training_scales(training_rows):
    if len(training_rows) < 4:
        raise ValueError("Need >=4 complete training windows for independent scales")
    result = {}
    for metric in METRICS:
        x = np.array([row[metric] for row in training_rows], dtype=float)
        if not np.isfinite(x).all():
            raise ValueError("Nonfinite training metric")
        result[metric] = max(float(np.quantile(x, .75)-np.quantile(x, .25)),
                             SCALE_FLOORS[metric])
    return result


def distribution_distance(observed, simulated, scales):
    """Two-sample shape/location distance; broad noise does not pass by coverage."""
    if not observed or not simulated:
        raise ValueError("No windows available for distribution comparison")
    details = []
    for name in METRICS:
        obs = np.array([row[name] for row in observed], dtype=float)
        sim = np.array([row[name] for row in simulated], dtype=float)
        scale = float(scales[name])
        if not np.isfinite(obs).all() or not np.isfinite(sim).all() or not scale > 0:
            raise ValueError("Distance requires finite metrics and positive training scales")
        distance = float(wasserstein_distance(obs, sim)/scale)
        details.append({"metric": name, "scaled_wasserstein": distance,
                        "training_scale": scale,
                        "observed_p05": np.quantile(obs, .05),
                        "observed_median": np.median(obs),
                        "observed_p95": np.quantile(obs, .95),
                        "simulated_p05": np.quantile(sim, .05),
                        "simulated_median": np.median(sim),
                        "simulated_p95": np.quantile(sim, .95)})
    return {"mean_scaled_wasserstein": float(np.mean([d["scaled_wasserstein"] for d in details])),
            "max_scaled_wasserstein": float(max(d["scaled_wasserstein"] for d in details)),
            "observed_windows": len(observed), "simulated_paths": len(simulated),
            "metrics": details}


def _novel_fraction(values, empirical):
    reference = np.sort(np.asarray(empirical, dtype=float))
    j = np.searchsorted(reference, values)
    left = reference[np.clip(j-1, 0, len(reference)-1)]
    right = reference[np.clip(j, 0, len(reference)-1)]
    return float(np.mean(np.minimum(abs(values-left), abs(values-right)) > 1e-12))


def randomness_checks(generate, model, config, history, seed=8700000):
    """Algorithmic tests; enough randomness is not evidence of market fidelity."""
    a = _features(generate(model, config, 336, seed, drift=0., parameter_uncertainty=True))
    b = _features(generate(model, config, 336, seed, drift=0., parameter_uncertainty=True))
    longer = _features(generate(model, config, 672, seed, drift=0., parameter_uncertainty=True))
    other = _features(generate(model, config, 336, seed+1, drift=0., parameter_uncertainty=True))
    train = np.asarray(history["features"])[np.asarray(history["times"]) <
            int(pd.Timestamp("2024-01-01", tz="UTC").timestamp()), 0]
    empirical = np.r_[train, train-train.mean()]
    endpoints, low_future, high_future = [], [], []
    for i in range(8):
        f = _features(generate(model, config, HOURS, seed+100+31*i,
                               drift=0., parameter_uncertainty=True))
        r = f[-HOURS:, 0]
        endpoints.append(float(r.sum()))
        # Nonoverlapping day blocks: previous state predicts following risk.
        day_variance = np.mean(r[:len(r)//24*24].reshape(-1, 24)**2, axis=1)
        state, following = day_variance[:-1], day_variance[1:]
        low_future.extend(following[state <= np.quantile(state, .25)])
        high_future.extend(following[state >= np.quantile(state, .75)])
    cluster = float(np.mean(high_future)/max(np.mean(low_future), 1e-20))
    result = {"same_seed_reproducible": bool(np.array_equal(a, b)),
              "different_seed_changes_path": bool(not np.array_equal(a, other)),
              "prefix_invariant_to_requested_horizon": bool(np.array_equal(a, longer[:len(a)])),
              "free_endpoint_logreturn_sd": float(np.std(endpoints, ddof=1)),
              "no_fixed_endpoint": bool(np.std(endpoints) > 1e-10),
              "fraction_hourly_returns_not_in_training_or_centered_training":
                  _novel_fraction(a[721:, 0], empirical),
              "conditional_nextday_variance_high_vs_low_ratio": cluster,
              "volatility_clustering_detected": bool(cluster > 1.05),
              "note": "Algorithm checks and eight-path descriptive clustering; not a market or probability calibration test"}
    required = ["same_seed_reproducible", "different_seed_changes_path",
                "prefix_invariant_to_requested_horizon", "no_fixed_endpoint"]
    result["algorithm_checks_pass"] = all(result[k] for k in required)
    if model != "bootstrap_reference":
        result["novel_parametric_returns_pass"] = bool(
            result["fraction_hourly_returns_not_in_training_or_centered_training"] > .99)
        result["algorithm_checks_pass"] &= result["novel_parametric_returns_pass"]
    else:
        result["novel_parametric_returns_pass"] = None
        result["reference_note"] = "Historical resampling reference is not required to generate novel innovations"
    return result


def research_gate(comparison, randomness, numerical_failures):
    reasons = []
    if numerical_failures > RESEARCH_GATES["numerical_failures_max"]:
        reasons.append("numerical_failure")
    if not randomness["algorithm_checks_pass"]:
        reasons.append("randomness_algorithm_failure")
    if comparison["mean_scaled_wasserstein"] > RESEARCH_GATES["mean_scaled_wasserstein_max"]:
        reasons.append("distribution_distance_mean")
    if comparison["max_scaled_wasserstein"] > RESEARCH_GATES["any_metric_scaled_wasserstein_max"]:
        reasons.append("distribution_distance_single_metric")
    return {"research_gate_pass": not reasons, "failures": reasons,
            "real_world_adequacy_certified": False,
            "meaning": "Predeclared descriptive research preferences; NOT a calibrated hypothesis test or profitability evidence"}


def evaluate_generator(generate, model, config, history, paths=128, seed=7600000):
    """Keep failed paths in the audit; do not condition the market gate on survival."""
    try:
        random = randomness_checks(generate, model, config, history)
    except (ValueError, RuntimeError, FloatingPointError, OverflowError) as error:
        random = {"algorithm_checks_pass": False, "error": str(error)}
    simulated, failures, records = [], [], []
    for i in range(paths):
        try:
            f = _features(generate(model, config, HOURS, seed+31*i,
                                   drift=0., parameter_uncertainty=True))
            if len(f) != HOURS+721:
                raise ValueError("Unexpected generator horizon")
            metrics = market_metrics(f)
            simulated.append(metrics)
            records.append({"model": model, "path": i, "seed": seed+31*i, **metrics})
        except (ValueError, RuntimeError, FloatingPointError, OverflowError) as error:
            failures.append({"path": i, "seed": seed+31*i, "error": str(error)})
    return simulated, failures, records, random


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="market-validation-results")
    parser.add_argument("--config")
    parser.add_argument("--paths", type=int, default=128)
    parser.add_argument("--seed", type=int, default=7600000)
    args = parser.parse_args()
    if args.paths < 16:
        raise ValueError("Need >=16 paths; small runs remain descriptive smoke checks")
    out = Path(args.out)
    if not out.is_absolute():
        out = HERE/out
    out.mkdir(parents=True, exist_ok=True)
    if (out/"validation-protocol.json").exists():
        raise FileExistsError("Refuse to overwrite a frozen market-only validation run")
    from generators import fit, generate  # lazy: unit tests need no calibration/data
    source_paths = [Path(__file__), HERE/"generators.py", SANDBOX/"data/btc_spot_1h.csv"]
    hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_paths}
    write_json(out/"validation-protocol.json", {
        "fit_period": "2020-2023 only", "selection_period": "2024 only",
        "legacy_diagnostic": "2025-2026 already inspected; not untouched historical test",
        "horizon_hours": HOURS, "paths_per_model": args.paths, "seed": args.seed,
        "models": MODELS, "metrics": METRICS, "gates": RESEARCH_GATES,
        "metric_scaling": "Training nonoverlapping90d IQR with predeclared floors",
        "drift": "0 annual log-return drift in all simulated diagnostic paths; historical drift is not removed",
        "no_profit_model_selection": True, "source_sha256_before": hashes,
        "notes": ["Four2024 windows imply very weak distribution evidence",
                  "Wasserstein distance penalizes overly broad distributions; no envelope-coverage pass count",
                  "Randomness is algorithmic, realism empirical, profitability a separate question"]})
    history = load_history()
    if args.config:
        config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    else:
        config = fit(history, out/"generator-calibration.json")
    assert_training_scope(config)
    write_json(out/"generator-config-used.json", config)
    end = pd.Timestamp(int(history["times"][-1])+3600, unit="s", tz="UTC").strftime("%Y-%m-%d %H:%M:%S")
    training, train_omitted = historical_windows(history, "2020-01-01", "2024-01-01", align_first=True)
    validation, val_omitted = historical_windows(history, "2024-01-01", "2025-01-01")
    legacy, legacy_omitted = historical_windows(history, "2025-01-01", end)
    scales = training_scales(training)
    write_json(out/"observed-market-windows.json", {"training": training, "validation": validation,
        "legacy": legacy, "scales": scales, "omitted_missing_bars": {
            "training": train_omitted, "validation": val_omitted, "legacy": legacy_omitted}})
    models, rows, path_rows = {}, [], []
    for model in MODELS:
        simulated, failures, records, random = evaluate_generator(
            generate, model, config, history, args.paths, args.seed)
        path_rows.extend(records)
        if simulated:
            val = distribution_distance(validation, simulated, scales)
            leg = distribution_distance(legacy, simulated, scales)
            gate = research_gate(val, random, len(failures))
            for cohort, comparison in (("validation_2024", val), ("legacy_2025_2026", leg)):
                rows.extend({"model": model, "cohort": cohort, **r} for r in comparison["metrics"])
            models[model] = {"validation": val, "legacy": leg, "randomness": random,
                             "numerical_failures": failures, **gate}
        else:
            models[model] = {"research_gate_pass": False, "numerical_failures": failures,
                             "randomness": random, "failures": ["no_valid_paths"],
                             "real_world_adequacy_certified": False}
        print(model, "market-only validation complete", flush=True)
    selected = min((m for m in models if models[m].get("research_gate_pass")),
                   key=lambda m: models[m]["validation"]["mean_scaled_wasserstein"], default=None)
    write_json(out/"market-validation.json", {"models": models, "research_reference_selected": selected,
        "selection_uses": "Only2024 market distribution distance, never strategy returns",
        "market_adequacy_guaranteed": False,
        "limitations": ["Few nonoverlapping validation windows and one historical realization",
            "Marginal metric distances do not validate all joint dynamics or future regimes",
            "Physical price validation does not validate option quotes, IV, fills or margin",
            "No model silently discarded for losing strategies or failed numerical paths"]})
    pd.DataFrame(rows).to_csv(out/"market-validation.csv", index=False)
    pd.DataFrame(path_rows).to_csv(out/"simulated-market-metrics.csv", index=False)
    after = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_paths}
    if hashes != after:
        raise RuntimeError("Validation source/input changed during run; do not publish as reproducible")
    write_json(out/"validation-manifest.json", {"source_sha256": hashes,
        "artifact_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                            for p in sorted(out.iterdir()) if p.is_file()}})


if __name__ == "__main__":
    main()
