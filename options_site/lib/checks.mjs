/**
 * User settings and the vocabulary of rule checks: shared by the screening
 * engine (Web Worker / server) and the interface thread, which needs labels
 * and setting defaults without loading the engine itself.
 */
import {DEFAULT_FEES} from "./quant.mjs";

export const DEFAULT_SETTINGS = Object.freeze({
  fees: DEFAULT_FEES,
  evVol: "rv30",           // forecast σ for expected value: rv30 | rv7 | atm | custom
  evVolCustom: .6,
  drift: 0,
  riskBudget: 1000,        // 交易模型：期权账户 1,000 USDT，接受全部亏损
  holdingsUsd: 6000,       // 对话 #90：约 6,000 美元现货
  holdingsBtc: null,       // explicit BTC holdings override the USD figure
  dcaDaily: 20,            // 对话 #90：每天定投 20 美元
  dipCash: 0,              // 独立抄底资金（对话 #69、#141）
  maxOpenShortPuts: 1,     // 对话 #99：初期只允许同时持有一笔
  maxShortPutQty: .01,     // 对话 #107：初始总仓位不超过 0.01 BTC
  payoutCapPct: 10,        // 对话 #107：未到期 Put 最大赔付 ≤ 现货价值约 10%
  enforceDiscipline: false,
  stressElapsedDays: 1,
  stressIvShift: .2,
});

export function mergeSettings(input = {}) {
  const s = {...DEFAULT_SETTINGS, ...(input && typeof input === "object" ? input : {})};
  s.fees = {...DEFAULT_FEES, ...(input?.fees ?? {})};
  for (const key of ["tradeRate", "exerciseRate", "cap"]) {
    if (!(s.fees[key] >= 0 && s.fees[key] <= 1)) s.fees[key] = DEFAULT_FEES[key];
  }
  for (const [key, min, max] of [["riskBudget", 0, 1e9], ["holdingsUsd", 0, 1e10], ["dcaDaily", 0, 1e7], ["dipCash", 0, 1e10],
    ["maxOpenShortPuts", 0, 1000], ["maxShortPutQty", 0, 1e4], ["payoutCapPct", 0, 1000], ["evVolCustom", .01, 5], ["drift", -5, 5],
    ["stressElapsedDays", 0, 30], ["stressIvShift", 0, 3]]) {
    const value = Number(s[key]);
    s[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : DEFAULT_SETTINGS[key];
  }
  s.holdingsBtc = Number(s.holdingsBtc) > 0 ? Number(s.holdingsBtc) : null;
  if (!["rv30", "rv7", "atm", "custom"].includes(s.evVol)) s.evVol = DEFAULT_SETTINGS.evVol;
  s.enforceDiscipline = Boolean(s.enforceDiscipline);
  return s;
}

/** Human-readable labels for every check id. */
export const CHECK_LABELS = Object.freeze({
  trigger: "急跌触发", dte: "剩余天数", nearDte: "近月天数", farDte: "远月天数", otm: "价外幅度", shortOtm: "卖出腿价外", longOtm: "买入腿价外",
  width: "价差宽度", delta: "|Delta|", quote: "可成交报价", depth: "盘口深度", spread: "买卖价差", credit: "净权利金为正",
  debit: "净支出为正", minAnnual: "最低年化", minRor: "最低收益/风险", minIvRv: "IV/RV 下限", maxIvRv: "IV/RV 上限",
  minRichness: "IV 相对微笑溢价", maxCostAnnual: "年化保护成本", atmBand: "平值容差", balance: "Delta 平衡", quantity: "数量",
  budget: "风险预算", openPuts: "同时卖 Put 笔数", putQty: "卖 Put 总数量", payoutCap: "赔付上限（现货 10%）",
  margin: "可用保证金", freshness: "行情时效", rules: "合约规则", replay: "数据来源", account: "账户", expiry: "同一到期日",
  termStructure: "期限结构",
});

/** Text explanation of a check, shared by the API and the interface. */
export function describeCheck(check, unitFor = () => "") {
  const unit = unitFor(check.id);
  const f = (x, d = 2) => Number.isFinite(x) ? Number(x.toFixed(d)).toString() : "—";
  if (check.kind === "range") return `${f(check.value)}${unit}（要求 ${f(check.lo)}–${f(check.hi)}${unit}）`;
  if (check.kind === "min") return `${f(check.value)}${unit}（要求 ≥ ${f(check.min)}${unit}）`;
  if (check.kind === "max") return `${f(check.value)}${unit}（要求 ≤ ${f(check.max)}${unit}）`;
  return check.detail ?? "";
}

export const CHECK_UNITS = Object.freeze({dte: " 天", nearDte: " 天", farDte: " 天", otm: "%", shortOtm: "%", longOtm: "%", width: "%",
  spread: "%", minAnnual: "%", minRor: "%", maxCostAnnual: "%", minIvRv: "×", maxIvRv: "×", minRichness: " vol", atmBand: "%", credit: " USDT", debit: " USDT"});
