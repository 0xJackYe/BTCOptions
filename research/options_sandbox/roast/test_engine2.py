"""Offline acceptance tests for the roast engine and v2 generator. python -m unittest test_engine2"""
import math
import unittest

import numpy as np

import common  # noqa: F401
import engine2 as e2
from strategy_engine import quote, fee

TERM, RHO, ETA = .0576, -.245, 1.0


def market(close, iv=.5, spread=.01):
    n = len(close)
    return (close, close.copy(), close.copy(), np.full(n, iv), np.full(n, iv), np.full(n, spread), np.ones(n, np.bool_))


class EngineTests(unittest.TestCase):
    def test_flat_market_short_put_keeps_premium_minus_fees(self):
        close = np.full(720 + 24 * 30 + 1, 80000.)
        out = e2.run(e2.params(side=0, dte=7, delta=.15), *market(close), TERM, RHO, ETA)
        self.assertGreater(out[3], 0)                  # traded
        self.assertEqual(out[10], 0)                   # never settled ITM
        self.assertAlmostEqual(out[0] - 1000, out[6] - out[5] - out[16], places=6)  # premium - fees - open liability
        self.assertEqual(out[7], 0)

    def test_hold_to_expiry_matches_hand_calculation(self):
        n = 720 + 24 * 12 + 1
        close = np.full(n, 80000.)
        close[760:] = 60000.  # crash after the first entry, held to settlement
        p = e2.params(side=0, dte=7, delta=.10, maxpos=1, entry_hour=-1, slot_gap=10 ** 6)
        out = e2.run(p, *market(close), TERM, RHO, ETA)
        self.assertEqual(out[3], 1)
        # reconstruct: entry decided at hour 721 close -> filled at 722 quotes
        i = 722
        elapsed = i - 720
        weekday = (1 + elapsed // 24) % 7
        hour = elapsed % 24
        nearest = i + ((4 - weekday) % 7) * 24 + 8 - hour
        expiry = min((nearest + w * 168 for w in range(-1, 14) if nearest + w * 168 - i >= 24), key=lambda e: abs(e - i - 168))
        K = e2._strike_for_delta(-1, 80000., expiry - i, .5, TERM, RHO, ETA, .01, .10, False, 1000.0)
        bid = quote(-1, 80000., K, expiry - i, .5, TERM, RHO, ETA, .01)[1]
        credit = .01 * bid - fee(bid, 80000.)
        ins = K - 60000.
        pnl = credit - .01 * ins - .01 * min(.00015 * 60000., .1 * ins)
        self.assertAlmostEqual(out[0], 1000 + pnl, places=6)
        self.assertEqual(out[10], 1)

    def test_spread_caps_loss(self):
        n = 720 + 24 * 12 + 1
        close = np.full(n, 80000.)
        close[760:] = 20000.
        naked = e2.run(e2.params(side=0, dte=7, delta=.15, entry_hour=-1, slot_gap=10 ** 6), *market(close), TERM, RHO, ETA)
        spread = e2.run(e2.params(side=0, dte=7, delta=.15, wing=-.10, entry_hour=-1, slot_gap=10 ** 6), *market(close), TERM, RHO, ETA)
        self.assertLess(naked[0], spread[0])
        self.assertEqual(spread[7], 0)                      # cash-secured spread survives the crash
        self.assertGreater(spread[0], 1000 - .01 * 8000 - 1)  # loss <= one 0.01 lot of the ~$7-8k width

    def test_standard_account_overlevered_spread_gets_liquidated(self):
        n = 720 + 24 * 12 + 1
        close = np.full(n, 80000.)
        close[760:] = 20000.
        p = e2.params(side=0, dte=7, delta=.15, wing=-.10, entry_hour=-1, slot_gap=10 ** 6, lever=10, risk=.5)
        std = e2.run(p, *market(close), TERM, RHO, ETA)
        p[e2.IDX["pm"]] = 1
        pm = e2.run(p, *market(close), TERM, RHO, ETA)
        self.assertEqual(std[7], 1)                  # naked-margin rules force-liquidate the "defined-risk" spread
        self.assertEqual(pm[7], 0)                   # with portfolio margin the same trade just pays its max loss
        self.assertGreater(pm[0], std[0])

    def test_real_calendar_expires_on_friday_0800(self):
        """Binance weeklies expire Friday 08:00 UTC. Clock starts Friday 06:00, first fill Friday 08:00 -> settles next Friday 08:00."""
        close = np.full(720 + 24 * 9 + 1, 80000.)
        p = e2.params(side=0, dte=7, delta=.10, maxpos=1, entry_hour=8, slot_gap=10 ** 6)
        out = e2.run(p, *market(close), TERM, RHO, ETA, 1000.0, 720, 4, 6)
        self.assertEqual(out[3], 1)
        self.assertEqual(out[11], 168 + 1)   # 168h held; hours_in_market also counts the settlement hour
        # starting one hour later, the first 08:00 fill is Saturday -> nearest Friday is 144h away
        out = e2.run(p, *market(close), TERM, RHO, ETA, 1000.0, 720, 4, 7)
        self.assertEqual(out[11], 144 + 1)

    def test_sparse_strike_grid_is_respected(self):
        close = np.full(720 + 24 * 3 + 1, 80000.)
        for step in (1000., 2000., 4000.):
            K = e2._strike_for_delta(-1, 80000., 168., .5, TERM, RHO, ETA, .01, .08, False, step)
            self.assertEqual(K % step, 0)
            self.assertLess(K, 80000.)

    def test_settlement_is_usdt_cash_only(self):
        """Binance BTC options are cash-settled in USDT: an ITM short put debits intrinsic + exercise fee, no BTC moves."""
        n = 720 + 24 * 12 + 1
        close = np.full(n, 80000.)
        close[760:] = 60000.
        out = e2.run(e2.params(side=0, dte=7, delta=.10, entry_hour=-1, slot_gap=10 ** 6), *market(close), TERM, RHO, ETA)
        self.assertEqual(out[10], 1)                      # settled in the money
        self.assertNotIn("btc", " ".join(e2.OUT_NAMES))   # the account holds USDT only
        self.assertLess(out[0], 1000)                     # paid out in USDT

    def test_future_cannot_change_past(self):
        n = 720 + 24 * 20 + 1
        a = np.full(n, 80000.)
        b = a.copy()
        b[720 + 24 * 15:] = 50000.
        p = e2.params(side=0, dte=3, delta=.2, entry_hour=-1, slot_gap=10 ** 6)
        cut = 720 + 24 * 15
        ra = e2.run(p, *[x[:cut] for x in market(a)], TERM, RHO, ETA)
        rb = e2.run(p, *[x[:cut] for x in market(b)], TERM, RHO, ETA)
        np.testing.assert_allclose(ra, rb)


class GeneratorTests(unittest.TestCase):
    def test_circular_bootstrap_uniform_and_reproducible(self):
        import v2_market as v2
        a = v2.circular_indices(1000, 200000, 50.0, 7)
        b = v2.circular_indices(1000, 200000, 50.0, 7)
        np.testing.assert_array_equal(a, b)
        counts = np.bincount(a, minlength=1000)
        self.assertLess(counts.std() / counts.mean(), .35)  # no structural under-sampling
        self.assertTrue(counts[:50].mean() > .6 * counts.mean())

    def test_iv_richness_is_persistent_not_hourly_noise(self):
        """Regression guard: a fast mean-reverting IV residual made 'sell when IV is rich' print +815 USDT/yr."""
        import v2_market as v2
        two = v2.CAL["iv_level"]["two_component"]
        self.assertGreater(two["phi_slow"] ** 24, .9)          # tradable richness half-life >> 1 day
        self.assertEqual(v2.WORLD_DEFAULT["iv_fast_noise"], 0.0)  # mark-switch noise is not tradable by default
        real = two["real_acf"]
        self.assertGreater(real["24"], .5)                    # the real 2023 residual is persistent at 24h

    def test_capped_fhs_cannot_explode(self):
        import v2_market as v2
        raw = np.zeros((100, 4)); raw[:, 0] = np.r_[np.full(99, .001), -.5]
        hist_h = np.full(100, 1e-6)
        idx = np.full(5000, 99, dtype=np.int64)
        f = v2.fhs_capped(raw, idx, hist_h, 1e-7, .1, .1, .89, 1e-6, 0., 0., 0., 1., 8., (2.5 / math.sqrt(8760)) ** 2)
        self.assertTrue(np.isfinite(f).all())
        self.assertLessEqual(np.abs(f[:, 0]).max(), 8 * 2.5 / math.sqrt(8760) + 1e-12)


if __name__ == "__main__":
    unittest.main(verbosity=2)
