"""Causal hourly SELL research engine for a standard USDT options account.

Q=.01 BTC per filled leg. Both means an atomic same-expiry Put+Call entry;
exits remain independent. No long wings, portfolio margin, spot or borrowing.
The paired entry is a coordinated execution approximation; real exchange
orders cannot be assumed to fill atomically. A one-tick limit concession is
fixed equally for all directions, with zero ticks available for sensitivity.
The notional cap is checked against post-fill liquidation-value NAV at entry;
IM/MM still use wallet-based Adjusted Equity. Gaps can breach the notional ratio
after entry, so the configured multiplier is not an ongoing leverage guarantee.

Old positions face high->low and low->high stress orders; the worse resulting
account is retained. This is a conservative two-order OHLC stress approximation,
not a rigorous pathwise bound or a tick-path replay.
At each extreme IV uses the PREVIOUS hour IV times (1+2*abs(log spot move)).
Only forced risk reduction executes intrahour. Ordinary exits use closing asks.
Next-hour-close fills occur AFTER that hour's risk: new orders cannot be exposed
retroactively to an earlier high/low. Expiry uses the hourly close proxy.
"""
import math
import sys
from pathlib import Path

import numpy as np
from numba import njit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from strategy_engine import quote, fee, margin_leg

Q = .01
NAMES = ["side", "dte", "delta", "wing", "tp", "sl", "dstop", "texit", "entry",
         "entry_param", "maxpos", "risk", "lever", "min_credit", "cooldown",
         "entry_hour", "ivgate", "slot_gap", "pm", "kstep", "limit_ticks"]
IDX = {name: i for i, name in enumerate(NAMES)}
OUT_NAMES = ["end_nav", "return", "max_drawdown", "trades", "wins", "fees", "premium",
             "liquidations", "worst_trade", "stopouts", "settled_itm", "hours_in_market",
             "min_nav", "skipped_size", "avg_contracts", "bankrupt", "end_liability", "min_margin_ratio"]
N_OUT = 18
# State: wallet, peakNAV, maxDD, minNAV, minAE/MM, fees, grossPremium,
# filledLegs, wins, liquidatedLegs, worstTrade, stopouts, itmSettlements,
# exposedHours, sizeRejects, bankrupt, cooldownUntil, lastFill.
W, PEAK, DD, MINNAV, MR, FEES, PREMIUM, FILLS, WINS, LIQ, WORST, STOPS, ITM, HOURS, REJECT, BANKRUPT, COOL, LAST = range(18)
# Position rows: sign(-1 Put,+1 Call), K, expiry(hour index), net entry credit.


def params(**kwargs):
    base = dict(side=0, dte=7., delta=.08, wing=0., tp=.9, sl=2., dstop=0., texit=0.,
                entry=0, entry_param=0., maxpos=4, risk=1., lever=3., min_credit=.5,
                cooldown=0., entry_hour=8, ivgate=0., slot_gap=0., pm=0., kstep=1000., limit_ticks=1)
    unknown = set(kwargs)-set(base)
    if unknown:
        raise KeyError(sorted(unknown))
    base.update(kwargs)
    p = np.asarray([base[k] for k in NAMES], dtype=np.float64)
    _validate_params(p)
    return p


def _validate_params(p):
    if p.shape != (len(NAMES),) or not np.isfinite(p).all():
        raise ValueError("finite parameter vector required")
    if p[0] not in (0, 1, 2) or not 1 <= p[1] <= 90:
        raise ValueError("side=0/1/2 and DTE in [1,90] required")
    if not 0 < abs(p[2]) < 1 or p[3] != 0 or p[18] != 0:
        raise ValueError("Delta/OTM in (0,1); wings and portfolio margin unsupported")
    if not 0 <= p[4] <= 1 or p[5] < 0 or not 0 <= p[6] <= 1 or p[7] < 0:
        raise ValueError("invalid exits")
    if p[8] not in (0, 1, 2, 3, 4) or p[9] < 0:
        raise ValueError("invalid entry rule")
    if p[10] != int(p[10]) or not 1 <= p[10] <= 8 or (p[0] == 2 and p[10] < 2):
        raise ValueError("maxpos counts actual legs (1..8); both requires >=2")
    if p[11] != 1:
        raise ValueError("risk sizing disabled: risk must remain1; each leg fixed .01BTC")
    if p[12] <= 0 or p[13] < 0 or p[14] < 0 or p[16] < 0 or p[17] < 0 or p[19] <= 0:
        raise ValueError("invalid sizing, gates or strike spacing")
    if p[15] != int(p[15]) or not -1 <= p[15] <= 23:
        raise ValueError("entry_hour=-1 or UTC0..23")
    if p[20] != int(p[20]) or p[20] < 0:
        raise ValueError("limit_ticks must be a nonnegative integer")


@njit(cache=True)
def _account(pos, S, clock, sig, sp, term, rho, eta):
    mm, im, liability, notional, count = 0., 0., 0., 0., 0
    for k in range(8):
        if pos[k, 1] > 0:
            sd, K, ex = pos[k, 0], pos[k, 1], pos[k, 2]
            q = quote(sd, S, K, max(ex-clock, 1e-6), sig, term, rho, eta, sp)
            mm += margin_leg(sd, S, K, q[0], False)
            im += margin_leg(sd, S, K, q[0], True)
            liability += Q*q[2]+fee(q[2], S)
            notional += Q*(K if sd < 0 else S)
            count += 1
    return mm, im, liability, notional, count


@njit(cache=True)
def _record(state, nav):
    state[PEAK] = max(state[PEAK], nav)
    state[DD] = max(state[DD], 1-nav/state[PEAK])
    state[MINNAV] = min(state[MINNAV], nav)
    if nav <= 0:
        state[BANKRUPT] = 1


@njit(cache=True)
def _entry_budget(wallet, liability, im, notional, added_credit, added_liability,
                  added_im, added_notional, lever):
    """Risk notional uses NAV; exchange IM uses post-fill wallet AE."""
    post_wallet = wallet+added_credit
    post_nav = post_wallet-liability-added_liability
    return (post_nav > 0. and notional+added_notional <= lever*post_nav
            and im+added_im <= .8*post_wallet)


@njit(cache=True)
def _force(state, pos, S, clock, sig, sp, term, rho, eta):
    """Fresh AE/MM each pass; only cash belongs to AE for this short-only book."""
    for step in range(8):
        mm, im, liability, notional, count = _account(pos, S, clock, sig, sp, term, rho, eta)
        if count == 0:
            break
        if mm > 0:
            state[MR] = min(state[MR], state[W]/mm)
        if state[W] > 0 and mm < .95*state[W]:
            break
        # Partial liquidation proxy: highest margin burden first, then recheck.
        selected, burden = -1, -1.
        for k in range(8):
            if pos[k, 1] > 0:
                q = quote(pos[k, 0], S, pos[k, 1], max(pos[k, 2]-clock, 1e-6),
                          sig, term, rho, eta, sp)
                m = margin_leg(pos[k, 0], S, pos[k, 1], q[0], False)
                if m > burden:
                    selected, burden = k, m
        k = selected
        q = quote(pos[k, 0], S, pos[k, 1], max(pos[k, 2]-clock, 1e-6), sig,
                  term, rho, eta, min(2*sp+.05, .95))
        charges = fee(q[2], S)+min(.0019*S*Q, .25*Q*q[2])
        debit = Q*q[2]+charges
        pnl = pos[k, 3]-debit
        state[W] -= debit
        state[FEES] += charges
        state[WORST] = min(state[WORST], pnl)
        state[WINS] += pnl > 0
        state[LIQ] += 1
        state[COOL] = max(state[COOL], clock+168.)
        pos[k, 1] = 0.
    mm, im, liability, notional, count = _account(pos, S, clock, sig, sp, term, rho, eta)
    _record(state, state[W]-liability)


@njit(cache=True)
def _extremes(state, pos, first, second, previousS, previousIV, previousSpread,
              clock, term, rho, eta):
    for endpoint in (first, second):
        shock = abs(math.log(endpoint/previousS))
        sig = previousIV*(1+2*shock)
        sp = min(.95, previousSpread*(1+5*shock)+.1*shock)
        _force(state, pos, endpoint, clock, sig, sp, term, rho, eta)


@njit(cache=True)
def _expiry(i, dte, warmup, start_weekday, start_hour):
    elapsed = i-warmup+start_hour
    weekday, hour = (start_weekday+elapsed//24) % 7, elapsed % 24
    nearest = i+((4-weekday) % 7)*24+8-hour
    best, distance = -1., 1e30
    for w in range(-1, 15):
        ex = nearest+w*168
        if ex-(i+1) < 24:
            continue
        gap = abs(ex-(i+1)-dte*24)
        if gap < distance:
            best, distance = ex, gap
    return best


@njit(cache=True)
def _strike(sd, S, remaining, sig, sp, term, rho, eta, target, kstep):
    if S/kstep > 9e15:
        raise ValueError("Strike grid exceeds floating-point precision; retain numerical failure")
    if target < 0:
        K = round(S*(1+target if sd < 0 else 1-target)/kstep)*kstep
        if K <= 0 or (sd < 0 and K >= S) or (sd > 0 and K <= S):
            return 0.
        return K
    lower = max(1, int(.4*S/kstep))
    upper = int(1.8*S/kstep)+1
    if sd < 0:
        upper = min(upper, int(math.ceil(S/kstep))-1)
    else:
        lower = max(lower, int(math.floor(S/kstep))+1)
    if lower > upper:
        return 0.
    # Frozen-IV Black-Scholes delta is monotone in strike for the constrained
    # SSVI families used here. Binary search avoids an O(spot/kstep) scan on
    # uncapped jump paths. Tests compare with exhaustive grids in both tails.
    left, right = lower, upper
    while left <= right:
        mid = (left+right)//2
        d = abs(quote(sd, S, mid*kstep, remaining, sig, term, rho, eta, sp)[3])
        if (sd < 0 and d < target) or (sd > 0 and d > target):
            left = mid+1
        else:
            right = mid-1
    best, difference = 0., 1e30
    for j in range(7):
        kk = lower if j == 0 else upper if j == 1 else left+j-4
        if kk < lower or kk > upper:
            continue
        K = kk*kstep
        d = abs(quote(sd, S, K, remaining, sig, term, rho, eta, sp)[3])
        if abs(d-target) < difference or (abs(d-target) == difference and K < best):
            best, difference = K, abs(d-target)
    return best


@njit(cache=True)
def _kernel(P, close, high, low, atm, rv20, spread, available, entry_random,
            exit_random, term, rho, eta, spread_scale, miss_probability, iv_scale,
            equity0, warmup, start_weekday, start_hour):
    state = np.zeros(18)
    state[W] = state[PEAK] = state[MINNAV] = equity0
    state[MR], state[COOL], state[LAST] = 1e9, -1., -1e12
    pos = np.zeros((8, 4))
    pending = np.zeros((2, 4))  # sign,K,expiry,fixed previous-close limit
    daily = np.empty((len(close)-warmup)//24+2)
    daily[0], daily_count = equity0, 1
    for i in range(warmup+1, len(close)):
        S, sig = close[i], atm[i]*iv_scale
        sp = min(.95, spread[i]*spread_scale)
        old_count = 0
        for k in range(8):
            old_count += pos[k, 1] > 0
        if old_count:
            state[HOURS] += 1
            # Keep poorer realized liquidation-value branch; no ordinary exits
            # at unknown high/low ordering, and no new fills before this point.
            a, b = state.copy(), state.copy()
            pa, pb = pos.copy(), pos.copy()
            previousIV = atm[i-1]*iv_scale
            previousSpread = min(.95, spread[i-1]*spread_scale)
            _extremes(a, pa, high[i], low[i], close[i-1], previousIV, previousSpread,
                      i, term, rho, eta)
            _extremes(b, pb, low[i], high[i], close[i-1], previousIV, previousSpread,
                      i, term, rho, eta)
            va = a[W]-_account(pa, S, i, sig, sp, term, rho, eta)[2]
            vb = b[W]-_account(pb, S, i, sig, sp, term, rho, eta)[2]
            if vb < va or (vb == va and b[DD] > a[DD]):
                state, pos = b, pb
            else:
                state, pos = a, pa
            _force(state, pos, S, i, sig, sp, term, rho, eta)
        # Settlement and ordinary exits, AFTER risk. No quote means no exit.
        for k in range(8):
            if pos[k, 1] <= 0:
                continue
            sd, K, ex, credit = pos[k]
            if ex <= i:
                intrinsic = max(K-S, 0.) if sd < 0 else max(S-K, 0.)
                charges = Q*min(.00015*S, .1*intrinsic)
                debit, reason = Q*intrinsic+charges, 4
                state[ITM] += intrinsic > 0
            else:
                q = quote(sd, S, K, ex-i, sig, term, rho, eta, sp)
                charges = fee(q[2], S)
                debit, reason = Q*q[2]+charges, 0
                if P[4] < 1 and debit <= (1-P[4])*credit:
                    reason = 1
                elif P[5] > 0 and debit >= P[5]*credit:
                    reason = 2
                elif P[6] > 0 and abs(q[3]) >= P[6]:
                    reason = 2
                elif P[7] > 0 and ex-i <= P[7]:
                    reason = 3
                channel = 0 if sd < 0 else 1
                if not available[i] or miss_probability >= 1 or exit_random[i, channel] < miss_probability:
                    reason = 0
            if reason:
                pnl = credit-debit
                state[W] -= debit
                state[FEES] += charges
                state[WINS] += pnl > 0
                state[WORST] = min(state[WORST], pnl)
                state[STOPS] += reason == 2
                if pnl < 0:
                    state[COOL] = max(state[COOL], i+P[14])
                pos[k, 1] = 0.
        # Recompute after closes: no stale maintenance or initial margin.
        mm, im, liability, notional, count = _account(pos, S, i, sig, sp, term, rho, eta)
        wanted = int(pending[0, 1] > 0)+int(pending[1, 1] > 0)
        if wanted and state[BANKRUPT] == 0:
            ok = available[i] and count+wanted <= P[10] and i >= state[COOL]
            addedIM, addedNotional, addedCredit, addedLiability = 0., 0., 0., 0.
            for j in range(2):
                if pending[j, 1] <= 0:
                    continue
                sd, K, ex, limit = pending[j]
                q = quote(sd, S, K, ex-i, sig, term, rho, eta, sp)
                credit = Q*q[1]-fee(q[1], S)
                if q[1] < limit or credit < P[13] or miss_probability >= 1 or entry_random[i, j] < miss_probability or ex-i < 24:
                    ok = False
                addedIM += margin_leg(sd, S, K, q[0], True)
                addedNotional += Q*(K if sd < 0 else S)
                addedCredit += credit
                addedLiability += Q*q[2]+fee(q[2], S)
            if not _entry_budget(state[W], liability, im, notional, addedCredit,
                                 addedLiability, addedIM, addedNotional, P[12]):
                ok = False
                state[REJECT] += wanted
            if ok:
                for j in range(2):
                    if pending[j, 1] <= 0:
                        continue
                    sd, K, ex, limit = pending[j]
                    q = quote(sd, S, K, ex-i, sig, term, rho, eta, sp)
                    charges = fee(q[1], S)
                    credit = Q*q[1]-charges
                    for k in range(8):
                        if pos[k, 1] <= 0:
                            pos[k] = np.array([sd, K, ex, credit])
                            break
                    state[W] += credit
                    state[FEES] += charges
                    state[PREMIUM] += Q*q[1]
                    state[FILLS] += 1
                state[LAST] = i
                _force(state, pos, S, i, sig, sp, term, rho, eta)
        pending[:, :] = 0.
        mm, im, liability, notional, count = _account(pos, S, i, sig, sp, term, rho, eta)
        _record(state, state[W]-liability)
        if (i-warmup) % 24 == 0:
            daily[daily_count] = state[W]-liability
            daily_count += 1
        # Closed-hour signal freezes actual contract and limit for next close.
        hour_next = (start_hour+i+1-warmup) % 24
        r24 = S/close[i-24]-1
        signal = available[i] and (P[15] < 0 or hour_next == P[15]) and i+1 >= state[COOL] and i+1-state[LAST] >= P[17]
        if P[8] == 1: signal = signal and r24 <= -P[9]
        if P[8] == 2: signal = signal and sig/rv20[i] >= P[9]
        if P[8] == 3: signal = signal and r24 >= P[9]
        if P[8] == 4:
            if P[0] == 0: signal = signal and r24 <= -P[9]
            elif P[0] == 1: signal = signal and r24 >= P[9]
            else: signal = signal and abs(r24) >= P[9]
        if P[16] > 0: signal = signal and sig/rv20[i] >= P[16]
        needed = 2 if P[0] == 2 else 1
        if signal and state[BANKRUPT] == 0 and count+needed <= P[10] and i < len(close)-1:
            ex = _expiry(i, P[1], warmup, start_weekday, start_hour)
            valid = ex > i+1
            for j in range(2):
                if (P[0] == 0 and j == 1) or (P[0] == 1 and j == 0):
                    continue
                sd = -1 if j == 0 else 1
                K = _strike(sd, S, ex-i, sig, sp, term, rho, eta, P[2], P[19])
                if K <= 0:
                    valid = False
                    continue
                q = quote(sd, S, K, ex-i, sig, term, rho, eta, sp)
                if Q*q[1]-fee(q[1], S) < P[13]:
                    valid = False
                pending[j] = np.array([sd, K, ex, max(5., q[1]-5.*P[20])])
            if not valid:
                pending[:, :] = 0.
    S = close[-1]
    liability = _account(pos, S, len(close)-1, atm[-1]*iv_scale,
                         min(.95, spread[-1]*spread_scale), term, rho, eta)[2]
    nav = state[W]-liability
    out = np.array([nav, nav/equity0-1, state[DD], state[FILLS], state[WINS], state[FEES],
        state[PREMIUM], state[LIQ], state[WORST], state[STOPS], state[ITM], state[HOURS],
        state[MINNAV], state[REJECT], 1. if state[FILLS] else 0., state[BANKRUPT], liability, state[MR]])
    return out, daily[:daily_count]


def run(P, close, high, low, atm, rv20, spread, available, entry_random, exit_random,
        term, rho, eta, spread_scale=1., miss_probability=0., iv_scale=1.,
        equity0=1000., warmup=720, start_weekday=1, start_hour=0):
    """Return (18 frozen-compatible metrics, daily liquidation-value NAV).

    Inputs include warmup+initial point. Random arrays shape [hours,2], columns
    Put/Call; a minimum-size lot fills entirely or not at all. The miss knob is
    a stress assumption. Forced liquidation uses a conservative price proxy,
    independent of user-order quote availability; it is not a guaranteed fill.
    """
    P = np.asarray(P, dtype=np.float64)
    _validate_params(P)
    n = len(close)
    if n <= warmup+1 or warmup < 24 or any(len(x) != n for x in (high, low, atm, rv20, spread, available, entry_random, exit_random)):
        raise ValueError("equal-length market arrays with >=24h warmup required")
    if np.shape(entry_random) != (n, 2) or np.shape(exit_random) != (n, 2):
        raise ValueError("random arrays must have shape [hours,2]")
    if not np.isfinite([miss_probability, spread_scale, iv_scale, equity0, term, rho, eta]).all():
        raise ValueError("finite execution, surface and account settings required")
    if not 0 <= miss_probability <= 1 or spread_scale <= 0 or iv_scale <= 0 or equity0 <= 0:
        raise ValueError("invalid execution or account settings")
    for x in (close, high, low, atm):
        if not np.isfinite(x).all() or np.any(np.asarray(x) <= 0):
            raise ValueError("positive finite prices/IV required")
    if np.any(np.asarray(high) < np.asarray(low)):
        raise ValueError("high must be >=low")
    if np.any(np.asarray(high) < np.asarray(close)) or np.any(np.asarray(low) > np.asarray(close)):
        raise ValueError("OHLC endpoints must contain closing price")
    for x in (entry_random, exit_random):
        if not np.isfinite(x).all() or np.any(np.asarray(x) < 0) or np.any(np.asarray(x) > 1):
            raise ValueError("finite execution uniforms in [0,1] required")
    if not np.isfinite(spread).all() or np.any(np.asarray(spread) < 0):
        raise ValueError("finite nonnegative spreads required")
    if not np.isfinite(np.asarray(rv20)[warmup:]).all() or np.any(np.asarray(rv20)[warmup:] <= 0):
        raise ValueError("positive finite active-period RV required")
    if start_weekday not in range(7) or start_hour not in range(24):
        raise ValueError("invalid UTC starting calendar")
    return _kernel(P, close, high, low, atm, rv20, spread, available, entry_random,
                   exit_random, term, rho, eta, spread_scale, miss_probability,
                   iv_scale, equity0, warmup, start_weekday, start_hour)
