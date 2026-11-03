"""One-at-a-time rule sensitivity for the chosen strategy C on fresh seeds (base worlds) + real-path replay."""
import multiprocessing as mp

import numpy as np
import pandas as pd

from common import ROAST
import engine2 as e2
from optimize import build_bank, MODELS
from replay_real import year_markets
import v2_market as v2

BEST = dict(side=0, dte=7, delta=.08, tp=.9, sl=2.0, maxpos=4, lever=3.0, min_credit=.5, entry_hour=8)
VARIANTS = {
    "C as chosen": {},
    "no stop-loss": {"sl": 0.0},
    "stop at 3x credit": {"sl": 3.0},
    "no take-profit (hold to expiry unless stopped)": {"tp": 1.0},
    "take-profit at 50%": {"tp": .5},
    "0.05 delta": {"delta": .05},
    "0.12 delta": {"delta": .12},
    "14-day expiry": {"dte": 14},
    "1 lot, cash-secured (1x notional)": {"maxpos": 1, "lever": 1.0},
    "2 lots (1.5x notional)": {"maxpos": 2, "lever": 1.5},
    "only when ATM IV/RV20 >= 1.1": {"ivgate": 1.1},
    "only after a -3% day": {"entry": 1, "entry_param": .03, "entry_hour": -1},
}
_BANK = None


def _init():
    global _BANK
    _BANK = build_bank(8_000_000, 300)


def _job(name):
    P = e2.params(**{**BEST, **VARIANTS[name]})
    rows = []
    for model, mk, prm in _BANK:
        out = e2.run(P, *mk, *prm)
        rows.append((name, model, out[0] - 1000, out[2], out[3], out[9]))
    return rows


def replay(name):
    P = e2.params(**{**BEST, **VARIANTS[name]})
    tot = 0.0
    worst = 1e9
    for y, k, mk, prm, (wd, hh) in year_markets(0):
        pnl = e2.run(P, *mk[:7], *prm, 1000.0, 720, wd, hh)[0] - 1000
        tot += pnl
        worst = min(worst, pnl)
    return tot, worst


def main():
    with mp.Pool(4, initializer=_init) as pool:
        rows = [r for chunk in pool.map(_job, list(VARIANTS)) for r in chunk]
    df = pd.DataFrame(rows, columns=["variant", "model", "pnl", "maxdd", "trades", "stops"])
    out = []
    for name in VARIANTS:
        g = df[df.variant == name]
        r = {"variant": name}
        for m in MODELS:
            x = g[g.model == m].pnl.to_numpy()
            r[f"{m} mean"] = x.mean()
            r[f"{m} cvar5"] = np.sort(x)[:len(x) // 20].mean()
        r["trades/yr"] = g.trades.mean()
        r["stops/yr"] = g.stops.mean()
        r["replay 2020-26 total"], r["replay worst year"] = replay(name)
        out.append(r)
    res = pd.DataFrame(out)
    res.to_csv(ROAST / "results/sensitivity-best.csv", index=False)
    pd.set_option("display.width", 250)
    print(res.round(1).to_string(index=False))


if __name__ == "__main__":
    main()
