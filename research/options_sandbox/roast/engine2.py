"""Parametrized hourly option-selling engine for the strategy search. Offline research only.

Reuses the sandbox's own quote()/fee()/margin_leg() so pricing, ticks and fees are identical
to strategy_engine.py. One USDT options account; every position is a single-side vertical
spread or a naked short (put or call). Causal: decisions at the close of hour i execute at
the quotes of hour i+1 (entries) or hour i (exits, as in V1). Liquidation value NAV:
cash + long legs at bid - short legs at ask (incl. fees).

Parameter vector P (float64) - see NAMES.
"""
import math

import numpy as np
from numba import njit

import common  # noqa: F401  (puts the sandbox on sys.path)
from strategy_engine import quote, fee, margin_leg, bs

Q = .01
NAMES = ["side", "dte", "delta", "wing", "tp", "sl", "dstop", "texit", "entry", "entry_param", "maxpos",
         "risk", "lever", "min_credit", "cooldown", "entry_hour", "ivgate", "slot_gap", "pm", "kstep"]
IDX = {n: i for i, n in enumerate(NAMES)}
# side: 0 put, 1 call, 2 both sides (two independent single-side trades, same expiry)
# dte: target days; delta: short |delta| target (<0 => OTM fraction); wing: long |delta| (0 naked, <0 => width as fraction of S)
# tp: close when cost <= (1-tp)*credit (>=1 off); sl: close when cost >= sl*credit (0 off)
# dstop: close when short |delta| >= dstop (0 off); texit: close when hours to expiry <= texit (0 = hold to settlement)
# entry: 0 schedule, 1 dip (r24 <= -p), 2 iv/rv20 >= p, 3 rally (r24 >= p) ; entry_param: p
# maxpos: concurrent trades; risk: max-loss budget per trade as fraction of equity (naked put: strike notional)
# lever: total naked notional cap (x equity); min_credit: USDT per 0.01 contract; cooldown: h after a loss exit
# entry_hour: UTC hour for scheduled entries (-1 any); ivgate: extra atm/rv20 floor (0 off); slot_gap: min hours between entries
# pm: 0 = Binance STANDARD account (no spread margin offset: size every short leg cash-secured on its strike,
#     liquidate when equity < sum of naked maintenance margins); 1 = portfolio margin (spread risk = max loss)
# kstep: listed strike spacing in USDT (1000 = every $1k; real Binance non-monthly weeklies near 5-15% OTM were 2k-4k apart)
# run(..., start_weekday, start_hour): calendar of the first traded hour (Mon=0). Default Tue 00:00 like the sandbox;
#     the historical replay passes the REAL weekday/hour so expiries land on real Fridays 08:00 UTC.
N_OUT = 18
OUT_NAMES = ["end_nav", "return", "max_drawdown", "trades", "wins", "fees", "premium", "liquidations", "worst_trade",
             "stopouts", "settled_itm", "hours_in_market", "min_nav", "skipped_size", "avg_contracts", "bankrupt", "end_liability", "min_margin_ratio"]


@njit(cache=True)
def _strike_for_delta(side, S, hours, atm, term, rho, eta, sp, target, otm_mode, kstep):
    """Short strike on a kstep grid: |delta| closest to target among OTM strikes (or fixed OTM %)."""
    if otm_mode:
        k = S * (1 - target) if side < 0 else S * (1 + target)
        return max(kstep, round(k / kstep) * kstep)
    best, bestd = 0.0, 1e9
    lo = max(1, int(S * .40 / kstep))  # strikes are positive (a deep crash with a coarse grid can push this to 0)
    hi = int(S * 1.80 / kstep) + 1
    for kk in range(lo, hi):
        K = kk * kstep
        if (side < 0 and K >= S) or (side > 0 and K <= S):
            continue
        d = abs(quote(side, S, K, hours, atm, term, rho, eta, sp)[3])
        if abs(d - target) < bestd:
            bestd, best = abs(d - target), K
    return best


@njit(cache=True)
def run(P, close, high, low, atm, rv20, spread, available, term, rho, eta, equity0=1000.0, warmup=720, start_weekday=1, start_hour=0):
    side_mode = int(P[0]); dte = P[1]; dtarget = P[2]; wing = P[3]; tp = P[4]; sl = P[5]; dstop = P[6]
    texit = P[7]; entry = int(P[8]); eparam = P[9]; maxpos = int(P[10]); risk = P[11]; lever = P[12]
    min_credit = P[13]; cooldown_h = P[14]; entry_hour = int(P[15]); ivgate = P[16]; slot_gap = P[17]; pm = P[18] > .5; kstep = P[19]
    MAXT = 8
    t_side = np.zeros(MAXT, np.int64); t_ks = np.zeros(MAXT); t_kl = np.zeros(MAXT); t_exp = np.zeros(MAXT, np.int64)
    t_n = np.zeros(MAXT); t_credit = np.zeros(MAXT); t_open = np.zeros(MAXT, np.bool_)
    cash = equity0
    top = equity0
    maxdd = 0.0
    out = np.zeros(N_OUT)
    trades = 0; wins = 0; fees = 0.0; prem = 0.0; liq = 0; worst = 0.0; stops = 0; itm = 0; inmkt = 0
    minnav = equity0; skipped = 0; contracts = 0.0; bankrupt = 0; min_mr = 1e9
    cool_until = -1; last_entry = -(10 ** 12)
    pending = False
    n = len(close)
    for i in range(warmup + 1, n):
        S = close[i]
        sp = spread[i]
        sig = atm[i]
        av = available[i]
        # ---------- execute pending entries decided at i-1 (fills at hour i quotes) ----------
        if pending and av and bankrupt == 0:
            pending = False
            elapsed = i - warmup
            weekday = (start_weekday + (start_hour + elapsed) // 24) % 7
            hour = (start_hour + elapsed) % 24
            # expiry: Friday 08:00 UTC with remaining hours closest to target (>= 24h)
            nearest = i + ((4 - weekday) % 7) * 24 + 8 - hour
            best_e, best_gap = -1, 1e18
            for w in range(-1, 14):
                e = nearest + w * 168
                rem = e - i
                if rem < 24:
                    continue
                gap = abs(rem - dte * 24.0)
                if gap < best_gap:
                    best_gap, best_e = gap, e
            s_first = 1 if side_mode == 1 else 0
            s_last = 0 if side_mode == 0 else 1
            # equity at liquidation value
            nav_now = cash
            naked_notional = 0.0
            mm_now = 0.0
            for k in range(MAXT):
                if t_open[k]:
                    sd = -1 if t_side[k] == 0 else 1
                    rem = t_exp[k] - i
                    a = quote(sd, S, t_ks[k], rem, sig, term, rho, eta, sp)
                    nav_now -= t_n[k] * (Q * a[2] + fee(a[2], S))
                    mm_now += t_n[k] * margin_leg(sd, S, t_ks[k], a[0], False)
                    if t_kl[k] > 0:
                        b = quote(sd, S, t_kl[k], rem, sig, term, rho, eta, sp)
                        nav_now += t_n[k] * max(Q * b[1] - fee(b[1], S), 0.0)
                    if t_kl[k] <= 0 or not pm:
                        naked_notional += t_n[k] * Q * (t_ks[k] if sd < 0 else S)
            for s_ in range(s_first, s_last + 1):
                nopen = 0
                for k in range(MAXT):
                    nopen += t_open[k]
                if nopen >= min(maxpos, MAXT) or best_e < 0:
                    break
                sd = -1 if s_ == 0 else 1
                rem = best_e - i
                otm_mode = dtarget < 0
                Ks = _strike_for_delta(sd, S, rem, sig, term, rho, eta, sp, abs(dtarget), otm_mode, kstep)
                if Ks <= 0:
                    continue
                qs = quote(sd, S, Ks, rem, sig, term, rho, eta, sp)
                bid_s = qs[1]
                Kl = 0.0
                ask_l = 0.0
                if wing != 0:
                    if wing < 0:
                        Kl = Ks * (1 + wing) if sd < 0 else Ks * (1 - wing)
                        Kl = round(Kl / kstep) * kstep
                    else:
                        # wing by delta, strictly further OTM than the short strike
                        bestd = 1e9
                        kk = Ks
                        for step in range(1, 60):
                            K2 = Ks - kstep * step if sd < 0 else Ks + kstep * step
                            if K2 <= 0:
                                break
                            d2 = abs(quote(sd, S, K2, rem, sig, term, rho, eta, sp)[3])
                            if abs(d2 - wing) < bestd:
                                bestd, kk = abs(d2 - wing), K2
                        Kl = kk
                    if (sd < 0 and Kl >= Ks) or (sd > 0 and Kl <= Ks) or Kl <= 0:
                        continue
                    ask_l = quote(sd, S, Kl, rem, sig, term, rho, eta, sp)[2]
                fee_in = fee(bid_s, S) + (fee(ask_l, S) if Kl > 0 else 0.0)
                credit1 = Q * (bid_s - ask_l) - fee_in  # per 0.01 contract
                if credit1 < min_credit or bid_s <= 0:
                    continue
                if Kl > 0:
                    maxloss1 = Q * abs(Ks - Kl) - credit1
                    notional1 = 0.0 if pm else Q * (Ks if sd < 0 else S)
                else:
                    maxloss1 = Q * Ks - credit1 if sd < 0 else Q * 3.0 * S  # naked call: 3x spot stress as "max"
                    notional1 = Q * (Ks if sd < 0 else S)
                if maxloss1 <= 0:
                    continue
                ncon = math.floor(risk * nav_now / maxloss1 + 1e-9)
                if notional1 > 0:
                    ncon = min(ncon, math.floor((lever * nav_now - naked_notional) / notional1 + 1e-9))
                # Binance standard account: every short leg needs its own margin; keep IM <= 80% of equity
                im1 = margin_leg(sd, S, Ks, qs[0], True)
                ncon = min(ncon, math.floor((.8 * nav_now - mm_now) / im1 + 1e-9))
                if ncon < 1:
                    skipped += 1
                    continue
                for k in range(MAXT):
                    if not t_open[k]:
                        t_open[k] = True
                        t_side[k] = s_; t_ks[k] = Ks; t_kl[k] = Kl; t_exp[k] = best_e; t_n[k] = ncon
                        t_credit[k] = ncon * credit1
                        cash += ncon * credit1
                        fees += ncon * fee_in
                        prem += ncon * Q * bid_s
                        trades += 1
                        contracts += ncon
                        naked_notional += ncon * notional1
                        mm_now += ncon * margin_leg(sd, S, Ks, qs[0], False)
                        last_entry = i
                        break
        elif pending:
            pending = False
        # ---------- mark positions, exits, settlement ----------
        open_liab = 0.0  # liquidation-value cost to close still-open trades (ask/bid + fees)
        mark_adj = 0.0   # mark-price value of still-open trades (Binance margin balance)
        mm_tot = 0.0
        anyopen = False
        for k in range(MAXT):
            if not t_open[k]:
                continue
            anyopen = True
            sd = -1 if t_side[k] == 0 else 1
            rem = t_exp[k] - i
            Ks, Kl, nk = t_ks[k], t_kl[k], t_n[k]
            if rem <= 0:
                # cash settlement at hourly close (proxy for the 30-min average index)
                ins = max(Ks - S, 0.0) if sd < 0 else max(S - Ks, 0.0)
                inl = 0.0
                if Kl > 0:
                    inl = max(Kl - S, 0.0) if sd < 0 else max(S - Kl, 0.0)
                ex_fee = nk * Q * (min(.00015 * S, .1 * ins) + (min(.00015 * S, .1 * inl) if inl > 0 else 0.0))
                debit = nk * Q * (ins - inl) + ex_fee
                cash -= debit
                fees += ex_fee
                pnl = t_credit[k] - debit
                if ins > 0:
                    itm += 1
                if pnl > 0:
                    wins += 1
                worst = min(worst, pnl)
                t_open[k] = False
                continue
            a = quote(sd, S, Ks, rem, sig, term, rho, eta, sp)
            cost = nk * (Q * a[2] + fee(a[2], S))
            longval = 0.0
            if Kl > 0:
                b = quote(sd, S, Kl, rem, sig, term, rho, eta, sp)
                longval = nk * max(Q * b[1] - fee(b[1], S), 0.0)
            close_cost = cost - longval
            # Binance margin balance uses MARK prices (not the ask/bid you would trade at)
            mark_long = quote(sd, S, Kl, rem, sig, term, rho, eta, sp)[0] if Kl > 0 else 0.0
            eq_adj = nk * Q * (mark_long - a[0])
            if pm and Kl > 0:
                mm_tot += min(nk * margin_leg(sd, S, Ks, a[0], False), nk * Q * abs(Ks - Kl))
            else:
                mm_tot += nk * margin_leg(sd, S, Ks, a[0], False)
            reason = 0
            if tp < 1 and close_cost <= (1 - tp) * t_credit[k]:
                reason = 1
            elif sl > 0 and close_cost >= sl * t_credit[k]:
                reason = 2
            elif dstop > 0 and abs(a[3]) >= dstop:
                reason = 2
            elif texit > 0 and rem <= texit:
                reason = 3
            if reason > 0 and av:
                cash -= close_cost
                fees += nk * fee(a[2], S) + (nk * fee(quote(sd, S, Kl, rem, sig, term, rho, eta, sp)[1], S) if Kl > 0 else 0.0)
                pnl = t_credit[k] - close_cost
                if pnl > 0:
                    wins += 1
                worst = min(worst, pnl)
                if reason == 2:
                    stops += 1
                    cool_until = i + int(cooldown_h)
                elif pnl < 0:
                    cool_until = i + int(cooldown_h)
                t_open[k] = False
                continue
            open_liab += close_cost
            mark_adj += eq_adj
        nav = cash - open_liab
        nav_mark = cash + mark_adj
        if anyopen:
            inmkt += 1
        # ---------- liquidation (Binance standard account: mark-price equity < maintenance margin) ----------
        if mm_tot > 0:
            min_mr = min(min_mr, nav_mark / mm_tot)
        if mm_tot > 0 and nav_mark < mm_tot:
            for k in range(MAXT):
                if t_open[k]:
                    sd = -1 if t_side[k] == 0 else 1
                    rem = t_exp[k] - i
                    a = quote(sd, S, t_ks[k], rem, sig, term, rho, eta, min(2 * sp + .05, .6))
                    debit = t_n[k] * (Q * a[2] + fee(a[2], S) + min(.0019 * S * Q, Q * a[2] * .25))
                    if t_kl[k] > 0:
                        b = quote(sd, S, t_kl[k], rem, sig, term, rho, eta, min(2 * sp + .05, .6))
                        debit -= t_n[k] * max(Q * b[1] - fee(b[1], S), 0.0)
                    cash -= debit
                    worst = min(worst, t_credit[k] - debit)
                    t_open[k] = False
            liq += 1
            nav = cash
            cool_until = i + 24 * 7
        if nav <= 0 and bankrupt == 0:
            bankrupt = 1
        top = max(top, nav)
        maxdd = max(maxdd, 1 - nav / top if top > 0 else 0)
        minnav = min(minnav, nav)
        # ---------- entry decision at the close of hour i (executes at i+1) ----------
        if bankrupt == 0 and i < n - 1 and i >= cool_until and i - last_entry >= slot_gap:
            elapsed = i + 1 - warmup
            hour_next = (start_hour + elapsed) % 24
            ok = True
            if entry_hour >= 0 and hour_next != entry_hour:
                ok = False
            r24 = S / close[i - 24] - 1
            if ok and entry == 1 and not (r24 <= -eparam):
                ok = False
            if ok and entry == 2 and not (sig / rv20[i] >= eparam):
                ok = False
            if ok and entry == 3 and not (r24 >= eparam):
                ok = False
            if ok and ivgate > 0 and sig / rv20[i] < ivgate:
                ok = False
            if ok:
                nopen = 0
                for k in range(MAXT):
                    nopen += t_open[k]
                if nopen < min(maxpos, MAXT):
                    pending = True
    # terminal liquidation value
    nav = cash
    cash_end = cash
    S = close[n - 1]
    for k in range(MAXT):
        if t_open[k]:
            sd = -1 if t_side[k] == 0 else 1
            rem = max(t_exp[k] - (n - 1), 0)
            a = quote(sd, S, t_ks[k], rem, atm[n - 1], term, rho, eta, spread[n - 1])
            nav -= t_n[k] * (Q * a[2] + fee(a[2], S))
            if t_kl[k] > 0:
                b = quote(sd, S, t_kl[k], rem, atm[n - 1], term, rho, eta, spread[n - 1])
                nav += t_n[k] * max(Q * b[1] - fee(b[1], S), 0.0)
    out[0] = nav; out[1] = nav / equity0 - 1; out[2] = maxdd; out[3] = trades; out[4] = wins; out[5] = fees
    out[6] = prem; out[7] = liq; out[8] = worst; out[9] = stops; out[10] = itm; out[11] = inmkt; out[12] = minnav
    out[13] = skipped; out[14] = contracts / trades if trades > 0 else 0.0; out[15] = bankrupt; out[16] = cash_end - nav; out[17] = min_mr
    return out


def params(**kw):
    base = {"side": 0, "dte": 14, "delta": .10, "wing": 0, "tp": 1.0, "sl": 0, "dstop": 0, "texit": 0, "entry": 0,
            "entry_param": 0, "maxpos": 1, "risk": 1.0, "lever": 1.0, "min_credit": .5, "cooldown": 0, "entry_hour": 8,
            "ivgate": 0, "slot_gap": 0, "pm": 0, "kstep": 1000}
    for k in kw:
        if k not in base:
            raise KeyError(k)
    base.update(kw)
    return np.array([float(base[n]) for n in NAMES])
