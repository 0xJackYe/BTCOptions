# 冻结研究示例：2026-11-05

[先看研究结果](RESULT.md)，[完整方法](../../README.md)。数字是固定模型条件下的模拟结果，没有实盘保证。

来源版本、候选、种子和规则见protocol.json。run-manifest.json记录本次执行源码和公开输入SHA256，报告另有report-manifest.json。

完整每路径CSV较大，留在本地，不随示例发布；manifest中保留其指纹。重跑../../optimize.py可以生成它们。price-calibration.json内的压缩数组是公开训练数据参考，不含账户资料。

market-validation是与本次源码匹配的最终市场诊断。market-iterations保存策略收益产生前的旧失败诊断，记录结构选择过程；旧版生成器的历史指纹不等同当前代码，不能用当前版本逐字复现老版本数值。

Windows manifest中的反斜杠是路径表示。数据下载见父级prepare_data.py，源码字段可按文件名与相对路径规范化后核对，不依赖原机器绝对路径。
