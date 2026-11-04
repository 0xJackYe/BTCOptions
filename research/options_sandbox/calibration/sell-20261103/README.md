# 2026-11-03 市场拟真验证与当前 SSVI 公共资料包

本目录只保存公开市场数据、市场拟合脚本、验证结果和指纹。没有 API Key、账户、订单或策略收益输入。

可直接在本目录运行：

```powershell
python fit_current_ssvi.py
```

依赖 Python 3.9+、numpy、pandas、scipy。脚本只读本目录 `current-cross-section.csv` 和 `current-cross-section-check.json`，不联网、不访问主策略代码。重跑会更新 `current-ssvi-calibration.json` 与 `current-ssvi-cross-validation.csv`。同环境下已实跑比对输出 SHA256。

- `CURRENT_SSVI_CALIBRATION.md`：当前截面四参数 SSVI、整组交叉验证、误差和限制。
- `MARKET_FIT_AUDIT.md`：价格同长度验证、2023 IV 时间切分、旧 SSVI 对当前市场失配的审计。
- `current-ssvi-calibration.json`：供研究读取的当前冻结 shape、ATM14、as-of、拟合范围、组外误差与源 SHA。
- `ssvi-2023-baseline.json`：保留的历史失配模型，供模型风险场景比较。
- `PUBLIC_QUOTE_SNAPSHOT.json`：本次 60 个合约的原始公开规则、mark、ticker 字段，公开指数、服务器时间、最近 1000h spot，以及完整源响应的 SHA256/URL/采集时间。它是有明确标记的摘录，不冒充完整交易所响应。
- `input-manifest.json`：完整研究输入的文件指纹；147 个历史 ZIP 和历史大 spot 数据不随本资料包复制。价格和历史 IV 验证结果随包保存，但重跑这些历史分析需要另外获取完整公开输入。
- `CHECKSUMS.sha256`：资料包文件校验值。

服务器 as-of 为 2026-11-02 20:15:46.966 UTC（北京 2026-11-03 04:15:46.966）。本机请求时间 20:15:26.950–20:15:28.429 UTC，存在约 19 秒时钟偏移。不同接口并非原子快照，报价命中不能当成成交保证。

当前拟合范围仅 **10–20 DTE**，实际只有 **10.4890、17.4890 天** 两个期限。5-fold 按 `(expiry,strike)` 整组划分，同 K 的 Call/Put 不跨训练测试。该验证检验当前缺失行权价的插值，**不能验证未来、未见到期日或动态 IV**。将参数用于 7–10、21–35 DTE 或持仓临近到期属于外推，不能推广为已验证的实盘定价。

价格发生器只用 2020–2023 拟合，2024 选模；已看过的 2025–2026 数据仅作 legacy 诊断。新 MC 种子不能把已查看市场数据重新变成首次留出。静态曲面检查不能证明真实测度 P、风险中性测度 Q 与成交过程的联合动态一致性。

原分析位置是 `analysis/sell-optimization-20261103/market-validation/`。报告中引用的完整历史数据和采集脚本路径属于该原分析目录；本资料包的当前拟合重放完全独立。
