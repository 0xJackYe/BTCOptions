# BTCOptions

[打开 BTC 期权独立看板](https://btcopt.pages.dev/) · [策略看板](https://btcopt.pages.dev/strategy.html)（[使用说明](策略看板使用说明.md)） · [部署、测试与只读账户说明](options_site/README.md)

## 本地比特币终端

本地运行的比特币看板：价格警报、期权行情和盈亏模拟、钱包资产分布、BTC 定投成本与长期持仓浮盈。行情和账户统计只读，不提供下单功能。

## 启动

需要 Python 3.9 或更新版本；完整测试另需 Node.js。

```powershell
python -m pip install -r requirements.txt
python launch_btc_terminal.py
```

浏览器打开 <http://127.0.0.1:8766/>。Windows 也可使用 `启动比特币终端.bat`。

交易所连接在本机配置，只使用读取权限。密钥、账户绑定成本账本、钱包快照和日志保存在本机；仓库不会携带这些数据。新安装或迁移后需要自行配置账户并导入已核对的历史记录，未配置的模块会显示不可用。

离线钱包页面从本机快照生成；其源模板和计算代码包含在仓库内，生成文件不纳入版本控制。生成方法见 [钱包模块说明](terminal/wallet/README.md)。

## 使用与验证

- [终端使用说明](比特币终端使用说明.md)
- [长期持仓成本与浮盈计算](BTC-PNL.md)
- [期权收益风险比较](期权收益风险比较说明.md)
- [策略看板：对话策略的实时筛选](策略看板使用说明.md)

```powershell
python run_site_checks.py
```

完整回归使用模拟数据和临时本地服务，覆盖 Python 后台、前端、钱包计算及 Windows 启动策略。测试报告写入仅本机的 `verification/` 目录。
