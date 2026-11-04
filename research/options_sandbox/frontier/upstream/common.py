"""Shared helpers for the roast study. Offline; no network, keys or orders.

Imports the user's sandbox (market_models / strategy_engine / run_sandbox) unchanged.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

ROAST = Path(__file__).resolve().parent
SANDBOX = ROAST.parent
sys.path.insert(0, str(SANDBOX))

import market_models as mm  # noqa: E402
import run_sandbox as rs  # noqa: E402
import strategy_engine as se  # noqa: E402

FROZEN = SANDBOX / "examples/2026-11-03"


def frozen_calibration(history):
    """Rebuild calibrate_price() outputs from the FROZEN published GJR parameters.

    scipy-version optimizer drift moves alpha/beta in the 4th digit; pinning the
    published parameters makes reproduction an exact-match test of everything else.
    """
    import pandas as pd
    cut = int(pd.Timestamp("2025-01-01", tz="UTC").timestamp())
    selected = history["times"] < cut
    f = history["features"][selected]
    times = history["times"][selected]
    cont = np.r_[np.diff(times) == 3600, False]
    p = json.loads((FROZEN / "price-calibration.json").read_text(encoding="utf-8"))
    mu = float(f[:, 0].mean())
    scale = float(np.mean((f[:, 0] - mu) ** 2))
    x = (f[:, 0] - mu) / math.sqrt(scale)
    h = mm.filter_variance(x, cont, p["omega_log_variance"] / scale, p["alpha"], p["gamma"], p["beta"], 1.0) * scale
    return p, f, cont, h


def ssvi():
    return json.loads((SANDBOX / "calibration/ssvi-calibration.json").read_text(encoding="utf-8"))


def load_all(frozen=True):
    history = mm.load_history()
    if frozen:
        calib, raw, follows, h = frozen_calibration(history)
    else:
        import tempfile
        calib, raw, follows, h = mm.calibrate_price(history, Path(tempfile.gettempdir()) / "pc.json")
    return history, calib, raw, follows, h, ssvi()

