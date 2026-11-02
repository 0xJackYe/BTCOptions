"""Gap risk of the chosen strategy: a stop-loss cannot help inside a one-hour gap.

Deterministic injections in the style of the sandbox's stress_cases.py (NOT probabilities):
a single-hour crash right after the ladder is fully open, IV x3 and spreads 20% after the gap.
"""
import json

import numpy as np
import pandas as pd

from common import ROAST, SANDBOX
import engine2 as e2
import v2_market as v2

BEST = dict(side=0, dte=7, delta=.08, tp=.9, sl=2.0, maxpos=4, lever=3.0, min_credit=.5, entry_hour=8)


def worst_real_moves():
    d = pd.read_csv(SANDBOX / "data/btc_spot_1h.csv")
    c = d.close.to_numpy()
    lo = d.low.to_numpy()
    out = {}
    for h in (1, 4, 24):
        r = lo[h - 1:] / np.r_[c[0], c[:-1]][:len(lo) - h + 1] - 1 if h == 1 else lo[h - 1:] / c[:-h + 1 if h > 1 else None][:len(lo) - h + 1] - 1
        out[f"worst_{h}h_close_to_low"] = float(np.min(r))
    return out


def run_gap(drop, cfg):
    n = 720 + 24 * 10 + 1
    close = np.full(n, 80000.)
    iv = np.full(n, .45)
    spread = np.full(n, .01)
    gap_at = 720 + 24 * 4  # after four daily 08:00 entries -> ladder full
    close[gap_at:] = 80000. * (1 + drop)
    iv[gap_at:] = 1.35
    spread[gap_at:gap_at + 24] = .2
    avail = np.ones(n, np.bool_)
    P = e2.params(**cfg)
    out = e2.run(P, close, close.copy(), close.copy(), iv, np.full(n, .45), spread, avail, v2.SMILE["term_coef"], v2.SMILE["rho"], v2.SMILE["eta"])
    return {"drop": drop, "pnl": float(out[0] - 1000), "liquidated": bool(out[7] > 0), "bankrupt": bool(out[15] > 0), "open_lots_before_gap": None}


def main():
    res = {"real_2020_2026": worst_real_moves(), "injections": []}
    for name, cfg in (("C (<=4 lots, 3x notional)", BEST), ("C-half (<=2 lots)", {**BEST, "maxpos": 2, "lever": 1.5}),
                      ("C 1 lot (cash-secured)", {**BEST, "maxpos": 1, "lever": 1.0})):
        for drop in (-.15, -.25, -.35, -.50, -.70):
            r = run_gap(drop, cfg)
            r["strategy"] = name
            res["injections"].append(r)
    (ROAST / "results/tail-gaps.json").write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(json.dumps(res["real_2020_2026"], indent=1))
    df = pd.DataFrame(res["injections"])
    print(df.pivot_table(index="strategy", columns="drop", values="pnl").round(0).to_string())
    print(df.pivot_table(index="strategy", columns="drop", values="liquidated").to_string())


if __name__ == "__main__":
    main()
