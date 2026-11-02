"""Rule-by-rule ablation of the user's V1 engine on v2 worlds.

Variants are built from strategy_engine.py source by EXACT, asserted text substitutions (each must
match once), so everything else is the user's code verbatim.
"""
import itertools
import multiprocessing as mp
import sys
import types

import numpy as np
import pandas as pd

from common import ROAST, SANDBOX, load_all, rs
import v2_market as v2

SRC = (SANDBOX / "strategy_engine.py").read_text(encoding="utf-8")
PATCHES = {
    "no_spot_conversion": [("            convert = (reason == 3 and not both_risk and not global_exit and pause_until == 0) or (is_settlement and buyback_price > 0 and not global_exit)",
                            "            convert = False")],
    "puts_only": [("    if leg == 1 and inventory + 1e-10 < Q:\n        return 0.0, 0, 0.0",
                   "    if leg == 1:\n        return 0.0, 0, 0.0")],
    "no_take_profit": [("            elif credit[leg] - Q * ask - fee(ask, S) >= .60 * credit[leg]:",
                        "            elif False:")],
    "no_delta_touch_stop": [("            elif queued_risk[leg] > 0 or abs(delta) >= .35 or (leg == 0 and low[i] <= strikes[leg]) or (leg == 1 and high[i] >= strikes[leg]):",
                             "            elif queued_risk[leg] > 0:")],
}
PATCHES["puts_only_no_conversion"] = PATCHES["puts_only"] + PATCHES["no_spot_conversion"]


def build(name):
    src = SRC.replace("@njit(cache=True)", "@njit(cache=False)")
    for old, new in PATCHES.get(name, []):
        assert src.count(old) == 1, (name, old[:60])
        src = src.replace(old, new)
    mod = types.ModuleType(f"v1_{name}")
    exec(compile(src, f"<v1_{name}>", "exec"), mod.__dict__)
    return mod.simulate_path


VARIANTS = ["as_is", "iv_gate_off", "no_spot_conversion", "puts_only", "puts_only_no_conversion", "no_take_profit", "no_delta_touch_stop"]
_CTX = None
_ENG = None


def _init():
    global _CTX, _ENG
    history, calib, raw, follows, h, ivc = load_all()
    _CTX = v2.context(history, (calib, raw, follows, h))
    _ENG = {v: build("as_is" if v == "iv_gate_off" else v) for v in VARIANTS}


def _job(args):
    model, path = args
    f, mk, prm = v2.market({"model": model}, 365 * 24, 3_000_000 + 31 * path, _CTX)
    out = []
    for v in VARIANTS:
        gate = 0.0 if v == "iv_gate_off" else 1.20
        m = dict(zip(rs.METRICS, _ENG[v](*mk, *prm, 1.0, 1.0, 0.0, 14.0, .10, gate)[0]))
        out.append({"model": model, "path": path, "variant": v, "pnl_vs_hold": m["end_nav"] - m["holding_benchmark_nav"],
                    "option_pnl": m["option_pnl_including_terminal_liability"], "inventory_pnl": m["inventory_rebalance_pnl_vs_hold"],
                    "legs": m["opened_legs"], "premium": m["gross_premiums"]})
    return out


def main():
    paths = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    jobs = list(itertools.product(("boot_all", "boot_recent", "gjr_capped"), range(paths)))
    with mp.Pool(4, initializer=_init) as pool:
        rows = [r for chunk in pool.map(_job, jobs, chunksize=16) for r in chunk]
    df = pd.DataFrame(rows)
    df.to_csv(ROAST / "results/v1-ablation.csv.gz", index=False)
    g = df.groupby(["variant", "model"]).agg(pnl=("pnl_vs_hold", "mean"), pnl_se=("pnl_vs_hold", lambda x: x.std() / np.sqrt(len(x))),
                                             option_pnl=("option_pnl", "mean"), inventory_pnl=("inventory_pnl", "mean"),
                                             legs=("legs", "mean"), premium=("premium", "mean")).round(2)
    pd.set_option("display.width", 200)
    print(g.to_string())


if __name__ == "__main__":
    main()
