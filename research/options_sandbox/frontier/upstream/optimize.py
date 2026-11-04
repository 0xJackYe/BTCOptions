"""Strategy search on v2 worlds with common random numbers and a seed holdout. Offline.

Stage 1  random search on TRAIN seeds (3 physical models, zero drift, thin VRP, Oct-2026 skew).
Stage 2  top candidates re-scored on fresh HOLDOUT seeds (removes winner's-curse selection bias).
Usage: python optimize.py stage1 N_CONFIGS PATHS ; python optimize.py stage2 TOPK PATHS
"""
import json
import multiprocessing as mp
import sys

import numpy as np
import pandas as pd

from common import ROAST, load_all
import engine2 as e2
import v2_market as v2

H = 365 * 24
MODELS = ("boot_all", "boot_recent", "gjr_capped")
SPACE = {
    "side": [0, 0, 0, 2, 1],          # puts weighted: they carry the measured edge; calls/strangles still explored
    "dte": [3, 7, 14, 21, 30, 45, 60],
    "delta": [.03, .05, .08, .10, .15, .20, .25, -.10, -.15, -.20, -.25, -.30],
    "wing": [0, 0, 0, .01, .02, -.10, -.20],
    "tp": [.5, .7, .9, 1.0, 1.0],
    "sl": [0, 0, 2, 3, 5],
    "texit": [0, 0, 24, 72],
    "entry": [0, 0, 1, 2],
    "maxpos": [1, 1, 2, 3, 4],
    "lever": [1.0, 1.0, 1.5, 2.0, 3.0],
    "min_credit": [.2, .5, 1.0],
}
ENTRY_PARAM = {0: [0], 1: [.03, .05, .08], 2: [1.0, 1.1, 1.2, 1.3]}
_BANK = None


def build_bank(seeds_offset, paths, world=None):
    history, calib, raw, follows, h, ivc = load_all()
    ctx = v2.context(history, (calib, raw, follows, h))
    bank = []
    for model in MODELS:
        for p in range(paths):
            w = {"model": model, **(world or {})}
            f, mk, prm = v2.market(w, H, seeds_offset + 31 * p, ctx)
            bank.append((model, mk[:7], prm))
    return bank


def _init(seeds_offset, paths, world):
    global _BANK
    _BANK = build_bank(seeds_offset, paths, world)


def evaluate(P, bank):
    res = {m: [] for m in MODELS}
    for model, mk, prm in bank:
        out = e2.run(P, *mk, *prm)
        res[model].append(out)
    return {m: np.array(v) for m, v in res.items()}


def score(r):
    """Per-model stats on annual P&L (USDT on 1,000) plus a pooled robust score."""
    s = {}
    for m, a in r.items():
        pnl = a[:, 0] - 1000
        s[m] = {"mean": float(pnl.mean()), "median": float(np.median(pnl)), "p05": float(np.quantile(pnl, .05)),
                "cvar5": float(np.sort(pnl)[:max(1, len(pnl) // 20)].mean()), "p_loss": float((pnl < 0).mean()),
                "p_loss_gt_300": float((pnl < -300).mean()), "bankrupt": float(a[:, 15].mean()), "liq": float((a[:, 7] > 0).mean()),
                "maxdd_p95": float(np.quantile(a[:, 2], .95)), "trades": float(a[:, 3].mean()), "fees": float(a[:, 5].mean()),
                "log_growth": float(np.mean(np.log(np.maximum(a[:, 0], 1e-6) / 1000)))}
    means = [s[m]["mean"] for m in MODELS]
    s["pooled_mean"] = float(np.mean(means))
    s["worst_model_mean"] = float(np.min(means))
    s["worst_cvar5"] = float(min(s[m]["cvar5"] for m in MODELS))
    s["worst_p_loss_gt_300"] = float(max(s[m]["p_loss_gt_300"] for m in MODELS))
    s["pooled_log_growth"] = float(np.mean([s[m]["log_growth"] for m in MODELS]))
    # Feasible = tail-controlled in EVERY physical model; ranking = mean P&L of the worst model.
    s["min_trades"] = float(min(s[m]["trades"] for m in MODELS))
    s["feasible"] = bool(s["worst_cvar5"] >= -300 and s["worst_p_loss_gt_300"] <= .025 and max(s[m]["bankrupt"] for m in MODELS) == 0
                         and s["min_trades"] >= 2)
    return s


def _job(cfg):
    P = e2.params(**cfg)
    r = evaluate(P, _BANK)
    return {"cfg": cfg, "score": score(r)}


def sample_configs(n, rng):
    out = []
    keys = list(SPACE)
    for _ in range(n):
        c = {k: SPACE[k][rng.integers(len(SPACE[k]))] for k in keys}
        c["entry_param"] = ENTRY_PARAM[c["entry"]][rng.integers(len(ENTRY_PARAM[c["entry"]]))]
        c["entry_hour"] = -1 if c["entry"] else 8
        c["risk"] = 1.0
        out.append({k: float(v) for k, v in c.items()})
    # seeds of known structures so they are always compared
    known = [dict(side=0, dte=45, delta=-.25, entry=1, entry_param=.05, maxpos=1, tp=1.0, entry_hour=-1, min_credit=.3),  # original idea
             dict(side=0, dte=14, delta=.10, maxpos=1, tp=.6, texit=72, entry_hour=8),
             dict(side=0, dte=30, delta=.10, maxpos=1, tp=1.0, entry_hour=8),
             dict(side=0, dte=7, delta=.10, maxpos=1, tp=1.0, entry_hour=8)]
    defaults = dict(zip(e2.NAMES, e2.params()))
    for k in known:
        c = {kk: float(defaults[kk]) for kk in list(SPACE) + ["entry_param", "entry_hour", "risk"]}
        c.update({kk: float(v) for kk, v in k.items()})
        out.append(c)
    return out


def flat(row):
    d = dict(row["cfg"])
    sc = row["score"]
    for m in MODELS:
        for k, v in sc[m].items():
            d[f"{m}.{k}"] = v
    for k in ("pooled_mean", "worst_model_mean", "worst_cvar5", "worst_p_loss_gt_300", "pooled_log_growth", "min_trades", "feasible"):
        d[k] = sc[k]
    return d


def main():
    stage = sys.argv[1]
    if stage == "stage1":
        n, paths = int(sys.argv[2]), int(sys.argv[3])
        cfgs = sample_configs(n, np.random.default_rng(20261103))
        with mp.Pool(4, initializer=_init, initargs=(1_000_000, paths, None)) as pool:
            rows = pool.map(_job, cfgs, chunksize=4)
        df = pd.DataFrame([flat(r) for r in rows])
        df.to_csv(ROAST / "results/search-stage1.csv", index=False)
        top = df[df.feasible].sort_values("worst_model_mean", ascending=False)
        print("feasible", int(df.feasible.sum()), "of", len(df))
        print(top.head(25)[["side", "dte", "delta", "wing", "tp", "sl", "texit", "entry", "entry_param", "maxpos", "lever", "min_credit",
                            "pooled_mean", "worst_model_mean", "worst_cvar5", "worst_p_loss_gt_300", "pooled_log_growth"]].round(3).to_string())
    elif stage == "refine":
        topk, paths = int(sys.argv[2]), int(sys.argv[3])
        s1 = pd.read_csv(ROAST / "results/search-stage1.csv")
        cols = list(SPACE) + ["entry_param", "entry_hour", "risk"]
        seeds = s1[s1.feasible].sort_values("worst_model_mean", ascending=False).head(topk)
        cfgs, seen = [], set()
        grids = {**{k: sorted(set(v)) for k, v in SPACE.items()}, "entry_param": sorted({x for v in ENTRY_PARAM.values() for x in v})}
        for _, r in seeds.iterrows():
            base = {k: float(r[k]) for k in cols}
            for k, values in grids.items():
                for val in values:
                    c = dict(base, **{k: float(val)})
                    if k == "entry":
                        c["entry_param"] = float(ENTRY_PARAM[int(val)][len(ENTRY_PARAM[int(val)]) // 2])
                        c["entry_hour"] = -1.0 if val else 8.0
                    if c["entry_param"] not in ENTRY_PARAM[int(c["entry"])]:
                        continue
                    key = tuple(sorted(c.items()))
                    if key not in seen:
                        seen.add(key)
                        cfgs.append(c)
        with mp.Pool(4, initializer=_init, initargs=(1_000_000, paths, None)) as pool:
            rows = pool.map(_job, cfgs, chunksize=2)
        df = pd.DataFrame([flat(r) for r in rows])
        df.to_csv(ROAST / "results/search-refine.csv", index=False)
        print("refined", len(df), "neighbours; feasible", int(df.feasible.sum()))
        print(df[df.feasible].sort_values("worst_model_mean", ascending=False).head(15)[["side", "dte", "delta", "wing", "tp", "sl", "texit", "entry", "entry_param",
              "maxpos", "lever", "min_credit", "pooled_mean", "worst_model_mean", "worst_cvar5", "worst_p_loss_gt_300"]].round(3).to_string())
    elif stage == "stage2":
        topk, paths = int(sys.argv[2]), int(sys.argv[3])
        s1 = pd.read_csv(ROAST / "results/search-stage1.csv")
        if (ROAST / "results/search-refine.csv").exists():
            s1 = pd.concat([s1, pd.read_csv(ROAST / "results/search-refine.csv")], ignore_index=True)
            cols0 = list(SPACE) + ["entry_param", "entry_hour", "risk"]
            s1 = s1.drop_duplicates(subset=cols0)
        cand = s1[s1.feasible].sort_values("worst_model_mean", ascending=False).head(topk)
        cols = list(SPACE) + ["entry_param", "entry_hour", "risk"]
        cfgs = [{k: float(r[k]) for k in cols} for _, r in cand.iterrows()]
        with mp.Pool(4, initializer=_init, initargs=(2_000_000, paths, None)) as pool:
            rows = pool.map(_job, cfgs, chunksize=1)
        df = pd.DataFrame([flat(r) for r in rows])
        df["train_worst_model_mean"] = cand.worst_model_mean.to_numpy()
        df.to_csv(ROAST / "results/search-stage2-holdout.csv", index=False)
        print(df.sort_values("worst_model_mean", ascending=False).head(20)[["side", "dte", "delta", "wing", "tp", "sl", "texit", "entry", "entry_param",
              "maxpos", "lever", "min_credit", "train_worst_model_mean", "pooled_mean", "worst_model_mean", "worst_cvar5", "worst_p_loss_gt_300"]].round(3).to_string())


if __name__ == "__main__":
    main()

