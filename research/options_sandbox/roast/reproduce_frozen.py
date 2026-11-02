"""Re-run the published 2026-11-03 example and diff it path-by-path against the frozen CSV."""
import time
import numpy as np
import pandas as pd
from common import load_all, rs, mm, FROZEN

history, calib, raw, follows, h, ivc = load_all(frozen=True)
surface = ivc["surface_model"]
rows = []
t0 = time.time()
for model in ("stationary", "gjr_fhs"):
    for path in range(256):
        seed = 20261102 + path * 31
        f = mm.generate_market(model, raw, follows, h, calib, 365 * 24, seed)
        market = rs.prepare_market(f, ivc, seed + 7)
        for scenario, s in rs.SCENARIOS.items():
            active = market
            if s.get("drift") == "zero":
                zf = mm.generate_market(model, raw, follows, h, calib, 365 * 24, seed, drift="zero")
                active = rs.prepare_market(zf, ivc, seed + 7)
            metrics, _ = rs.simulate_path(*active, surface["term_coef"], surface["rho"], surface["eta"], s["iv"], s["spread"], s["miss"])
            rows.append({"model": model, "path": path, "seed": seed, "scenario": scenario, **dict(zip(rs.METRICS, metrics))})
print("elapsed", round(time.time() - t0, 1))
mine = pd.DataFrame(rows).set_index(["model", "path", "scenario"]).sort_index()
ref = pd.read_csv(FROZEN / "path-results.csv").set_index(["model", "path", "scenario"]).sort_index()
assert mine.index.equals(ref.index)
worst = {}
for c in rs.METRICS:
    d = np.abs(mine[c].to_numpy() - ref[c].to_numpy())
    rel = d / np.maximum(1, np.abs(ref[c].to_numpy()))
    worst[c] = float(rel.max())
bad = {k: v for k, v in worst.items() if v > 1e-9}
print("metrics compared:", len(worst), "rows:", len(mine))
print("max relative deviation per metric > 1e-9:", bad if bad else "NONE (exact reproduction)")

# V1 economics inside the user's own frozen run (report section 3.1)
b = ref.reset_index()
b = b[b.scenario.isin(["base", "zero_drift"])]
eco = b.groupby(["model", "scenario"]).agg(gross_premium=("gross_premiums", "mean"), fees=("all_fees", "mean"),
                                           option_pnl=("option_pnl_including_terminal_liability", "mean"),
                                           conversion_pnl_vs_hold=("inventory_rebalance_pnl_vs_hold", "mean"),
                                           total_vs_hold=("excess_return", lambda x: (x * 1779.2847673913).mean()))
print(eco.round(2).to_string())
