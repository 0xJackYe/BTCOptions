"""Quantitative audit of the sandbox Monte Carlo generator (offline).

A. Physical price paths vs REAL BTCUSDT 2020-01..2026-10 hourly history.
B. Built-in option-seller edge: model premium vs realized payoff on the SAME simulated paths.
C. IV reaction to crashes / rallies inside the generator.
D. SSVI smile and spread model vs a REAL Binance chain snapshot (2026-10-15).
E. Real-history break-even IV for 14-day OTM options (model-free yardstick).

Writes roast/results/generator-audit.json. Usage: python audit_generator.py [paths]
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from common import ROAST, SANDBOX, load_all, mm, rs, se

OUT = ROAST / "results"
OUT.mkdir(exist_ok=True, parents=True)
PATHS = int(sys.argv[1]) if len(sys.argv) > 1 else 200
DAYS = 365
H = DAYS * 24


def q(x, qs=(.05, .25, .5, .75, .95)):
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    return {f"p{int(v * 100):02d}": float(np.quantile(x, v)) for v in qs} | {"mean": float(x.mean()), "n": int(len(x))}


def window_stats(r):
    """r: hourly log returns of one window (no gaps)."""
    logs = np.r_[0, np.cumsum(r)]
    s = np.exp(logs)
    daily = logs[24::24] - logs[:-24:24]
    rv30 = [np.sqrt(np.mean(r[i:i + 720] ** 2) * 8760) for i in range(0, len(r) - 720 + 1, 720)]
    return {
        "ann_vol": float(np.std(r) * math.sqrt(8760)),
        "log_return": float(logs[-1]),
        "max_drawdown": float(np.max(1 - s / np.maximum.accumulate(s))),
        "worst_day": float(daily.min()),
        "days_le_minus10pct": int((np.exp(daily) - 1 <= -.10).sum()),
        "days_ge_plus10pct": int((np.exp(daily) - 1 >= .10).sum()),
        "rv30_max": float(max(rv30)),
        "rv30_min": float(min(rv30)),
    }


def real_windows(history, start=None, end=None, step_days=7):
    t, f = history["times"], history["features"]
    keep = np.ones(len(t), bool)
    if start:
        keep &= t >= pd.Timestamp(start, tz="UTC").timestamp()
    if end:
        keep &= t < pd.Timestamp(end, tz="UTC").timestamp()
    t, r = t[keep], f[keep, 0]
    out = []
    for i in range(0, len(r) - H, step_days * 24):
        if t[i + H - 1] - t[i] != (H - 1) * 3600:  # skip windows spanning missing hours
            continue
        out.append(window_stats(r[i:i + H]))
    return pd.DataFrame(out)


FAILURES = {}


def sim_windows(model, raw, follows, h, calib, ivc, drift="empirical"):
    rows, markets, failed = [], [], []
    for p in range(PATHS):
        seed = 777000 + p * 31
        f = mm.generate_market(model, raw, follows, h, calib, H, seed, drift=drift)
        stats = window_stats(f[721:, 0])
        try:
            market = rs.prepare_market(f, ivc, seed + 7)
        except ValueError as error:  # recorded, never silently dropped
            failed.append({"seed": seed, "error": str(error), **stats})
            continue
        rows.append(stats)
        markets.append((f, market))
    FAILURES[model] = failed
    return pd.DataFrame(rows), markets


def premium_edge(markets, ivc, otm, side, dte_h=336, step=24):
    """Seller edge of a fixed-moneyness option sold at MARK and held to expiry, per 1 BTC.

    edge = mean(mark - payoff) / mean(mark). Pure pricing-vs-physics test, no fees/spread.
    """
    sm = ivc["surface_model"]
    prem, pay, ivs, rvf = [], [], [], []
    for f, mk in markets:
        close, atm = mk[0], mk[3]
        r = f[:, 0]
        for i in range(721, len(close) - dte_h, step):
            S = close[i]
            K = S * (1 - otm) if side < 0 else S * (1 + otm)
            mark, _, _, _, iv = se.quote(side, S, K, dte_h, atm[i], sm["term_coef"], sm["rho"], sm["eta"], 0.0)
            ST = close[i + dte_h]
            prem.append(mark)
            pay.append(max(K - ST, 0) if side < 0 else max(ST - K, 0))
            ivs.append(iv)
            rvf.append(np.sqrt(np.sum(r[i + 1:i + dte_h + 1] ** 2) * 8760 / dte_h))
    prem, pay = np.array(prem), np.array(pay)
    se_mean = np.std(prem - pay) / math.sqrt(len(prem)) / prem.mean()
    return {"otm": otm, "side": "put" if side < 0 else "call", "samples": len(prem),
            "mean_premium_per_btc": float(prem.mean()), "mean_payoff_per_btc": float(pay.mean()),
            "seller_edge_fraction_of_premium": float(1 - pay.mean() / prem.mean()),
            "edge_standard_error_naive": float(se_mean), "mean_strike_iv": float(np.mean(ivs)),
            "mean_forward_rv": float(np.mean(rvf)),
            "hit_rate_itm": float(np.mean(pay > 0))}


def vrp_stats(markets, dte_h=336, step=6):
    iv, rv, gate = [], [], []
    for f, mk in markets:
        r = f[:, 0]
        atm, rv20 = mk[3], mk[4]
        for i in range(721, len(r) - dte_h, step):
            iv.append(atm[i])
            rv.append(np.sqrt(np.sum(r[i + 1:i + dte_h + 1] ** 2) * 8760 / dte_h))
            gate.append(atm[i] / rv20[i])
    iv, rv, gate = map(np.array, (iv, rv, gate))
    return {"atm14_iv": q(iv), "forward_rv14": q(rv), "iv_minus_fwd_rv_mean": float(np.mean(iv - rv)),
            "variance_premium_mean": float(np.mean(iv ** 2 - rv ** 2)),
            "fraction_iv_above_fwd_rv": float(np.mean(iv > rv)), "atm_iv_over_rv20": q(gate),
            "fraction_atm_iv_over_rv20_ge_1p2": float(np.mean(gate >= 1.2)),
            "corr_iv_fwd_rv": float(np.corrcoef(iv, rv)[0, 1])}


def iv_event_study(markets, threshold=.10):
    """ATM IV change from the hour before a 24h move crossed +/-threshold to 24h after."""
    out = {}
    for name, sign in (("crash", -1), ("rally", 1)):
        ratios, imm = [], []
        for f, mk in markets:
            close, atm = mk[0], mk[3]
            r24 = np.r_[np.zeros(24), close[24:] / close[:-24] - 1]
            hit = np.where((sign * r24 >= threshold) & (np.r_[0, sign * r24[:-1]] < threshold))[0]
            for i in hit:
                if 745 <= i < len(close) - 24:
                    imm.append(atm[i] / atm[i - 24])
                    ratios.append(atm[i + 24] / atm[i - 24])
        out[name] = {"events": len(ratios), "iv_ratio_at_cross_vs_24h_before": q(imm) if imm else None,
                     "iv_ratio_24h_after_vs_24h_before": q(ratios) if ratios else None}
    return out


def snapshot_checks(ivc):
    snap = json.loads((ROAST.parent.parent.parent / "analysis/put-20261030/snapshot.json").read_text(encoding="utf-8"))
    S = float(snap["btc_index_price"])
    now = snap["server_now_ms"]
    sm = ivc["surface_model"]
    rows = []
    for o in snap["options"]:
        hours = (o["expiry_ms"] - now) / 3.6e6
        if not (5 * 24 <= hours <= 75 * 24):
            continue
        K, iv = float(o["strike_price"]), float(o["mark_iv"])
        bid, ask, mark = float(o["bid_price"]), float(o["ask_price"]), float(o["mark_price"])
        side = 1 if o["side"] == "CALL" else -1
        rows.append({"expiry": o["symbol"].split("-")[1], "hours": hours, "K": K, "side": side, "iv": iv,
                     "delta": float(o["delta"]), "bid": bid, "ask": ask, "mark": mark})
    d = pd.DataFrame(rows)
    report = []
    for ex, g in d.groupby("expiry"):
        hours = g.hours.iloc[0]
        # model ATM parameter fitted so the model ATM IV equals the real near-ATM IV
        g = g.assign(absk=(np.log(g.K / S)).abs())
        atm_real = g.sort_values("absk").iv.iloc[:2].mean()
        lo, hi = .05, 3.0
        for _ in range(80):
            mid = (lo + hi) / 2
            if se.surface_iv(S, S * math.exp(se.RATE * hours / 8760), hours, mid, sm["term_coef"], sm["rho"], sm["eta"]) < atm_real:
                lo = mid
            else:
                hi = mid
        atm14 = (lo + hi) / 2
        otm = g[((g.side < 0) & (g.K < S)) | ((g.side > 0) & (g.K > S))].copy()
        otm["model_iv"] = [se.surface_iv(S, k, hours, atm14, sm["term_coef"], sm["rho"], sm["eta"]) for k in otm.K]
        otm["abs_delta"] = otm.delta.abs()
        for side, name in ((-1, "put"), (1, "call")):
            for lo_d, hi_d in ((.04, .07), (.07, .13), (.13, .20), (.20, .30)):
                b = otm[(otm.side == side) & otm.abs_delta.between(lo_d, hi_d)]
                if len(b):
                    report.append({"expiry": ex, "dte": round(hours / 24, 1), "side": name, "abs_delta_bucket": f"{lo_d:.2f}-{hi_d:.2f}",
                                   "n": len(b), "real_iv": float(b.iv.mean()), "model_iv": float(b.model_iv.mean()),
                                   "model_minus_real_vol_pts": float(100 * (b.model_iv - b.iv).mean()),
                                   "real_spread_over_mid": float(((b.ask - b.bid) / ((b.ask + b.bid) / 2)).median()),
                                   "real_bid_median": float(b.bid.median())})
    return {"spot": S, "snapshot_utc": pd.to_datetime(now, unit="ms").isoformat(), "rows": report}


def real_breakeven_iv(history, ivc, otm, side, dte_h=336, step=24, start="2020-01-01", end=None):
    """Constant IV at which selling the fixed-moneyness option at BS fair value broke even on REAL history."""
    t, f = history["times"], history["features"]
    d = history["data"].set_index("open_epoch_sec")
    cal = np.arange(d.index.min(), d.index.max() + 1, 3600)
    c = d.close.reindex(cal).to_numpy()
    tt = cal
    keep = tt >= pd.Timestamp(start, tz="UTC").timestamp()
    if end:
        keep &= tt < pd.Timestamp(end, tz="UTC").timestamp()
    idx = np.where(keep)[0]
    S, ST = [], []
    for i in idx[::step]:
        j = i + dte_h
        if j < len(c) and np.isfinite(c[i]) and np.isfinite(c[j]):
            S.append(c[i]); ST.append(c[j])
    S, ST = np.array(S), np.array(ST)
    K = S * (1 - otm) if side < 0 else S * (1 + otm)
    pay = np.maximum(K - ST, 0) if side < 0 else np.maximum(ST - K, 0)

    def price(sig):
        return np.mean([se.bs(side, s, k, dte_h, sig)[0] for s, k in zip(S, K)])
    lo, hi = .01, 5.0
    target = pay.mean()
    for _ in range(60):
        mid = (lo + hi) / 2
        if price(mid) < target:
            lo = mid
        else:
            hi = mid
    return {"otm": otm, "side": "put" if side < 0 else "call", "window": f"{start}..{end or 'end'}", "samples": int(len(S)),
            "hit_rate_itm": float(np.mean(pay > 0)), "breakeven_constant_iv": (lo + hi) / 2,
            "mean_payoff_fraction_of_spot": float(np.mean(pay / S))}


def bootstrap_visit_bias(raw, follows, paths=200, block=72):
    """G2: the sandbox's non-circular stationary_indices under-samples hours after gaps/series start."""
    visits = np.zeros(len(raw))
    for s in range(paths):
        np.add.at(visits, mm.stationary_indices(len(raw), H + 721, block, follows, 7000 + s), 1)
    w = visits / visits.sum()
    return {"block_hours": block, "gaps": int((~follows).sum()), "uniform_drift_per_year": float(raw[:, 0].mean() * 8760),
            "visit_weighted_drift_per_year": float((w * raw[:, 0]).sum() * 8760),
            "visit_freq_min_over_mean": float(visits.min() / visits.mean())}


def snapshot_tick_spreads():
    """G8: real 2026-10-15 OTM book, spread in 5-USDT ticks by mark bucket (DTE > 3d)."""
    snap = json.loads((ROAST.parent.parent.parent / "analysis/put-20261030/snapshot.json").read_text(encoding="utf-8"))
    S, now = float(snap["btc_index_price"]), snap["server_now_ms"]
    rows = []
    for o in snap["options"]:
        K = float(o["strike_price"])
        otm = (o["side"] == "PUT" and K < S) or (o["side"] == "CALL" and K > S)
        bid, ask, mark = float(o["bid_price"]), float(o["ask_price"]), float(o["mark_price"])
        if otm and bid > 0 and (o["expiry_ms"] - now) / 8.64e7 > 3:
            rows.append({"mark": mark, "ticks": (ask - bid) / 5, "rel": (ask - bid) / ((ask + bid) / 2), "bid_qty": float(o.get("bid_quantity") or 0)})
    d = pd.DataFrame(rows)
    d["bucket"] = pd.cut(d.mark, [0, 50, 100, 200, 500, 1000, 3000, 1e9]).astype(str)
    return d.groupby("bucket").agg(n=("ticks", "size"), ticks_median=("ticks", "median"), rel_spread_median=("rel", "median"),
                                   bid_qty_median=("bid_qty", "median")).reset_index().to_dict("records")


def main():
    history, calib, raw, follows, h, ivc = load_all(frozen=True)
    result = {"paths_per_model": PATHS, "days": DAYS}
    real_all = real_windows(history, "2020-01-01")
    real_hold = real_windows(history, "2025-01-01")
    result["A_physical"] = {"real_2020_2026_rolling_365d": {c: q(real_all[c]) for c in real_all},
                            "real_2025_2026_rolling_365d": {c: q(real_hold[c]) for c in real_hold}}
    markets_by_model = {}
    for model in ("stationary", "gjr_fhs"):
        sim, markets = sim_windows(model, raw, follows, h, calib, ivc)
        markets_by_model[model] = markets
        result["A_physical"][model] = {c: q(sim[c]) for c in sim}
        result["A_physical"][model]["fraction_paths_ann_vol_gt_100pct"] = float((sim.ann_vol > 1.0).mean())
        result["A_physical"][model]["fraction_paths_ann_vol_gt_150pct"] = float((sim.ann_vol > 1.5).mean())
        print(model, "physical done", flush=True)
    result["A_physical"]["prepare_market_failures"] = FAILURES
    result["A_physical"]["real_fraction_windows_ann_vol_gt_100pct"] = float((real_all.ann_vol > 1.0).mean())
    result["B_vrp"] = {m: vrp_stats(mk) for m, mk in markets_by_model.items()}
    result["B_seller_edge"] = {m: [premium_edge(mk, ivc, o, s) for s in (-1, 1) for o in (.05, .10, .15, .20)]
                               for m, mk in markets_by_model.items()}
    print("edge done", flush=True)
    result["C_iv_events"] = {m: iv_event_study(mk) for m, mk in markets_by_model.items()}
    result["D_snapshot"] = snapshot_checks(ivc)
    result["E_real_breakeven_iv"] = [real_breakeven_iv(history, ivc, o, s, start=a, end=b)
                                     for (a, b) in (("2020-01-01", None), ("2020-01-01", "2025-01-01"), ("2025-01-01", None))
                                     for s in (-1, 1) for o in (.10, .15, .20)]
    result["G2_bootstrap_visit_bias"] = bootstrap_visit_bias(raw, follows)
    result["G8_real_book_ticks"] = snapshot_tick_spreads()
    (OUT / "generator-audit.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(json.dumps({"G2": result["G2_bootstrap_visit_bias"], "G8": result["G8_real_book_ticks"]}, indent=1))
    print(json.dumps(result, indent=1)[:200])


if __name__ == "__main__":
    main()
