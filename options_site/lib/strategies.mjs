/**
 * Strategy catalog distilled from the options conversation
 * (分享对话可见消息.md), the trading model note (币安BTC期权交易模型.md) and the
 * user's earlier workbench settings. Every default records its provenance so
 * the interface can tell the user's own rules apart from suggestions.
 *
 * Pure data + validation. Shared by the browser, the Node backend and tests.
 */

export const ORIGINS = Object.freeze({
  user: {label: "你的规则", hint: "来自对话中你本人提出的规则"},
  assistant: {label: "对话建议", hint: "来自对话中助手的建议，你未逐项确认"},
  workbench: {label: "工作台设置", hint: "来自你此前在卖 Put / 卖 Call 工作台使用的默认条件"},
  model: {label: "交易模型", hint: "来自《币安 BTC 期权交易模型》中你确认的资金设定"},
  system: {label: "系统默认", hint: "可调整的通用默认值，不是对话原文"},
});

/** Metric registry: semantics, units and the direction that counts as better. */
export const METRICS = Object.freeze({
  annualYield: {label: "年化收益率", short: "年化", unit: "%", better: "high", digits: 2,
    help: "净权利金 ÷ 资金基数 × 365 ÷ 剩余天数。卖 Put 的资金基数为行权价 × 数量（现金担保口径，对话 #62）；价差为最大亏损；卖 Call 为现货名义金额。不是预期收益。"},
  periodYield: {label: "本期收益率", short: "本期", unit: "%", better: "high", digits: 3,
    help: "净权利金 ÷ 资金基数，持有到期且不被行权时的单期收益率。"},
  dailyPremium: {label: "日均权利金", short: "日均", unit: "USDT", better: "high", digits: 3,
    help: "净权利金 ÷ 剩余天数。对应你在对话 #44 比较「每天收多少权利金」的方法。"},
  netCredit: {label: "净权利金", short: "净权利金", unit: "USDT", better: "high", digits: 2,
    help: "按可成交价（卖出用买一、买入用卖一）计算的期初现金流，已扣开仓手续费；负数表示净支出。"},
  maxProfit: {label: "最大盈利", short: "最大盈利", unit: "USDT", better: "high", digits: 2,
    help: "持有到期的理论最大净盈利，含行权费。"},
  maxLoss: {label: "最大亏损", short: "最大亏损", unit: "USDT", better: "low", digits: 2,
    help: "持有到期、结算价在全部非负区间内的理论最大净亏损，含行权费。不包含提前强平路径。"},
  returnOnRisk: {label: "收益 / 风险", short: "收益/风险", unit: "%", better: "high", digits: 2,
    help: "最大盈利 ÷ 最大亏损。适用于有限风险组合。"},
  annualRor: {label: "年化收益 / 风险", short: "年化 RoR", unit: "%", better: "high", digits: 1,
    help: "收益 / 风险 × 365 ÷ 剩余天数。"},
  ev: {label: "模型期望收益", short: "期望", unit: "USDT", better: "high", digits: 2,
    help: "在预测波动率 σ（默认 30 日已实现波动率）的对数正态假设下，到期净盈亏的期望值。对应对话 #65 的「预期净收益 = P − E[max(K−S,0)] − 交易成本」。仅为模型值，BTC 真实尾部比对数正态更厚。"},
  evRisk: {label: "期望 / 最大亏损", short: "EV/风险", unit: "%", better: "high", digits: 2,
    help: "模型期望收益 ÷ 最大亏损。"},
  pop: {label: "盈利概率", short: "胜率", unit: "%", better: "high", digits: 1,
    help: "市场隐含口径：用合约自身标记 IV（多腿用到期日平值 IV）在对数正态下计算到期净盈利 > 0 的概率。高胜率不等于正期望（对话 #88）。"},
  pItm: {label: "行权概率", short: "实值概率", unit: "%", better: "low", digits: 2,
    help: "主风险腿到期进入实值的隐含概率（N(−d2)）。Delta 不等于概率。"},
  es99: {label: "尾部损失 ES99", short: "ES99", unit: "USDT", better: "low", digits: 2,
    help: "模型最差 1% 情景的平均亏损（预测 σ，对数正态）。不是最大亏损上限。"},
  breakevenDist: {label: "盈亏平衡距离", short: "保本距离", unit: "%", better: "high", digits: 2,
    help: "当前指数到盈亏平衡价的距离。卖 Put 为 (指数 − 平衡价) ÷ 指数。"},
  otm: {label: "价外幅度", short: "价外", unit: "%", better: "high", digits: 2,
    help: "Put 为 1 − 行权价 ÷ 指数；Call 为 行权价 ÷ 指数 − 1。对话 #44 的「预留 20%–30%」。"},
  dte: {label: "剩余天数", short: "天数", unit: "天", better: null, digits: 1, help: "距 08:00 UTC 到期的精确天数。"},
  iv: {label: "隐含波动率", short: "IV", unit: "%", better: null, digits: 1, help: "主风险腿的标记 IV。"},
  ivRv: {label: "IV / RV", short: "IV/RV", unit: "×", better: "high", digits: 2,
    help: "标记 IV ÷ 30 日已实现波动率。大于 1 表示期权定价的波动高于近期实际波动（波动率风险溢价，对话 #65）。"},
  richness: {label: "IV 相对微笑溢价", short: "IV 溢价", unit: "vol", better: "high", digits: 2,
    help: "可成交 IV（卖出用买一 IV）减去同到期日拟合波动率微笑在该行权价的值，单位为波动率点。对应对话 #65「比较相同到期日、相近 Delta 的期权的 IV」。"},
  delta: {label: "组合 Delta", short: "Δ", unit: "BTC", better: null, digits: 4, help: "按数量合计的方向敞口，正数为看涨。"},
  theta: {label: "组合 Theta", short: "Θ/天", unit: "USDT", better: null, digits: 3, help: "每过一天的时间价值变化（币安标记 Greeks）。"},
  vega: {label: "组合 Vega", short: "Vega", unit: "USDT", better: null, digits: 3, help: "IV 每变化 1 个波动率点的价值变化。"},
  spread: {label: "买卖价差", short: "价差", unit: "%", better: "low", digits: 1,
    help: "各腿 (卖一 − 买一) ÷ 中间价 的最大值。流动性越差越大。"},
  costAnnual: {label: "年化保护成本", short: "年化成本", unit: "%", better: "low", digits: 2,
    help: "权利金与手续费 ÷ 被保护现货名义 × 365 ÷ 剩余天数。对话 #26：每月重复支付权利金会侵蚀长期收益。"},
  protection: {label: "保护起点", short: "免赔", unit: "%", better: "low", digits: 2,
    help: "现货 + Put 的最大跌幅（含权利金）÷ 指数，相当于保险的免赔额。"},
  termSpread: {label: "期限结构价差", short: "近−远 IV", unit: "vol", better: "high", digits: 2,
    help: "近月卖出腿 IV − 远月买入腿 IV。正值时日历价差更有利。"},
  budgetPremium: {label: "预算内净权利金", short: "预算权利金", unit: "USDT", better: "high", digits: 2,
    help: "按剩余风险预算 ÷ 单位最大亏损向下取整后的数量计算的净权利金（交易模型 §5，对话 #146）。"},
  budgetQty: {label: "预算内最大数量", short: "预算数量", unit: "BTC", better: "high", digits: 2,
    help: "剩余风险预算 ÷ 每 BTC 最大到期亏损，按合约步长向下取整。"},
  moveToBe: {label: "保本所需波动", short: "所需波动", unit: "%", better: "low", digits: 2,
    help: "到期时 BTC 需要偏离当前指数多少才能保本（取较近的一侧）。"},
  moveRatio: {label: "所需 ÷ 隐含波动", short: "所需/隐含", unit: "×", better: "low", digits: 2,
    help: "保本所需波动 ÷ 隐含 1σ 波动幅度。小于 1 表示保本门槛低于市场预期的一个标准差。"},
  marginIm: {label: "开仓保证金（估）", short: "初始保证金", unit: "USDT", better: "low", digits: 2,
    help: "按币安清算规则逐腿估算的卖方开仓初始保证金加买方权利金。默认账户不按价差抵扣。"},
});

const RANGE = (key, label, unit, min, max, step, value, origin, help) =>
  ({key, type: "range", label, unit, min, max, step, default: value, origin, help});
const NUMBER = (key, label, unit, min, max, step, value, origin, help) =>
  ({key, type: "number", label, unit, min, max, step, default: value, origin, help});
const SELECT = (key, label, options, value, origin, help) =>
  ({key, type: "select", label, options, default: value, origin, help});

const TRIGGER_PARAMS = (mode = "watch") => [
  SELECT("trigger", "急跌触发", [
    {value: "watch", label: "观察名单：未触发时照常列出并标注"},
    {value: "strict", label: "严格：未触发时不给候选"},
    {value: "off", label: "忽略触发条件"},
  ], mode, "assistant", "对话 #76：急跌 5% 是观察信号，不应单独作为入场信号。"),
  SELECT("dropWindow", "急跌窗口", [
    {value: 4, label: "4 小时"}, {value: 24, label: "24 小时"}, {value: 72, label: "72 小时"}, {value: 168, label: "7 天"},
  ], 24, "system", "「短时间」在对话中没有精确定义，默认 24 小时，可调整。"),
  NUMBER("dropPct", "急跌幅度", "%", 1, 40, .5, 5, "user", "对话 #44：短时间内跌约 5%。按窗口内最高价到当前指数的回撤计算。"),
];

const QUANTITY_PARAMS = (mode, value, origin, help) => [
  SELECT("quantityMode", "数量方式", [
    {value: "fixed", label: "固定数量"},
    {value: "budget", label: "按风险预算最大化"},
    {value: "holdings", label: "匹配现货持仓"},
  ], mode, origin, help),
  NUMBER("quantity", "固定数量", "BTC", .01, 100, .01, value, origin,
    "币安 BTC 期权 1 张 = 1 BTC，最小 0.01 张。对话 #107 建议起步总仓位不超过 0.01 BTC。"),
];

const SPREAD_PARAM = (value = 40) => NUMBER("maxSpread", "最大买卖价差", "%", 1, 200, 1, value, "workbench",
  "按 (卖一 − 买一) ÷ 中间价 计算。你此前工作台用 (卖一 − 买一) ÷ 买一 ≤ 50%，约等于中间价口径 40%。");

const RANK = (options, value) => SELECT("rank", "排序依据", options.map(key => ({value: key, label: METRICS[key].label})), value, "system",
  "排序只在同一组假设内比较候选，不是推荐或预测。");

const CITE = {
  m14: {ref: 14, who: "助手", quote: "交易策略：Long Call、Long Put、Covered Call、Protective Put、Straddle、Strangle、Vertical Spread、Calendar Spread、Ratio Spread 等。"},
  m26: {ref: 26, who: "助手", quote: "持有 0.07 BTC……买入覆盖 0.07 BTC 的一个月期 Put 组合。行权价为 80,000 美元。Protective Put 的本质是用确定的期权费购买下行保护。"},
  m44: {ref: 44, who: "你", quote: "每当比特币下跌，发生一些剧烈下跌，就比如说短时间内跌个百分之五这样的，那我就会开始去卖 Put……一般都是一两个月，然后价格会预留百分之二十甚至百分之三十。"},
  m62: {ref: 62, who: "助手", quote: "年化权利金收益率 = 权利金 ÷ 行权价 × 365 ÷ 剩余天数 × 100%；盈亏平衡价格 = K − P。"},
  m65iv: {ref: 65, who: "助手", quote: "你以后至少应该比较相同到期日、相近 Delta 的期权的 IV……高 IV 是考虑卖出的条件之一，不是充分条件。"},
  m65stress: {ref: 65, who: "助手", quote: "假设卖出后 BTC 再跌 20%、40% 和 60%，分别计算期权亏损、现货浮亏和剩余可用现金。"},
  m69: {ref: 69, who: "你", quote: "我卖 put 不是为了交割比特币……下跌了我可以花额外的现金去抄底比特币。"},
  m76: {ref: 76, who: "助手", quote: "当 BTC 出现短期 5% 以上的下跌时，开始观察 Put 报价……优先检查 30–60 天到期、行权价低于现价 20%–30% 的 Put。"},
  m77: {ref: 77, who: "你", quote: "A —— 无论浮亏多少，只要保证金足够，就坚持持有到期。"},
  m88: {ref: 88, who: "助手", quote: "95% 的交易到期赚 25 美元；5% 的交易到期亏损 1,000 美元……即使胜率高达 95%，长期数学期望仍为负数。"},
  m107: {ref: 107, who: "助手", quote: "初始总仓位不超过 0.01 BTC……所有未到期 Put 的最大到期赔付合计控制在现有 BTC 价值的约 10% 以内……权利金过低时宁可不交易。"},
  m121: {ref: 121, who: "你", quote: "比如说现在一张比特币期权是八千美元，然后我就卖出 0.1 张。"},
  m130: {ref: 130, who: "你", quote: "我的期权账户还有一个功能，是用来确保我的现金流的……我就可以让它为我赚一个源源不断的现金流。"},
  m139: {ref: 139, who: "助手", quote: "期限 30 天、0.1 BTC、每 BTC 报价 $500，实收 $50；相对 5,500 美元担保资金，简单年度权利金比例约 10.9%……必须允许某些月份完全不交易。"},
  m141: {ref: 141, who: "你", quote: "就算比如说跌到五万五千或者更低了……比特币已经跌到了……我抄底的目标价，那那样也可以。"},
  m146: {ref: 146, who: "助手", quote: "卖出 $55,000 Put，同时买入同到期日 $40,000 Put，这叫做 Bull Put Spread；最大到期净亏损 = (55,000 − 40,000) × 0.1 − 净权利金。"},
  m146budget: {ref: 146, who: "助手", quote: "在最大亏损预算 1,000 美元的情况下，哪种 Put 或 Put Spread 能提供风险调整后更有吸引力的净权利金？"},
  model: {ref: "model", who: "你", quote: "期权账户投入 1,000 USDT，并接受该风险资金全部亏损；q ≤ 风险预算 ÷ (K − p)。"},
  wbPut: {ref: "workbench-put", who: "你", quote: "BTC Put，行权价为当前指数的 75%–80%，剩余 10–20 天，默认先按接近 15 天排序；最大买卖价差 50%。"},
  wbCall: {ref: "workbench-call", who: "你", quote: "我的 Call 条件：剩余 10–20 天、行权价高于当前指数 20%–25%。"},
};

/**
 * Builders: single | vertical | budget | straddle | strangle | calendar | ratio.
 * Leg actions: SELL uses the best bid, BUY uses the best ask.
 */
export const STRATEGIES = Object.freeze([
  {
    id: "crash-put", group: "playbook", hotkey: "1", builder: "single", leg: {action: "SELL", type: "PUT"},
    name: "急跌卖 Put", nameEn: "Crash-Triggered Cash-Secured Put",
    tagline: "BTC 短时急跌后，卖出 1–2 个月、价外 20%–30% 的现金担保 Put，持有到期",
    view: {direction: "看涨 / 中性", vol: "做空波动率", risk: "高 · 尾部风险，现金担保"},
    collateral: "cash",
    rules: [
      "急跌触发：窗口内从最高价回撤 ≥ 5%（观察信号，非充分条件）",
      "期限 30–60 天，行权价低于指数 20%–32%",
      "按现金担保年化收益率排序，同时看 IV/RV、价差与极端损失",
      "按行权价 × 数量预留足额 USDT，持有到期（选择 A）",
    ],
    params: [
      ...TRIGGER_PARAMS("watch"),
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [30, 60], "user", "对话 #44「一般都是一两个月」，对话 #76 细化为 30–60 天。"),
      RANGE("otm", "价外幅度", "%", 0, 80, .5, [20, 32], "user",
        "对话 #44「预留 20% 甚至 30%」。80,000 → 55,000 的例子实际为 31.25%，所以上限默认 32%。"),
      NUMBER("minAnnual", "最低年化", "%", 0, 300, .5, 3, "system",
        "对话 #107「权利金过低时宁可不交易」，0.41% 年化的例子被判定不足以补偿风险。3% 为可调门槛。"),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("fixed", .01, "assistant", "对话 #107：初始总仓位不超过 0.01 BTC。"),
      RANK(["annualYield", "dailyPremium", "ev", "pop", "ivRv", "richness", "otm", "breakevenDist"], "annualYield"),
    ],
    columns: ["otm", "dte", "netCredit", "dailyPremium", "annualYield", "pop", "ev", "ivRv", "maxLoss", "spread"],
    stress: {moves: [-.2, -.4, -.6], ivShifts: [0, .2, .6], source: "m65stress"},
    citations: ["m44", "m76", "m62", "m77", "m107"],
    warnings: ["卖 Put 不会自动买入 BTC；币安现金结算，下跌后需另用现金抄底（对话 #66、#69）。",
      "保证金充足不等于风险可承受；保证金不足时币安可直接强平，不会等待补仓（对话 #88）。"],
  },
  {
    id: "bull-put", group: "playbook", hotkey: "2", builder: "vertical", vertical: {type: "PUT", kind: "credit"},
    name: "牛市看跌价差", nameEn: "Bull Put Credit Spread",
    tagline: "卖出价外 Put，同时买入更低行权价 Put，把最大亏损锁定在价差宽度内",
    view: {direction: "看涨 / 中性", vol: "做空波动率", risk: "中 · 最大亏损有限"},
    collateral: "maxLoss",
    rules: [
      "卖出腿价外 20%–32%，买入腿同到期、行权价更低",
      "价差宽度为指数的 3%–20%（币安 1–2 个月合约通常只挂到价外约 27%）",
      "最大到期亏损 = 宽度 × 数量 − 净权利金（对话 #146）",
      "币安默认账户不按价差抵扣保证金，两腿需分别满足保证金",
    ],
    params: [
      ...TRIGGER_PARAMS("watch"),
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [30, 60], "user", "沿用急跌卖 Put 的 1–2 个月期限（对话 #44、#76）。"),
      RANGE("shortOtm", "卖出腿价外", "%", 0, 80, .5, [20, 32], "user", "沿用对话 #44 的 20%–30% 安全边际。"),
      RANGE("width", "价差宽度", "% 指数", 1, 60, .5, [3, 20], "system",
        "对话 #146 的 55,000 / 40,000 例子宽度约为指数的 18.75%；但币安 1–2 个月到期的 Put 通常只挂到价外约 27%，默认放宽到 3%–20% 才能组成价差。"),
      NUMBER("minRor", "最低收益 / 风险", "%", 0, 500, .5, 2, "system", "净权利金 ÷ 最大亏损的下限。"),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("budget", .1, "model", "默认按 1,000 USDT 风险预算 ÷ 每 BTC 最大亏损取整；对话 #146 示例为 0.1 BTC。"),
      RANK(["annualRor", "returnOnRisk", "ev", "evRisk", "pop", "netCredit", "budgetPremium"], "annualRor"),
    ],
    columns: ["otm", "dte", "netCredit", "maxLoss", "returnOnRisk", "annualRor", "pop", "ev", "spread", "marginIm"],
    stress: {moves: [-.2, -.4, -.6], ivShifts: [0, .2, .6], source: "m65stress"},
    citations: ["m146", "m65stress", "m141"],
    warnings: ["币安默认账户不会按价差最大亏损计算保证金；组合保证金抵扣有特定账户条件（交易模型 §8）。"],
  },
  {
    id: "income-put", group: "playbook", hotkey: "3", builder: "single", leg: {action: "SELL", type: "PUT"},
    name: "现金流卖 Put", nameEn: "Monthly Put-Write Income",
    tagline: "期权现金流账户：约 30 天滚动卖出深度价外 Put，权利金到期结算后再提取",
    view: {direction: "中性 / 看涨", vol: "做空波动率", risk: "高 · 现金流不等于利润"},
    collateral: "cash",
    rules: [
      "约 30 天（21–45 天）到期，价外 20%–35%",
      "IV ≥ 已实现波动率时才算有风险补偿；不满足宁可这个月不交易",
      "权利金先留在期权账户，到期结算后才算已实现收益",
      "现金流与已实现净利润分开统计（对话 #139）",
    ],
    params: [
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [21, 45], "assistant", "对话 #139 的现金流示例为 30 天期限。"),
      RANGE("otm", "价外幅度", "%", 0, 80, .5, [20, 35], "assistant", "对话 #139 示例 80,000 → 55,000，约 31%。"),
      NUMBER("minAnnual", "最低年化", "%", 0, 300, .5, 5, "system", "对话 #139 示例约 10.9%；5% 为可调门槛。"),
      NUMBER("minIvRv", "最低 IV / RV", "×", 0, 5, .05, 1, "assistant",
        "对话 #139：在波动率较低或风险补偿不充分时，强行卖 Put 很危险。"),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("budget", .1, "model", "默认按风险预算取整（交易模型 §5）；对话 #139 示例为 0.1 BTC，可切换为固定数量。"),
      RANK(["annualYield", "dailyPremium", "ev", "ivRv", "pop", "otm"], "annualYield"),
    ],
    columns: ["otm", "dte", "netCredit", "dailyPremium", "annualYield", "ivRv", "pop", "ev", "maxLoss", "spread"],
    stress: {moves: [-.2, -.4, -.6], ivShifts: [0, .2, .6], source: "m65stress"},
    citations: ["m130", "m139", "m88"],
    warnings: ["卖出期权能创造现金流，但不能保证利润，也不能保证现金流长期稳定（对话 #132）。"],
  },
  {
    id: "budget-put", group: "playbook", hotkey: "4", builder: "budget",
    name: "预算最优卖 Put", nameEn: "Risk-Budget Optimal Put Selling",
    tagline: "给定最多愿意亏的钱，比较裸卖 Put 与 Put 价差，找出预算内净权利金最高的结构",
    view: {direction: "看涨 / 中性", vol: "做空波动率", risk: "按预算封顶（到期口径）"},
    collateral: "maxLoss",
    rules: [
      "风险预算默认 1,000 USDT（交易模型：接受全部亏损的期权资金）",
      "数量 = 剩余预算 ÷ 每 BTC 最大到期亏损，按 0.01 步长向下取整",
      "同时比较裸卖 Put 与牛市看跌价差，按预算内净权利金排序",
      "预算只约束到期最大亏损，不能阻止提前强平",
    ],
    params: [
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [21, 60], "user", "覆盖对话中 1–2 个月及 30 天的期限。"),
      RANGE("shortOtm", "卖出腿价外", "%", 0, 80, .5, [20, 35], "user", "对话 #44 的 20%–30% 安全边际，含 55k/80k 例子。"),
      RANGE("width", "价差宽度", "% 指数", 1, 60, .5, [3, 25], "assistant", "对话 #146 的 55k/40k 宽度约 18.75%；币安挂牌行权价有限，默认 3%–25%。"),
      SELECT("structures", "比较结构", [
        {value: "both", label: "裸卖 Put + Put 价差"}, {value: "naked", label: "仅裸卖 Put"}, {value: "spread", label: "仅 Put 价差"},
      ], "both", "assistant", "对话 #146：比较裸卖 Put 与 Put Credit Spread。"),
      SPREAD_PARAM(),
      RANK(["budgetPremium", "ev", "pop", "annualRor"], "budgetPremium"),
    ],
    columns: ["otm", "dte", "budgetQty", "budgetPremium", "maxLoss", "annualRor", "pop", "ev", "spread"],
    stress: {moves: [-.2, -.4, -.6], ivShifts: [0, .2, .6], source: "m65stress"},
    citations: ["m146budget", "model", "m141"],
    warnings: ["预算是到期最大亏损口径；交易所可能在到期前因保证金不足强平（交易模型 §5）。"],
  },
  {
    id: "vrp-put", group: "playbook", hotkey: "5", builder: "single", leg: {action: "SELL", type: "PUT"},
    name: "波动率溢价卖 Put", nameEn: "IV-Rich Put (Volatility Risk Premium)",
    tagline: "只卖定价偏贵的 Put：IV 高于已实现波动率，且高于同到期日波动率微笑",
    view: {direction: "中性", vol: "做空波动率（相对价值）", risk: "高 · 现金担保"},
    collateral: "cash",
    rules: [
      "IV / 30 日已实现波动率 ≥ 1.2",
      "可成交 IV 高于同到期日拟合微笑（相对同类合约更贵）",
      "|Delta| 0.05–0.25，期限 14–60 天，相近 Delta 内比较",
      "高 IV 是卖出的必要条件之一，不是充分条件",
    ],
    params: [
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [14, 60], "assistant", "对话 #65：重点比较 30–60 天合约的 IV 与近期实际波动。"),
      RANGE("delta", "|Delta|", "", 0, 1, .01, [.05, .25], "assistant", "对话 #65：比较相同到期日、相近 Delta 的期权的 IV。"),
      NUMBER("minIvRv", "最低 IV / RV", "×", 0, 5, .05, 1.2, "system", "1.2 表示期权定价波动率比近 30 天实际波动高 20%。"),
      NUMBER("minRichness", "最低 IV 溢价", "vol", -20, 50, .5, 0, "system", "相对拟合微笑的波动率点数下限。"),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("fixed", .01, "assistant", "对话 #107：初始总仓位不超过 0.01 BTC。"),
      RANK(["richness", "ivRv", "annualYield", "ev", "pop"], "richness"),
    ],
    columns: ["otm", "dte", "iv", "richness", "ivRv", "annualYield", "pop", "ev", "maxLoss", "spread"],
    stress: {moves: [-.2, -.4, -.6], ivShifts: [0, .2, .6], source: "m65stress"},
    citations: ["m65iv", "m62"],
    warnings: ["已实现波动率是历史值；急跌后 IV 上升可能正确地预示更大波动（对话 #65 情况 B）。"],
  },
  {
    id: "protective-put", group: "playbook", hotkey: "6", builder: "single", leg: {action: "BUY", type: "PUT"}, overlay: "spot",
    name: "保护性 Put", nameEn: "Protective Put (Spot Hedge)",
    tagline: "为现货持仓买入约 1 个月 Put，用确定的权利金换下行保护",
    view: {direction: "对冲现货", vol: "做多波动率", risk: "低 · 最大亏损为权利金"},
    collateral: "premium",
    rules: [
      "数量匹配现货 BTC 持仓（默认 6,000 USDT 现货 ÷ 指数）",
      "约 1 个月（20–45 天），行权价低于指数 3%–12%",
      "按年化保护成本从低到高排序",
      "每月滚动买入会持续侵蚀长期收益，需控制频率（对话 #26）",
    ],
    params: [
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [20, 45], "assistant", "对话 #26：一个月期 Put。"),
      RANGE("otm", "价外幅度", "%", 0, 50, .5, [3, 12], "assistant", "对话 #26：85,000 指数买 80,000 Put，约 5.9% 价外。"),
      NUMBER("maxCostAnnual", "最高年化成本", "%", 0, 500, 1, 60, "system", "保护成本上限；超过则视为保险太贵。"),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("holdings", .07, "assistant", "对话 #26：持有约 0.07 BTC。默认匹配「我的资金」中的现货持仓。"),
      RANK(["costAnnual", "protection", "pItm", "iv"], "costAnnual"),
    ],
    columns: ["otm", "dte", "netCredit", "costAnnual", "protection", "iv", "ivRv", "spread"],
    stress: {moves: [-.1, -.2, -.4], ivShifts: [0, .2], source: "m26"},
    citations: ["m26", "m69"],
    warnings: ["保护性 Put 的收益曲线已包含你的现货；表中「净权利金」为负数代表保险费支出。"],
  },
  {
    id: "short-put", group: "playbook", hotkey: "7", builder: "single", leg: {action: "SELL", type: "PUT"},
    name: "短周期卖 Put", nameEn: "Short-Dated Put (Workbench Rules)",
    tagline: "你工作台的默认条件：10–20 天、行权价为指数 75%–80%，优先接近 15 天",
    view: {direction: "看涨 / 中性", vol: "做空波动率", risk: "高 · Gamma 风险更集中"},
    collateral: "cash",
    rules: ["剩余 10–20 天，优先接近 15 天", "行权价为指数的 75%–80%（价外 20%–25%）", "买卖价差 ≤ 50%（买一口径）"],
    params: [
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [10, 20], "workbench", "卖 Put 工作台：剩余 10–20 天。"),
      RANGE("otm", "价外幅度", "%", 0, 80, .5, [20, 25], "workbench", "卖 Put 工作台：行权价为指数的 75%–80%。"),
      NUMBER("minAnnual", "最低年化", "%", 0, 300, .5, 0, "system", "默认不设门槛，按日均权利金比较。"),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("fixed", .01, "assistant", "对话 #107：初始总仓位不超过 0.01 BTC。"),
      RANK(["dailyPremium", "annualYield", "ev", "pop", "otm", "dte"], "dailyPremium"),
    ],
    columns: ["otm", "dte", "netCredit", "dailyPremium", "annualYield", "pop", "ev", "ivRv", "maxLoss", "spread"],
    stress: {moves: [-.1, -.2, -.3], ivShifts: [0, .2, .6], source: "wbPut"},
    citations: ["wbPut", "m44"],
    warnings: ["期限越短，临近到期时价格穿越行权价的损益变化越剧烈（负 Gamma）。"],
  },
  {
    id: "short-call", group: "playbook", hotkey: "8", builder: "single", leg: {action: "SELL", type: "CALL"},
    name: "短周期卖 Call", nameEn: "Short-Dated Call (Workbench Rules)",
    tagline: "你工作台的 Call 条件：10–20 天、行权价高于指数 20%–25%",
    view: {direction: "看跌 / 中性", vol: "做空波动率", risk: "极高 · 理论亏损无上限"},
    collateral: "notional",
    rules: ["剩余 10–20 天", "行权价高于指数 20%–25%", "裸卖 Call 到期亏损无上限；现货名义金额仅作收益率参考"],
    params: [
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [10, 20], "workbench", "卖 Call 工作台：剩余 10–20 天。"),
      RANGE("otm", "价外幅度", "%", 0, 200, .5, [20, 25], "workbench", "卖 Call 工作台：行权价高于指数 20%–25%。"),
      NUMBER("minAnnual", "最低年化（名义）", "%", 0, 300, .5, 0, "system", "按现货名义金额计算的年化下限。"),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("fixed", .01, "system", "裸卖 Call 风险无上限，默认最小数量。"),
      RANK(["dailyPremium", "annualYield", "ev", "pop", "otm"], "dailyPremium"),
    ],
    columns: ["otm", "dte", "netCredit", "dailyPremium", "annualYield", "pop", "ev", "ivRv", "es99", "spread"],
    stress: {moves: [.1, .2, .3], ivShifts: [0, .2, .6], source: "wbCall"},
    citations: ["wbCall"],
    warnings: ["裸卖 Call 理论亏损无上限；币安不会把你钱包里的现货 BTC 计入 USDT 保证金。"],
  },
  {
    id: "covered-call", group: "library", builder: "single", leg: {action: "SELL", type: "CALL"}, overlay: "spot", covered: true,
    name: "备兑看涨", nameEn: "Covered Call",
    tagline: "按现货持仓数量卖出价外 Call，以放弃部分上涨换取权利金",
    view: {direction: "温和看涨", vol: "做空波动率", risk: "中 · 上涨收益封顶"},
    collateral: "notional",
    rules: ["数量匹配现货持仓", "14–45 天，价外 10%–30%", "按现货名义年化收益排序", "币安现金结算，现货不会被自动交割，需要独立保证金"],
    params: [
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [14, 45], "system", ""),
      RANGE("otm", "价外幅度", "%", 0, 200, .5, [10, 30], "system", ""),
      NUMBER("minAnnual", "最低年化（名义）", "%", 0, 300, .5, 2, "system", ""),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("holdings", .07, "system", "匹配「我的资金」中的现货持仓。"),
      RANK(["annualYield", "dailyPremium", "otm", "pop", "ev"], "annualYield"),
    ],
    columns: ["otm", "dte", "netCredit", "annualYield", "dailyPremium", "pop", "ivRv", "spread"],
    stress: {moves: [.1, .2, .4], ivShifts: [0, .2], source: null},
    citations: ["m14", "m130"],
    warnings: ["对话 #130 中你提到长期持有的币不想卖出：备兑 Call 会封顶上涨收益，到期实值需现金赔付。"],
  },
  {
    id: "long-straddle", group: "library", builder: "straddle",
    name: "买入跨式", nameEn: "Long Straddle",
    tagline: "同时买入平值 Call 和 Put，押注大幅波动、不押方向",
    view: {direction: "无方向", vol: "做多波动率", risk: "中 · 最大亏损为权利金"},
    collateral: "premium",
    rules: ["同到期、同一平值行权价", "7–45 天", "保本所需波动 ÷ 隐含 1σ 越低越便宜", "IV 低于已实现波动时更有利"],
    params: [
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [7, 45], "system", ""),
      NUMBER("atmBand", "平值容差", "%", .5, 15, .5, 3, "system", "行权价与指数的最大偏离。"),
      NUMBER("maxIvRv", "最高 IV / RV", "×", 0, 5, .05, 1.5, "system", "买入波动率时 IV 不宜明显高于已实现波动。"),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("fixed", .01, "system", ""),
      RANK(["moveRatio", "ev", "ivRv", "netCredit"], "moveRatio"),
    ],
    columns: ["dte", "netCredit", "moveToBe", "moveRatio", "iv", "ivRv", "pop", "ev", "theta", "spread"],
    stress: {moves: [-.2, -.1, .1, .2], ivShifts: [-.1, 0, .2], source: null},
    citations: ["m14"],
    warnings: ["时间价值每天流失（负 Theta）；横盘时亏损。"],
  },
  {
    id: "long-strangle", group: "library", builder: "strangle",
    name: "买入宽跨式", nameEn: "Long Strangle",
    tagline: "买入价外 Call 与价外 Put，成本低于跨式，但需要更大波动",
    view: {direction: "无方向", vol: "做多波动率", risk: "中 · 最大亏损为权利金"},
    collateral: "premium",
    rules: ["同到期，Call / Put 的 |Delta| 0.15–0.35 且大致平衡", "7–45 天", "按保本所需波动 ÷ 隐含波动排序"],
    params: [
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [7, 45], "system", ""),
      RANGE("delta", "|Delta|", "", 0, 1, .01, [.15, .35], "system", ""),
      NUMBER("balance", "Delta 不平衡上限", "", 0, .5, .01, .08, "system", "|Δcall| 与 |Δput| 的最大差。"),
      NUMBER("maxIvRv", "最高 IV / RV", "×", 0, 5, .05, 1.5, "system", ""),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("fixed", .01, "system", ""),
      RANK(["moveRatio", "ev", "ivRv", "netCredit"], "moveRatio"),
    ],
    columns: ["dte", "netCredit", "moveToBe", "moveRatio", "iv", "ivRv", "pop", "ev", "theta", "spread"],
    stress: {moves: [-.3, -.15, .15, .3], ivShifts: [-.1, 0, .2], source: null},
    citations: ["m14"],
    warnings: ["两条腿都在价外，横盘或小幅波动时可能全部归零。"],
  },
  {
    id: "bear-call", group: "library", builder: "vertical", vertical: {type: "CALL", kind: "credit"},
    name: "熊市看涨价差", nameEn: "Bear Call Credit Spread",
    tagline: "卖出价外 Call、买入更高行权价 Call，是裸卖 Call 的有限风险版本",
    view: {direction: "看跌 / 中性", vol: "做空波动率", risk: "中 · 最大亏损有限"},
    collateral: "maxLoss",
    rules: ["卖出腿价外 10%–30%，同到期买入更高行权价", "宽度为指数的 5%–20%", "最大亏损 = 宽度 × 数量 − 净权利金"],
    params: [
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [10, 45], "system", ""),
      RANGE("shortOtm", "卖出腿价外", "%", 0, 200, .5, [10, 30], "workbench", "卖 Call 工作台的 20%–25% 条件附近。"),
      RANGE("width", "价差宽度", "% 指数", 1, 60, .5, [5, 20], "system", ""),
      NUMBER("minRor", "最低收益 / 风险", "%", 0, 500, .5, 2, "system", ""),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("fixed", .1, "system", ""),
      RANK(["annualRor", "returnOnRisk", "ev", "pop", "netCredit"], "annualRor"),
    ],
    columns: ["otm", "dte", "netCredit", "maxLoss", "returnOnRisk", "annualRor", "pop", "ev", "spread", "marginIm"],
    stress: {moves: [.1, .2, .3], ivShifts: [0, .2, .6], source: null},
    citations: ["m14", "wbCall"],
    warnings: ["币安默认账户不按价差抵扣保证金。"],
  },
  {
    id: "bull-call", group: "library", builder: "vertical", vertical: {type: "CALL", kind: "debit"},
    name: "牛市看涨价差", nameEn: "Bull Call Debit Spread",
    tagline: "买入近平值 Call、卖出更高行权价 Call，以有限成本表达看涨",
    view: {direction: "看涨", vol: "中性", risk: "低 · 最大亏损为净支出"},
    collateral: "premium",
    rules: ["买入腿价外 −5%–8%（可略为实值），卖出腿更高", "宽度为指数的 5%–25%", "按收益 / 风险排序"],
    params: [
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [20, 90], "system", ""),
      RANGE("longOtm", "买入腿价外", "%", -20, 50, .5, [-5, 8], "system", "负数表示实值。"),
      RANGE("width", "价差宽度", "% 指数", 1, 60, .5, [5, 25], "system", ""),
      NUMBER("minRor", "最低收益 / 风险", "%", 0, 2000, 5, 50, "system", ""),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("fixed", .1, "system", ""),
      RANK(["returnOnRisk", "ev", "evRisk", "pop", "netCredit"], "returnOnRisk"),
    ],
    columns: ["otm", "dte", "netCredit", "maxProfit", "returnOnRisk", "breakevenDist", "pop", "ev", "spread"],
    stress: {moves: [-.2, -.1, .1, .2], ivShifts: [0, .2], source: null},
    citations: ["m14"],
    warnings: [],
  },
  {
    id: "calendar", group: "library", builder: "calendar",
    name: "日历价差", nameEn: "Calendar Spread",
    tagline: "卖出近月、买入远月同一行权价，赚取近月更快的时间价值流失",
    view: {direction: "中性", vol: "做多远月波动率", risk: "中 · 最大亏损约为净支出"},
    collateral: "premium",
    rules: ["同一近平值行权价", "近月 5–21 天卖出，远月 25–90 天买入", "近月 IV 高于远月（期限结构倒挂）更有利", "按近月到期时的模型损益估算"],
    params: [
      RANGE("nearDte", "近月天数", "天", 1, 120, 1, [5, 21], "system", ""),
      RANGE("farDte", "远月天数", "天", 2, 400, 1, [25, 90], "system", ""),
      NUMBER("atmBand", "平值容差", "%", .5, 20, .5, 4, "system", ""),
      SELECT("optionType", "期权类型", [{value: "AUTO", label: "自动（价外一侧）"}, {value: "CALL", label: "Call"}, {value: "PUT", label: "Put"}], "AUTO", "system", ""),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("fixed", .01, "system", "币安标准账户不抵扣日历价差保证金，近月卖出腿需单独满足保证金。"),
      RANK(["termSpread", "returnOnRisk", "ev", "pop"], "termSpread"),
    ],
    columns: ["otm", "dte", "netCredit", "maxProfit", "returnOnRisk", "termSpread", "pop", "ev", "vega", "spread"],
    stress: {moves: [-.15, -.05, .05, .15], ivShifts: [-.1, 0, .1], source: null},
    citations: ["m14"],
    warnings: ["日历价差的到期损益依赖远月腿在近月到期时的价格，本工具按远月当前 IV 的 Black–Scholes 估值（sticky strike）。"],
  },
  {
    id: "put-ratio", group: "library", builder: "ratio",
    name: "看跌比率价差", nameEn: "1×2 Put Ratio Spread",
    tagline: "买 1 张较近价外 Put、卖 2 张更远价外 Put，常可零成本建仓",
    view: {direction: "温和看跌 / 中性", vol: "做空波动率", risk: "高 · 下方尾部为裸卖"},
    collateral: "cash",
    rules: ["同到期，买入腿价外 3%–12%，卖出腿价外 12%–30%", "比例 1 : 2", "多卖出的一张在下方构成裸卖 Put 风险"],
    params: [
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [14, 60], "system", ""),
      RANGE("longOtm", "买入腿价外", "%", 0, 50, .5, [3, 12], "system", ""),
      RANGE("shortOtm", "卖出腿价外", "%", 0, 80, .5, [12, 30], "system", ""),
      NUMBER("ratio", "卖出 / 买入比例", "×", 1.5, 3, .5, 2, "system", ""),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("fixed", .01, "system", ""),
      RANK(["maxProfit", "ev", "netCredit", "breakevenDist", "pop"], "ev"),
    ],
    columns: ["otm", "dte", "netCredit", "maxProfit", "maxLoss", "breakevenDist", "pop", "ev", "spread"],
    stress: {moves: [-.2, -.4, -.6], ivShifts: [0, .2, .6], source: null},
    citations: ["m14"],
    warnings: ["下方尾部等同裸卖 Put，深跌时亏损随价格线性扩大。"],
  },
  {
    id: "long-call", group: "library", builder: "single", leg: {action: "BUY", type: "CALL"},
    name: "买入 Call", nameEn: "Long Call",
    tagline: "以有限权利金获取上涨敞口",
    view: {direction: "看涨", vol: "做多波动率", risk: "低 · 最大亏损为权利金"},
    collateral: "premium",
    rules: ["30–120 天", "|Delta| 0.25–0.55", "IV 不宜明显高于已实现波动"],
    params: [
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [30, 120], "system", ""),
      RANGE("delta", "|Delta|", "", 0, 1, .01, [.25, .55], "system", ""),
      NUMBER("maxIvRv", "最高 IV / RV", "×", 0, 5, .05, 1.4, "system", ""),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("fixed", .01, "system", ""),
      RANK(["ev", "ivRv", "breakevenDist", "pop"], "ev"),
    ],
    columns: ["otm", "dte", "netCredit", "breakevenDist", "iv", "ivRv", "pop", "ev", "theta", "spread"],
    stress: {moves: [-.2, -.1, .1, .2], ivShifts: [-.1, 0, .2], source: null},
    citations: ["m14"],
    warnings: [],
  },
  {
    id: "long-put", group: "library", builder: "single", leg: {action: "BUY", type: "PUT"},
    name: "买入 Put", nameEn: "Long Put / Tail Hedge",
    tagline: "以有限权利金获取下跌敞口或尾部保护",
    view: {direction: "看跌 / 对冲", vol: "做多波动率", risk: "低 · 最大亏损为权利金"},
    collateral: "premium",
    rules: ["30–120 天", "|Delta| 0.10–0.30", "按成本与期望比较"],
    params: [
      RANGE("dte", "剩余天数", "天", 1, 400, 1, [30, 120], "system", ""),
      RANGE("delta", "|Delta|", "", 0, 1, .01, [.1, .3], "system", ""),
      NUMBER("maxIvRv", "最高 IV / RV", "×", 0, 5, .05, 1.6, "system", ""),
      SPREAD_PARAM(),
      ...QUANTITY_PARAMS("fixed", .01, "system", ""),
      RANK(["ev", "costAnnual", "ivRv", "breakevenDist"], "ev"),
    ],
    columns: ["otm", "dte", "netCredit", "breakevenDist", "costAnnual", "iv", "ivRv", "ev", "theta", "spread"],
    stress: {moves: [-.4, -.2, -.1, .1], ivShifts: [0, .2, .6], source: null},
    citations: ["m14"],
    warnings: [],
  },
]);

export const GROUPS = Object.freeze([
  {id: "playbook", label: "我的策略", hint: "来自你与期权专家的对话与工作台设置"},
  {id: "library", label: "策略库", hint: "对话 #14 列出的标准期权策略"},
]);

export const CITATIONS = CITE;

export function getStrategy(id) {
  return STRATEGIES.find(strategy => strategy.id === id) ?? null;
}

export function defaultParams(strategy) {
  return Object.fromEntries(strategy.params.map(param => [param.key, Array.isArray(param.default) ? [...param.default] : param.default]));
}

const round = (value, step) => {
  if (!(step > 0)) return value;
  const decimals = Math.max(0, Math.min(10, (String(step).split(".")[1] ?? "").length));
  return Number((Math.round(value / step) * step).toFixed(decimals));
};

/**
 * Validates and clamps user parameters. Unknown keys are dropped; invalid
 * values fall back to defaults and are reported, so a bad URL never breaks
 * screening.
 */
export function normalizeParams(strategy, input = {}) {
  const params = defaultParams(strategy), issues = [];
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  for (const spec of strategy.params) {
    if (!Object.hasOwn(source, spec.key)) continue;
    const raw = source[spec.key];
    if (spec.type === "select") {
      const option = spec.options.find(item => String(item.value) === String(raw));
      if (option) params[spec.key] = option.value;
      else issues.push(`${spec.label}的取值无效，已使用默认值`);
    } else if (spec.type === "range") {
      const pair = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[~,_]/) : null;
      const values = pair?.length === 2 ? pair.map(Number) : null;
      if (!values || !values.every(Number.isFinite)) { issues.push(`${spec.label}须为两个数值`); continue; }
      let [low, high] = values.map(value => round(Math.min(spec.max, Math.max(spec.min, value)), spec.step));
      if (low > high) [low, high] = [high, low];
      params[spec.key] = [low, high];
    } else if (spec.type === "number") {
      const value = Number(raw);
      if (raw === "" || raw === null || !Number.isFinite(value)) { issues.push(`${spec.label}须为数值`); continue; }
      params[spec.key] = round(Math.min(spec.max, Math.max(spec.min, value)), spec.step);
    }
  }
  return {params, issues};
}

/** Compact, URL-safe encoding of the parameters that differ from defaults. */
export function encodeParams(strategy, params) {
  const defaults = defaultParams(strategy), parts = [];
  for (const spec of strategy.params) {
    const value = params[spec.key], fallback = defaults[spec.key];
    if (JSON.stringify(value) === JSON.stringify(fallback)) continue;
    parts.push(spec.key + "=" + encodeURIComponent(Array.isArray(value) ? value.join("~") : String(value)));
  }
  return parts.join("&");
}

export function decodeParams(strategy, text) {
  const input = {};
  for (const part of String(text ?? "").split("&")) {
    if (!part) continue;
    const [key, value = ""] = part.split("=");
    try { input[decodeURIComponent(key)] = decodeURIComponent(value); } catch { /* ignore malformed */ }
  }
  return normalizeParams(strategy, input);
}

/** Public catalog shape for the API (no functions, stable ordering). */
export function catalog() {
  return {
    version: 1,
    groups: GROUPS,
    origins: ORIGINS,
    metrics: METRICS,
    citations: CITE,
    strategies: STRATEGIES.map(strategy => ({...strategy, defaults: defaultParams(strategy)})),
  };
}
