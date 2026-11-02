"""Stage 3: score finalist configs on HOLDOUT seeds across 54 worlds (model x drift x VRP x skew).

Usage: python robustness.py finalists.json PATHS   (finalists: [{"name":..,"cfg":{..}}, ...])
Writes roast/results/robustness.csv (per world) and robustness-paths.csv.gz (per path, base worlds).
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

H = 365 * 24
MODELS = ("boot_all", "boot_recent", "gjr_capped")
DRIFTS = {"bear": -.35, "zero": 0.0, "bull": .35}
VRPS = {"none": .95, "thin": 1.0, "rich": 1.12}
SKEWS = {"oct2026_put_skew": {"rho": v2.SMILE["rho"], "eta": v2.SMILE["eta"]}, "neutral_2023": {"rho": -.06, "eta": 1.15},
         "panic_iv_x3": {"rho": v2.SMILE["rho"], "eta": v2.SMILE["eta"], "fear": 3.0}}  # crash IV spikes ~ Aug-2024 size
_CTX = None
_FIN = None


def _init(finalists):
    global _CTX, _FIN
    history, calib, raw, follows, h, ivc = load_all()
    _CTX = v2.context(history, (calib, raw, follows, h))
    _FIN = [(f["name"], e2.params(**f["cfg"]) if f["cfg"] != "V1" else "V1") for f in finalists]


def _job(args):
    model, d, v, s, path = args
    world = {"model": model, "drift": DRIFTS[d], "vrp": VRPS[v], **SKEWS[s]}
    f, mk, prm = v2.market(world, H, 4_000_000 + 31 * path, _CTX)
    rows = []
    for name, P in _FIN:
        if isinstance(P, str):
            m = dict(zip(rs.METRICS, se.simulate_path(*mk, *prm)[0]))
            rows.append((model, d, v, s, path, name, m["end_nav"] - m["holding_benchmark_nav"], m["max_drawdown"], m["opened_legs"], 0.0, 0.0))
        else:
            out = e2.run(P, *mk[:7], *prm)
            rows.append((model, d, v, s, path, name, out[0] - 1000, out[2], out[3], out[7], out[15]))
    return rows


def main():
    finalists = json.loads(open(sys.argv[1]).read())
    paths = int(sys.argv[2])
    jobs = [j for j in itertools.product(MODELS, DRIFTS, VRPS, SKEWS, range(paths))
            if j[3] != "panic_iv_x3" or (j[1] == "zero" and j[2] == "thin")]
    with mp.Pool(4, initializer=_init, initargs=(finalists,)) as pool:
        rows = [r for chunk in pool.imap_unordered(_job, jobs, chunksize=32) for r in chunk]
    df = pd.DataFrame(rows, columns=["model", "drift", "vrp", "smile", "path", "strategy", "pnl", "maxdd", "trades", "liq", "bankrupt"])
    base = df[(df.drift == "zero") & (df.vrp == "thin") & (df["smile"] == "oct2026_put_skew")]
    base.to_csv(ROAST / "results/robustness-paths-base.csv.gz", index=False)

    def agg(g):
        x = g.pnl.to_numpy()
        return pd.Series({"mean": x.mean(), "se": x.std() / np.sqrt(len(x)), "median": np.median(x), "p05": np.quantile(x, .05),
                          "cvar5": np.sort(x)[:max(1, len(x) // 20)].mean(), "p_loss": (x < 0).mean(), "p_loss_gt_300": (x < -300).mean(),
                          "maxdd_p95": g.maxdd.quantile(.95), "trades": g.trades.mean(), "p_liq": (g.liq > 0).mean()})
    res = df.groupby(["strategy", "model", "drift", "vrp", "smile"]).apply(agg).reset_index()
    res.to_csv(ROAST / "results/robustness.csv", index=False)
    pd.set_option("display.width", 250)
    b = res[(res.drift == "zero") & (res.vrp == "thin") & (res["smile"] == "oct2026_put_skew")]
    print("BASE worlds (zero drift, thin VRP, Oct-2026 skew):")
    print(b.pivot_table(index="strategy", columns="model", values=["mean", "p05", "cvar5"]).round(1).to_string())
    print("\nMean P&L by drift x VRP (avg over models, Oct-2026 skew):")
    print(res[res["smile"] == "oct2026_put_skew"].pivot_table(index="strategy", columns=["drift", "vrp"], values="mean").round(1).to_string())
    print("\nMean P&L by skew (zero drift, thin VRP, avg over models):")
    print(res[(res.drift == "zero") & (res.vrp == "thin")].pivot_table(index="strategy", columns="smile", values="mean").round(1).to_string())
    print("\nPanic-IV stress (fear x3, zero drift, thin VRP):")
    print(res[res["smile"] == "panic_iv_x3"].pivot_table(index="strategy", columns="model", values=["mean", "cvar5"]).round(1).to_string())
    print("\nWorst-world mean / worst-world cvar5 across all worlds:")
    print(res.groupby("strategy").agg(worst_mean=("mean", "min"), worst_cvar5=("cvar5", "min"), max_p_liq=("p_liq", "max")).round(1).to_string())


if __name__ == "__main__":
    main()
