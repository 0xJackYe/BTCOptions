"""The original idea in March 2020 across its own stated range (20-30% OTM, 1-2 months), marked on hourly LOWS."""
import json

import pandas as pd

from common import ROAST
import engine2 as e2
import v2_market as v2
from replay_real import real_features, year_slices

cal, d, f = real_features()
y, a, b = [x for x in year_slices(cal) if x[0] == 2020][0]
world = dict(v2.WORLD_DEFAULT, iv_noise=0.0)
mk = v2.option_layer(f[a:b].copy(), 7000, world)
level = d.close.to_numpy()[a + 720] / mk[0][720]
mk = (mk[2] * level, mk[1] * level, mk[2] * level) + mk[3:]  # close := hourly low (conservative)
rows = []
for dte in (14, 21, 30, 45, 60):
    for otm in (.20, .25, .30):
        out = e2.run(e2.params(side=0, dte=dte, delta=-otm, entry=1, entry_param=.05, maxpos=1, tp=1.0, entry_hour=-1, min_credit=.3),
                     *mk[:7], world["term"], world["rho"], world["eta"])
        rows.append({"dte": dte, "otm": otm, "pnl_2020": out[0] - 1000, "liquidated": bool(out[7] > 0), "min_margin_ratio": out[17], "worst_trade": out[8]})
df = pd.DataFrame(rows)
df.to_csv(ROAST / "results/replay-2020-original-grid.csv", index=False)
print(df.round(2).to_string(index=False))
