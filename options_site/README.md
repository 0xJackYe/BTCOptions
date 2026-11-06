# BTC 期权独立看板

生产地址：[btcopt.pages.dev](https://btcopt.pages.dev/)。源代码仓库：[BTCOptions](https://github.com/0xJackYe/BTCOptions)。

独立站复用终端期权页的行情链、买卖方向、单腿与组合到期盈亏、风险比较、CSV 导出和自选。卖方筛选覆盖 Put 和 Call，支持低风险、风险收益平衡、权利金三种排序。原本机版的 DeepSeek 自然语言服务和本地凭据仍由原终端管理。

- 行情由同源 Worker 读取 Binance Options 的公开 WebSocket 和 REST。网站每 12 秒读取一次快照，展示接收时间，保留真实的缺失和过期状态。后台标签页暂停轮询。
- 「币安账户」按需读取保证金账户和持仓。请使用 HMAC 只读 Key。Secret 仅在浏览器内用于签名，页面提交后清空密钥输入。API Key 和短时签名会通过站点 Worker 转发给币安。私有结果不进入服务端缓存、浏览器持久存储或 GitHub。Key 的 IP 白名单和地区权限由币安校验。
- 模拟计算和私有查询都不包含交易操作。组合和收益风险模型保留各自的计算口径。

## 构建和验证

在仓库根目录使用 Node.js 22 运行：

```sh
node options_site/check.mjs
```

构建输出为 `options_site/dist`，其中包括静态资产和 Cloudflare Pages Advanced Mode Worker。Cloudflare Pages 使用仓库根目录、构建命令 `node options_site/check.mjs`、输出目录 `options_site/dist`。推送到 `main` 后，GitHub Actions 先运行测试，再通过受限的 Cloudflare Deploy Hook 触发生产构建并验证线上 commit。测试失败时继续提供上一版。部署后 `/version.json` 显示实际部署的 Git commit，`/api/health` 检查路由可用，`/api/market` 独立报告币安数据状态。
