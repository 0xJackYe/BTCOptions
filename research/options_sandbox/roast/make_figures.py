"""Static report figures (PNG). Palette: reference categorical slots 1-3, validated (see report)."""
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from common import ROAST

R = ROAST / "results"
SURFACE, INK, INK2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e6e5e1"
S1, S2, S3 = "#2a78d6", "#eb6834", "#1baf7a"  # blue, orange, aqua (validated light-mode order)
plt.rcParams.update({"figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
                     "axes.edgecolor": GRID, "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2,
                     "text.color": INK, "axes.grid": True, "grid.color": GRID, "grid.linewidth": .8, "grid.linestyle": "-",
                     "axes.spines.top": False, "axes.spines.right": False, "font.size": 9.5, "axes.titlesize": 11,
                     "axes.titleweight": "bold", "legend.frameon": False})


def whisker(ax, rows, title, xlabel, fmt="{:.0%}"):
    """rows: list of (label, color, p05, p50, p95, mean_or_None)."""
    y = np.arange(len(rows))[::-1]
    for yi, (lab, col, lo, mid, hi, mean) in zip(y, rows):
        ax.plot([lo, hi], [yi, yi], color=col, lw=2, solid_capstyle="round")
        ax.plot([mid], [yi], "o", ms=8, color=col, mec=SURFACE, mew=2, zorder=3)
        if mean is not None:
            ax.plot([mean], [yi], "D", ms=6, color=INK, mec=SURFACE, mew=1.5, zorder=4)
        ax.text(mid, yi + .2, fmt.format(mid), va="bottom", ha="center", fontsize=8.5, color=INK2)
    ax.set_yticks(y, [r[0] for r in rows])
    ax.set_title(title, loc="left")
    ax.set_xlabel(xlabel)
    ax.grid(axis="y", visible=False)


def fig_generator():
    a = json.loads((R / "generator-audit.json").read_text())
    v = json.loads((R / "v2-validation.json").read_text())
    fig, axes = plt.subplots(1, 3, figsize=(16, 4.8), gridspec_kw={"width_ratios": [1.1, 1, 1.2]})
    # (a) annual vol envelope
    rows = []
    for lab, col, src in (("Real BTC 2020–26", S1, v["real_2020_2026"]["ann_vol"]), ("Real BTC 2023–26", S1, v["real_2023_2026"]["ann_vol"]),
                          ("Your bootstrap", S2, a["A_physical"]["stationary"]["ann_vol"]), ("Your GJR-FHS", S2, a["A_physical"]["gjr_fhs"]["ann_vol"]),
                          ("v2 boot_all", S3, v["boot_all"]["physical"]["ann_vol"]), ("v2 boot_recent", S3, v["boot_recent"]["physical"]["ann_vol"]),
                          ("v2 gjr_capped", S3, v["gjr_capped"]["physical"]["ann_vol"])):
        rows.append((lab, col, src["p05"], src["p50"], src["p95"], None))
    whisker(axes[0], rows, "365-day realized vol (p5 · median · p95)", "annualized volatility")
    axes[0].set_xlim(.3, 1.35)
    # (b) IV reaction to +/-10% 24h moves
    gens = [("Your bootstrap", a["C_iv_events"]["stationary"]), ("Your GJR-FHS", a["C_iv_events"]["gjr_fhs"]),
            ("v2 boot_all", {"crash": v["boot_all"]["events"]["crash"], "rally": v["boot_all"]["events"]["rally"]}),
            ("v2 boot_recent", {"crash": v["boot_recent"]["events"]["crash"], "rally": v["boot_recent"]["events"]["rally"]}),
            ("v2 gjr_capped", {"crash": v["gjr_capped"]["events"]["crash"], "rally": v["gjr_capped"]["events"]["rally"]})]
    yy = np.arange(len(gens))[::-1]
    for k, (name, col, off) in enumerate((("crash", S1, .18), ("rally", S2, -.18))):
        vals = []
        for _, g in gens:
            node = g[name]
            key = "iv_ratio_at_cross_vs_24h_before" if "iv_ratio_at_cross_vs_24h_before" in node else "iv_ratio_at_cross"
            vals.append(node[key]["p50"] - 1)
        axes[1].barh(yy + off, vals, height=.32, color=col, label=f"BTC {'-' if name == 'crash' else '+'}10% in 24h")
        for yi, val in zip(yy + off, vals):
            axes[1].text(val, yi, f" {val:+.0%}", va="center", fontsize=8.5, color=INK2)
    axes[1].axvline(.5, color=INK2, lw=1)
    axes[1].text(.51, yy[-1] - .45, "real BTC IV,\nAug-5-2024 ≈ +50%", fontsize=8, color=INK2, va="bottom")
    axes[1].set_xlim(0, .9)
    axes[1].set_yticks(yy, [g[0] for g in gens])
    axes[1].set_title("ATM IV jump when the 24h move crosses ±10%", loc="left")
    axes[1].set_xlabel("median change in ATM IV vs 24h earlier")
    axes[1].xaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1.0))
    axes[1].legend(loc="upper right", bbox_to_anchor=(1.0, 1.0))
    axes[1].grid(axis="y", visible=False)
    # (c) seller edge, 14d options sold at mark, held to expiry
    cats = ["put\n10% OTM", "put\n20% OTM", "call\n10% OTM", "call\n20% OTM"]

    def pick(rows, side, otm, key):
        return next(r[key] for r in rows if r["side"] == side and abs(r["otm"] - otm) < 1e-9)
    old = [pick(a["B_seller_edge"]["stationary"], s, o, "seller_edge_fraction_of_premium") for s, o in (("put", .1), ("put", .2), ("call", .1), ("call", .2))]
    new = [pick(v["boot_all"]["edge"], s, o, "seller_edge") for s, o in (("put", .1), ("put", .2), ("call", .1), ("call", .2))]
    x = np.arange(len(cats))
    axes[2].bar(x - .19, old, width=.34, color=S2, label="your bootstrap (+50%/yr drift)")
    axes[2].bar(x + .19, new, width=.34, color=S3, label="v2 boot_all (zero drift, real skew)")
    axes[2].axhline(0, color=INK2, lw=1)
    axes[2].set_xticks(x, cats)
    axes[2].yaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1.0))
    axes[2].set_title("Option-seller edge (14d, sold at mark)", loc="left")
    axes[2].legend(loc="lower left", fontsize=8.5)
    axes[2].set_ylabel("1 − mean payoff / mean premium")
    for xi, (o, n_) in enumerate(zip(old, new)):
        for off, val in ((-.19, o), (.19, n_)):
            axes[2].text(xi + off, val + (.02 if val >= 0 else -.02), f"{val:+.0%}", ha="center", va="bottom" if val >= 0 else "top", fontsize=7.5, color=INK2)
    axes[2].set_ylim(-.62, .62)
    axes[2].grid(axis="x", visible=False)
    fig.tight_layout()
    fig.savefig(R / "fig-generator-audit.png", dpi=150)


def fig_strategies(names):
    base = pd.read_csv(R / "robustness-paths-base.csv.gz")
    rep = pd.read_csv(R / "replay-real-deterministic.csv")
    fig, axes = plt.subplots(1, 2, figsize=(15, 4.8), gridspec_kw={"width_ratios": [1, 1.2]})
    cols = [S1, S2, S3]
    rows = []
    for (short, full), col in zip(names, cols):
        for model in ("boot_recent", "gjr_capped", "boot_all"):
            x = base[(base.strategy == full) & (base.model == model)].pnl.to_numpy()
            rows.append((f"{short} · {model}", col, np.quantile(x, .05), np.median(x), np.quantile(x, .95), x.mean()))
    whisker(axes[0], rows, "Monte Carlo: annual P&L on a 1,000 USDT account", "USDT per year   (line p5–p95 · ● median · ◆ mean)", fmt="{:+.0f}")
    axes[0].axvline(0, color=INK2, lw=1)
    years = sorted(rep.year.unique())
    x = np.arange(len(years))
    w = .26
    for k, ((short, full), col) in enumerate(zip(names, cols)):
        vals = [rep[(rep.year == y) & (rep.strategy == full)].pnl.iloc[0] for y in years]
        axes[1].bar(x + (k - 1) * w, vals, width=w - .03, color=col, label=short)
    axes[1].axhline(0, color=INK2, lw=1)
    axes[1].set_xticks(x, [str(y) if y < 2026 else "2026 YTD" for y in years])
    axes[1].set_title("Replay on the real BTC path, fresh account each year", loc="left")
    axes[1].set_ylabel("USDT")
    axes[1].legend(loc="lower right")
    axes[1].grid(axis="x", visible=False)
    fig.tight_layout()
    fig.savefig(R / "fig-strategies.png", dpi=150)


if __name__ == "__main__":
    import sys
    fig_generator()
    if len(sys.argv) > 1:
        fig_strategies(json.loads(sys.argv[1]))
