"""Roast: the user's V1 engine (UNCHANGED) and the original sell-put idea across v2 worlds.

Worlds = physical model x drift x VRP, paired seeds. Writes roast/results/roast-v1.csv and a summary.
"""
import itertools
import json
import multiprocessing as mp
import sys

import numpy as np
import pandas as pd

from common import ROAST, load_all, se, rs
import engine2 as e2
import v2_market as v2

PATHS = int(sys.argv[1]) if len(sys.argv) > 1 else 300
H = 365 * 24
MODELS = ("boot_all", "boot_recent", "gjr_capped")
DRIFTS = {"bear": -.35, "zero": 0.0, "bull": .35}
VRPS = {"none": .95, "thin": 1.0, "rich": 1.12}
# The user's original idea (币安BTC期权交易模型.md): after a ~5% drop sell a 1-2 month put 20-30% OTM,
# hold to expiry, 0.01 BTC, 1,000 USDT account.
ORIGINAL = e2.params(side=0, dte=45, delta=-.25, entry=1, entry_param=.05, maxpos=1, tp=1.0, entry_hour=-1, min_credit=.3)

_CTX = None


def _init():
    global _CTX
    history, calib, raw, follows, h, ivc = load_all()
    _CTX = v2.context(history, (calib, raw, follows, h))


def _job(args):
    model, dname, vname, path = args
    seed = 500000 + 31 * path
    f, mk, prm = v2.market({"model": model, "drift": DRIFTS[dname], "vrp": VRPS[vname]}, H, seed, _CTX)
    v1, _ = se.simulate_path(*mk, *prm)
    m = dict(zip(rs.METRICS, v1))
    orig = e2.run(ORIGINAL, mk[0], mk[1], mk[2], mk[3], mk[4], mk[5], mk[6], *prm)
    btc = mk[0][-1] / mk[0][720] - 1
    return {"model": model, "drift": dname, "vrp": vname, "path": path, "btc_return": btc,
            "v1_pnl_vs_hold": m["end_nav"] - m["holding_benchmark_nav"], "v1_option_pnl": m["option_pnl_including_terminal_liability"],
            "v1_inventory_pnl": m["inventory_rebalance_pnl_vs_hold"], "v1_total_return": m["total_return"],
            "v1_legs": m["opened_legs"], "v1_maxdd": m["max_drawdown"], "v1_fees": m["all_fees"], "v1_premium": m["gross_premiums"],
            "v1_liq": m["potential_intrahour_liquidations"],
            "orig_pnl": orig[0] - 1000, "orig_trades": orig[3], "orig_maxdd": orig[2], "orig_worst": orig[8], "orig_itm": orig[10],
            "orig_premium": orig[6], "orig_liq": orig[7]}


def main():
    jobs = list(itertools.product(MODELS, DRIFTS, VRPS, range(PATHS)))
    with mp.Pool(4, initializer=_init) as pool:
        rows = pool.map(_job, jobs, chunksize=64)
    df = pd.DataFrame(rows)
    df.to_csv(ROAST / "results/roast-v1.csv.gz", index=False)

    def summ(g, col):
        x = g[col].to_numpy()
        return {"mean": x.mean(), "se": x.std() / np.sqrt(len(x)), "median": np.median(x), "p05": np.quantile(x, .05),
                "p_loss": (x < 0).mean(), "cvar5": np.sort(x)[:max(1, len(x) // 20)].mean()}
    out = []
    for (m, d, v), g in df.groupby(["model", "drift", "vrp"]):
        r = {"model": m, "drift": d, "vrp": v}
        for col in ("v1_pnl_vs_hold", "v1_option_pnl", "v1_inventory_pnl", "orig_pnl"):
            r.update({f"{col}_{k}": val for k, val in summ(g, col).items()})
        r.update({"v1_legs": g.v1_legs.mean(), "v1_premium": g.v1_premium.mean(), "v1_fees": g.v1_fees.mean(),
                  "orig_trades": g.orig_trades.mean(), "orig_premium": g.orig_premium.mean(), "orig_itm": g.orig_itm.mean(),
                  "orig_worst_p05": g.orig_worst.quantile(.05)})
        out.append(r)
    s = pd.DataFrame(out)
    s.to_csv(ROAST / "results/roast-v1-summary.csv", index=False)
    pd.set_option("display.width", 250)
    print(s[["model", "drift", "vrp", "v1_pnl_vs_hold_mean", "v1_pnl_vs_hold_se", "v1_option_pnl_mean", "v1_inventory_pnl_mean",
             "v1_legs", "v1_premium", "orig_pnl_mean", "orig_pnl_se", "orig_pnl_p05", "orig_trades", "orig_premium"]].round(2).to_string())


if __name__ == "__main__":
    main()
