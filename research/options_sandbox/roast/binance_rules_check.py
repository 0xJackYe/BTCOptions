"""Strategy C under Binance BTC-option mechanics: USDT cash settlement, Friday 08:00 UTC weeklies, sparse strikes.

- Monte Carlo base worlds on fresh seeds with the listed strike spacing at 1k (assumed so far), 2k and 4k USDT
  (the 2026-10-15 chain listed only 70k/74k/76k between 5% and 15% OTM for the next non-monthly weekly).
- Replay on the REAL 2020-2026 path with expiries on real Fridays 08:00 UTC, same three grids.
- How often a put finishes in the money and is cash-settled in USDT (no BTC is ever delivered).
Writes results/binance-rules-check.csv.
"""
import multiprocessing as mp

import numpy as np
import pandas as pd

from common import ROAST
import engine2 as e2
from optimize import build_bank, MODELS
from replay_real import year_markets

BEST = dict(side=0, dte=7, delta=.08, tp=.9, sl=2.0, maxpos=4, lever=3.0, min_credit=.5, entry_hour=8)
GRIDS = (1000, 2000, 4000)
_BANK = None


def _init():
    global _BANK
    _BANK = build_bank(10_000_000, 300)


def _mc(kstep):
    P = e2.params(**{**BEST, "kstep": kstep})
    return [(kstep, model, *e2.run(P, *mk, *prm)[[0, 3, 10, 7]]) for model, mk, prm in _BANK]


def main():
    with mp.Pool(3, initializer=_init) as pool:
        rows = [r for chunk in pool.map(_mc, GRIDS) for r in chunk]
    mc = pd.DataFrame(rows, columns=["kstep", "model", "nav", "trades", "itm_settled", "liq"])
    mc["pnl"] = mc.nav - 1000
    out = []
    for (k, m), g in mc.groupby(["kstep", "model"]):
        x = g.pnl.to_numpy()
        out.append({"test": "monte_carlo_base", "kstep": k, "model": m, "mean": x.mean(), "p05": np.quantile(x, .05),
                    "cvar5": np.sort(x)[:len(x) // 20].mean(), "trades_per_year": g.trades.mean(),
                    "itm_cash_settlements_per_year": g.itm_settled.mean(), "liquidated_paths": (g.liq > 0).mean()})
    for k in GRIDS:
        P = e2.params(**{**BEST, "kstep": k})
        for y, _, mk, prm, (wd, hh) in year_markets(0):
            r = e2.run(P, *mk[:7], *prm, 1000.0, 720, wd, hh)
            out.append({"test": "replay_real_calendar", "kstep": k, "model": str(y), "mean": r[0] - 1000, "trades_per_year": r[3],
                        "itm_cash_settlements_per_year": r[10], "liquidated_paths": float(r[7] > 0)})
        r0 = [e2.run(P, *mk[:7], *prm)[0] - 1000 for y, _, mk, prm, _ in year_markets(0)]
        out.append({"test": "replay_synthetic_calendar_total", "kstep": k, "model": "2020-2026", "mean": float(np.sum(r0))})
    res = pd.DataFrame(out)
    res.to_csv(ROAST / "results/binance-rules-check.csv", index=False)
    pd.set_option("display.width", 220)
    print(res[res.test == "monte_carlo_base"].round(2).to_string(index=False))
    rp = res[res.test == "replay_real_calendar"].pivot_table(index="kstep", columns="model", values="mean")
    rp["total"] = rp.sum(axis=1)
    print("\nReplay, real Fridays 08:00 UTC (USDT per year):\n", rp.round(1).to_string())
    print("\nReplay ITM cash settlements per year:\n",
          res[res.test == "replay_real_calendar"].pivot_table(index="kstep", columns="model", values="itm_cash_settlements_per_year").to_string())
    print("\nOld synthetic-calendar replay totals:\n", res[res.test == "replay_synthetic_calendar_total"][["kstep", "mean"]].round(1).to_string(index=False))


if __name__ == "__main__":
    main()
