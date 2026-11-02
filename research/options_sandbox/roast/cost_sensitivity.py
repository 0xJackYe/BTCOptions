"""Strategy C and neighbours under 3x / 6x wider option spreads than the real 2026 book."""
import multiprocessing as mp

import pandas as pd

from common import ROAST
import engine2 as e2
from optimize import build_bank

BEST = dict(side=0, dte=7, delta=.08, tp=.9, sl=2.0, maxpos=4, lever=3.0, min_credit=.5, entry_hour=8)
STRATS = {"C (7d 0.08d)": BEST, "C 14-day": {**BEST, "dte": 14}, "C 0.12d": {**BEST, "delta": .12}, "C 1 lot": {**BEST, "maxpos": 1, "lever": 1.0}}
WORLDS = {"real-2026 book (1-2 ticks)": {"spread_base": .01}, "3x wider": {"spread_base": .03}, "6x wider": {"spread_base": .06}}


def job(wname):
    bank = build_bank(9_000_000, 150, WORLDS[wname])
    return [(wname, s, model, e2.run(e2.params(**cfg), *mk, *prm)[0] - 1000) for s, cfg in STRATS.items() for model, mk, prm in bank]


if __name__ == "__main__":
    with mp.Pool(3) as pool:
        rows = [r for chunk in pool.map(job, list(WORLDS)) for r in chunk]
    df = pd.DataFrame(rows, columns=["spreads", "strategy", "model", "pnl"])
    df.to_csv(ROAST / "results/cost-sensitivity.csv.gz", index=False)
    pd.set_option("display.width", 200)
    print(df.pivot_table(index="strategy", columns=["spreads", "model"], values="pnl", aggfunc="mean").round(1).to_string())
