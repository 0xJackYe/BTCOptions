"""Run the same audit battery on v2 worlds. Writes roast/results/v2-validation.json."""
import json
import math
import sys

import numpy as np

from audit_generator import q, real_windows, window_stats, OUT
from common import load_all, se
import v2_market as v2

PATHS = int(sys.argv[1]) if len(sys.argv) > 1 else 200
H = 365 * 24


def edge(markets, params, otm, side, dte_h=336, step=24):
    term, rho, eta = params
    prem, pay = [], []
    for f, mk in markets:
        close, atm = mk[0], mk[3]
        for i in range(721, len(close) - dte_h, step):
            S = close[i]
            K = S * (1 - otm) if side < 0 else S * (1 + otm)
            prem.append(se.quote(side, S, K, dte_h, atm[i], term, rho, eta, 0.0)[0])
            ST = close[i + dte_h]
            pay.append(max(K - ST, 0) if side < 0 else max(ST - K, 0))
    prem, pay = np.array(prem), np.array(pay)
    return {"side": "put" if side < 0 else "call", "otm": otm, "mean_premium": float(prem.mean()), "mean_payoff": float(pay.mean()),
            "seller_edge": float(1 - pay.mean() / prem.mean()), "se": float(np.std(prem - pay) / math.sqrt(len(prem)) / prem.mean())}


def vrp(markets, dte_h=336, step=6):
    iv, rv = [], []
    for f, mk in markets:
        r = f[:, 0]
        for i in range(721, len(r) - dte_h, step):
            iv.append(mk[3][i])
            rv.append(math.sqrt(np.sum(r[i + 1:i + dte_h + 1] ** 2) * 8760 / dte_h))
    iv, rv = np.array(iv), np.array(rv)
    calm = rv < np.median(rv)
    return {"atm_iv": q(iv), "fwd_rv": q(rv), "iv_minus_rv_mean": float((iv - rv).mean()), "median_iv_over_rv": float(np.median(iv / rv)),
            "var_premium_mean": float((iv ** 2 - rv ** 2).mean()), "p_iv_gt_rv": float((iv > rv).mean()),
            "iv_minus_rv_calm_half": float((iv - rv)[calm].mean()), "iv_minus_rv_volatile_half": float((iv - rv)[~calm].mean())}


def events(markets, thr=.10):
    out = {}
    for name, sign in (("crash", -1), ("rally", 1)):
        imm, after = [], []
        for f, mk in markets:
            close, atm = mk[0], mk[3]
            r24 = np.r_[np.zeros(24), close[24:] / close[:-24] - 1]
            hit = np.where((sign * r24 >= thr) & (np.r_[0, sign * r24[:-1]] < thr))[0]
            for i in hit:
                if 745 <= i < len(close) - 24:
                    imm.append(atm[i] / atm[i - 24])
                    after.append(atm[i + 24] / atm[i - 24])
        out[name] = {"events": len(imm), "iv_ratio_at_cross": q(imm) if imm else None, "iv_ratio_24h_after": q(after) if after else None}
    return out


def main():
    history, calib, raw, follows, h, ivc = load_all()
    ctx = v2.context(history, (calib, raw, follows, h))
    res = {"paths": PATHS, "real_2020_2026": {c: q(v) for c, v in real_windows(history, "2020-01-01").items()},
           "real_2023_2026": {c: q(v) for c, v in real_windows(history, "2023-01-01").items()}}
    for model in ("boot_all", "boot_recent", "gjr_capped"):
        rows, markets = [], []
        for p in range(PATHS):
            f, mk, params = v2.market({"model": model}, H, 900000 + 31 * p, ctx)
            rows.append(window_stats(f[721:, 0]))
            markets.append((f, mk))
        import pandas as pd
        df = pd.DataFrame(rows)
        res[model] = {"physical": {c: q(df[c]) for c in df}, "vrp": vrp(markets), "events": events(markets),
                      "edge": [edge(markets, params, o, s) for s in (-1, 1) for o in (.05, .10, .15, .20)]}
        print(model, "done", flush=True)
    (OUT / "v2-validation.json").write_text(json.dumps(res, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
