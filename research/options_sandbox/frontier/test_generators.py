"""Tests of physical random markets, not profitability or policy implementation."""
import copy
import json
import math
from pathlib import Path
import tempfile
import unittest

import numpy as np
import pandas as pd

import generators as g


def synthetic_history():
    rng = np.random.default_rng(80211)
    n = 6000
    x = np.empty(n)
    x[0] = math.log(.5)
    for i in range(1, n):
        x[i] = math.log(.5)+.99*(x[i-1]-math.log(.5))+.04*rng.standard_normal()
    r = np.exp(x)/math.sqrt(g.YEAR)*rng.standard_normal(n)
    r[::137] -= .035
    r[::223] += .04
    f = np.column_stack((r, np.zeros(n), np.maximum(r, 0)+.001,
                         np.minimum(r, 0)-.001))
    t0 = int(pd.Timestamp("2020-01-01", tz="UTC").timestamp())
    times = t0+3600*np.arange(n, dtype=np.int64)
    return {"features": f, "times": times}


class GeneratorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.history = synthetic_history()
        cls.config = g.fit(cls.history, Path(cls.tmp.name)/"calibration.json")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_fit_does_not_use_2024_or_later_returns(self):
        h = self.history
        t = int(pd.Timestamp("2024-01-01", tz="UTC").timestamp())+3600*np.arange(100)
        contaminated = {"times": np.r_[h["times"], t],
                        "features": np.vstack((h["features"], np.full((100, 4), 1000.)))}
        c = g.fit(contaminated, Path(self.tmp.name)/"future-not-fit.json")
        self.assertEqual(c, self.config)
        self.assertEqual(c["training"]["rows"], 6000)
        self.assertEqual(c["training"]["end_exclusive_utc"], "2024-01-01T00:00:00+00:00")

    def test_json_roundtrip_self_contained_generation(self):
        c = json.loads(json.dumps(self.config))
        for model in g.MODELS:
            a, _ = g.generate(model, c, 24, 71)
            b, _ = g.generate(model, self.config, 24, 71)
            np.testing.assert_array_equal(a, b)

    def test_seed_reproducibility_and_entire_future_prefix_invariance(self):
        for model in g.MODELS:
            for uncertain in (False, True):
                a, la = g.generate(model, self.config, 48, 105, parameter_uncertainty=uncertain)
                b, lb = g.generate(model, self.config, 336, 105, parameter_uncertainty=uncertain)
                np.testing.assert_array_equal(a, b[:len(a)])
                for key in ("annual_vol", "regime", "jump_count", "jump_log_return"):
                    np.testing.assert_array_equal(la[key], lb[key][:len(a)])
                repeat, _ = g.generate(model, self.config, 48, 105, parameter_uncertainty=uncertain)
                np.testing.assert_array_equal(a, repeat)

    def test_primary_returns_are_new_continuous_draws_not_historical_replay(self):
        source = self.history["features"][:, 0]
        for model in ("regime_jump", "sv_jump"):
            a, la = g.generate(model, self.config, 1000, 882)
            b, _ = g.generate(model, self.config, 1000, 883)
            self.assertTrue(la["new_parametric_draws"])
            self.assertFalse(np.array_equal(a, b))
            self.assertEqual(int(np.isin(a[:, 0], source).sum()), 0)

    def test_ohlc_substeps_bound_open_and_close_and_finite_positive_vol(self):
        for model in g.MODELS:
            f, latent = g.generate(model, self.config, 2160, 1212)
            self.assertEqual(f.shape, (2881, 4))
            self.assertTrue(np.isfinite(f).all())
            self.assertTrue(np.all(f[:, 2] >= np.maximum(f[:, 0]-f[:, 1], 0)))
            self.assertTrue(np.all(f[:, 3] <= np.minimum(f[:, 0]-f[:, 1], 0)))
            self.assertTrue(np.all(latent["annual_vol"] > 0))

    def controlled(self, model="sv_jump", **kw):
        c = copy.deepcopy(self.config)
        p = c["models"][model]
        p.pop("two_factor", None)
        p.update({"mu_log_annual_vol": [math.log(.3)], "phi": .99,
            "eta_logvol": [.04], "rho_price_vol": -.3,
            "transition": [[1.]], "jump_rate_per_hour": [.04],
            "jump_p_negative": .8, "jump_eta_negative": 20., "jump_eta_positive": 40.,
            "cojump_negative": 0., "cojump_positive": 0.})
        p.update(kw)
        return c

    def test_compensated_asymmetric_jump_process_has_zero_mean_log_drift(self):
        c = self.controlled(eta_logvol=[0.])
        f, latent = g.generate("sv_jump", c, 100000, 6677, parameter_uncertainty=False)
        r = f[g.WARMUP:, 0]
        p = c["models"]["sv_jump"]
        rate, pn = p["jump_rate_per_hour"][0], p["jump_p_negative"]
        variance = .3**2/g.YEAR+rate*(2*pn/20**2+2*(1-pn)/40**2)
        self.assertLess(abs(r.mean()), 4.5*math.sqrt(variance/len(r)))
        self.assertGreater(latent["jump_count"].sum(), 3500)
        self.assertLess(latent["jump_count"].sum(), 4500)

    def test_explicit_drift_is_annual_log_mean_not_arithmetic_drift(self):
        c = self.controlled(eta_logvol=[0.], jump_rate_per_hour=[0.])
        a, _ = g.generate("sv_jump", c, 200, 456, drift=0., parameter_uncertainty=False)
        b, _ = g.generate("sv_jump", c, 200, 456, drift=.35, parameter_uncertainty=False)
        np.testing.assert_allclose(b[:, 0]-a[:, 0], .35/g.YEAR, rtol=0, atol=1e-17)

    def test_bridge_extrema_match_brownian_range_marginals(self):
        c = self.controlled(mu_log_annual_vol=[math.log(.3)], eta_logvol=[0.],
                            jump_rate_per_hour=[0.], rho_price_vol=0.)
        f, latent = g.generate("sv_jump", c, 30000, 772, parameter_uncertainty=False)
        sigma_hour = .3/math.sqrt(g.YEAR)
        # Unconditional E[max(BM[0,1])] = sqrt(2/pi), and E[min]=-E[max].
        expected = math.sqrt(2/math.pi)
        self.assertLess(abs(f[:, 2].mean()/sigma_hour-expected), .025)
        self.assertLess(abs(f[:, 3].mean()/sigma_hour+expected), .025)
        self.assertTrue(latent["brownian_bridge_marginal_extrema"])

    def test_jump_sizes_are_unbounded_draws_not_recycled_or_clipped(self):
        c = self.controlled(eta_logvol=[0.], jump_rate_per_hour=[.2],
                            jump_eta_negative=2.02, jump_eta_positive=2.02)
        f, latent = g.generate("sv_jump", c, 10000, 62, parameter_uncertainty=False)
        # Much larger than historical one-hour moves: a stress distribution, not
        # a claim that these are realistic frequencies. No hidden return cap.
        self.assertGreater(np.max(np.abs(latent["jump_log_return"])), 2.)
        self.assertTrue(latent["no_return_or_volatility_cap"])

    def test_logvol_creates_positive_absolute_return_clustering(self):
        c = self.controlled(eta_logvol=[.05], jump_rate_per_hour=[0.])
        f, latent = g.generate("sv_jump", c, 15000, 996, parameter_uncertainty=False)
        a = np.abs(f[g.WARMUP:, 0])
        self.assertGreater(np.corrcoef(a[:-1], a[1:])[0, 1], .05)
        self.assertGreater(np.corrcoef(np.log(latent["annual_vol"][:-1]),
                                       np.log(latent["annual_vol"][1:]))[0, 1], .95)

    def test_two_factor_model_has_weekly_memory_and_retains_variance_budget(self):
        c = self.controlled(jump_rate_per_hour=[0.], cojump_negative=0., cojump_positive=0.)
        p = c["models"]["sv_jump"]
        p["two_factor"] = {"weight_slow": .6, "phi_slow": .999,
            "phi_fast": .7, "target_logvol_variance": .3,
            "annual_diffusion_variance_target": .09}
        g._two_factor_moments(p)
        f, latent = g.generate("sv_jump", c, 50000, 8632, parameter_uncertainty=False)
        lv = np.log(latent["annual_vol"])
        observed = np.corrcoef(lv[:-168], lv[168:])[0, 1]
        theoretical = .6*.999**168+.4*.7**168
        self.assertLess(abs(observed-theoretical), .12)
        self.assertGreater(observed, .3)
        self.assertEqual(latent["slow_logvol_factor"].shape, (50721,))
        self.assertLess(abs(np.mean(latent["annual_vol"]**2)/.09-1), .5)
        self.assertTrue(np.isfinite(f).all())

    def test_two_factor_training_scope_and_analytic_total_variance(self):
        p = self.config["models"]["sv_jump"]
        t = p["two_factor"]
        self.assertEqual(t["fit_cutoff_exclusive"], "2024-01-01T00:00:00+00:00")
        self.assertEqual(set(t["training_acf"]), {"1", "6", "24", "72", "168", "336", "720"})
        self.assertGreater(t["phi_slow"], t["phi_fast"])
        expected_diffusion = math.exp(2*p["mu_log_annual_vol"][0]
            +2*t["slow_gaussian_variance"]+2*t["fast_gaussian_variance"]
            +t["stationary_log_mgf_cojump_at2"])
        self.assertAlmostEqual(expected_diffusion+t["baseline_annual_jump_variance"],
                               t["baseline_total_annual_logreturn_variance_target"], places=11)

    def test_markov_regimes_and_poisson_frequency_match_declared_parameters(self):
        c = self.controlled(model="regime_jump", mu_log_annual_vol=[math.log(.2), math.log(.6)],
            eta_logvol=[0., 0.], transition=[[.99, .01], [.05, .95]], jump_rate_per_hour=[.02, .08])
        _, latent = g.generate("regime_jump", c, 30000, 1882, parameter_uncertainty=False)
        s = latent["regime"]
        self.assertLess(abs(np.mean(s == 0)-5/6), .05)
        for state, expected in ((0, .02), (1, .08)):
            observed = np.mean(latent["jump_count"][s == state])
            self.assertLess(abs(observed-expected), .012)
        p01 = np.mean(s[1:][s[:-1] == 0] == 1)
        p10 = np.mean(s[1:][s[:-1] == 1] == 0)
        self.assertLess(abs(p01-.01), .004)
        self.assertLess(abs(p10-.05), .015)

    def test_uncertainty_changes_fitted_parameters_once_per_path(self):
        _, a = g.generate("sv_jump", self.config, 24, 901, parameter_uncertainty=False)
        _, b = g.generate("sv_jump", self.config, 24, 901, parameter_uncertainty=True)
        self.assertEqual(a["sampled_parameters"], self.config["models"]["sv_jump"])
        self.assertNotEqual(a["sampled_parameters"], b["sampled_parameters"])
        p = b["sampled_parameters"]
        self.assertTrue(0 < p["phi"] < .9995)
        self.assertGreater(p["jump_eta_negative"], 2.01)

    def test_numerical_failure_is_raised_without_clipping_or_path_drop(self):
        c = self.controlled(mu_log_annual_vol=[1000.], eta_logvol=[0.])
        with self.assertRaises(g.NumericalMarketError):
            g.generate("sv_jump", c, 24, 49, parameter_uncertainty=False)

    def test_input_validation(self):
        for kw in ({"hours": True}, {"hours": 0}, {"seed": -1}, {"drift": np.nan},
                   {"parameter_uncertainty": "yes"}):
            args = {"hours": 24, "seed": 1}
            args.update(kw)
            with self.assertRaises(ValueError):
                g.generate("sv_jump", self.config, **args)
        with self.assertRaises(ValueError):
            g.generate("unknown", self.config, 24, 1)


if __name__ == "__main__":
    unittest.main()
