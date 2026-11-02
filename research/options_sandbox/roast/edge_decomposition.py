"""Where does the option-seller edge come from? 14-day options sold at MARK and held, by smile assumption.

Same physical paths and ATM IV path; only the smile (rho, eta) changes. Writes results/edge-decomposition.csv.
"""
import math

import numpy as np
import pandas as pd

from common import ROAST, load_all, se
import v2_market as v2

SMILES = {"oct2026 put skew (rho -0.245, eta 1.00)": (v2.SMILE["rho"], v2.SMILE["eta"]),
          "neutral 2023 smile (rho -0.06, eta 1.15)": (-.06, 1.15),
          "almost flat smile (rho 0, eta 0.05)": (0.0, .05)}


def main(paths=150, dte_h=336, step=24):
    history, calib, raw, follows, h, ivc = load_all()
    ctx = v2.context(history, (calib, raw, follows, h))
    rows = []
    for model in ("boot_all", "boot_recent", "gjr_capped"):
        mkts = [v2.market({"model": model}, 365 * 24, 6_000_000 + 31 * p, ctx) for p in range(paths)]
        for sname, (rho, eta) in SMILES.items():
            for side in (-1, 1):
                for otm in (.05, .10, .15, .20):
                    prem, pay = [], []
                    for f, mk, prm in mkts:
                        close, atm = mk[0], mk[3]
                        for i in range(721, len(close) - dte_h, step):
                            S = close[i]
                            K = S * (1 - otm) if side < 0 else S * (1 + otm)
                            prem.append(se.quote(side, S, K, dte_h, atm[i], prm[0], rho, eta, 0.0)[0])
                            ST = close[i + dte_h]
                            pay.append(max(K - ST, 0) if side < 0 else max(ST - K, 0))
                    prem, pay = np.array(prem), np.array(pay)
                    rows.append({"model": model, "smile": sname, "side": "put" if side < 0 else "call", "otm": otm,
                                 "premium_pct_spot": 100 * float(np.mean(prem)) / 77928.48, "seller_edge": float(1 - pay.mean() / prem.mean())})
    df = pd.DataFrame(rows)
    df.to_csv(ROAST / "results/edge-decomposition.csv", index=False)
    pd.set_option("display.width", 220)
    print(df.pivot_table(index=["side", "otm"], columns=["smile", "model"], values="seller_edge").round(2).to_string())


if __name__ == "__main__":
    main()
