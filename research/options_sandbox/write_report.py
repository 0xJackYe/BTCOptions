# -*- coding: utf-8 -*-
"""Render a standalone research report from completed Monte Carlo artifacts."""
import argparse
import json
from pathlib import Path
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent
NAMES = {"base": "基准定价", "low_iv": "IV降低15%", "high_iv": "IV提高15%", "wide_spread": "价差翻倍", "execution_stress": "价差翻倍＋15%不成交", "zero_drift": "历史漂移归零"}
MODELS = {"stationary": "历史连续块", "gjr_fhs": "GJR过滤历史冲击"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="annual-results")
    args = ap.parse_args()
    out = ROOT / args.out
    result = json.loads((out / "results.json").read_text(encoding="utf-8"))
    records = pd.read_csv(out / "path-results.csv")
    assert records.invariant_violations.sum() == 0
    np.testing.assert_allclose(records.end_nav, records.end_wallet_usdt + records.end_btc * ((records.holding_benchmark_nav - 1000) / .01) - records.terminal_option_liability, rtol=1e-10, atol=1e-7)
    np.testing.assert_allclose(records.end_nav - records.holding_benchmark_nav, records.option_pnl_including_terminal_liability + records.inventory_rebalance_pnl_vs_hold, rtol=1e-9, atol=1e-7)
    summaries = result["summary"]
    lines = ["# BTC期权蒙特卡洛研究沙箱：首轮结果", "", "完成日期：2026-11-03（北京时间）；发布的冻结V1研究样例。", "", "**这是已运行的小时级研究沙箱，不是真实订单回测，也不是收益预测。随机性通过有种子的随机数生成器实现，可复现、可换种子。仿真程度通过留出数据诊断而非宣称保证。**", "", f"每模型{result['paths_per_model']}条独立随机冲击路径，每条{result['horizon_days']}天；两套模型、六种情景，共{len(records):,}条策略路径结果。数值失败{len(result['numerical_failures'])}条。初始0.01BTC＋1,000USDT，BTC起点77,928.48USDT，总资本约1,779.28USDT；0.09BTC核心仓完全排除。", "", "## 模型和历史数据", "", "现货模型只用2020—2024的43,801条有效小时收益校准，2025—2026年10月留作价格诊断。原始数据82个月官方SHA256通过；缺小时处不串接收益块。期权IV、价差用147份已校验2023年官方小时档案校准，与价格生成机制分开。", "", "- 历史连续块：随机抽取平均72小时的几何长度收益/OHLC块，保留块内厚尾、急跌、波动聚集。不能自动创造历史上未见过的冲击，长于块的依赖可能丢失。", "- GJR过滤历史冲击：拟合非对称GARCH与Student-t似然，再随机抽取真实标准化冲击、递归更新方差。创新来自经验残差，不是独立正态涨跌。", "- 期权市场：随机ATM IV共同因子＋受约束SSVI微笑/期限结构；买价向下、卖价向上按5USDT取格，另计真实规则形式的交易/行权/强平费用。没有规定IV必须大于RV的1.20倍。", "", "## 留出样本检验", "", "预先固定的描述性门槛：至少80%的13项诊断，其留出观测位于128条90天模拟路径的95%区间；门槛不是正式统计证明。", "", "| 价格模型 | 相容指标 | 门槛结果 | 未相容指标 |", "|---|---:|---|---|"]
    for model, v in result["model_validation"].items():
        lines.append(f"| {MODELS[model]} | {v['compatible_metrics']}/{v['total_metrics']} | {'达到探索门槛' if v['exploratory_gate_pass'] else '未达到'} | {', '.join(v['failed_metrics'])} |")
    lines += ["", "未通过的模型结果仍完整保留作模型风险对照，不能冒充已验证的市场概率。检验涉及小时/24小时尾部分位、绝对及平方收益自相关、同期限回撤。GJR的周尺度平方收益依赖仍不匹配，期权2026定价和秒级执行也没有通过独立验证。", "", "## 策略表现", "", "下列百分比都按完整初始资本计算，含现货市值、空头买回负债与费用。比较基准是同一路径下始终持有0.01BTC＋1,000USDT。", "", "| 模型／情景 | 收益中位数 | 收益5%—95%区间 | 平均相对持有超额 | 亏损路径比例 | 回撤95%分位 | 平均开仓腿数 |", "|---|---:|---:|---:|---:|---:|---:|"]
    for s in summaries:
        lines.append(f"| {MODELS[s['model']]}／{NAMES[s['scenario']]} | {s['median_total_return']:.2%} | {s['total_return_p05']:.2%} ～ {s['total_return_p95']:.2%} | {s['mean_excess_return']:.2%} | {s['probability_of_loss_model_conditional']:.2%} | {s['max_drawdown_p95']:.2%} | {s['mean_opened_legs']:.2f} |")
    lines += ["", "这些比例只是各个假设模型下的模拟频率。表内区间是路径结果的分位数，不是对真实未来收益的95%保证。均值可能受极端路径影响；详见逐路径CSV、模型数值失败和尾部样本数。", "", "## 期权贡献与现货调整贡献", "", "| 模型基准情景 | 平均期权盈亏，含终点负债 | 平均库存调整相对持有贡献 | 期末未平负债均值 | 可能小时内强平路径 |", "|---|---:|---:|---:|---:|"]
    for model, g in records[records.scenario == "base"].groupby("model"):
        lines.append(f"| {MODELS[model]} | {g.option_pnl_including_terminal_liability.mean():.2f} USDT | {g.inventory_rebalance_pnl_vs_hold.mean():.2f} USDT | {g.terminal_option_liability.mean():.2f} USDT | {(g.potential_intrahour_liquidations > 0).mean():.2%} |")
    lines += ["",
         "两项贡献之和等于策略期末净值减持有基准，逐路径已勾稽。库存贡献可能来自改变BTC敞口，不能归功于卖期权的定价优势。强平栏是使用小时High/Low和保守报价做的潜在事件上界，不是真实交易所强平概率。",
         "",
         "## 已实现规则与研究变体",
         "",
         "实现原V1的±3%穿越、反向小时0.25%确认、12小时观察、24小时冷却、10—20DTE、Delta0.05—0.15、价外10%—25%、IV/RV20门槛、同到期、单边0.01张、现金/库存/覆盖、72场景开仓压力检查、60%净止盈、Delta0.35/触价退出、72小时退出、25%净值回撤暂停及期权后现货转换。",
         "",
         "为保持时间因果，信号在已结束小时产生，下单最早在下一小时成交，固定原行权价与限价并重新准入。这不等同于原规则的30秒FOK重试。价格触及或潜在强平的小时内顺序未知，使用不利端点估算风险成交。",
         "",
         "现金储备不足时记录并关闭期权风险，不假装储备从不受亏损影响。初始开仓前严格检查覆盖和预算；期末未平空头仍按ask＋买回费用记负债，没有清零或只统计收到的权利金。",
         "",
         "## 尚不能称为真实交易所的部分",
         "",
         "1. 只有小时数据，不能验证5秒止损、毫秒网络延迟、盘口排队、部分成交及小时内事件先后。基准成交假设偏理想，压力版加入15%未成交假设；这个15%不是从档案估出的真实失败率。",
         "2. 未来合约由每周五08UTC、1,000USDT行权价网格生成；未来币安真实挂牌、最小量和价格限制可能不同。0.01张、5USDT格点是研究设定。",
         "3. 正常72小时前退出；执行失败进入到期分支时，以模拟小时收盘作为结算代理，尚未还原官方最终30分钟均价。",
         "4. 期权AE仅计钱包，策略现货不抵扣普通账户保证金；实际清算引擎和费率以交易所为准。MM保守加入清算费用储备。",
         "5. IV来自2023有限行情，SSVI只有静态约束和有限网格通过；未证明价格/IV联合动态无套利。IV创新可能带ATM合约切换噪声。定价误差、未来流动性与制度变化不能靠增加路径数消除。",
         "6. 基准历史对数漂移约50.4%/年，是历史统计而非预测；另跑零漂移情景。模型参数不以策略利润调优。",
         "7. 数值失败如非零必须保留，不得通过丢弃坏路径把策略变好；本次失败清单见results.json。",
         "",
         "## 复现",
         "",
         "```powershell",
         "python research/options_sandbox/run_sandbox.py --paths 256 --days 365 --seed 20261102 --out annual-results",
         "python research/options_sandbox/write_report.py --out annual-results",
         "python -m unittest discover -s research/options_sandbox -p 'test_*.py'",
         "```",
         "",
         "修改seed会得到新的随机实现；使用同seed可以重现同一市场。需要numpy、pandas、scipy、numba、matplotlib，当前本机环境已具备。脚本只读本地公开数据，无网络、密钥、账户或下单能力。",
         "",
         "![模拟结果图](sandbox-results.png)",
         "",
         "原始逐路径结果：path-results.csv；模型诊断：model-validation.json；完整设定、失败及结果：results.json；示例每日净值：sample-nav-paths.csv。",
         "",
         "## 依据",
         "",
         "- [Politis/Romano Stationary Bootstrap](https://doi.org/10.1080/01621459.1994.10476870)",
         "- [波动模型、GJR与厚尾模拟的官方文档](https://arch.readthedocs.io/en/latest/univariate/univariate_volatility_modeling.html)",
         "- [Gatheral/Jacquier：无静态套利SVI曲面](https://arxiv.org/abs/1204.0646)",
         "- [币安期权保证金规则](https://www.binance.com/en/support/faq/detail/1ceb77f837344e3085ecf98d9a6a8097)"]
    stress_path = out / "tail-stress.json"
    if stress_path.exists():
        cases = json.loads(stress_path.read_text(encoding="utf-8"))["cases"]
        tail = ["", "## 独立极端注入测试", "",
                "另外在已确认开仓后注入极端跳变。它们不进入蒙特卡洛概率或收益统计，也不声称是历史发生率。每例初始现价80,000、0.01BTC＋1,000USDT。", "",
                "| 人为压力路径 | 总净值收益 | 期末期权钱包 | 潜在强平事件 |", "|---|---:|---:|---:|"]
        for case in cases:
            m = case["metrics"]
            title = "Put开仓后单小时下跌70%" if case["case"].startswith("put") else "Call开仓后单小时上涨200%"
            tail.append(f"| {title} | {m['total_return']:.2%} | {m['end_wallet_usdt']:.2f} USDT | {int(m['potential_intrahour_liquidations'])} |")
        tail.extend(["", "下跌例说明25%回撤触发不能保证亏损止于25%。上涨例说明现货覆盖下组合可以盈利，期权钱包仍可能亏空；负值是模拟待处置亏空，未模拟保险基金、ADL和实际追索规则。不能把普通账户的组合净值当期权保证金。", ""])
        where = lines.index("## 复现")
        lines[where:where] = tail
    breached = int((records.cash_reserve_breach_hours > 0).sum())
    lines += ["", f"完整情景结果中，库存/Call覆盖不变量违规为0；现金储备不足风险被记录在{breached}条策略情景路径中，已进入关闭风险分支。它是亏损导致的预算风险事件，不是隐去后宣称预算永不受损。"]
    (out / "沙箱结果报告.md").write_text("\n".join(lines), encoding="utf-8")
    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    fig, axes = plt.subplots(2, 2, figsize=(13, 9), constrained_layout=True)
    colors = {"stationary": "#2563eb", "gjr_fhs": "#d97706"}
    scenarios = list(NAMES)
    for model in MODELS:
        mid, lo, hi = [], [], []
        for scenario in scenarios:
            g = records[(records.model == model) & (records.scenario == scenario)].excess_return
            mid.append(g.median() * 100); lo.append(g.quantile(.05) * 100); hi.append(g.quantile(.95) * 100)
        y = np.arange(len(scenarios)) + (-.12 if model == "stationary" else .12)
        axes[0, 0].errorbar(mid, y, xerr=[np.array(mid) - lo, np.array(hi) - mid], fmt="o", color=colors[model], label=MODELS[model], capsize=3)
    axes[0, 0].set_yticks(range(len(scenarios)), [NAMES[x] for x in scenarios])
    axes[0, 0].axvline(0, color="#64748b", lw=.8)
    axes[0, 0].set(title="相对持有基准的超额收益", xlabel="百分点：点为中位数，线为5%—95%路径区间")
    axes[0, 0].legend(fontsize=8)
    for model in MODELS:
        g = records[(records.model == model) & (records.scenario == "base")].max_drawdown.sort_values().to_numpy() * 100
        axes[0, 1].plot(g, np.arange(1, len(g) + 1) / len(g), color=colors[model], label=MODELS[model])
    axes[0, 1].set(title="基准情景：最大回撤分布", xlabel="最大回撤（%）", ylabel="累计路径比例")
    axes[0, 1].legend(fontsize=8)
    traces = pd.read_csv(out / "sample-nav-paths.csv")
    for path, group in traces[traces.model == "gjr_fhs"].groupby("path"):
        axes[1, 0].plot(group.day, group.nav, lw=1, alpha=.75, label=f"路径{path}")
    axes[1, 0].set(title="GJR模型：5条示例净值路径", xlabel="天", ylabel="策略净值（USDT）")
    axes[1, 0].legend(fontsize=8)
    base = records[records.scenario == "base"]
    for j, (model, group) in enumerate(base.groupby("model")):
        axes[1, 1].bar(j - .15, group.option_pnl_including_terminal_liability.mean(), width=.28, color="#2563eb", label="期权净贡献" if j == 0 else None)
        axes[1, 1].bar(j + .15, group.inventory_rebalance_pnl_vs_hold.mean(), width=.28, color="#d97706", label="库存调整贡献" if j == 0 else None)
    axes[1, 1].set_xticks(range(2), [MODELS[x] for x in sorted(MODELS)])
    axes[1, 1].axhline(0, color="#64748b", lw=.8)
    axes[1, 1].set(title="超额盈亏来源分解", ylabel="平均USDT，包含终点期权负债")
    axes[1, 1].legend(fontsize=8)
    for ax in axes.flat:
        ax.grid(alpha=.15)
        ax.spines[["top", "right"]].set_visible(False)
    fig.suptitle("BTC期权研究沙箱 · 模型条件下的模拟结果，不是未来收益承诺", fontsize=15)
    fig.savefig(out / "sandbox-results.png", dpi=160)
    print(out / "沙箱结果报告.md")


if __name__ == "__main__":
    main()
