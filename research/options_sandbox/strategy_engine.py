"""Hour-resolution RESEARCH VARIANT of the V1 inventory strategy.

No HTTP, keys, accounts or live orders. Synthetic listings and execution are
explicit assumptions. Black-Scholes Greeks are local frozen-IV sensitivities.
"""
import math
import numpy as np
from numba import njit

Q = .01
RATE = .0576
YEAR_HOURS = 8760.0


@njit(cache=True)
def cdf(z):
    return .5 * (1 + math.erf(z / math.sqrt(2)))


@njit(cache=True)
def bs(side, S, K, hours, iv):
    if hours <= 0:
        value = max(S - K, 0) if side == 1 else max(K - S, 0)
        delta = (1.0 if S > K else 0.0) if side == 1 else (-1.0 if S < K else 0.0)
        return value, delta
    T = hours / YEAR_HOURS
    root = iv * math.sqrt(T)
    d1 = (math.log(S / K) + (RATE + .5 * iv * iv) * T) / root
    d2 = d1 - root
    if side == 1:
        return max(S * cdf(d1) - K * math.exp(-RATE * T) * cdf(d2), 0), cdf(d1)
    return max(K * math.exp(-RATE * T) * cdf(-d2) - S * cdf(-d1), 0), cdf(d1) - 1


@njit(cache=True)
def surface_iv(S, K, hours, atm14, term, rho, eta):
    T = max(hours, 1e-6) / YEAR_HOURS
    theta = atm14 * atm14 * T * (max(hours, 1e-6) / 336.0) ** (2 * term)
    k = math.log(K / (S * math.exp(RATE * T)))
    phi = eta / math.sqrt(theta * (1 + theta))
    x = phi * k
    w = theta * .5 * (1 + rho * x + math.sqrt((x + rho) ** 2 + 1 - rho * rho))
    return math.sqrt(max(w / T, 1e-12))


@njit(cache=True)
def quote(side, S, K, hours, atm14, term, rho, eta, relative_spread):
    iv = surface_iv(S, K, hours, atm14, term, rho, eta)
    mark, delta = bs(side, S, K, hours, iv)
    bid = max(0.0, math.floor(mark * (1 - relative_spread / 2) / 5) * 5)
    ask = max(5.0, math.ceil(mark * (1 + relative_spread / 2) / 5) * 5)
    return mark, bid, ask, delta, iv


@njit(cache=True)
def fee(price, S):
    return Q * min(.00024 * S, .1 * price)


@njit(cache=True)
def margin_leg(side, S, K, mark, initial=False):
    otm = max(K - S, 0) if side == 1 else max(S - K, 0)
    rate = .15 if initial else .075
    floor = .10 if initial else .05
    reserve = 0.0 if initial else .0019 * S
    return Q * (max(floor * S, rate * S - otm) + mark + reserve)


@njit(cache=True)
def stress_pass(S, hours, strikes, expiries, atm, term, rho, eta, wallet):
    changes = np.array([-.5, -.3, -.2, -.1, 0, .1, .2, .5])
    for change in changes:
        Sp = S * (1 + change)
        for shift in (0.0, .2, .4):
            for future in (0, 24, 999999):
                mm = 0.0
                for leg in range(2):
                    if strikes[leg] <= 0:
                        continue
                    side = -1 if leg == 0 else 1
                    remaining = max(expiries[leg] - hours, 1.0 / 3600)
                    new_remaining = max(remaining - future, 1.0 / 3600)
                    iv = surface_iv(S, strikes[leg], remaining, atm, term, rho, eta)
                    base = bs(side, S, strikes[leg], remaining, iv)[0]
                    stressed = bs(side, Sp, strikes[leg], new_remaining, iv + shift)[0]
                    intrinsic = max(strikes[leg] - Sp, 0) if side == -1 else max(Sp - strikes[leg], 0)
                    stressed = max(intrinsic, stressed)
                    mm += margin_leg(side, Sp, strikes[leg], stressed)
                if wallet <= 0 or mm / wallet > .60:
                    return False
    return True


@njit(cache=True)
def eligible(side, S, K, remaining, atm, rv20, term, rho, eta, spread, target_dte, target_delta, iv_gate):
    mark, bid, ask, delta, iv = quote(side, S, K, remaining, atm, term, rho, eta, spread)
    otm = 1 - K / S if side == -1 else K / S - 1
    if not (240 <= remaining <= 480 and .10 <= otm <= .25 and .05 <= abs(delta) <= .15 and bid > 0):
        return False, bid, ask, mark, delta
    if (ask - bid) / ((ask + bid) * .5) > .20:
        return False, bid, ask, mark, delta
    if iv_gate > 0 and iv / rv20 < iv_gate:
        return False, bid, ask, mark, delta
    # Avoid 30-step IV inversion: monotonic BS price tests bidIV >= RV20.
    if bid < bs(side, S, K, remaining, rv20)[0]:
        return False, bid, ask, mark, delta
    credit = bid * Q - fee(bid, S) - fee(.4 * bid, S)
    if credit < 1.0:
        return False, bid, ask, mark, delta
    return True, bid, ask, mark, delta


@njit(cache=True)
def choose_contract(leg, S, i, weekday, hour, strikes, expiries, atm, rv20, term, rho, eta, spread, wallet, inventory, target_dte, target_delta, iv_gate):
    other = 1 - leg
    if leg == 1 and inventory + 1e-10 < Q:
        return 0.0, 0, 0.0
    if leg == 0 and inventory + Q > .0200000001:
        return 0.0, 0, 0.0
    nearest_friday = i + ((4 - weekday) % 7) * 24 + 8 - hour
    side = -1 if leg == 0 else 1
    bestK, bestE, bestBid = 0.0, 0, 0.0
    best_t, best_d, best_credit = 1e20, 1e20, -1e20
    for w in range(5):
        expiry = nearest_friday + w * 168
        if strikes[other] > 0 and expiry != expiries[other]:
            continue
        remaining = expiry - i
        if remaining < 240 or remaining > 480:
            continue
        # Assumed future listings: weekly expiries, $1000 strikes. Not reconstructed venue history.
        for kk in range(int(S * .74 / 1000), int(S * 1.26 / 1000) + 2):
            K = kk * 1000.0
            if K <= 0:
                continue
            ok, bid, ask, mark, delta = eligible(side, S, K, remaining, atm, rv20, term, rho, eta, spread, target_dte, target_delta, iv_gate)
            if not ok:
                continue
            if leg == 0 and wallet + Q * bid - fee(bid, S) < 200 + 1.10 * Q * K:
                continue
            dt = abs(remaining / 24 - target_dte)
            dd = abs(abs(delta) - target_delta)
            credit = Q * bid - fee(bid, S) - fee(.4 * bid, S)
            if dt < best_t or (dt == best_t and (dd < best_d or (dd == best_d and credit > best_credit))):
                bestK, bestE, bestBid = K, expiry, bid
                best_t, best_d, best_credit = dt, dd, credit
    return bestK, bestE, bestBid


@njit(cache=True)
def simulate_path(close, high, low, atm, rv20, spread, available, entry_random, exit_random, term, rho, eta, iv_scale=1.0, spread_scale=1.0, miss_probability=0.0, target_dte=14.0, target_delta=.10, iv_gate=1.20):
    """Synthetic market already realized by engine; trader reads only through i.

    Signal at hour i is submitted for earliest fill i+1; strike and limit fixed.
    Intrahour margin uses adverse H/L upper-bound, exits at end of hour.
    """
    warmup = 720
    wallet, inventory = 1000.0, .01
    initial_nav = wallet + inventory * close[warmup]
    top_nav = initial_nav
    strikes = np.zeros(2)
    expiries = np.zeros(2, dtype=np.int64)
    credit = np.zeros(2)
    pendingK = np.zeros(2)
    pendingE = np.zeros(2, dtype=np.int64)
    pendingBid = np.zeros(2)
    pendingAt = np.zeros(2, dtype=np.int64)
    armed = np.full(2, -100000, dtype=np.int64)
    cooldown = np.full(2, -100000, dtype=np.int64)
    queued_risk = np.zeros(2, dtype=np.int64)
    pause_until, shock_until, healthy = 0, 0, 0
    n_open, n_close, n_liquidations, n_failed_exit = 0, 0, 0, 0
    fees, option_pnl, gross_premium = 0.0, 0.0, 0.0
    buys, sells, skipped_cash, rejected_margin = 0, 0, 0, 0
    max_drawdown, max_mm = 0.0, 0.0
    nav = initial_nav
    daily = np.empty((len(close) - warmup + 23) // 24 + 1)
    daily_count = 1
    daily[0] = nav
    violations, reserve_breach_hours = 0, 0
    liquidation_pending = False
    for i in range(warmup + 1, len(close)):
        S = close[i]
        av = available[i]
        healthy = healthy + 1 if av else 0
        sig = atm[i] * iv_scale
        sp = spread[i] * spread_scale
        r24 = S / close[i - 24] - 1
        prev_r24 = close[i - 1] / close[i - 25] - 1
        r1 = S / close[i - 1] - 1
        mm, worst_mm, liability = 0.0, 0.0, 0.0
        for leg in range(2):
            if strikes[leg] <= 0:
                continue
            side = -1 if leg == 0 else 1
            mark, bid, ask, delta, iv = quote(side, S, strikes[leg], expiries[leg] - i, sig, term, rho, eta, sp)
            mm += margin_leg(side, S, strikes[leg], mark)
            liability += Q * ask + fee(ask, S)
        # Portfolio margin H/L bound: evaluate whole account at each same spot endpoint.
        for extreme in (high[i], low[i]):
            cur_mm = 0.0
            for leg in range(2):
                if strikes[leg] <= 0:
                    continue
                side = -1 if leg == 0 else 1
                mark = quote(side, extreme, strikes[leg], expiries[leg] - i, max(sig, atm[i - 1] * iv_scale), term, rho, eta, sp)[0]
                cur_mm += margin_leg(side, extreme, strikes[leg], mark)
            worst_mm = max(worst_mm, cur_mm)
        ratio = mm / wallet if wallet > 0 else (999.0 if mm > 0 else 0.0)
        intrabar_ratio = worst_mm / wallet if wallet > 0 else (999.0 if worst_mm > 0 else 0.0)
        max_mm = max(max_mm, ratio, intrabar_ratio)
        nav = wallet + inventory * S - liability
        top_nav = max(top_nav, nav)
        dd = max(0.0, 1 - nav / top_nav)
        max_drawdown = max(max_drawdown, dd)
        reserve_breach = strikes[0] > 0 and wallet < 200 + 1.1 * Q * strikes[0]
        if reserve_breach:
            reserve_breach_hours += 1
        global_exit = ratio >= .50 or dd >= .25 or wallet <= 0 or reserve_breach
        if dd >= .25 and pause_until == 0:
            pause_until = i + 720
        if pause_until > 0 and i >= pause_until and dd < .20 and healthy >= 2:
            pause_until = 0
        force = intrabar_ratio >= .95 and np.any(strikes > 0)
        if force:
            n_liquidations += 1
            liquidation_pending = True
            global_exit = True
        if global_exit or abs(r24) >= .10 or pause_until > 0:
            pendingK[:] = 0
            armed[:] = -100000
        if abs(r24) >= .10:
            shock_until = i + 24
        # First record both triggers, so simultaneous risks do not churn spot.
        reasons = np.zeros(2, dtype=np.int64)
        for leg in range(2):
            if strikes[leg] <= 0:
                continue
            side = -1 if leg == 0 else 1
            mark, bid, ask, delta, iv = quote(side, S, strikes[leg], expiries[leg] - i, sig, term, rho, eta, sp)
            if i >= expiries[leg]:
                reasons[leg] = 5
            elif global_exit or liquidation_pending:
                reasons[leg] = 4
            elif queued_risk[leg] > 0 or abs(delta) >= .35 or (leg == 0 and low[i] <= strikes[leg]) or (leg == 1 and high[i] >= strikes[leg]):
                reasons[leg] = 3
                queued_risk[leg] = 1
            elif expiries[leg] - i <= 72:
                reasons[leg] = 2
            elif credit[leg] - Q * ask - fee(ask, S) >= .60 * credit[leg]:
                reasons[leg] = 1
        both_risk = reasons[0] == 3 and reasons[1] == 3
        for leg in range(2):
            reason = reasons[leg]
            if reason == 0:
                continue
            side = -1 if leg == 0 else 1
            K = strikes[leg]
            is_settlement = reason == 5
            if not is_settlement and not force and (not av or exit_random[i, leg] < miss_probability):
                n_failed_exit += 1
                continue
            # Adverse fill convention for unobservable intrahour risk trigger ordering.
            fill_spot = S
            if reason == 3 or force:
                fill_spot = min(S, low[i]) if leg == 0 else max(S, high[i])
            if is_settlement:
                buyback_price = max(K - S, 0) if leg == 0 else max(S - K, 0)
                debit = Q * buyback_price + Q * min(.00015 * S, .1 * buyback_price)
                close_fee = debit - Q * buyback_price
            else:
                ask = quote(side, fill_spot, K, expiries[leg] - i, sig, term, rho, eta, sp * (2 if force else 1))[2]
                debit = Q * ask + fee(ask, fill_spot)
                close_fee = fee(ask, fill_spot)
                if force:
                    liquidation_fee = min(.0019 * fill_spot * Q, Q * ask * .25)
                    debit += liquidation_fee
                    close_fee += liquidation_fee
            wallet -= debit
            fees += close_fee
            option_pnl += credit[leg] - debit
            n_close += 1
            strikes[leg] = 0
            queued_risk[leg] = 0
            cooldown[leg] = i + 24
            remaining_liability = 0.0
            for other in range(2):
                if strikes[other] > 0:
                    sd = -1 if other == 0 else 1
                    other_ask = quote(sd, S, strikes[other], expiries[other] - i, sig, term, rho, eta, sp)[2]
                    remaining_liability += Q * other_ask + fee(other_ask, S)
            if 1 - (wallet + inventory * S - remaining_liability) / top_nav >= .25:
                if pause_until == 0:
                    pause_until = i + 720
            convert = (reason == 3 and not both_risk and not global_exit and pause_until == 0) or (is_settlement and buyback_price > 0 and not global_exit)
            if convert and leg == 0:
                purchase = Q * S * 1.001 * 1.001  # spot slippage + fee in USDT
                other_reserve = 1.1 * Q * strikes[0]
                if inventory + Q <= .0200000001 and wallet - purchase >= 200 + other_reserve and debit + purchase - credit[leg] <= 1.1 * Q * K:
                    wallet -= purchase
                    inventory += Q
                    fees += Q * S * 1.001 * .001
                    buys += 1
                else:
                    skipped_cash += 1
            elif convert and leg == 1 and inventory + 1e-10 >= Q:
                proceeds = Q * S * .999 * .999
                wallet += proceeds
                inventory -= Q
                fees += Q * S * .999 * .001
                sells += 1
        if not np.any(strikes > 0):
            liquidation_pending = False
        # Execute prior-hour pending entry, never a signal using its own future quote.
        if av and not global_exit and pause_until == 0 and i >= shock_until and ratio < .30 and wallet > 0:
            for leg in range(2):
                if pendingK[leg] <= 0 or pendingAt[leg] >= i:
                    continue
                K, ex = pendingK[leg], pendingE[leg]
                side = -1 if leg == 0 else 1
                ok, bid, ask, mark, delta = eligible(side, S, K, ex - i, sig, rv20[i], term, rho, eta, sp, target_dte, target_delta, iv_gate)
                pendingK[leg] = 0
                if not ok or strikes[leg] > 0 or entry_random[i, leg] < miss_probability or bid < pendingBid[leg]:
                    cooldown[leg] = i + 24
                    continue
                if (leg == 1 and inventory + 1e-10 < Q) or (leg == 0 and (inventory + Q > .0200000001 or wallet + Q * bid - fee(bid, S) < 200 + 1.1 * Q * K)):
                    skipped_cash += 1
                    continue
                if strikes[1 - leg] > 0 and ex != expiries[1 - leg]:
                    cooldown[leg] = i + 24
                    continue
                newwallet = wallet + Q * bid - fee(bid, S)
                trialK, trialE = strikes.copy(), expiries.copy()
                trialK[leg], trialE[leg] = K, ex
                if newwallet < 200 + 1.1 * Q * trialK[0]:
                    skipped_cash += 1
                    cooldown[leg] = i + 24
                    continue
                im, nm = 0.0, 0.0
                for l in range(2):
                    if trialK[l] > 0:
                        sd = -1 if l == 0 else 1
                        mk = quote(sd, S, trialK[l], trialE[l] - i, sig, term, rho, eta, sp)[0]
                        im += margin_leg(sd, S, trialK[l], mk, True)
                        nm += margin_leg(sd, S, trialK[l], mk)
                if im / newwallet > .35 or nm / newwallet > .20 or newwallet <= im or not stress_pass(S, i, trialK, trialE, sig, term, rho, eta, newwallet):
                    rejected_margin += 1
                    cooldown[leg] = i + 24
                    continue
                strikes[leg], expiries[leg] = K, ex
                wallet = newwallet
                credit[leg] = Q * bid - fee(bid, S)
                gross_premium += Q * bid
                fees += fee(bid, S)
                n_open += 1
        else:
            pendingK[:] = 0
        # New signals from current CLOSED hour; startup history is never replayed.
        if not global_exit and pause_until == 0 and i >= shock_until and av:
            elapsed = i - warmup
            weekday = (1 + elapsed // 24) % 7  # hypothetical simulation starts Tuesday UTC00
            hour = elapsed % 24
            for leg in range(2):
                if strikes[leg] > 0 or pendingK[leg] > 0 or i < cooldown[leg]:
                    continue
                if i - armed[leg] > 12:
                    armed[leg] = -100000
                direction = -1 if leg == 0 else 1
                if direction * r24 >= .03 and direction * prev_r24 < .03 and armed[leg] < 0:
                    armed[leg] = i
                if armed[leg] >= 0 and i > armed[leg] and direction * r24 >= .03 and direction * r1 <= -.0025:
                    K, ex, bid = choose_contract(leg, S, i, weekday, hour, strikes, expiries, sig, rv20[i], term, rho, eta, sp, wallet, inventory, target_dte, target_delta, iv_gate)
                    if K > 0:
                        pendingK[leg], pendingE[leg], pendingBid[leg], pendingAt[leg] = K, ex, bid, i
                        armed[leg] = -100000
        if inventory < -1e-9 or inventory + (Q if strikes[0] > 0 else 0) > .020000001 or (strikes[1] > 0 and inventory + 1e-9 < Q):
            violations += 1
        liability = 0.0
        for leg in range(2):
            if strikes[leg] > 0:
                sd = -1 if leg == 0 else 1
                terminal_ask = quote(sd, S, strikes[leg], expiries[leg] - i, sig, term, rho, eta, sp)[2]
                liability += Q * terminal_ask + fee(terminal_ask, S)
        nav = wallet + inventory * S - liability
        top_nav = max(top_nav, nav)
        max_drawdown = max(max_drawdown, 1 - nav / top_nav)
        if (i - warmup) % 24 == 0:
            daily[daily_count] = nav
            daily_count += 1
    benchmark = 1000 + .01 * close[-1]
    open_credit = 0.0
    for leg in range(2):
        if strikes[leg] > 0:
            open_credit += credit[leg]
    option_total_pnl = option_pnl + open_credit - liability
    inventory_rebalance_pnl = nav - benchmark - option_total_pnl
    result = np.array([nav, benchmark, (nav / initial_nav - 1), (nav - benchmark) / initial_nav, max_drawdown, max_mm, n_open, n_close, n_liquidations, n_failed_exit, fees, option_pnl, gross_premium, inventory, wallet, buys, sells, skipped_cash, rejected_margin, violations, liability, initial_nav, reserve_breach_hours, option_total_pnl, inventory_rebalance_pnl])
    return result, daily[:daily_count]
