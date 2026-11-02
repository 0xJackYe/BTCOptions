"""Historical replay on the REAL BTCUSDT path 2020..2026-10, one fresh account per calendar year.

Prices are real; option quotes come from the v2 calibrated layer applied to the real path
(HAR(RV) * m0 * fear, Oct-2026 smile). IV noise off (deterministic) plus an ensemble with noise.
Real option quotes for these years are NOT available offline, so this is a semi-historical replay.
Usage: python replay_real.py '<json list of {"name":..,"cfg":{..}}>'  (V1 + original always included)
"""
import json
import sys

import numpy as np
import pandas as pd

from common import ROAST, SANDBOX, se, rs
import engine2 as e2
import v2_market as v2


def real_features():
    d = pd.read_csv(SANDBOX / "data/btc_spot_1h.csv").set_index("open_epoch_sec").sort_index()
    cal = np.arange(d.index.min(), d.index.max() + 1, 3600)
    d = d.reindex(cal).ffill()  # 15 missing hours carried forward (flat), never invented moves
    prev = d.close.shift(1)
    f = np.column_stack([np.log(d.close / prev), np.log(d.open / prev), np.log(d.high / d.open), np.log(d.low / d.open)])
    f[0] = 0
    f[:, 2] = np.maximum(f[:, 2], np.maximum(f[:, 0] - f[:, 1], 0))
    f[:, 3] = np.minimum(f[:, 3], np.minimum(f[:, 0] - f[:, 1], 0))
    return cal, d, f


def year_slices(cal):
    t = pd.to_datetime(cal, unit="s", utc=True)
    out = []
    for y in range(2020, 2027):
        start = np.searchsorted(cal, pd.Timestamp(f"{y}-01-01", tz="UTC").timestamp())
        end = np.searchsorted(cal, pd.Timestamp(f"{y + 1}-01-01", tz="UTC").timestamp())
        if start < 721:  # 2020 needs a 30-day warmup: trade from Feb 1
            start = 721
        out.append((y, start - 721, end))
    return out


def run_all(strategies, noise_seeds=0):
    cal, d, f = real_features()
    rows = []
    for y, a, b in year_slices(cal):
        fy = f[a:b].copy()
        for k in range(max(1, noise_seeds)):
            world = dict(v2.WORLD_DEFAULT, iv_noise=1.0 if noise_seeds else 0.0)
            mk = v2.option_layer(fy, 7000 + k, world)
            # option_layer rescales the start to S0; restore the REAL price level
            level = d.close.to_numpy()[a + 720] / mk[0][720]
            mk = (mk[0] * level, mk[1] * level, mk[2] * level) + mk[3:]
            prm = (world["term"], world["rho"], world["eta"])
            v1, _ = se.simulate_path(*mk, *prm)
            m = dict(zip(rs.METRICS, v1))
            base = {"year": y, "noise_draw": k, "btc_start": mk[0][720], "btc_end": mk[0][-1], "btc_return": mk[0][-1] / mk[0][720] - 1}
            rows.append({**base, "strategy": "V1 (sandbox, unchanged)", "pnl": m["end_nav"] - m["holding_benchmark_nav"],
                         "option_pnl": m["option_pnl_including_terminal_liability"], "trades": m["opened_legs"], "maxdd": m["max_drawdown"]})
            for s in strategies:
                out = e2.run(e2.params(**s["cfg"]), *mk[:7], *prm)
                rows.append({**base, "strategy": s["name"], "pnl": out[0] - 1000, "option_pnl": out[0] - 1000, "trades": out[3],
                             "maxdd": out[2], "worst_trade": out[8], "itm": out[10], "liq": out[7]})
    return pd.DataFrame(rows)


def main():
    extra = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
    strategies = [{"name": "Original idea (45d 25%OTM put after -5% day, hold)", "cfg": dict(side=0, dte=45, delta=-.25, entry=1, entry_param=.05, maxpos=1,
                                                                                             tp=1.0, entry_hour=-1, min_credit=.3)}] + extra
    det = run_all(strategies, 0)
    noisy = run_all(strategies, 20)
    det.to_csv(ROAST / "results/replay-real-deterministic.csv", index=False)
    noisy.to_csv(ROAST / "results/replay-real-noise.csv", index=False)
    pd.set_option("display.width", 220)
    print("BTC by year:", det.drop_duplicates("year")[["year", "btc_start", "btc_end", "btc_return"]].round(3).to_string(index=False))
    print(det.pivot_table(index="strategy", columns="year", values="pnl").round(1).to_string())
    print("\nwith IV noise (mean over 20 draws):")
    print(noisy.pivot_table(index="strategy", columns="year", values="pnl", aggfunc="mean").round(1).to_string())


if __name__ == "__main__":
    main()
