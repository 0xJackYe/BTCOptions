"""Render frozen frontier research; never retune policies or market models."""
import argparse
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

import engine
from optimize import summarize

ROOT = Path(__file__).resolve().parent
SIDE = {0: "Put", 1: "Call", 2: "Put+Call"}


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def pct(x):
    return "%.2f%%" % (100*x)


def tail_stress(policies, quote_config, out):
    n, shock = 720+14*24+1, 720+5*24+9
    S = quote_config["S0"]
    surface = quote_config["surface"]
    rows = []
    for policy in policies:
        config = engine.params(**policy["config"])
        s = np.full(n, S)
        base = [s, s.copy(), s.copy(), np.full(n, .8), np.full(n, .6),
                np.full(n, .02), np.ones(n, dtype=bool), np.full((n, 2), .5), np.full((n, 2), .5)]
        args = (surface["term_coef"], surface["rho"], surface["eta"])
        pre, _ = engine.run(config, *[a[:shock] for a in base], *args)
        for gap in (-.15, -.25, -.35, -.50, -.70, .50, 1., 2.):
            mk = [a.copy() for a in base]
            for j in (0, 1, 2): mk[j][shock:] = S*(1+gap)
            mk[1][shock] = max(S, S*(1+gap))
            mk[2][shock] = min(S, S*(1+gap))
            mk[3][shock:] *= 3
            m, _ = engine.run(config, *mk, *args)
            rows.append({"policy": policy["id"], "gap": gap, "iv_after_multiplier": 3.,
                "before_open_liability": float(pre[16]), "before_filled_legs": int(pre[3]),
                "had_open_position_at_injection": bool(pre[16] > 0),
                **dict(zip(engine.OUT_NAMES, map(float, m)))})
    pd.DataFrame(rows).to_csv(out/"deterministic-gap-stress.csv", index=False)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="results")
    parser.add_argument("--market", default="market-validation-final")
    args = parser.parse_args()
    out, market_dir = Path(args.out), Path(args.market)
    if not out.is_absolute(): out = ROOT/out
    if not market_dir.is_absolute(): market_dir = ROOT/market_dir
    decision = read(out/"decision.json")
    if decision["smoke_only"]: raise ValueError("Smoke runs are not return evidence")
    protocol = read(out/"protocol.json")
    rank = read(out/"test-ranking.json")
    finalists = read(out/"frozen-finalists.json")
    policies = {p["id"]: p for p in finalists}
    c = next(p for p in protocol["candidates"] if p["id"] == "C_fixed_quantity")
    policies[c["id"]] = c
    validation = read(market_dir/"market-validation.json")
    manifest = read(market_dir/"validation-manifest.json")
    hashes = manifest["source_sha256"]
    expected = next(v for k, v in hashes.items() if k.replace("\\", "/").rsplit("/", 1)[-1] == "generators.py")
    actual = hashlib.sha256((ROOT/"generators.py").read_bytes()).hexdigest()
    if expected != actual: raise ValueError("Market validation used a different generator version")
    frame = pd.read_csv(out/"test-paths.csv.gz")
    summaries = {}
    for (cell, policy), f in frame.groupby(["cell", "policy"]):
        s = summarize(f[engine.OUT_NAMES].to_numpy())
        s["no_trade_fraction"] = float(np.mean(f.trades.to_numpy() == 0))
        summaries[cell, policy] = s
    published = [{"cell": cell, "policy": pid, **s} for (cell, pid), s in summaries.items()]
    (out/"test-summary-controls.json").write_text(json.dumps(published, indent=2), encoding="utf-8")
    stresses = tail_stress(list(policies.values()), read(out/"pricing-calibration.json"), out)
    models = protocol["models"]
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    x = np.arange(len(models))
    for i, p in enumerate(policies.values()):
        stats = [summaries[m+"/base", p["id"]] for m in models]
        y = np.array([s["mean_pnl_usdt"] for s in stats])
        half = np.array([(s["mean_return_mc95"][1]-s["mean_return"])*1000 for s in stats])
        axes[0].errorbar(x+(i-1.5)*.09, y, yerr=half, marker="o", linestyle="none", capsize=3,
                         label="C reference" if p["id"] == c["id"] else SIDE[p["config"]["side"]])
    axes[0].axhline(0, color="black", linewidth=1)
    axes[0].set_xticks(x, models, rotation=15)
    axes[0].set_ylabel("Annual mean PnL (USDT / initial 1000)")
    axes[0].set_title("Frozen independent-seed test | ordinary 95% MC intervals")
    axes[0].legend()
    axes[0].grid(axis="y", alpha=.2)
    selected_gaps = [-.70, -.50, -.35, -.25, -.15, .50, 1., 2.]
    for p in policies.values():
        vals = [next(r for r in stresses if r["policy"] == p["id"] and r["gap"] == gap) for gap in selected_gaps]
        axes[1].plot(np.arange(len(selected_gaps)),
            [(r["end_nav"]-1000) if r["had_open_position_at_injection"] else np.nan for r in vals], marker="o",
            label="C reference" if p["id"] == c["id"] else SIDE[p["config"]["side"]])
    axes[1].set_xticks(np.arange(len(selected_gaps)), ["%+.0f%%" % (100*g) for g in selected_gaps])
    axes[1].axhline(0, color="black", linewidth=1)
    axes[1].set_ylabel("End PnL in deterministic shock (USDT)")
    axes[1].set_title("One-hour gap + IV x3 | N/A if no pre-shock exposure")
    axes[1].legend()
    axes[1].grid(axis="y", alpha=.2)
    fig.tight_layout()
    fig.savefig(out/"frontier-results.png", dpi=160)
    plt.close(fig)
    lines = ["# Put / Call / 双卖：新随机市场研究结果", "",
        "本轮冻结有限候选、修复账户与执行后完成比较。全部数值是模型条件下的模拟证据，不是实际成交回报或未来保证。", "",
        "## 随机市场检验", "",
        "两个主发生器用新Gaussian/Poisson/双指数冲击，历史只估计参数；历史重采样另列对照。参数不按策略盈亏校准。", "",
        "|模型|平均标准化市场距离|研究门槛|随机性检查|", "|---|---:|---|---|"]
    for model in models:
        v = validation["models"][model]
        distance = v.get("validation", {}).get("mean_scaled_wasserstein", float("nan"))
        lines.append("|%s|%.3f|%s|见随包详细诊断|" % (model, distance, "通过" if v.get("research_gate_pass") else "未通过"))
    lines += ["", "门槛只用于研究筛选；即使通过也不能证明未来市场等价。2024只有四个不重叠90天窗口，而且用于模型结构选择；2025–2026以前已看过。", "",
        "## 策略测试", "",
        "217组有限候选；搜索24条90天路径/模型，验证128条年度路径/模型，每方向冻结一名，再用512条年度路径/模型测试。三种方向资金、数量和成交约束一致。", "",
        "|方向|候选期限/Delta|止盈/止损|入场|验证及最终均通过的模型内候选|", "|---|---|---|---|---|"]
    ranked = {r["policy"]: r for r in rank["ranked"]}
    valid = set(decision["validation_passed_ids"])
    for p in finalists:
        cfg, r = p["config"], ranked[p["id"]]
        ok = p["id"] in valid and r["risk_eligible"] and r["score"] > 0
        lines.append("|%s|%gd / %.2f|%g%% / %g倍|%s|%s|" % (SIDE[cfg["side"]], cfg["dte"], cfg["delta"],
            cfg["tp"]*100, cfg["sl"], "每日定时" if cfg["entry"] == 0 else "3%方向化逆向", "是" if ok else "否"))
    lines += ["", "下表是基础情景的平均年度净盈亏USDT，分母均为初始1000USDT；失败诊断候选也保留，不能把其行解读成推荐。", "",
        "|方向/对照|"+"|".join(models)+"|最差情景同时95%下界|", "|---|"+"---:|"*(len(models)+1)]
    for p in policies.values():
        values = ["%.2f" % summaries[m+"/base", p["id"]]["mean_pnl_usdt"] for m in models]
        name = "C固定数量对照" if p["id"] == c["id"] else SIDE[p["config"]["side"]]
        lines.append("|%s|%s|%s|" % (name, "|".join(values), pct(ranked[p["id"]]["score"])))
    selected = decision["conditional_selected_policy"]
    text_selected = "现金基准（未发现满足预声明条件的卖方候选）" if selected == "cash" else selected["id"]
    lines += ["", "|方向/对照|最差CVaR5|最高回撤95分位|单情景最多强平路径/512|最低平均年成交腿数|最高零成交比例|",
              "|---|---:|---:|---:|---:|---:|"]
    for p in policies.values():
        stats = [v for (cell, pid), v in summaries.items() if pid == p["id"]]
        name = "C固定数量对照" if p["id"] == c["id"] else SIDE[p["config"]["side"]]
        lines.append("|%s|%s|%s|%d|%.2f|%s|" % (name,
            pct(min(s["cvar5"] for s in stats)), pct(max(s["max_drawdown_p95"] for s in stats)),
            max(s["liquidation_paths"] for s in stats), min(s["mean_trades"] for s in stats),
            pct(max(s["no_trade_fraction"] for s in stats))))
    lines += ["", "模型内选择：**%s**。实际市场适配与执行证据仍不足，不自动推广实盘。" % text_selected, "",
        "零观察事件不等于零风险：每情景512条独立路径，零次强平时单侧95%模型条件概率上界约0.58%。不同情景共用路径，不能相加成独立样本。", "",
        "![基础收益与跳空压力](frontier-results.png)", "",
        "## 本轮修复与限制", "",
        "固定每腿0.01BTC、最多四腿；双卖成对进入；修正AE、95%强平阈值、平仓后MM重算和IM预算；盘中高低点风险先于普通止损，旧限价和新单成交均保持因果；期末负债/费用完整计入。", "",
        "OHLC取不利顺序属于保守压力近似，不是覆盖所有真实路径的严格损失上界；协调双腿和全部最小数量成交的假设未获真实盘口验证；行权仍用小时结算代理。止损不能限制跳空最大损失，Call空头理论损失无上限。", "",
        "当前一次SSVI截面、2023 IV动态、未来偏斜和真实成交缺少按时间留出的验证。新随机过程避免只复制历史，并不自动消除模型偏差。", "",
        "确定性跳空表见deterministic-gap-stress.csv：只对给定冲击展示损益，没有为极端冲击捏造发生概率。若注入前没有持仓，图中标为缺失、不与已持仓策略比较，不能将未暴露的零损失解释为安全。完整协议和候选均冻结，最终测试后不再调参追逐盈利。", ""]
    (out/"RESULT.md").write_bytes("\n".join(lines).encode("utf-8"))
    sources = {"report.py": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    artifacts = {n: hashlib.sha256((out/n).read_bytes()).hexdigest() for n in (
        "RESULT.md", "frontier-results.png", "test-summary-controls.json", "deterministic-gap-stress.csv")}
    (out/"report-manifest.json").write_text(json.dumps({"source_sha256": sources,
        "artifact_sha256": artifacts, "market_validation_sha256": hashlib.sha256((market_dir/"market-validation.json").read_bytes()).hexdigest()}, indent=2), encoding="utf-8")
    print(out/"RESULT.md")


if __name__ == "__main__":
    main()
