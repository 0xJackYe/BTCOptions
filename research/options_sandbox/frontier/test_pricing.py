"""Quote-layer causality and accounting-input checks, without data downloads."""
import unittest
import numpy as np
from pricing import market


class PricingTests(unittest.TestCase):
    def config(self):
        return {"S0": 77000., "har_beta": [-.15, .2, .3, .25],
                "har_residual_variance": .08, "slow_std": .1, "slow_phi": .997,
                "fast_std": .08, "fast_phi": .8, "log_iv_level": -.1}

    def features(self, n):
        f = np.zeros((n, 4))
        f[:, 0] = .005*np.sin(np.arange(n)*1.7)
        f[:, 2] = np.maximum(f[:, 0], 0)+.002
        f[:, 3] = np.minimum(f[:, 0], 0)-.002
        return f

    def test_seed_prefix_including_initial_iv_and_execution_streams(self):
        a = market(self.features(1000), self.config(), 17, fast_noise=.25)
        b = market(self.features(1500), self.config(), 17, fast_noise=.25)
        for x, y in zip(a, b):
            np.testing.assert_array_equal(x, y[:len(x)])
        self.assertGreater(np.max(abs(a[3]-market(self.features(1000), self.config(), 18)[3])), .001)

    def test_changing_future_cannot_change_past_active_quotes(self):
        a = self.features(1400)
        b = a.copy()
        b[1100:, 0] -= .01
        ma, mb = market(a, self.config(), 123), market(b, self.config(), 123)
        for x, y in zip(ma, mb):
            np.testing.assert_array_equal(x[:1100], y[:1100])

    def test_ohlc_and_rv20_known_hour_formula(self):
        f = self.features(1100)
        m = market(f, self.config(), 33)
        self.assertAlmostEqual(m[0][720], 77000.)
        self.assertTrue(np.all(m[1] >= m[0]))
        self.assertTrue(np.all(m[2] <= m[0]))
        self.assertTrue(np.all(m[2] > 0))
        self.assertTrue(np.all(m[3] > 0))
        expected = np.std(f[901-479:902, 0], ddof=1)*np.sqrt(8760)
        self.assertAlmostEqual(m[4][901], expected)


if __name__ == "__main__":
    unittest.main()
