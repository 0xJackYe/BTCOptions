"""Regression checks against economic/accounting and execution failure cases."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine as e

TERM, RHO, ETA = .0576, -.245, 1.


def market(days=12, S=80000., iv=.5):
    n = 721+24*days
    c = np.full(n, S)
    sigma = np.full(n, iv)
    # An explicit next-hour IV rise lets fixed previous-bid limits fill;
    # a flat decaying option need not fill that sell limit at all.
    sigma[728::24] = iv*1.1
    return [c, c.copy(), c.copy(), sigma, np.full(n, iv),
            np.full(n, .01), np.ones(n, dtype=np.bool_),
            np.full((n, 2), .9), np.full((n, 2), .9)]


def run(p, m, **kw):
    return e.run(p, *m, TERM, RHO, ETA, **kw)


class AccountTests(unittest.TestCase):
    def test_notional_budget_uses_post_fill_nav_not_wallet_ae(self):
        # Wallet1000 minus existing liability400 plus new netcredit10 minus
        # new ask liability12 = NAV598. AE1010 still funds IM390, but a2000
        # notional book exceeds 3*598=1794 and must not enter.
        self.assertFalse(e._entry_budget(1000., 400., 300., 1400., 10., 12., 90., 600., 3.))
        self.assertTrue(1400+600 <= 3*1000)  # old AE notional check passed
        self.assertTrue(300+90 <= .8*1010)
        self.assertTrue(e._entry_budget(1000., 400., 300., 1400., 10., 12., 90., 394., 3.))
        self.assertFalse(e._entry_budget(1000., 400., 300., 1400., 10., 12., 90., 394.001, 3.))
        self.assertFalse(e._entry_budget(1000., 1001., 0., 0., 0., 0., 0., 1., 3.))

    def test_short_mark_is_in_mm_not_subtracted_again_from_adjusted_equity(self):
        state = np.zeros(18)
        state[e.W] = state[e.PEAK] = state[e.MINNAV] = 1000.
        state[e.MR] = 1e9
        pos = np.zeros((8, 4))
        pos[0] = [-1, 80000., 900., 5.]
        mm, im, liability, _, _ = e._account(pos, 20000., 800, .5, .01, TERM, RHO, ETA)
        self.assertGreater(mm, 600)
        self.assertLess(mm, .95*1000)
        self.assertLess(1000-liability, mm)  # old double-subtraction falsely liquidated
        e._force(state, pos, 20000., 800, .5, .01, TERM, RHO, ETA)
        self.assertEqual(state[e.LIQ], 0)
        self.assertEqual(pos[0, 1], 80000.)

    def test_no_stale_mm_after_four_stop_closes(self):
        m = market(days=7)
        m[0][820:] = 60000.
        m[1][820:] = 60000.
        m[2][820:] = 60000.
        p = e.params(delta=.08, tp=1., sl=2., slot_gap=24, cooldown=10000,
                     min_credit=.01, maxpos=4, lever=3.)
        result, _ = run(p, m)
        self.assertEqual(result[3], 4)
        self.assertEqual(result[9], 4)
        self.assertEqual(result[7], 0)
        self.assertEqual(result[16], 0)

    def test_fixed_quantity_does_not_expand_at_lower_btc_prices(self):
        result, _ = run(e.params(tp=1., min_credit=.01), market(days=30, S=40000.))
        self.assertGreater(result[3], 4)
        self.assertEqual(result[14], 1.)

    def test_terminal_liability_and_all_fees_reconcile_without_settlements(self):
        m = market(days=2)
        result, daily = run(e.params(tp=1., sl=0., min_credit=.01), m)
        self.assertGreater(result[16], 0)
        self.assertAlmostEqual(result[0], 1000+result[6]-result[5]-result[16], places=8)
        self.assertAlmostEqual(daily[-1], result[0], places=8)

    def test_settlement_matches_fixed_contract_hand_calculation(self):
        m = market(days=12)
        m[0][780:] = m[1][780:] = m[2][780:] = 60000.
        p = e.params(delta=.1, tp=1., sl=0., min_credit=.01, slot_gap=10000)
        result, _ = run(p, m)
        expiry = e._expiry(727, 7., 720, 1, 0)
        K = e._strike(-1, 80000., expiry-727, .5, .01, TERM, RHO, ETA, .1, 1000.)
        bid = e.quote(-1, 80000., K, expiry-728, .55, TERM, RHO, ETA, .01)[1]
        credit = .01*bid-e.fee(bid, 80000.)
        intrinsic = max(K-60000., 0.)
        settlement_fee = .01*min(.00015*60000., .1*intrinsic)
        self.assertEqual(result[3], 1)
        self.assertEqual(result[10], 1)
        self.assertEqual(result[7], 0)
        self.assertAlmostEqual(result[0], 1000+credit-.01*intrinsic-settlement_fee, places=8)


class ExecutionTests(unittest.TestCase):
    def test_high_low_risk_is_used_even_if_close_recovers(self):
        normal = market(days=7)
        stress = [a.copy() for a in normal]
        stress[2][820] = 10000.
        p = e.params(tp=1., sl=0., min_credit=.01, slot_gap=24)
        base, _ = run(p, normal)
        adverse, _ = run(p, stress)
        self.assertEqual(base[7], 0)
        self.assertGreater(adverse[7], 0)
        self.assertGreater(adverse[2], base[2]+.2)

    def test_new_close_fill_does_not_see_earlier_intrahour_low(self):
        normal = market(days=1)
        before_fill = [a.copy() for a in normal]
        # First scheduled order fills at Tue08h, index728. Its low occurred
        # before the close fill; no prior position exists yet.
        before_fill[2][728] = 1000.
        p = e.params(tp=1., sl=0., min_credit=.01, slot_gap=10000)
        a, d1 = run(p, normal)
        b, d2 = run(p, before_fill)
        self.assertEqual(a[3], 1)
        np.testing.assert_array_equal(a, b)
        np.testing.assert_array_equal(d1, d2)

    def test_limit_and_contract_are_frozen_before_next_hour_price_move(self):
        m = market(days=1)
        m = [x[:729].copy() for x in m]
        m[0][728] = m[1][728] = m[2][728] = 100000.
        result, _ = run(e.params(delta=.2, min_credit=.01), m)
        # Put's fixed earlier strike/limit becomes worthless after rally;
        # choosing a fresh strike at100k would falsely manufacture a fill.
        self.assertEqual(result[3], 0)

    def test_identical_one_tick_concession_is_explicit_and_passive_is_retained(self):
        m = market(days=1)
        m = [x[:729].copy() for x in m]
        m[3][:] = .5
        strict, _ = run(e.params(min_credit=.01, limit_ticks=0), m)
        concession, _ = run(e.params(min_credit=.01, limit_ticks=1), m)
        self.assertEqual(strict[3], 0)
        self.assertEqual(concession[3], 1)
        self.assertLess(concession[0], 1000.)  # bid fill, ask liability, fees

    def test_unavailable_quotes_prevent_entry(self):
        m = market(days=2)
        m[6][:] = False
        result, _ = run(e.params(min_credit=.01), m)
        self.assertEqual(result[3], 0)
        self.assertEqual(result[0], 1000)

    def test_missing_decision_quote_and_total_miss_cannot_manufacture_fills(self):
        m = market(days=1)
        m = [a[:729].copy() for a in m]
        p = e.params(delta=.2, min_credit=.01)
        m[6][727] = False
        missing_decision, _ = run(p, m)
        self.assertEqual(missing_decision[3], 0)
        m[6][727] = True
        m[7][:] = 1.
        total_miss, _ = run(p, m, miss_probability=1.)
        self.assertEqual(total_miss[3], 0)

    def test_stop_miss_keeps_position_liability(self):
        m = market(days=1)
        m = [x[:730].copy() for x in m]
        m[0][729] = m[1][729] = m[2][729] = 74000.
        p = e.params(delta=.15, tp=1., sl=2., min_credit=.01, slot_gap=10000)
        hit, _ = run(p, m, miss_probability=.5)
        failed = [a.copy() for a in m]
        failed[8][729, 0] = .1
        miss, _ = run(p, failed, miss_probability=.5)
        self.assertEqual(hit[9], 1)
        self.assertEqual(hit[16], 0)
        self.assertEqual(miss[9], 0)
        self.assertGreater(miss[16], 0)
        no_quote = [a.copy() for a in m]
        no_quote[6][729] = False
        no_quote_result, _ = run(p, no_quote)
        self.assertEqual(no_quote_result[9], 0)
        self.assertGreater(no_quote_result[16], 0)

    def test_risk_liquidation_precedes_ordinary_stop(self):
        m = market(days=7)
        m[0][820:] = m[1][820:] = m[2][820:] = 10000.
        result, _ = run(e.params(tp=1., sl=2., min_credit=.01, slot_gap=24), m)
        self.assertEqual(result[3], 4)
        self.assertEqual(result[7], 4)
        self.assertEqual(result[9], 0)
        self.assertEqual(result[15], 1)

    def test_both_entry_is_atomic_under_funding_and_fill_failure(self):
        m = market(days=1, iv=.8)
        m = [a[:729].copy() for a in m]
        both = e.params(side=2, delta=.2, min_credit=.01, tp=1.)
        ok, _ = run(both, m)
        self.assertEqual(ok[3], 2)
        self.assertEqual(ok[14], 1)
        tight = both.copy(); tight[e.IDX['lever']] = .9
        rejected, _ = run(tight, m)
        self.assertEqual(rejected[3], 0)
        failed = [a.copy() for a in m]
        failed[7][728, 1] = .1
        rejected_fill, _ = run(both, failed, miss_probability=.5)
        self.assertEqual(rejected_fill[3], 0)
        put_only, _ = run(e.params(side=0, delta=.2, min_credit=.01, tp=1., lever=.9), m)
        self.assertEqual(put_only[3], 1)

    def test_pair_budget_includes_both_new_ask_liabilities(self):
        m = market(days=1, iv=.8)
        m = [a[:729].copy() for a in m]
        expiry = e._expiry(727, 7., 720, 1, 0)
        credit, liability, notional = 0., 0., 0.
        for sign in (-1, 1):
            K = e._strike(sign, 80000., expiry-727, .8, .01, TERM, RHO, ETA, .2, 1000.)
            q = e.quote(sign, 80000., K, expiry-728, .88, TERM, RHO, ETA, .01)
            credit += .01*q[1]-e.fee(q[1], 80000.)
            liability += .01*q[2]+e.fee(q[2], 80000.)
            notional += .01*(K if sign < 0 else 80000.)
        post_nav = 1000+credit-liability
        self.assertLess(post_nav, 1000.)
        between_ae_and_nav = .5*(notional/1000+notional/post_nav)
        p = e.params(side=2, delta=.2, tp=1., min_credit=.01, lever=between_ae_and_nav)
        rejected, _ = run(p, m)
        self.assertEqual(rejected[3], 0)
        p[e.IDX['lever']] = notional/post_nav+1e-8
        accepted, _ = run(p, m)
        self.assertEqual(accepted[3], 2)
        self.assertAlmostEqual(accepted[0], post_nav, places=8)

    def test_future_prices_do_not_change_earlier_nav(self):
        m = market(days=20)
        future = [a.copy() for a in m]
        future[0][721+24*10:] *= .6
        future[1][721+24*10:] *= .6
        future[2][721+24*10:] *= .6
        p = e.params(side=2, delta=.2, min_credit=.01, tp=1.)
        _, original_daily = run(p, m)
        _, changed_daily = run(p, future)
        np.testing.assert_array_equal(original_daily[:11], changed_daily[:11])

    def test_side_call_supported_and_unsupported_portfolio_features_rejected(self):
        result, _ = run(e.params(side=1, delta=.2, min_credit=.01), market(days=2, iv=.8))
        self.assertGreater(result[3], 0)
        self.assertEqual(result[14], 1)
        for bad in ({'wing': -.1}, {'pm': 1}, {'risk': .5}, {'side': 2, 'maxpos': 1}):
            with self.assertRaises(ValueError):
                e.params(**bad)
        self.assertEqual(e.params(entry=4, entry_param=.03)[e.IDX['entry']], 4)

    def test_expiry_calendar_and_market_input_validation(self):
        for weekday in range(7):
            for hour in (0, 8, 23):
                ex = e._expiry(727, 7., 720, weekday, hour)
                absolute = int(ex)-720+hour
                self.assertEqual((weekday+absolute//24) % 7, 4)
                self.assertEqual(absolute % 24, 8)
                self.assertGreaterEqual(ex-728, 24)
        m = market(days=1)
        m[7][729, 0] = np.nan
        with self.assertRaises(ValueError):
            run(e.params(), m)

    def test_binary_delta_selection_matches_exhaustive_grid_without_price_cap(self):
        for sd in (-1, 1):
            for spot in (8000., 40000., 76998.59, 400000.):
                for iv in (.2, .5, 1.5, 4.):
                    for remaining in (24., 168., 672.):
                        for target in (.05, .10, .20, .45):
                            exact, error = 0., float('inf')
                            for k in range(max(1, int(.4*spot/1000)), int(1.8*spot/1000)+2):
                                strike = 1000.*k
                                if (sd < 0 and strike >= spot) or (sd > 0 and strike <= spot):
                                    continue
                                delta = abs(e.quote(sd, spot, strike, remaining, iv, TERM, RHO, ETA, .01)[3])
                                if abs(delta-target) < error:
                                    exact, error = strike, abs(delta-target)
                            found = e._strike(sd, spot, remaining, iv, .01, TERM, RHO, ETA, target, 1000.)
                            self.assertEqual(found, exact)
        self.assertGreater(e._strike(-1, 1e12, 168., .5, .01, TERM, RHO, ETA, .1, 1000.), 0)


if __name__ == '__main__':
    unittest.main()
