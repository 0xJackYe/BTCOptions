"""Explicit deterministic tail injections, NOT estimated event probabilities."""
import argparse
import json
from pathlib import Path
import numpy as np
from strategy_engine import simulate_path
from run_sandbox import METRICS

ROOT = Path(__file__).resolve().parent


def run_case(kind):
    ssvi = json.loads((ROOT / "calibration/ssvi-calibration.json").read_text(encoding="utf-8"))["surface_model"]
    c = np.full(961, 80000.)
    if kind == "put_down70pct_after_open":
        c[745:] = 75000.; c[746:] = 75300.
        factor = .30
    elif kind == "call_up200pct_after_open":
        c[745:] = 85000.; c[746:] = 84600.; c[747:] = 84700.
        factor = 3.0
    else:
        raise ValueError(kind)
    def simulate(values):
        n = len(values)
        return simulate_path(values, values.copy(), values.copy(), np.full(n, .7), np.full(n, .3), np.full(n, .08), np.ones(n, dtype=np.bool_), np.full((n, 2), .99), np.full((n, 2), .99), ssvi["term_coef"], ssvi["rho"], ssvi["eta"])[0]
    prefix = simulate(c[:755])
    assert prefix[6] == 1 and prefix[7] == 0, "Fixture must inject shock AFTER a real simulated entry."
    c[755:] = c[754] * factor
    result = simulate(c)
    return {"case": kind, "not_a_probability_estimate": True, "pre_shock_spot": float(c[754]), "post_shock_spot": float(c[755]), "metrics": dict(zip(METRICS, map(float, result)))}


if __name__ == "__main__":
    rows = [run_case(x) for x in ("put_down70pct_after_open", "call_up200pct_after_open")]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="annual-results")
    args = parser.parse_args()
    out = ROOT / args.out / "tail-stress.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"type": "deterministic_tail_injections_not_mixed_into_MC_probabilities", "cases": rows}, indent=2), encoding="utf-8")
    print(json.dumps(rows, indent=2))
