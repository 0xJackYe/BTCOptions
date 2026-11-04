"""Finite Put/Call/paired-short search. Offline research, no account or orders.

Freeze protocol before strategy results; compare policies on shared market paths.
New synthetic innovations explore scenarios, not a guarantee of future prediction.
"""
import argparse
import hashlib
import json
import math
import multiprocessing as mp
from pathlib import Path
import platform
import sys
import time

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
from market_models import load_history
from sell_statistics import simultaneous_lower_bounds
import pricing

MODELS = ("regime_jump", "sv_jump", "bootstrap_reference")
COHORTS = {"search": (24, 90, 7511000), "validation": (128, 365, 8511000),
           "test": (512, 365, 10511000)}
SCENARIOS = {
    "base": {"drift": 0., "level": 1., "spread": 1., "miss": 0.},
    "bear": {"drift": -.35, "level": 1., "spread": 1., "miss": 0.},
    "bull": {"drift": .35, "level": 1., "spread": 1., "miss": 0.},
    "execution_thin_iv": {"drift": 0., "level": .85, "spread": 3., "miss": .15,
                          "kstep": 4000.},
    "opposite_skew": {"drift": 0., "level": 1., "spread": 1., "miss": 0., "flip": True},
    "passive_fill": {"drift": 0., "level": 1., "spread": 1., "miss": 0., "limit_ticks": 0},
}
_WORKER = None


def save(path, obj):
    Path(path).write_bytes((json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False)+"\n").encode("utf-8"))


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def policy_grid():
    rows = []
    for side in (0, 1, 2):
        for dte in (7, 14, 28):
            for delta in (.05, .10, .20):
                for tp in (.7, .9):
                    for sl in (2., 3.):
                        for entry in (0, 4):
                            config = {"side": side, "dte": dte, "delta": delta, "tp": tp,
                                "sl": sl, "entry": entry, "entry_param": .03 if entry else 0.,
                                "maxpos": 4, "lever": 3., "min_credit": .5, "entry_hour": 8,
                                "kstep": 2000., "risk": 1., "wing": 0., "pm": 0., "slot_gap": 24,
                                "limit_ticks": 1}
                            name = "%s_d%d_delta%02d_tp%d_sl%d_entry%d" % (
                                ("put", "call", "both")[side], dte, int(delta*100), int(tp*100), sl, entry)
                            rows.append({"id": name, "config": config})
    rows.append({"id": "C_fixed_quantity", "config": {"side": 0, "dte": 7, "delta": .08,
        "tp": .9, "sl": 2., "maxpos": 4, "lever": 3., "min_credit": .5,
        "entry_hour": 8, "kstep": 2000., "risk": 1., "wing": 0., "pm": 0.,
        "entry": 0, "entry_param": 0., "slot_gap": 24, "limit_ticks": 1}})
    assert len(rows) == 217
    assert len({json.dumps(p["config"], sort_keys=True) for p in rows}) == len(rows)
    return rows


def protocol(smoke=False):
    cohorts = {k: {"paths": 2 if smoke else v[0], "days": 30 if smoke else v[1],
                   "seed_base": v[2]+(10000000 if smoke else 0)} for k, v in COHORTS.items()}
    return {"version": "frontier-20261105-v2-postfill-nav", "upstream_commit": "60df266cee19390f75d1dbef596fb407d6646b28",
        "frozen_before_strategy_results": True, "smoke_only": smoke, "models": list(MODELS),
        "aborted_constraint_pilot": "Original2511000/3511000/5511000 seed protocol stopped during search before any strategy result or ranking was generated; independent review found entry notional cap used wallet AE instead of predeclared economic NAV; corrected with new seeds, not based on profit",
        "cohorts": cohorts, "seed_rule": "seed_base+37*path; same path/cell random streams for every policy",
        "price_fit": "2020-2023 only; 2024 market-only validation; 2025-2026 legacy already viewed",
        "market_models_never_selected_by_policy_profit": True,
        "parameter_uncertainty": "per-path parameter draw; research perturbation, not a calibrated posterior",
        "pricing": "2020-2023 HAR; reconstructed2023 IV state; frozen2026-11-03 SSVI cross-section; uncertainty scenarios",
        "candidates": policy_grid(), "scenarios": SCENARIOS,
        "search_cells": ["base", "bear", "bull"],
        "objective": "maximize worst model/scenario mean USDT PnL/1000 confidence lower bound; hold cash score0",
        "bootstrap": "2000 centered paired-path resamples, fixed observed SE, max across all candidate x cell means; approximate MC-only simultaneous bounds",
        "risk_limits": {"cvar5_return_min": -.30, "prob_loss_over30pct_max": .025,
            "observed_liquidation_paths_max": 0, "bankrupt_paths_max": 0,
            "max_drawdown_p95_max": .35, "mean_trades_per_year_min": 2.},
        "risk_note": "Predeclared design preferences, not mathematical universal optimum; no assurance on unseen jump risk",
        "shortlist": "top2 per side by risk-feasible-first/worstLCB, or leading infeasible diagnostics if none",
        "validation": "full six scenarios, choose one per side; freeze all3 before final seeds",
        "test": "three frozen directional candidates plus C control once; jointly corrected family across all3/cells; no refinement after test; promotion requires validation risk pass and positiveLCB too",
        "promotion": "positive all-cell lower bound and all risk criteria; real-market execution/IV adequacy also required and currently unproven",
        "no_qualified_policy": "cash control, no forced active winner",
        "fixed": {"initial_usdt": 1000, "lot_btc": .01, "max_legs": 4,
            "max_entry_strike_or_spot_notional_to_postfill_NAV": 3, "spot_trading": False,
            "notional_note": "Entry cap only; gaps or mark changes can increase ratio afterward. Margin checks separately use wallet AE",
            "entry_pairing": "both=coordinated Put+Call entry approximation, not native atomic guarantee; independent exits",
            "entry_limit": "fixed previous-hour strike/expiry; previous bid minus1 tick5USDT, next-hour bid must meet limit; passive stress0ticks",
            "base_strike_grid": 2000},
        "resolution": "hourly decisions plus adverse intrahour OHLC bounds; conservative order approximation, not tick matching",
        "limitations": ["Fresh innovations are random, but assumptions can be wrong",
            "SSVI/IV dynamics and actual bid fills lack future option-market temporal validation",
            "Historical data already viewed cannot become fresh real-world holdout by changing RNG seeds",
            "Same path scenarios and different models are dependent; do not sum them as independent samples"]}


def summarize(a):
    n = len(a)
    pnl = (a[:, 0]-1000)/1000
    se = float(np.std(pnl, ddof=1)/math.sqrt(n))
    tail = max(1, math.ceil(.05*n))
    return {"paths": n, "mean_return": float(pnl.mean()), "median_return": float(np.median(pnl)),
        "mean_pnl_usdt": float(1000*pnl.mean()), "mean_return_mc95": [float(pnl.mean()-1.96*se), float(pnl.mean()+1.96*se)],
        "cvar5": float(np.sort(pnl)[:tail].mean()), "tail_count": tail,
        "probability_loss_model_conditional": float(np.mean(pnl < 0)),
        "probability_loss_over30pct": float(np.mean(pnl < -.30)),
        "max_drawdown_p95": float(np.quantile(a[:, 2], .95)), "mean_trades": float(a[:, 3].mean()),
        "mean_fees": float(a[:, 5].mean()), "mean_gross_premiums": float(a[:, 6].mean()),
        "liquidation_paths": int(np.count_nonzero(a[:, 7] > 0)), "bankrupt_paths": int(np.count_nonzero(a[:, 15] > 0)),
        "mean_lots_per_order": float(a[:, 14].mean()), "mean_terminal_liability": float(a[:, 16].mean()),
        "zero_event_probability_upper95": float(-math.expm1(math.log(.05)/n)) if not np.any(a[:, 7] > 0) else None}


def _init_worker(stage, policies, model_config, quote_config, cfg, names):
    global _WORKER
    _WORKER = (stage, policies, model_config, quote_config, cfg, names)


def _path_job(job):
    import generators
    import engine
    stage, policies, model_config, quote_config, cfg, names = _WORKER
    model, path = job
    seed = cfg["seed_base"]+37*path
    cache = {}
    rows, traces = [], []
    for name in names:
        setting = SCENARIOS[name]
        drift = setting["drift"]
        if drift not in cache:
            features, latent = generators.generate(model, model_config, cfg["days"]*24,
                seed, drift=drift, parameter_uncertainty=True)
            cache[drift] = pricing.market(features, quote_config, seed+11)
        mk = cache[drift]
        surface = quote_config["surface"]
        rho = abs(surface["rho"]) if setting.get("flip") else surface["rho"]
        for policy in policies:
            params = dict(policy["config"])
            if "kstep" in setting: params["kstep"] = setting["kstep"]
            if "limit_ticks" in setting: params["limit_ticks"] = setting["limit_ticks"]
            metrics, daily = engine.run(engine.params(**params), *mk,
                surface["term_coef"], rho, surface["eta"],
                spread_scale=setting["spread"], miss_probability=setting["miss"], iv_scale=setting["level"])
            if metrics.shape != (18,) or not np.isfinite(metrics).all():
                raise RuntimeError("Numerical/accounting failure; never remove a losing/failed path")
            if metrics[3] > 0 and abs(metrics[14]-1) > 1e-8:
                raise RuntimeError("Fixed quantity invariant failed")
            rows.append({"cohort": stage, "cell": model+"/"+name, "path": path, "seed": seed,
                         "policy": policy["id"], **dict(zip(engine.OUT_NAMES, metrics))})
            if stage == "test" and name == "base" and path < 3:
                traces.extend({"model": model, "path": path, "policy": policy["id"],
                               "day": d, "nav": float(nav)} for d, nav in enumerate(daily))
    return model, path, rows, traces


def run_cohort(stage, policies, model_config, quote_config, out, frozen_protocol):
    cfg = frozen_protocol["cohorts"][stage]
    names = frozen_protocol["search_cells"] if stage == "search" else list(SCENARIOS)
    cells = [m+"/"+s for m in MODELS for s in names]
    jobs = [(m, p) for m in MODELS for p in range(cfg["paths"])]
    initargs = (stage, policies, model_config, quote_config, cfg, names)
    rows, traces, done = [], [], 0
    started = time.time()
    workers = frozen_protocol.get("workers", 4)
    if workers == 1:
        _init_worker(*initargs)
        for model, path, r, t in map(_path_job, jobs):
            rows.extend(r); traces.extend(t); done += 1
            if done % 16 == 0 or done == len(jobs):
                print("%s %d/%d market paths %.1fs" % (stage, done, len(jobs), time.time()-started), flush=True)
    else:
        with mp.get_context("spawn").Pool(workers, initializer=_init_worker, initargs=initargs) as pool:
            for model, path, r, t in pool.imap_unordered(_path_job, jobs, chunksize=1):
                rows.extend(r); traces.extend(t); done += 1
                if done % 16 == 0 or done == len(jobs):
                    print("%s %d/%d market paths %.1fs" % (stage, done, len(jobs), time.time()-started), flush=True)
    frame = pd.DataFrame(rows)
    frame = frame.sort_values(["cell", "path", "policy"]).reset_index(drop=True)
    frame.to_csv(out/(stage+"-paths.csv.gz"), index=False, compression={"method": "gzip", "mtime": 0})
    if traces:
        pd.DataFrame(traces).sort_values(["model", "path", "policy", "day"]).to_csv(out/"test-traces.csv", index=False)
    return frame, cells


def rank(frame, policies, cells, days, out, stage):
    import engine
    ids = [p["id"] for p in policies]
    groups = {(c, p): f.sort_values("path")[engine.OUT_NAMES].to_numpy(float)
              for (c, p), f in frame.groupby(["cell", "policy"])}
    n = len(groups[cells[0], ids[0]])
    excess = np.empty((len(cells), n, len(ids)))
    for c, cell in enumerate(cells):
        for k, pid in enumerate(ids): excess[c, :, k] = (groups[cell, pid][:, 0]-1000)/1000
    stat = simultaneous_lower_bounds(excess, seed=7181000+len(ids), resamples=2000, studentization="observed")
    results, detail = [], []
    for k, pid in enumerate(ids):
        failures = []
        for c, cell in enumerate(cells):
            s = summarize(groups[cell, pid])
            why = []
            if s["liquidation_paths"]: why.append("liquidation")
            if s["bankrupt_paths"]: why.append("bankruptcy")
            if s["cvar5"] < -.30: why.append("cvar")
            if s["probability_loss_over30pct"] > .025: why.append("loss_tail")
            if s["max_drawdown_p95"] > .35: why.append("drawdown")
            if s["mean_trades"] < 2*days/365: why.append("inactivity")
            failures.extend(cell+":"+r for r in why)
            detail.append({"cell": cell, "policy": pid, **s, "risk_failures": why,
                           "simultaneous_lower_bound": float(stat["lower_bounds"][c, k])})
        results.append({"policy": pid, "score": float(np.min(stat["lower_bounds"][:, k])),
                        "risk_eligible": not failures, "risk_failures": failures})
    results.sort(key=lambda r: (-int(r["risk_eligible"]), -r["score"], r["policy"]))
    save(out/(stage+"-ranking.json"), {"ranked": results, "cell_summaries": detail,
        "bootstrap_critical": stat["critical"], "bootstrap_degeneracies": stat["degenerate_studentization_count"],
        "note": "MC-only approximate simultaneous confidence; no protection against wrong market assumptions"})
    return results


def select_by_side(ranked, policies, count):
    by_id = {p["id"]: p for p in policies}
    return [by_id[r["policy"]] for side in (0, 1, 2)
            for r in [x for x in ranked if by_id[x["policy"]]["config"]["side"] == side][:count]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="results")
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    import generators
    out = Path(args.out)
    if not out.is_absolute(): out = ROOT/out
    out.mkdir(parents=True, exist_ok=True)
    if (out/"protocol.json").exists():
        raise FileExistsError("Fresh directory required; never overwrite frozen trials")
    p = protocol(args.smoke)
    if not 1 <= args.workers <= 8: raise ValueError("workers must be1..8")
    p["workers"] = args.workers
    sources = [ROOT/n for n in ("optimize.py", "generators.py", "engine.py", "pricing.py", "validate.py")]
    sources += [ROOT.parent/"sell_statistics.py", ROOT.parent/"strategy_engine.py",
                ROOT.parent/"data/btc_spot_1h.csv", ROOT.parent/"calibration/atm-joint-innovations.csv",
                ROOT.parent/"calibration/ssvi-calibration.json",
                ROOT.parent/"calibration/sell-20261103/current-ssvi-calibration.json"]
    hashes = {str(x.relative_to(ROOT.parent)): digest(x) for x in sources}
    save(out/"protocol.json", p)
    save(out/"source-hashes-before.json", hashes)
    history = load_history()
    model_config = generators.fit(history, out/"price-calibration.json")
    quote_config = pricing.fit(history, out/"pricing-calibration.json")
    all_policies = policy_grid()
    f, cells = run_cohort("search", all_policies, model_config, quote_config, out, p)
    r = rank(f, all_policies, cells, p["cohorts"]["search"]["days"], out, "search")
    shortlist = select_by_side(r, all_policies, 2)
    save(out/"frozen-shortlist.json", shortlist)
    f, cells = run_cohort("validation", shortlist, model_config, quote_config, out, p)
    r = rank(f, shortlist, cells, p["cohorts"]["validation"]["days"], out, "validation")
    validation_ok = {x["policy"] for x in r if x["risk_eligible"] and x["score"] > 0}
    finalists = select_by_side(r, shortlist, 1)
    save(out/"frozen-finalists.json", finalists)
    baseline = all_policies[-1]
    test_policies = finalists+[baseline] if baseline["id"] not in {x["id"] for x in finalists} else finalists
    f, cells = run_cohort("test", test_policies, model_config, quote_config, out, p)
    r = rank(f, test_policies, cells, p["cohorts"]["test"]["days"], out, "test")
    by_id = {x["id"]: x for x in test_policies}
    qualified = [x for x in r if x["risk_eligible"] and x["score"] > 0
                 and x["policy"] in validation_ok and not args.smoke]
    decision = {"conditional_selected_policy": by_id[qualified[0]["policy"]] if qualified else "cash",
        "leading_active_diagnostic": by_id[r[0]["policy"]], "conditional_qualified_count": len(qualified),
        "live_promotion": False, "real_market_adequacy": "unproven execution and futureIV calibration",
        "smoke_only": args.smoke, "test_ranked": r,
        "validation_passed_ids": sorted(validation_ok),
        "interpretation": "Finite-grid model-conditional result, not a global optimum or a future return forecast"}
    save(out/"decision.json", decision)
    after = {str(x.relative_to(ROOT.parent)): digest(x) for x in sources}
    if after != hashes: raise RuntimeError("Source/input changed while running; refuse reproducibility claim")
    save(out/"run-manifest.json", {"source_sha256": hashes, "python": platform.python_version(),
        "numpy": np.__version__, "artifact_sha256": {x.name: digest(x) for x in out.iterdir() if x.is_file()}})
    print("COMPLETE", json.dumps({"selected": decision["conditional_selected_policy"], "leading": r[0]}), flush=True)


if __name__ == "__main__":
    main()
