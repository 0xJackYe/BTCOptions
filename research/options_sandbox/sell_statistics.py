"""Offline, paired Monte Carlo statistics; no market fitting or order access.

Intervals describe sampling uncertainty of means conditional on the supplied
market models. They are not probabilities of profit or protection against model
misspecification. Paths must be independent; all candidate/cell columns use the
same path identity so a joint row bootstrap preserves common random numbers.
"""
import math
import numbers
from statistics import NormalDist

import numpy as np


def _positive_integer(value, name, minimum=1):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, numbers.Integral) or value < minimum:
        raise ValueError(name + " must be an integer >= " + str(minimum))
    return int(value)


def _alpha(value):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, numbers.Real) or not math.isfinite(value) or not 0 < value < 1:
        raise ValueError("alpha must be finite and in (0,1)")
    return float(value)


def _metric_array(metrics):
    m = np.asarray(metrics, dtype=np.float64)
    if m.ndim != 2 or m.shape[1] != 25 or m.shape[0] < 2:
        raise ValueError("metrics must have shape [paths >= 2, 25]")
    if not np.isfinite(m).all():
        raise ValueError("metrics must contain only finite values")
    if np.any(m[:, 21] <= 0):
        raise ValueError("initial NAV in metrics[:,21] must be positive")
    return m


def _moments(values, axis=0):
    mean = np.mean(values, axis=axis)
    se = np.std(values, axis=axis, ddof=1) / math.sqrt(values.shape[axis])
    # Repeated decimal constants can have tiny floating-point residual variance.
    constant = np.max(values, axis=axis) == np.min(values, axis=axis)
    se = np.where(constant, 0.0, se)
    if not np.isfinite(mean).all() or not np.isfinite(se).all():
        raise ValueError("values overflow finite mean/standard-error arithmetic")
    return mean, se


def zero_event_upper_bound(n_paths, alpha=.05):
    """Exact one-sided 1-alpha binomial upper bound, ONLY if zero events.

    This is a path-event probability bound, unlike a mean-return confidence
    interval. Independence is required. No empirical event probability is set
    to zero merely because none happened in this finite simulation.
    """
    n = _positive_integer(n_paths, "n_paths")
    alpha = _alpha(alpha)
    return -math.expm1(math.log(alpha) / n)


def paired_summary(candidate_metrics, horizon_days=365., seed=20261103,
                   resamples=2000, alpha=.05):
    """Paired strategy-minus-hold returns with normal and percentile CIs.

    Hold NAV and initial NAV are columns 1 and 21, respectively. Normal and
    bootstrap intervals target the mean of paired path differences. Annualized
    arithmetic values are explicitly labeled and do not imply compounding.
    """
    m = _metric_array(candidate_metrics)
    alpha = _alpha(alpha)
    resamples = _positive_integer(resamples, "resamples", 2)
    if isinstance(horizon_days, (bool, np.bool_)) or not isinstance(horizon_days, numbers.Real) or not math.isfinite(horizon_days) or horizon_days <= 0:
        raise ValueError("horizon_days must be a finite positive number")
    excess = (m[:, 0] - m[:, 1]) / m[:, 21]
    if not np.isfinite(excess).all():
        raise ValueError("paired excess returns must be finite")
    mean, se = _moments(excess)
    z = NormalDist().inv_cdf(1 - alpha / 2)
    n = len(m)
    rng = np.random.default_rng(seed)
    means = np.empty(resamples)
    chunk = max(1, min(256, 1_000_000 // n))
    for start in range(0, resamples, chunk):
        stop = min(start + chunk, resamples)
        indices = rng.integers(0, n, size=(stop - start, n))
        means[start:stop] = excess[indices].mean(axis=1)
    bootstrap = np.quantile(means, (alpha / 2, 1 - alpha / 2))
    normal = [float(mean - z * se), float(mean + z * se)]
    annual_factor = 365. / float(horizon_days)
    return {
        "n_paths": n, "horizon_days": float(horizon_days),
        "confidence_level": 1 - alpha,
        "mean_excess_return": float(mean),
        "median_excess_return": float(np.median(excess)),
        "paired_standard_error": float(se),
        "normal_CI": normal,
        "paired_bootstrap_CI": [float(x) for x in bootstrap],
        "arithmetic_annualized_mean_excess_return": float(mean * annual_factor),
        "arithmetic_annualized_normal_CI": [x * annual_factor for x in normal],
    }


def simultaneous_lower_bounds(excess, seed=20261103, resamples=2000, alpha=.05,
                              studentization="observed"):
    """Approximate one-sided joint lower bounds over ALL cells/candidates.

    Input shape is [cells, paths, candidates]. Each bootstrap draws ONE common
    row-index vector for every cell and candidate. Centered bootstrap means are
    divided by the ORIGINAL sample SE (studentization='observed', default).
    The critical value is the upper 1-alpha quantile of the maximum standardized
    value over the entire family. This avoids unstable division by a resample's
    zero SE in sparse trading columns.

    studentization='resampled' retains full bootstrap-t for diagnostics. Its
    denominator is floored at observed_SE*1e-12 when a nonconstant column's
    resample degenerates. Such samples are NEVER dropped. The diagnostic can
    produce extremely conservative bounds for sparse data. Degenerate resample
    counts are reported in either mode. Exactly constant original columns have
    zero SE and lower=mean under either method.

    This is a bootstrap approximation, NOT a finite-sample strict familywise
    coverage guarantee. Sparse data, small N, unseen tails and market-model
    misspecification are not fixed by multiplicity adjustment. Small-N smoke
    runs have no substantive inferential use.
    """
    x = np.asarray(excess, dtype=np.float64)
    if x.ndim != 3 or x.shape[0] < 1 or x.shape[1] < 2 or x.shape[2] < 1:
        raise ValueError("excess must have shape [cells >= 1, paths >= 2, candidates >= 1]")
    if not np.isfinite(x).all():
        raise ValueError("excess must contain only finite values")
    alpha = _alpha(alpha)
    resamples = _positive_integer(resamples, "resamples", 2)
    if studentization not in ("observed", "resampled"):
        raise ValueError("studentization must be observed or resampled")
    cells, n, candidates = x.shape
    flat = np.ascontiguousarray(x.transpose(1, 0, 2).reshape(n, cells * candidates))
    mean, se = _moments(flat)
    active = se > 0
    family_size = int(np.count_nonzero(active))
    degeneracies = 0
    critical = 0.0
    if family_size:
        centered = np.ascontiguousarray(flat[:, active] - mean[active])
        ref_se = se[active]
        if not np.isfinite(centered).all():
            raise ValueError("centering overflowed finite arithmetic")
        rng = np.random.default_rng(seed)
        maxima = np.empty(resamples)
        # Keep the large [resample, path, family] temporary around 8MB.
        chunk = max(1, min(64, 1_000_000 // (n * family_size)))
        for start in range(0, resamples, chunk):
            stop = min(start + chunk, resamples)
            indices = rng.integers(0, n, size=(stop - start, n))
            draws = centered[indices]
            boot_mean = draws.mean(axis=1)
            boot_se = draws.std(axis=1, ddof=1) / math.sqrt(n)
            floor = ref_se * 1e-12
            # Count sparse/zero-SE resamples under both methods. Observed-SE
            # standardization does not divide by this random zero denominator.
            degeneracies += int(np.count_nonzero(boot_se <= floor))
            if studentization == "observed":
                studentized = boot_mean / ref_se
            else:
                studentized = boot_mean / np.maximum(boot_se, floor)
            maxima[start:stop] = studentized.max(axis=1)
        if not np.isfinite(maxima).all():
            raise ValueError("studentization overflowed finite arithmetic")
        # Empirical inverse-CDF quantile; avoids version-dependent np keywords.
        rank = min(resamples - 1, max(0, int(math.ceil((1 - alpha) * resamples)) - 1))
        critical = max(0., float(np.sort(maxima)[rank]))
    lower = mean - critical * se
    if not np.isfinite(lower).all():
        raise ValueError("confidence bounds overflowed finite arithmetic")
    return {
        "lower_bounds": lower.reshape(cells, candidates),
        "mean": mean.reshape(cells, candidates),
        "se": se.reshape(cells, candidates),
        "critical": critical,
        "alpha": alpha, "confidence_level": 1 - alpha,
        "one_sided": True, "resamples": resamples,
        "family_size": cells * candidates,
        "nonconstant_family_size": family_size,
        "degenerate_studentization_count": degeneracies,
        "studentization": studentization,
        "studentization_floor_relative": 1e-12 if studentization == "resampled" else None,
        "coverage": "bootstrap approximation; not a finite-sample strict FWER guarantee",
    }


def summarize_metrics(metrics):
    """JSON-ready path summary; normal mean-excess CI is not a profit chance.

    CVaR95 is SIGNED return averaged across the worst ceil(.05*N) paths, not
    its positive loss magnitude and not an option-premium-only statistic.
    Zero-event bounds apply separately to zero observed liquidation, negative
    wallet or invariant-violation PATHS; None means this zero-event formula
    cannot be used because at least one event was actually observed.
    """
    m = _metric_array(metrics)
    n = len(m)
    excess = (m[:, 0] - m[:, 1]) / m[:, 21]
    returns = m[:, 0] / m[:, 21] - 1
    if not np.isfinite(excess).all() or not np.isfinite(returns).all():
        raise ValueError("returns must be finite")
    mean, se = _moments(excess)
    z = NormalDist().inv_cdf(.975)
    tail_count = max(1, int(math.ceil(.05 * n)))
    liq_paths = int(np.count_nonzero(m[:, 8] > 0))
    wallet_paths = int(np.count_nonzero(m[:, 14] < 0))
    violation_paths = int(np.count_nonzero(m[:, 19] > 0))
    upper = zero_event_upper_bound(n)
    return {
        "n_paths": n,
        "mean_excess_return": float(mean),
        "excess_CI95": [float(mean - z * se), float(mean + z * se)],
        "excess_standard_error": float(se),
        "mean_return": float(np.mean(returns)),
        "median_return": float(np.median(returns)),
        "CVaR95": float(np.mean(np.sort(returns)[:tail_count])),
        "CVaR95_tail_paths": tail_count,
        "max_drawdown_p95": float(np.quantile(m[:, 4], .95)),
        "mean_trades": float(np.mean(m[:, 6])),
        "liq_count": int(np.sum(m[:, 8])),
        "liquidation_path_count": liq_paths,
        "negative_wallet_count": wallet_paths,
        "invariants": int(np.sum(m[:, 19])),
        "invariant_violation_path_count": violation_paths,
        "mean_options_pnl": float(np.mean(m[:, 23])),
        "mean_inventory_rebalance_pnl": float(np.mean(m[:, 24])),
        "zero_event_probability_upper95": upper if liq_paths == 0 else None,
        "negative_wallet_probability_upper95": upper if wallet_paths == 0 else None,
        "invariant_violation_probability_upper95": upper if violation_paths == 0 else None,
    }
