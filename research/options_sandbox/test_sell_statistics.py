"""Independent finite-sample checks of Sell research statistics, no network."""
import json
import math
from pathlib import Path
from statistics import NormalDist
import sys
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sell_statistics import (paired_summary, simultaneous_lower_bounds,
                             summarize_metrics, zero_event_upper_bound)


def make_metrics(returns, hold=None):
    returns = np.asarray(returns, dtype=float)
    hold = np.zeros(len(returns)) if hold is None else np.asarray(hold, dtype=float)
    m = np.zeros((len(returns), 25))
    m[:, 21] = 100.
    m[:, 0] = 100 * (1 + returns)
    m[:, 1] = 100 * (1 + hold)
    m[:, 2] = returns
    m[:, 3] = returns - hold
    m[:, 14] = 100.
    m[:, 23] = m[:, 0] - m[:, 1]
    return m


class PairedSummaryTests(unittest.TestCase):
    def test_paired_differences_cancel_common_market_variation(self):
        returns = np.array([1., -.5, .5, -.75, 1.5, 0.])
        hold = returns - .125
        s = paired_summary(make_metrics(returns, hold), resamples=200)
        self.assertEqual(s["mean_excess_return"], .125)
        self.assertEqual(s["paired_standard_error"], 0.)
        self.assertEqual(s["normal_CI"], [.125, .125])
        self.assertEqual(s["paired_bootstrap_CI"], [.125, .125])
        self.assertGreater(np.std(returns) / math.sqrt(len(returns)), 0.)

    def test_paired_normal_ci_matches_manual_differences(self):
        m = make_metrics([.1, -.2, .3, -.4, .05], [.05, -.1, .2, -.3, .08])
        e = (m[:, 0] - m[:, 1]) / m[:, 21]
        s = paired_summary(m, resamples=200)
        se = e.std(ddof=1) / math.sqrt(len(e))
        z = NormalDist().inv_cdf(.975)
        np.testing.assert_allclose(s["normal_CI"], [e.mean() - z * se, e.mean() + z * se])
        self.assertAlmostEqual(s["median_excess_return"], np.median(e))

    def test_bootstrap_reproducible_and_horizon_labeled_arithmetic(self):
        m = make_metrics(np.linspace(-.25, .5, 61))
        a = paired_summary(m, horizon_days=365, seed=123, resamples=400)
        b = paired_summary(m, horizon_days=365, seed=123, resamples=400)
        c = paired_summary(m, horizon_days=182.5, seed=123, resamples=400)
        self.assertEqual(a, b)
        self.assertEqual(c["mean_excess_return"], a["mean_excess_return"])
        self.assertAlmostEqual(c["arithmetic_annualized_mean_excess_return"],
                               2 * a["mean_excess_return"])
        json.dumps(a, allow_nan=False)

    def test_invalid_metrics_or_bootstrap_parameters_rejected(self):
        good = make_metrics([.1, .2])
        bad = [np.zeros((0, 25)), np.zeros((1, 25)), np.zeros((2, 24)),
               np.full((2, 25), np.nan), np.full((2, 25), np.inf),
               np.zeros((2, 25))]
        for metrics in bad:
            with self.subTest(shape=metrics.shape), self.assertRaises(ValueError):
                paired_summary(metrics, resamples=50)
            with self.assertRaises(ValueError):
                summarize_metrics(metrics)
        for kwargs in (dict(resamples=1), dict(resamples=3.5), dict(alpha=0),
                       dict(alpha=1), dict(alpha=float("nan")),
                       dict(horizon_days=0), dict(horizon_days=True)):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                paired_summary(good, **kwargs)


class JointBoundsTests(unittest.TestCase):
    def test_constant_and_zero_columns_exact(self):
        x = np.zeros((2, 10, 3))
        x[0, :, 1] = .125
        x[1, :, 2] = -.25
        for mode in ("observed", "resampled"):
            s = simultaneous_lower_bounds(x, resamples=200, studentization=mode)
            np.testing.assert_array_equal(s["lower_bounds"], x[:, 0, :])
            np.testing.assert_array_equal(s["se"], np.zeros((2, 3)))
            self.assertEqual(s["critical"], 0.)
            self.assertEqual(s["nonconstant_family_size"], 0)

    def test_joint_family_bound_no_higher_than_separate_cells(self):
        x = np.random.default_rng(18).normal(.02, .2, (4, 60, 3))
        for mode in ("observed", "resampled"):
            joint = simultaneous_lower_bounds(x, seed=501, resamples=500, studentization=mode)
            for i in range(len(x)):
                single = simultaneous_lower_bounds(x[i:i + 1], seed=501, resamples=500, studentization=mode)
                self.assertGreaterEqual(joint["critical"] + 1e-12, single["critical"])
                self.assertTrue(np.all(joint["lower_bounds"][i] <= single["lower_bounds"][0] + 1e-12))

    def test_common_row_bootstrap_preserves_perfect_cell_correlation(self):
        base = np.random.default_rng(73).normal(0, .1, 80)
        # Affine-positive columns have identical studentized bootstrap values
        # only when each cell and candidate shares the same resampled rows.
        x = np.empty((2, len(base), 2))
        x[0, :, 0] = base
        x[0, :, 1] = 2 * base + 1
        x[1, :, 0] = 4 * base - 2
        x[1, :, 1] = 8 * base + 3
        for mode in ("observed", "resampled"):
            single = simultaneous_lower_bounds(base[None, :, None], seed=24, resamples=500, studentization=mode)
            joint = simultaneous_lower_bounds(x, seed=24, resamples=500, studentization=mode)
            self.assertAlmostEqual(joint["critical"], single["critical"], delta=1e-11)

    def test_centered_studentized_reference_calculation(self):
        x = np.random.default_rng(8).normal(.1, .2, (2, 12, 2))
        seed, b = 41, 100
        flat = x.transpose(1, 0, 2).reshape(12, 4)
        mean = flat.mean(axis=0)
        se = flat.std(axis=0, ddof=1) / math.sqrt(12)
        indices = np.random.default_rng(seed).integers(0, 12, size=(b, 12))
        centered = (flat - mean)[indices]
        boot_se = centered.std(axis=1, ddof=1) / math.sqrt(12)
        for mode in ("observed", "resampled"):
            s = simultaneous_lower_bounds(x, seed=seed, resamples=b, alpha=.1, studentization=mode)
            denominator = se if mode == "observed" else np.maximum(boot_se, se * 1e-12)
            t = centered.mean(axis=1) / denominator
            critical = max(0., np.sort(t.max(axis=1))[math.ceil(.9 * b) - 1])
            self.assertAlmostEqual(s["critical"], critical, delta=1e-12)
            np.testing.assert_allclose(s["lower_bounds"].ravel(), mean - critical * se)

    def test_multiple_comparisons_are_more_conservative_than_normal_pointwise(self):
        x = np.random.default_rng(51).normal(0, 1, (4, 150, 8))
        s = simultaneous_lower_bounds(x, resamples=500)
        self.assertGreater(s["critical"], NormalDist().inv_cdf(.95))
        self.assertEqual(s["family_size"], 32)
        self.assertEqual(s["lower_bounds"].shape, (4, 8))

    def test_sparse_two_path_degenerate_bootstrap_is_not_dropped(self):
        x = np.zeros((1, 2, 2))
        x[0, 1, 0] = .1
        s = simultaneous_lower_bounds(x, seed=1, resamples=400, studentization="resampled")
        self.assertTrue(np.isfinite(s["lower_bounds"]).all())
        self.assertTrue(math.isfinite(s["critical"]))
        self.assertGreater(s["critical"], 1e10)
        self.assertGreater(s["degenerate_studentization_count"], 0)
        self.assertLess(s["lower_bounds"][0, 0], -.1)
        self.assertEqual(s["lower_bounds"][0, 1], 0.)

    def test_observed_se_sparse_columns_are_stable_but_not_zero_uncertainty(self):
        x = np.zeros((1, 2, 2))
        x[0, 1, 0] = .1
        s = simultaneous_lower_bounds(x, seed=1, resamples=400)
        self.assertEqual(s["studentization"], "observed")
        self.assertIsNone(s["studentization_floor_relative"])
        self.assertTrue(np.isfinite(s["lower_bounds"]).all())
        self.assertGreater(s["degenerate_studentization_count"], 0)
        self.assertAlmostEqual(s["critical"], 1.)
        self.assertAlmostEqual(s["se"][0, 0], .05)
        self.assertLess(s["lower_bounds"][0, 0], s["mean"][0, 0])
        self.assertEqual(s["lower_bounds"][0, 1], 0.)
        self.assertIn("not a finite-sample strict FWER guarantee", s["coverage"])

    def test_many_sparse_columns_do_not_poison_observed_family_critical(self):
        x = np.zeros((3, 48, 12))
        for cell in range(3):
            for candidate in range(12):
                x[cell, (cell + candidate) % 48, candidate] = -.2
        s = simultaneous_lower_bounds(x, seed=2, resamples=500)
        self.assertGreater(s["degenerate_studentization_count"], 0)
        self.assertLess(s["critical"], 10.)
        self.assertGreater(s["critical"], 0.)
        self.assertTrue(np.all(s["lower_bounds"] < s["mean"]))

    def test_seed_reproducibility_and_candidate_permutation(self):
        x = np.random.default_rng(135).normal(0, .1, (3, 40, 4))
        a = simultaneous_lower_bounds(x, seed=17, resamples=200)
        b = simultaneous_lower_bounds(x, seed=17, resamples=200)
        np.testing.assert_array_equal(a["lower_bounds"], b["lower_bounds"])
        self.assertEqual(a["critical"], b["critical"])
        perm = [3, 0, 2, 1]
        c = simultaneous_lower_bounds(x[:, :, perm], seed=17, resamples=200)
        np.testing.assert_allclose(c["lower_bounds"], a["lower_bounds"][:, perm], atol=1e-12)
        self.assertAlmostEqual(c["critical"], a["critical"], delta=1e-12)

    def test_bad_shape_nan_or_single_path_rejected(self):
        for x in (np.zeros((3, 4)), np.zeros((0, 4, 2)), np.zeros((2, 1, 2)),
                  np.zeros((2, 3, 0)), np.full((2, 4, 2), np.nan),
                  np.full((2, 4, 2), np.inf)):
            with self.subTest(shape=x.shape), self.assertRaises(ValueError):
                simultaneous_lower_bounds(x, resamples=50)
        for kwargs in (dict(resamples=0), dict(resamples=True), dict(alpha=-.1), dict(alpha=1),
                       dict(studentization="invalid"), dict(studentization=None)):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                simultaneous_lower_bounds(np.zeros((1, 3, 1)), **kwargs)


class MetricSummaryTests(unittest.TestCase):
    def test_cvar_is_signed_worst_five_percent_and_counts_match(self):
        m = make_metrics(np.linspace(-.5, .5, 21))
        m[:, 4] = np.linspace(0, .5, 21)
        m[:, 6] = 2.
        m[0, 8] = 2
        m[[0, 1], 14] = -1
        m[3, 19] = 3
        m[:, 24] = 2.
        s = summarize_metrics(m)
        self.assertAlmostEqual(s["CVaR95"], (-.5 - .45) / 2)
        self.assertEqual(s["CVaR95_tail_paths"], 2)
        self.assertEqual(s["mean_trades"], 2.)
        self.assertEqual(s["liq_count"], 2)
        self.assertEqual(s["liquidation_path_count"], 1)
        self.assertEqual(s["negative_wallet_count"], 2)
        self.assertEqual(s["invariants"], 3)
        self.assertEqual(s["invariant_violation_path_count"], 1)
        self.assertEqual(s["mean_inventory_rebalance_pnl"], 2.)
        self.assertAlmostEqual(s["max_drawdown_p95"], .475)
        self.assertIsNone(s["zero_event_probability_upper95"])
        self.assertIsNone(s["negative_wallet_probability_upper95"])
        json.dumps(s, allow_nan=False)

    def test_zero_events_get_exact_binomial_probability_upper_not_zero(self):
        n = 100
        expected = 1 - .05 ** (1 / n)
        self.assertAlmostEqual(zero_event_upper_bound(n), expected, delta=1e-15)
        self.assertGreater(zero_event_upper_bound(n), 0.)
        self.assertLess(zero_event_upper_bound(512), zero_event_upper_bound(128))
        s = summarize_metrics(make_metrics(np.zeros(n)))
        self.assertEqual(s["excess_CI95"], [0., 0.])
        self.assertAlmostEqual(s["zero_event_probability_upper95"], expected)
        self.assertNotEqual(s["zero_event_probability_upper95"], s["excess_CI95"][1])
        self.assertEqual(s["negative_wallet_probability_upper95"], s["zero_event_probability_upper95"])

    def test_event_upper_bound_probability_vs_return_interval_are_distinct(self):
        s = summarize_metrics(make_metrics(np.full(50, -.25)))
        self.assertEqual(s["excess_CI95"], [-.25, -.25])
        self.assertGreater(s["zero_event_probability_upper95"], 0)
        self.assertLess(s["zero_event_probability_upper95"], 1)
        # Constant losing strategy has an exact negative mean; the zero-event
        # liquidation bound says nothing about the probability of profit.
        self.assertEqual(s["median_return"], -.25)
        self.assertEqual(s["CVaR95"], -.25)

    def test_zero_event_formula_rejects_invalid_n(self):
        for n in (0, -1, 1.5, True):
            with self.assertRaises(ValueError):
                zero_event_upper_bound(n)


if __name__ == "__main__":
    unittest.main(verbosity=2)
