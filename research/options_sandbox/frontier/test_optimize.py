"""Independent finite-search and risk-selection checks; no model/strategy run."""
import itertools
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

import engine
import optimize as opt


class FrontierProtocolTests(unittest.TestCase):
    def test_grid_is_finite_unique_and_symmetric_except_declared_control(self):
        policies = opt.policy_grid()
        self.assertEqual(len(policies), 217)
        self.assertEqual(len({p["id"] for p in policies}), 217)
        self.assertEqual(policies[-1]["id"], "C_fixed_quantity")
        core = policies[:-1]
        self.assertEqual([sum(p["config"]["side"] == s for p in core) for s in (0, 1, 2)], [72, 72, 72])
        structures = []
        for side in (0, 1, 2):
            structures.append({tuple((k, v) for k, v in sorted(p["config"].items()) if k != "side")
                               for p in core if p["config"]["side"] == side})
        self.assertEqual(structures[0], structures[1])
        self.assertEqual(structures[1], structures[2])
        vectors = [engine.params(**p["config"]) for p in policies]
        self.assertEqual(len({tuple(v) for v in vectors}), 217)

    def test_every_direction_has_same_fixed_quantity_and_capital_constraints(self):
        self.assertEqual(engine.Q, .01)
        for p in opt.policy_grid():
            c = p["config"]
            self.assertEqual(c["risk"], 1.)
            self.assertEqual(c["maxpos"], 4)
            self.assertEqual(c["lever"], 3.)
            self.assertEqual(c["min_credit"], .5)
            self.assertEqual(c["wing"], 0.)
            self.assertEqual(c["pm"], 0.)
            self.assertEqual(c["slot_gap"], 24)
        fixed = opt.protocol()["fixed"]
        self.assertEqual(fixed["initial_usdt"], 1000)
        self.assertEqual(fixed["lot_btc"], .01)
        self.assertFalse(fixed["spot_trading"])
        self.assertIn("coordinated", fixed["entry_pairing"])
        self.assertIn("not native atomic guarantee", fixed["entry_pairing"])

    def test_protocol_separates_entry_notional_nav_from_wallet_margin_equity(self):
        fixed = opt.protocol()["fixed"]
        key = "max_entry_strike_or_spot_notional_to_postfill_NAV"
        self.assertEqual(fixed[key], 3)
        self.assertNotIn("max_total_strike_or_spot_notional_to_NAV", fixed)
        self.assertIn("Entry cap only", fixed["notional_note"])
        self.assertIn("Margin checks separately use wallet AE", fixed["notional_note"])
        # Same account, different denominators: a premium-bearing short book's
        # wallet AE supports margin, while close-out liability reduces NAV.
        wallet_ae, close_out_liability, maintenance_margin = 1000., 100., 500.
        economic_nav = wallet_ae-close_out_liability
        notional = 2800.
        self.assertLess(maintenance_margin/wallet_ae, .95)
        self.assertLess(notional, fixed[key]*wallet_ae)
        self.assertGreater(notional, fixed[key]*economic_nav)
        self.assertNotEqual(maintenance_margin/wallet_ae,
                            maintenance_margin/economic_nav)

    def test_formal_and_smoke_price_quote_seeds_are_separate(self):
        formal, smoke = opt.protocol(), opt.protocol(smoke=True)
        self.assertFalse(formal["smoke_only"])
        self.assertTrue(smoke["smoke_only"])
        formal_sets, smoke_sets = [], []
        for cohort in opt.COHORTS:
            f, s = formal["cohorts"][cohort], smoke["cohorts"][cohort]
            price = {f["seed_base"]+37*i for i in range(f["paths"])}
            quote = {x+11 for x in price}
            self.assertTrue(price.isdisjoint(quote))
            formal_sets.append(price | quote)
            smoke_price = {s["seed_base"]+37*i for i in range(s["paths"])}
            smoke_sets.append(smoke_price | {x+11 for x in smoke_price})
            self.assertEqual(s["days"], 30)
            self.assertEqual(s["paths"], 2)
        for a, b in itertools.combinations(formal_sets, 2):
            self.assertTrue(a.isdisjoint(b))
        all_formal = set.union(*formal_sets)
        self.assertTrue(all_formal.isdisjoint(set.union(*smoke_sets)))

    @staticmethod
    def ranking_fixture():
        ids = ("feasible", "liquidation", "bankruptcy", "cvar", "drawdown", "inactive")
        values = {}
        for pid in ids:
            a = np.zeros((20, len(engine.OUT_NAMES)))
            a[:, 0] = 1010 if pid == "feasible" else 1080
            a[:, 1] = a[:, 0]/1000-1
            a[:, 2], a[:, 3], a[:, 14] = .10, 6, 1
            values[pid] = a
        values["liquidation"][0, 7] = 1
        values["bankruptcy"][0, 15] = 1
        values["cvar"][0, 0] = 600
        values["drawdown"][:, 2] = .50
        values["inactive"][:, 3] = 0
        rows = [{"cell": cell, "policy": pid, "path": i, **dict(zip(engine.OUT_NAMES, v))}
                for cell in ("A/base", "A/stress") for pid, a in values.items() for i, v in enumerate(a)]
        frame = pd.DataFrame(rows).sample(frac=1, random_state=91)
        return frame, list(ids), ["A/base", "A/stress"]

    def test_risk_qualification_precedes_high_score_and_pairs_by_path(self):
        frame, ids, cells = self.ranking_fixture()
        seen = []
        def bounds(x, **kwargs):
            seen.append((x.copy(), kwargs))
            lower = np.full((len(cells), len(ids)), .05)
            lower[:, 0] = .001
            return {"lower_bounds": lower, "critical": 2., "degenerate_studentization_count": 0}
        with tempfile.TemporaryDirectory() as tmp, patch.object(opt, "simultaneous_lower_bounds", side_effect=bounds):
            ranked = opt.rank(frame, [{"id": x} for x in ids], cells, 365, Path(tmp), "fixture")
        self.assertEqual(ranked[0]["policy"], "feasible")
        self.assertTrue(ranked[0]["risk_eligible"])
        self.assertLess(ranked[0]["score"], ranked[1]["score"])
        failures = {r["policy"]: r["risk_failures"] for r in ranked}
        for pid, reason in (("liquidation", "liquidation"), ("bankruptcy", "bankruptcy"),
                            ("cvar", "cvar"), ("drawdown", "drawdown"), ("inactive", "inactivity")):
            self.assertTrue(any(x.endswith(":"+reason) for x in failures[pid]))
        x, kwargs = seen[0]
        self.assertEqual(x.shape, (2, 20, len(ids)))
        np.testing.assert_allclose(x[:, :, 0], .01)
        np.testing.assert_allclose(x[:, 0, 3], -.40)
        self.assertEqual(kwargs["studentization"], "observed")
        self.assertEqual(kwargs["resamples"], 2000)

    def test_side_shortlist_keeps_each_direction_and_respects_rank_order(self):
        policies = [{"id": f"{side}_{n}", "config": {"side": side}}
                    for side in (0, 1, 2) for n in (0, 1, 2)]
        order = ["1_1", "2_2", "0_2", "1_0", "0_0", "2_1", "0_1", "1_2", "2_0"]
        ranked = [{"policy": pid} for pid in order]
        one = opt.select_by_side(ranked, policies, 1)
        self.assertEqual([p["id"] for p in one], ["0_2", "1_1", "2_2"])
        two = opt.select_by_side(ranked, policies, 2)
        self.assertEqual([p["id"] for p in two], ["0_2", "0_0", "1_1", "1_0", "2_2", "2_1"])


if __name__ == "__main__":
    unittest.main()
