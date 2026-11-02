"""Independent offline acceptance checks for model math and strategy accounting.

Run: python -m unittest discover -s research/options_sandbox -p test_sandbox.py
No network calls, API keys, accounts or orders.
"""
import json
import math
from pathlib import Path
import sys
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import strategy_engine as engine
import market_models as models


class OptionMathTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        calibration = json.loads((ROOT / "calibration/ssvi-calibration.json").read_text(encoding="utf-8"))
        cls.term = calibration["surface_model"]["term_coef"]
        cls.rho = calibration["surface_model"]["rho"]
        cls.eta = calibration["surface_model"]["eta"]

    def test_bs_put_call_parity(self):
        for spot in (40000., 80000., 160000.):
            for ratio in (.5, 1., 1.5):
                for hours in (1., 168., 336., 2160.):
                    for vol in (.2, .6, 1.5):
                        strike = spot * ratio
                        call = engine.bs(1, spot, strike, hours, vol)[0]
                        put = engine.bs(-1, spot, strike, hours, vol)[0]
                        expected = spot - strike * math.exp(-engine.RATE * hours / 8760)
                        self.assertAlmostEqual(call - put, expected, delta=1e-7)

    def test_bs_delta_finite_difference(self):
        spot, strike, hours, vol, eps = 80000., 72000., 336., .6, .01
        for side in (-1, 1):
            analytic = engine.bs(side, spot, strike, hours, vol)[1]
            numeric = (engine.bs(side, spot + eps, strike, hours, vol)[0] - engine.bs(side, spot - eps, strike, hours, vol)[0]) / (2 * eps)
            self.assertAlmostEqual(analytic, numeric, delta=1e-7)

    def test_expiry_intrinsic_and_delta(self):
        self.assertEqual(engine.bs(1, 90000., 80000., 0., .6), (10000., 1.))
        self.assertEqual(engine.bs(-1, 70000., 80000., 0., .6), (10000., -1.))
        self.assertEqual(engine.bs(1, 70000., 80000., 0., .6)[0], 0.)
        self.assertEqual(engine.bs(-1, 90000., 80000., 0., .6)[0], 0.)

    def test_margin_otm_and_itm_symmetry(self):
        # Same intrinsic/mark situation should have equal Call/Put margin.
        spot, mark = 80000., 21000.
        for initial in (False, True):
            c = engine.margin_leg(1, spot, 60000., mark, initial)
            p = engine.margin_leg(-1, spot, 100000., mark, initial)
            self.assertAlmostEqual(c, p, places=10)
        self.assertAlmostEqual(engine.margin_leg(1, spot, 60000., mark, True), .01 * (12000 + 21000), places=8)
        self.assertAlmostEqual(engine.margin_leg(-1, spot, 100000., mark, False), .01 * (6000 + 21000 + 152), places=8)
        self.assertAlmostEqual(engine.margin_leg(1, spot, 100000., 200., True), .01 * (8000 + 200), places=8)
        self.assertAlmostEqual(engine.margin_leg(-1, spot, 60000., 200., False), .01 * (4000 + 200 + 152), places=8)

    def test_trade_fee_caps(self):
        self.assertAlmostEqual(engine.fee(50., 80000.), .05, places=12)
        self.assertAlmostEqual(engine.fee(1000., 80000.), .192, places=12)

    def test_constrained_ssvi_static_strike_arbitrage(self):
        spot = 80000.
        strikes = np.linspace(.10 * spot, 4 * spot, 601)
        for atm in (.2, .4, .8, 1.5):
            for hours in (24., 168., 336., 720., 2160.):
                calls = np.array([engine.bs(1, spot, k, hours, engine.surface_iv(spot, k, hours, atm, self.term, self.rho, self.eta))[0] for k in strikes])
                slopes = np.diff(calls) / np.diff(strikes)
                discount = math.exp(-engine.RATE * hours / 8760)
                self.assertLessEqual(float(slopes.max()), 1e-9)
                self.assertGreaterEqual(float(slopes.min()), -discount - 1e-9)
                self.assertGreaterEqual(float(np.diff(slopes).min()), -1e-8)

    def test_constrained_ssvi_total_variance_calendar(self):
        spot = 80000.
        for atm in (.2, .4, .8, 1.5):
            for log_forward_moneyness in (-1., -.5, -.25, 0., .25, .5, 1.):
                previous = -1.
                for hours in (1., 24., 168., 336., 720., 2160., 8760.):
                    T = hours / 8760
                    strike = spot * math.exp(engine.RATE * T + log_forward_moneyness)
                    iv = engine.surface_iv(spot, strike, hours, atm, self.term, self.rho, self.eta)
                    variance = iv * iv * T
                    self.assertTrue(math.isfinite(variance) and variance > 0)
                    self.assertGreaterEqual(variance + 1e-10, previous)
                    previous = variance

    def test_bid_ask_and_tick_ordering(self):
        for side in (-1, 1):
            for spot, strike in ((80000., 60000.), (80000., 80000.), (80000., 100000.)):
                mark, bid, ask, delta, iv = engine.quote(side, spot, strike, 336., .6, self.term, self.rho, self.eta, .15)
                self.assertGreaterEqual(bid, 0)
                self.assertLessEqual(bid, mark + 1e-8)
                self.assertGreaterEqual(ask + 1e-8, mark)
                self.assertLessEqual(bid, ask)
                self.assertAlmostEqual(bid % 5, 0.)
                self.assertAlmostEqual(ask % 5, 0.)


class MarketProcessTests(unittest.TestCase):
    def test_iv_and_quote_random_channels_do_not_anticipate_future(self):
        from run_sandbox import prepare_market
        config = json.loads((ROOT / "calibration/ssvi-calibration.json").read_text(encoding="utf-8"))
        rng = np.random.default_rng(73)
        raw = np.zeros((1200, 4))
        raw[:, 0] = rng.normal(0, .003, len(raw))
        raw[:, 2] = np.maximum(raw[:, 0], 0) + .001
        raw[:, 3] = np.minimum(raw[:, 0], 0) - .001
        shorter = prepare_market(raw[:1000], config, 151)
        longer = prepare_market(raw, config, 151)
        changed = raw.copy()
        changed[1000:, 0] += .05
        alternate = prepare_market(changed, config, 151)
        for a, b, c in zip(shorter, longer, alternate):
            np.testing.assert_allclose(a, b[:1000], equal_nan=True, atol=1e-10, rtol=1e-12)
            np.testing.assert_allclose(b[:1000], c[:1000], equal_nan=True, atol=1e-10, rtol=1e-12)

    def test_stationary_randomness_and_reproducibility(self):
        follows = np.array([True, True, False, True, True, False])
        a = models.stationary_indices(6, 1000, 72, follows, 12345)
        b = models.stationary_indices(6, 1000, 72, follows, 12345)
        c = models.stationary_indices(6, 1000, 72, follows, 12346)
        np.testing.assert_array_equal(a, b)
        self.assertFalse(np.array_equal(a, c))
        self.assertTrue(np.all((a >= 0) & (a < 6)))

    def test_variance_filter_resets_across_missing_hour(self):
        shocks = np.array([.1, .2, .3, .4])
        follows = np.array([True, False, True, False])
        h = models.filter_variance(shocks, follows, .001, .1, .03, .8, .01)
        self.assertAlmostEqual(h[0], .01)
        self.assertAlmostEqual(h[1], .001 + .1 * .1 ** 2 + .8 * .01)
        self.assertAlmostEqual(h[2], .01)
        self.assertTrue(np.all(h > 0))

    def test_fhs_ohlc_remains_consistent(self):
        raw = np.array([[.01, .002, .012, -.003], [-.02, .001, .004, -.025], [.001, 0, .003, -.002]])
        indices = np.array([0, 1, 2, 1, 0, 2], dtype=np.int64)
        hist_h = np.array([.0001, .0004, .0002])
        f = models.fhs_features(raw, indices, hist_h, .000001, .05, .02, .90, .0002, .001, 0., .03, 1.1)
        self.assertTrue(np.isfinite(f).all())
        self.assertTrue(np.all(f[:, 2] >= 0))
        self.assertTrue(np.all(f[:, 3] <= 0))
        self.assertTrue(np.all(f[:, 1] + f[:, 2] >= f[:, 0] - 1e-12))
        self.assertTrue(np.all(f[:, 1] + f[:, 3] <= f[:, 0] + 1e-12))


class StrategyAccountingTests(unittest.TestCase):
    def test_gap_down_does_not_treat_drawdown_stop_as_loss_guarantee(self):
        from stress_cases import run_case
        result = run_case("put_down70pct_after_open")["metrics"]
        self.assertGreater(result["max_drawdown"], .25)
        self.assertAlmostEqual(result["end_btc"], .01)
        self.assertEqual(result["invariant_violations"], 0)
        self.assertEqual(result["opened_legs"], result["closed_legs"])

    def test_covered_call_economic_profit_can_coexist_with_margin_deficit(self):
        from stress_cases import run_case
        result = run_case("call_up200pct_after_open")["metrics"]
        self.assertGreater(result["total_return"], 0)
        self.assertLess(result["end_wallet_usdt"], 0)
        self.assertGreater(result["potential_intrahour_liquidations"], 0)
        self.assertGreater(result["max_mm_ae"], .95)
        self.assertEqual(result["invariant_violations"], 0)

    @classmethod
    def setUpClass(cls):
        c = json.loads((ROOT / "calibration/ssvi-calibration.json").read_text(encoding="utf-8"))["surface_model"]
        cls.params = (c["term_coef"], c["rho"], c["eta"])

    def run_market(self, close, high=None, low=None, available=None):
        n = len(close)
        high = close.copy() if high is None else high
        low = close.copy() if low is None else low
        available = np.ones(n, dtype=np.bool_) if available is None else available
        return engine.simulate_path(close, high, low, np.full(n, .7), np.full(n, .3), np.full(n, .08), available, np.full((n, 2), .99), np.full((n, 2), .99), *self.params)

    def test_flat_market_zero_trade_cash_and_benchmark(self):
        result, daily = self.run_market(np.full(720 + 240 + 1, 80000.))
        self.assertAlmostEqual(result[0], 1800., places=8)
        self.assertAlmostEqual(result[1], 1800., places=8)
        self.assertAlmostEqual(result[2], 0.)
        self.assertAlmostEqual(result[3], 0.)
        self.assertEqual(result[6], 0)
        self.assertEqual(result[7], 0)
        self.assertEqual(result[10], 0)
        self.assertEqual(result[19], 0)
        np.testing.assert_allclose(daily, 1800.)

    def test_unavailable_market_does_not_open_new_positions(self):
        close = np.full(720 + 24 * 10 + 1, 80000.)
        close[750:] = 75000.
        close[751:] = 75300.
        result, _ = self.run_market(close, available=np.zeros(len(close), dtype=np.bool_))
        self.assertEqual(result[6], 0)
        self.assertEqual(result[7], 0)
        self.assertAlmostEqual(result[14], 1000.)
        self.assertAlmostEqual(result[13], .01)
        self.assertAlmostEqual(result[0], result[14] + result[13] * close[-1] - result[20])

    def test_future_changes_cannot_change_past_daily_nav(self):
        n = 720 + 24 * 16 + 1
        first = np.full(n, 80000.)
        first[745:] = 75000.
        first[746:] = 75300.
        second = first.copy()
        cut = 720 + 24 * 8
        second[cut:] = np.linspace(75300., 110000., len(second) - cut)
        a, nav_a = self.run_market(first)
        b, nav_b = self.run_market(second)
        # First eight daily entries are strictly before the first changed hour.
        np.testing.assert_allclose(nav_a[:8], nav_b[:8], rtol=0, atol=1e-9)
        for result, close in ((a, first), (b, second)):
            self.assertAlmostEqual(result[0], result[14] + result[13] * close[-1] - result[20], delta=1e-7)
            self.assertEqual(result[19], 0)
            self.assertGreaterEqual(result[13], -1e-9)
            self.assertLessEqual(result[13], .02000001)


if __name__ == "__main__":
    unittest.main(verbosity=2)
