"""The original idea in March 2020 across its own stated range (20-30% OTM, 1-2 months), marked on hourly LOWS."""
import json

import pandas as pd

from common import ROAST
import engine2 as e2
import v2_market as v2
from replay_real import year_markets

_, _, mk, prm, (wd, hh) = next(year_markets(0, years={2020}))
mk = (mk[2], mk[1], mk[2]) + mk[3:]  # close := hourly low (conservative)
world = dict(v2.WORLD_DEFAULT)
rows = []
for dte in (14, 21, 30, 45, 60):
    for otm in (.20, .25, .30):
        out = e2.run(e2.params(side=0, dte=dte, delta=-otm, entry=1, entry_param=.05, maxpos=1, tp=1.0, entry_hour=-1, min_credit=.3),
                     *mk[:7], *prm, 1000.0, 720, wd, hh)
        rows.append({"dte": dte, "otm": otm, "pnl_2020": out[0] - 1000, "liquidated": bool(out[7] > 0), "min_margin_ratio": out[17], "worst_trade": out[8]})
df = pd.DataFrame(rows)
df.to_csv(ROAST / "results/replay-2020-original-grid.csv", index=False)
print(df.round(2).to_string(index=False))
