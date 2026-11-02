# BTC options research sandbox

本地离线的BTC期权蒙特卡洛研究工具，模拟“小仓位现货＋现金担保Put＋备兑Call”策略。

**策略规则已经固定为V1研究版，尚未证明最优或具有稳定超额收益。没有交易所账户连接、API Key或下单功能。**

- [先读通俗策略说明](STRATEGY.md)
- [查看冻结的年度示例与局限](examples/2026-11-03/README.md)
- [Roast report: generator audit, calibrated v2 generator, V1 roast and strategy search (English)](roast/ROAST_REPORT.md)

## 从新clone开始

以下命令在本目录运行：

```bash
cd research/options_sandbox
python -m pip install -r requirements.txt
python prepare_data.py
python -m unittest discover -s . -p 'test_*.py'
python run_sandbox.py --paths 256 --days 365 --seed 20261102 --out annual-results
python stress_cases.py --out annual-results
python write_report.py --out annual-results
```

`prepare_data.py`下载2020-01至2026-10的82个月币安公开现货小时档案，逐份验证官方SHA256，生成本地 `data/btc_spot_1h.csv`。不需要Key。网络不可用或校验失败时会明确报错，不把缺数据默默当成完整数据。

已有本地公开CSV时，可放到 `data/btc_spot_1h.csv`。原始ZIP、生成数据、缓存和运行输出由本目录 `.gitignore` 排除，冻结示例单独保存在 `examples/`。

当前已验证Python 3.9.13环境；精确依赖版本见 `requirements-tested.txt`。首次运行Numba需要编译。绘图中文字体依赖操作系统，数值计算不依赖字体。测试本身不需要下载历史档案。

## 怎么运行不同随机市场

`--paths`是每个模型的路径数，`--days`是每条路径的交易天数。每条路径额外预热720小时，预热期不交易。

- 固定seed重现同一随机市场；更换seed产生新随机实现，不预设价格终点。
- 同一模型的定价/价差/成交敏感性复用随机冲击，便于配对比较；它们不是独立样本。
- 256路径×2模型×6情景得到3072条策略结果，不代表3072个独立市场样本。
- `--paths 4 --days 30 --validation-paths 16`适合运行检查，不能用来估计尾部风险。

## 模型

### 价格

1. **Stationary bootstrap**：抽取几何长度的连续收益/OHLC块，平均72小时。缺小时处断块，保留块内厚尾、跳变及波动聚集。长于块的依赖可能丢失。
2. **GJR-FHS**：用2020—2024数据拟合非对称GARCH和Student-t似然，再重抽真实标准化冲击、递归更新波动。不是用独立正态涨跌替代BTC市场。

2025—2026-10留作价格诊断，检查小时/24小时尾部、绝对/平方收益自相关和同期限回撤。失败模型仍显示，不能用“随机”二字保证逼真。

### IV与报价

使用147份2023年公开EOH档案校准ATM IV共同因子、经验厚尾创新、价差和受约束SSVI曲面。初始多项式曲面存在静态套利违例，已拒绝；主程序只读取 `calibration/ssvi-calibration.json`。

没有强制IV永远是RV的1.2倍。静态曲面约束不代表价格/IV联合动态无套利，也不能证明2023的定价关系适用于未来。

冻结的SSVI和创新CSV属于公开数据衍生物，可直接用于模拟。重做校准是可选步骤：

```bash
python prepare_data.py --options
python calibration/calibrate_iv.py
python calibration/diagnose_calibration.py
```

可选下载约56MB的147份冻结EOH档案；缺失字段、报价时序和模型误差说明见 [校准说明](calibration/校准说明.md)。

## 资金、策略与执行

示例初始0.01BTC＋1000USDT，0.09BTC核心仓排除。规则见 [STRATEGY.md](STRATEGY.md)。期权钱包、现货与组合净值分开，现货不抵扣普通期权账户保证金。期末未平空头按ask加预计买回费用记负债。

输出分列期权净贡献和现货库存调整相对持有贡献，不把BTC上涨归功于卖期权。

这是小时级V1变体，主要限制：

- 已结束小时产生信号，最早下一小时按固定合约、限价重新准入，不等同于30秒FOK重试或5秒止损。
- 未来挂牌使用假设的周五08UTC到期、1000USDT行权价网格和5USDT报价格点，不能保证等于未来真实目录。
- 未重建盘口队列、精确深度冲击及部分成交；基准合格报价假设足量成交，压力情景引入15%未成交假设，该值不是估出的真实失败率。
- 小时内高低价顺序未知，使用不利端点估算风险与潜在强平。这不是交易所真实强平概率。
- 正常在72小时前退出；异常到期使用小时收盘作为最终结算代理，未还原官方30分钟均价。
- 基准使用历史对数漂移，另有零对数漂移情景。零对数漂移不等于价格算术期望不变。
- Monte Carlo区间仅反映固定模型下的抽样，不能覆盖模型、IV面、制度、流动性等不确定性。

## 输出

| 文件 | 内容 |
|---|---|
| `results.json` | 设定、情景统计、限制与失败记录 |
| `path-results.csv` | 每条路径的净值、回撤、保证金、费用、库存和贡献 |
| `scenario-summary.csv` | 情景汇总 |
| `model-validation.json` | 留出诊断，含失败指标 |
| `sample-nav-paths.csv` | 示例每日净值及持有基准 |
| `run-manifest.json` | 种子、库版本、源码和输入SHA256 |
| `tail-stress.json` | 独立极端注入，不混入随机概率 |
| `沙箱结果报告.md` | 中文报告和假设 |

原V1的期限硬边界仍为10—20天，目标14天。不要仅改函数的 `target_dte` 或参考JSON，就把结果称为另一组真实期限参数的比较。

## 依据

- [Binance公开数据与官方校验说明](https://github.com/binance/binance-public-data)
- [Politis/Romano Stationary Bootstrap](https://doi.org/10.1080/01621459.1994.10476870)
- [GJR与厚尾波动模型](https://arch.readthedocs.io/en/latest/univariate/univariate_volatility_modeling.html)
- [Gatheral/Jacquier SVI](https://arxiv.org/abs/1204.0646)
- [Binance期权卖方与保证金规则](https://www.binance.com/en/support/faq/detail/1ceb77f837344e3085ecf98d9a6a8097)
