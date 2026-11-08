# BTC 期权独立看板

生产地址：[btcopt.pages.dev](https://btcopt.pages.dev/)。源代码仓库：[BTCOptions](https://github.com/0xJackYe/BTCOptions)。

**策略看板**（`/strategy`）把对话中的期权策略做成实时筛选器：点击策略即按币安实时报价筛出满足条件的合约或组合，附到期损益、规则检查、压力测试与资金规划。行情在后台线程中计算，看板资源带内容版本号、可长期缓存。见 [策略看板使用说明](../策略看板使用说明.md)（第七节为性能、可靠性与设计）；只读账户的 API Key 配置见该文第四节与仓库根目录的 `.env.example`。

独立站复用终端期权页的行情链、买卖方向、单腿与组合到期盈亏、风险比较、CSV 导出和自选。卖方筛选覆盖 Put 和 Call，支持低风险、风险收益平衡、权利金三种排序。原本机版的 DeepSeek 自然语言服务和本地凭据仍由原终端管理。

- 行情优先使用网站线路。币安拒绝 Cloudflare 请求时，页面自动直连币安官方 WebSocket，显示真实报价、深度、IV、Greeks 和指数。直连行情缺少完整合约规则与 24 小时统计，风险筛选需通过本机连接器核验。
- 「币安账户」默认由网站通过法兰克福云后端读取保证金账户和持仓。请使用 HMAC 只读 Key。Secret 仅在浏览器内用于签名，页面提交后清空密钥输入。API Key 和短时签名经网站及云后端转发给币安。私有结果不进入服务端缓存、浏览器持久存储或 GitHub。Key 的 IP 白名单和地区权限由币安校验。
- 模拟计算和私有查询都不包含交易操作。组合和收益风险模型保留各自的计算口径。

## 完整看板与只读账户

在仓库根目录运行以下命令，连接器独立于原总终端。

    node options_site/build.mjs
    node options_site/local_bridge.mjs

本机连接器为可选线路。启动后可打开 <http://127.0.0.1:8767/>，也可在网站选择「连接本机行情」并允许浏览器访问本地网络。账户页的本机线路需单独勾选，查询开始后固定该次请求的线路。真实账户读取仍需用户输入只读 Key 验证。

Windows 可双击 `options_site/start-local.cmd` 启动可选连接器。云后端为 <https://btcoptions.onrender.com>，使用 Render 免费实例。空闲 15 分钟后可能休眠，唤醒约需一分钟；`.github/workflows/keep-warm.yml` 每 10 分钟访问一次健康检查以减少休眠。唤醒期间网页可显示公开直连行情，完整规则和风险筛选在云端恢复后自动更新。

## 构建和验证

在仓库根目录使用 Node.js 22 运行：

```sh
node options_site/check.mjs
node options_site/e2e/strategy-desk.e2e.mjs   # 可选：浏览器端到端检查，需要 Playwright
```

构建输出为 `options_site/dist`，其中包括静态资产和 Cloudflare Pages Worker。Cloudflare 使用仓库根目录、构建命令 `node options_site/check.mjs`、输出目录 `options_site/dist`。Worker 的固定云后端地址在 `worker-entry.mjs` 中配置，部署凭据保存在 GitHub Actions Secrets。推送到 `main` 后，GitHub Actions 先测试，再通过受限 Deploy Hook 更新云后端，验证后端 commit 后发布网站并验证网站 commit。测试或后端部署失败时继续提供上一版网站。两个服务的 `/version.json` 均显示实际部署的 Git commit。
