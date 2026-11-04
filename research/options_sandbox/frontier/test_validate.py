"""Market-validation tests use synthetic inputs, never strategy returns."""
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

import validate as val


def features(returns):
    r = np.asarray(returns, dtype=float)
    return np.column_stack((r, np.zeros(len(r)), np.maximum(r, 0), np.minimum(r, 0)))


def row(value):
    return {m: float(value) for m in val.METRICS}


def history_fixture(count=2400):
    start = int(pd.Timestamp("2020-01-01", tz="UTC").timestamp())
    r = np.random.default_rng(17).normal(0, .005, count)
    return {"times": start+np.arange(count)*3600, "features": features(r)}


def random_generator(model, config, hours, seed, **kwargs):
    r = np.random.default_rng(seed).normal(0., .006, hours+721)
    return features(r), {"source": "unit fixture, not a realistic market"}


class ValidationTests(unittest.TestCase):
    def test_loaded_config_cannot_claim_future_or_missing_training_scope(self):
        valid = {"training": {"end_exclusive_utc": "2024-01-01T00:00:00+00:00",
                              "last_observation_utc": "2023-12-31T23:00:00+00:00"}}
        val.assert_training_scope(valid)
        with self.assertRaisesRegex(ValueError, "declare"):
            val.assert_training_scope({})
        leaked = {"training": dict(valid["training"], end_exclusive_utc="2025-01-01T00:00:00+00:00")}
        with self.assertRaisesRegex(ValueError, "2024"):
            val.assert_training_scope(leaked)
        leaked = {"training": dict(valid["training"], last_observation_utc="2024-01-01T00:00:00+00:00")}
        with self.assertRaises(ValueError):
            val.assert_training_scope(leaked)

    def test_metrics_use_exact_horizon_and_ignore_warmup(self):
        active = features(np.tile([-.01, 0., .02, 0.], 540))
        a = val.market_metrics(active)
        b = val.market_metrics(np.vstack((features(np.full(721, 1.)), active)))
        self.assertEqual(a, b)
        self.assertAlmostEqual(a["hourly_p01"], -.01)
        self.assertAlmostEqual(a["hourly_p99"], .02)
        # Every24h contains six identical4h blocks, with sum .06.
        self.assertAlmostEqual(a["daily_p01"], .06)
        self.assertAlmostEqual(a["daily_p99"], .06)
        self.assertAlmostEqual(a["worst24h_return"], np.expm1(.06))
        self.assertAlmostEqual(a["max_drawdown90"], 1-np.exp(-.01))

    def test_jump_frequency_is_simple_return_threshold_not_sigma_guess(self):
        r = np.zeros(val.HOURS)
        r[:4] = np.log([.96, 1.04, .99, 1.01])
        m = val.market_metrics(features(r))
        self.assertAlmostEqual(m["jump_frequency_abs_hour_ge3pct"], 2/val.HOURS)

    def test_high_low_inconsistency_and_nonfinite_fail_explicitly(self):
        bad = features(np.zeros(val.HOURS))
        bad[100, 2] = -.001
        with self.assertRaisesRegex(ValueError, "High"):
            val.market_metrics(bad)
        bad = features(np.zeros(val.HOURS))
        bad[100, 0] = np.nan
        with self.assertRaisesRegex(ValueError, "finite"):
            val.market_metrics(bad)
        with self.assertRaises(ValueError):
            val.market_metrics(features(np.zeros(191)), 191)

    def test_gap_window_is_omitted_and_never_forward_filled(self):
        history = history_fixture(240*4)
        # Delete one hour only from the second fixed240h window.
        history = {k: np.delete(v, 300, axis=0) for k, v in history.items()}
        rows, missing = val.historical_windows(history, "2020-01-01", "2020-02-10", hours=240)
        self.assertEqual(len(rows), 3)
        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0]["hours_found"], 239)
        self.assertEqual(rows[1]["start_utc"], "2020-01-21T00:00:00+00:00")

    def test_holdout_boundary_and_nonoverlap_are_calendar_fixed(self):
        history = history_fixture(240*5)
        rows, _ = val.historical_windows(history, "2020-01-11", "2020-02-10", hours=240)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["start_utc"], "2020-01-11T00:00:00+00:00")
        for a, b in zip(rows, rows[1:]):
            self.assertEqual(a["end_exclusive_utc"], b["start_utc"])
        invalid = dict(history, times=history["times"][::-1])
        with self.assertRaisesRegex(ValueError, "increasing"):
            val.historical_windows(invalid, "2020-01-01", "2020-02-10", hours=240)

    def test_scales_come_only_from_passed_training_and_handle_constant_columns(self):
        training = [row(x) for x in (0., 0., 0., 0.)]
        scales = val.training_scales(training)
        self.assertEqual(scales, val.SCALE_FLOORS)
        ordinary = val.training_scales([row(x) for x in (0., 1., 2., 3.)])
        self.assertTrue(all(s == 1.5 for s in ordinary.values()))
        with self.assertRaises(ValueError):
            val.training_scales(training[:3])

    def test_wasserstein_matches_hand_location_shift(self):
        result = val.distribution_distance([row(0), row(2)], [row(1), row(3)],
                                           {m: 1. for m in val.METRICS})
        self.assertAlmostEqual(result["mean_scaled_wasserstein"], 1.)
        self.assertAlmostEqual(result["max_scaled_wasserstein"], 1.)

    def test_overbroad_simulation_does_not_pass_by_covering_observed_points(self):
        # A 95%envelope can cover0 but cannot make a huge dispersion fit0.
        result = val.distribution_distance([row(0), row(0)], [row(-100), row(100)],
                                           {m: 1. for m in val.METRICS})
        self.assertAlmostEqual(result["mean_scaled_wasserstein"], 100.)
        gate = val.research_gate(result, {"algorithm_checks_pass": True}, 0)
        self.assertFalse(gate["research_gate_pass"])
        self.assertIn("distribution_distance_mean", gate["failures"])
        self.assertFalse(gate["real_world_adequacy_certified"])

    def test_identical_metrics_only_pass_descriptive_not_realworld_gate(self):
        result = val.distribution_distance([row(1)]*4, [row(1)]*128,
                                           {m: 1. for m in val.METRICS})
        gate = val.research_gate(result, {"algorithm_checks_pass": True}, 0)
        self.assertTrue(gate["research_gate_pass"])
        self.assertFalse(gate["real_world_adequacy_certified"])
        self.assertFalse(val.research_gate(result, {"algorithm_checks_pass": True}, 1)["research_gate_pass"])
        self.assertFalse(val.research_gate(result, {"algorithm_checks_pass": False}, 0)["research_gate_pass"])

    def test_randomness_checks_reproducibility_prefix_novelty_and_free_endpoint(self):
        check = val.randomness_checks(random_generator, "sv_jump", {}, history_fixture())
        self.assertTrue(check["algorithm_checks_pass"])
        self.assertTrue(check["prefix_invariant_to_requested_horizon"])
        self.assertTrue(check["no_fixed_endpoint"])
        self.assertGreater(check["fraction_hourly_returns_not_in_training_or_centered_training"], .99)
        # An iid Gaussian fixture passes algorithm tests without certifying realism.
        self.assertIn("not a market", check["note"])

    def test_fixed_endpoint_and_bad_prefix_are_detected(self):
        def zero_generator(model, config, hours, seed, **kwargs):
            return features(np.zeros(hours+721)), {}
        check = val.randomness_checks(zero_generator, "sv_jump", {}, history_fixture())
        self.assertFalse(check["no_fixed_endpoint"])
        self.assertFalse(check["algorithm_checks_pass"])

        def horizon_sensitive(model, config, hours, seed, **kwargs):
            return random_generator(model, config, hours, seed+hours, **kwargs)
        check = val.randomness_checks(horizon_sensitive, "sv_jump", {}, history_fixture())
        self.assertFalse(check["prefix_invariant_to_requested_horizon"])

    def test_failed_path_is_retained_and_disqualifies_market_gate(self):
        def intermittent(model, config, hours, seed, **kwargs):
            if seed == 100+31:
                raise RuntimeError("deliberate numerical failure")
            return random_generator(model, config, hours, seed, **kwargs)
        simulated, failures, records, random = val.evaluate_generator(
            intermittent, "sv_jump", {}, history_fixture(), paths=3, seed=100)
        self.assertEqual(len(simulated), 2)
        self.assertEqual(len(records), 2)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["path"], 1)
        comparison = val.distribution_distance(simulated, simulated, {m: 1. for m in val.METRICS})
        gate = val.research_gate(comparison, random, len(failures))
        self.assertFalse(gate["research_gate_pass"])
        self.assertIn("numerical_failure", gate["failures"])

    def test_randomness_numerical_failure_is_not_silently_ignored(self):
        def failed(model, config, hours, seed, **kwargs):
            raise RuntimeError("bad parameter draw")
        simulated, failures, records, random = val.evaluate_generator(
            failed, "sv_jump", {}, history_fixture(), paths=2, seed=100)
        self.assertEqual(len(failures), 2)
        self.assertFalse(random["algorithm_checks_pass"])
        self.assertEqual(simulated, [])
        self.assertEqual(records, [])


if __name__ == "__main__":
    unittest.main()
