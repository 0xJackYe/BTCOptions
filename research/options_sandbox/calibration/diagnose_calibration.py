"""Reproduce raw polynomial rejection and innovation-tail diagnostics."""
import json
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.special import ndtr

ROOT = Path(__file__).resolve().parent


def main():
    calibration = json.loads((ROOT / "calibration.json").read_text(encoding="utf-8"))
    b = calibration["model"]["coefficients"]
    K = np.linspace(.75, 1.25, 201)
    lm = np.log(K)
    rows = []
    for rv in (.25, .35, .5, .8):
        for r24 in (-.05, 0, .05):
            previous = None
            for days in (7, 14, 30):
                sigma = np.exp(b["intercept"] + b["beta_log_rv"] * np.log(rv) + b["skew_coef"] * lm + b["curvature"] * lm ** 2 + b["term_coef"] * np.log(days / 14) + b["negative_r24_coef"] * min(r24, 0) + b["positive_r24_coef"] * max(r24, 0))
                T = days / 365
                d1 = (-lm + .5 * sigma ** 2 * T) / (sigma * np.sqrt(T))
                call = ndtr(d1) - K * ndtr(d1 - sigma * np.sqrt(T))
                slopes = np.diff(call) / np.diff(K)
                rows.append({"ewma": rv, "r24": r24, "dte": days, "price_increasing_edges": int((slopes > 1e-9).sum()), "slope_below_minus1_edges": int((slopes < -1 - 1e-9).sum()), "nonconvex_points": int((np.diff(slopes) < -1e-7).sum()), "calendar_decrease_points": int((call < previous - 1e-9).sum()) if previous is not None else 0, "sigma_min": float(sigma.min()), "sigma_max": float(sigma.max())})
                previous = call
    result = {"status": "raw_polynomial_rejected_use_ssvi_calibration_instead", "model": "calibration.json.model, u=0; S=1 r=0; K/S .75..1.25 201 points", "scenarios": rows, "total_price_increasing_edges": sum(x["price_increasing_edges"] for x in rows), "total_slope_below_minus1_edges": sum(x["slope_below_minus1_edges"] for x in rows), "total_nonconvex_points": sum(x["nonconvex_points"] for x in rows), "total_calendar_decrease_points": sum(x["calendar_decrease_points"] for x in rows), "warning": "Do not use the unconstrained polynomial; see ssvi-calibration.json constrained alternative. Finite-grid checks alone never establish market adequacy."}
    (ROOT / "surface-diagnostics.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    innovations = pd.read_csv(ROOT / "atm-joint-innovations.csv").u_innovation.dropna()
    diagnostics = {"count": len(innovations), "mean": float(innovations.mean()), "std": float(innovations.std(ddof=1)), "robust_mad_std": float(1.4826 * np.median(np.abs(innovations - innovations.median()))), "skew": float(innovations.skew()), "excess_kurtosis": float(innovations.kurt()), "minimum": float(innovations.min()), "maximum": float(innovations.max()), "abs_greater_0p2_count": int(innovations.abs().gt(.2).sum()), "note": "Residual jumps can include changing selected nearest-ATM contract as well as market repricing. Do not assume Gaussian solely from this standard deviation."}
    (ROOT / "innovation-diagnostics.json").write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2), encoding="utf-8")
    assert result["total_price_increasing_edges"] > 0
    ssvi = json.loads((ROOT / "ssvi-calibration.json").read_text(encoding="utf-8"))
    assert ssvi["surface_model"]["finite_grid_violation_count"] == 0
    print("Raw polynomial rejected; constrained SSVI saved; innovation diagnostic updated.")


if __name__ == "__main__":
    main()
