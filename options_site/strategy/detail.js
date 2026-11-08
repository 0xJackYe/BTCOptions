// Candidate detail: KPIs, payoff chart, rule checks, stress, capital and legs.
// A new candidate arrives with a seal stamp, staggered figures and a brush-
// drawn payoff line; live refreshes of the same candidate update silently.
import {h, icon, fill} from "./dom.js";
import * as F from "./format.js";
import {createPayoffChart, bar, enso} from "./charts.js";
import {inkIn, stamp, placeInk} from "./motion.js";
import {METRICS, CITATIONS, ORIGINS} from "../lib/strategies.mjs";
import {CHECK_LABELS, CHECK_UNITS, describeCheck} from "../lib/checks.mjs";

const STRUCTURE = {single: null, protective: "保护性 Put", naked: "裸卖 Put", vertical: "垂直价差", straddle: "跨式", strangle: "宽跨式", calendar: "日历价差", ratio: "比率价差"};
const GROUPS = [
  ["策略条件", ["trigger", "dte", "nearDte", "farDte", "otm", "shortOtm", "longOtm", "width", "delta", "atmBand", "balance", "minAnnual", "minRor",
    "minIvRv", "maxIvRv", "minRichness", "maxCostAnnual", "credit", "debit", "quantity", "expiry", "termStructure"]],
  ["流动性与数据", ["quote", "depth", "spread", "freshness", "rules", "replay"]],
  ["资金纪律", ["budget", "openPuts", "putQty", "payoutCap", "margin", "account"]],
];
const ICON = {pass: "✓", fail: "✕", warn: "!", info: "i"};
const TABS = [["rules", "规则检查"], ["stress", "压力测试"], ["funds", "资金"], ["legs", "合约"]];
const N = ["01", "02", "03", "04", "05", "06", "07", "08"];

let chart = null;
let refs = null;          // {root, key, strategyId, tabs: Map, ink, body}
let lastFreshAt = 0;

const legLabel = leg => `${leg.action === "SELL" ? "卖出" : "买入"} ${leg.type === "PUT" ? "Put" : "Call"}`;

function title(candidate, strategy) {
  if (candidate.legs.length === 1) return legLabel(candidate.legs[0]) + (strategy.overlay === "spot" ? (strategy.id === "protective-put" ? " · 现货对冲" : " · 备兑") : "");
  if (candidate.structure === "vertical") {
    const credit = candidate.metrics.netCredit > 0;
    return candidate.legs[0].type === "PUT" ? (credit ? "牛市看跌价差" : "熊市看跌价差") : (credit ? "熊市看涨价差" : "牛市看涨价差");
  }
  return STRUCTURE[candidate.structure] ?? strategy.name;
}

const section = (n, text) => h("div.section-title", {dataset: {n: N[n] ?? ""}, text});

function kpi(label, value, sub, tone = "", tip = "") {
  return h("div.kpi", {"data-tip": tip || null}, h("label", {text: label}), h("strong", {class: tone, text: value}), h("small", {text: sub ?? ""}));
}

function kpis(candidate, state) {
  const m = candidate.metrics, sells = candidate.legs.some(leg => leg.action === "SELL"), strategy = state.strategy;
  const cards = [
    kpi(m.netCredit >= 0 ? "净权利金" : "净支出", F.signed(m.netCredit, 2), `毛额 ${F.num(Math.abs(m.grossPremium), 2)}`, F.tone(m.netCredit),
      `净权利金|卖出按买一、买入按卖一成交，已扣开仓手续费 ${F.num(m.entryFees, 3)} USDT：min(0.024%×指数, 10%×权利金)`),
    kpi("最大亏损", m.maxLoss === Infinity ? "无上限" : F.num(m.maxLoss, 2), m.maxLoss === Infinity ? "裸卖 Call" : "持有到期 · USDT", m.maxLoss === Infinity ? "neg" : "", METRICS.maxLoss.help),
  ];
  const longVol = ["straddle", "strangle"].includes(candidate.structure);
  const hedge = candidate.legs.length === 1 && candidate.legs[0].action === "BUY" && candidate.legs[0].type === "PUT";
  if (m.annualYield !== null && sells && m.netCredit > 0) cards.push(kpi("年化收益", F.pct(m.annualYield, 2), `本期 ${F.pct(m.periodYield, 3)}`, "pos",
    `年化收益（${{cash: "现金担保", maxLoss: "最大亏损", notional: "名义"}[m.collateralBasis] ?? ""}口径）|` + METRICS.annualYield.help));
  else if (hedge && m.costAnnual !== null) cards.push(kpi("年化成本", F.pct(m.costAnnual, 2), strategy.overlay === "spot" ? "相对被保护名义" : "相对名义本金", "", METRICS.costAnnual.help));
  else if (longVol) cards.push(kpi("保本所需波动", F.pct(m.moveToBe, 2), "隐含 1σ " + F.pct(m.expectedMove, 2), "", METRICS.moveToBe.help));
  else cards.push(kpi("收益 / 风险", F.pct(m.returnOnRisk, 1), m.maxProfit === Infinity ? "最大盈利无上限" : "最大盈利 " + F.num(m.maxProfit, 2), "", METRICS.returnOnRisk.help));
  return h("div.kpis", {}, cards);
}

/** The model's view in one quiet line: probability, expectation, tail. */
function modelLine(candidate, state) {
  const m = candidate.metrics;
  const evSource = {rv30: "RV30", rv7: "RV7", atm: "平值 IV", custom: "自定义"}[m.evSigmaSource] ?? "";
  return h("p.model-line", {},
    h("span", {"data-tip": "盈利概率|" + METRICS.pop.help}, "胜率 ", h("b", {text: F.pct((m.pop ?? NaN) * 100, 1)})),
    h("span", {"data-tip": `模型期望（σ ${evSource} ${F.pct((m.evSigma ?? NaN) * 100, 1)}）|` + METRICS.ev.help}, "期望 ", h("b", {class: F.tone(m.ev), text: F.signed(m.ev, 2)})),
    h("span", {"data-tip": "尾部 ES99|" + METRICS.es99.help}, "ES99 ", h("b", {class: "neg", text: F.num(state.detail?.tail?.es99, 2)})));
}

function checkList(checks) {
  return h("div.checks", {}, checks.map(check => h("div.check." + check.status, {},
    h("span.ic", {text: ICON[check.status] ?? "·"}),
    h("div", {}, h("strong", {text: CHECK_LABELS[check.id] ?? check.id}), check.hard ? h("span.tag-hard", {text: "硬性"}) : null,
      h("p", {text: describeCheck(check, id => CHECK_UNITS[id] ?? "") || (check.status === "pass" ? "满足" : "")})))));
}

function rulesTab(candidate, state) {
  const strategy = state.strategy, sections = [];
  let n = 0;
  const known = new Set(GROUPS.flatMap(([, ids]) => ids));
  for (const [label, ids] of GROUPS) {
    const checks = candidate.checks.filter(check => ids.includes(check.id));
    if (checks.length) sections.push(section(n++, label), checkList(checks));
  }
  const other = candidate.checks.filter(check => !known.has(check.id));
  if (other.length) sections.push(section(n++, "其他"), checkList(other));
  sections.push(section(n++, "策略要点"),
    h("dl.kv", {},
      h("dt", {text: "方向"}), h("dd", {text: strategy.view.direction}),
      h("dt", {text: "波动率"}), h("dd", {text: strategy.view.vol}),
      h("dt", {text: "风险"}), h("dd", {class: /极高|高/.test(strategy.view.risk) ? "neg" : "", text: strategy.view.risk})));
  sections.push(section(n++, "对话出处"),
    ...strategy.citations.map(ref => {
      const quote = CITATIONS[ref];
      const where = typeof quote.ref === "number" ? `对话 #${quote.ref} · ${quote.who}` : quote.ref === "model" ? "币安 BTC 期权交易模型" : quote.ref === "workbench-put" ? "卖 Put 工作台 · 你的默认条件" : "卖 Call 工作台 · 你的条件";
      return h("blockquote.quote", {}, h("cite", {text: where}), quote.quote);
    }));
  if (strategy.warnings.length) sections.push(section(n++, "注意"), h("ul.notes", {}, strategy.warnings.map(text => h("li", {text}))));
  return sections;
}

function stressTab(candidate, state) {
  const d = state.detail, overlay = Boolean(d?.overlay);
  if (!d) return [h("div.loading", {}, enso(), h("p", {text: "正在计算压力情景…"}))];
  const out = [];
  const liq = d.liquidation;
  if (liq) {
    const source = {account: "账户权益", budget: "风险预算", custom: "自定义"}[liq.equitySource];
    if (liq.immediate) out.push(h("div.callout.danger", {}, h("strong", {text: "按当前假设已不满足维持保证金"}),
      `以 ${F.num(liq.equity, 0)} USDT（${source}）计算，开仓后维持保证金已超过权益。`));
    else if (liq.safe) out.push(h("div.callout.safe", {}, h("strong", {text: "压力范围内未触及强平"}),
      `以 ${F.num(liq.equity, 0)} USDT（${source}）、IV 上升 ${F.num(liq.ivShift * 100, 0)} 点、经过 ${F.num(d.elapsedDays, 0)} 天，向不利方向的极端波动也不会使维持保证金超过权益。`));
    else out.push(h("div.callout.danger", {}, h("strong", {text: `BTC ${liq.direction === "down" ? "跌" : "涨"}至 ${F.price(liq.spot)}（${F.signed(liq.move * 100, 1)}%）可能被强平`}),
      `以 ${F.num(liq.equity, 0)} USDT（${source}）、IV 上升 ${F.num(liq.ivShift * 100, 0)} 点、经过 ${F.num(d.elapsedDays, 0)} 天估算；当前维持保证金 / 权益 = ${F.pct(liq.currentRatio * 100, 1)}。对话 #146：可能在尚未跌到行权价时就因保证金不足被强平。`));
  }
  out.push(section(0, "到期情景 · 持有到期"),
    h("table.mini", {}, h("thead", {}, h("tr", {}, h("th", {text: "BTC 变动"}), h("th", {text: "结算价"}), h("th", {text: "期权盈亏"}), overlay ? h("th", {text: "现货+期权"}) : null)),
      h("tbody", {}, d.scenarios.map(row => h("tr", {}, h("td", {class: F.tone(row.move), text: F.signedPct(row.move * 100, 0)}), h("td", {text: F.price(row.spot)}),
        h("td", {class: F.tone(row.pnl), text: F.signed(row.pnl, 2)}), overlay ? h("td", {class: F.tone(row.combined), text: F.signed(row.combined, 2)}) : null)))));
  out.push(section(1, `盯市压力 · 经过 ${F.num(d.elapsedDays, 0)} 天 · 维持保证金 / 权益`),
    h("div", {style: {overflow: "auto"}}, h("table.mini.stress", {}, h("thead", {}, h("tr", {}, h("th", {text: "BTC 变动"}), d.shifts.map(shift => h("th", {text: shift === 0 ? "IV 不变" : "IV " + F.signed(shift * 100, 0) + " 点"})))),
      h("tbody", {}, d.grid.map(row => h("tr", {}, h("td", {class: F.tone(row.move), text: F.signedPct(row.move * 100, 0)}),
        row.cells.map(cell => h("td.cell." + cell.state, {}, h("span", {class: F.tone(overlay ? cell.combined : cell.pnl), text: F.signed(overlay ? cell.combined : cell.pnl, 2)}),
          h("small", {text: Number.isFinite(cell.marginRatio) && cell.marginRatio > 0 ? "MM " + F.pct(cell.marginRatio * 100, 0) : "—"})))))))));
  out.push(h("p.muted", {text: "盯市值以当前标记价为锚，用 Black–Scholes 重估价格与 IV 变化，不是可成交报价；币安标准账户对每条卖出腿单独计算保证金。"}));
  return out;
}

function fundsTab(candidate, state, actions) {
  const m = candidate.metrics, s = state.settings, p = state.portfolio, strategy = state.strategy;
  const step = Math.max(...candidate.legs.map(l => l.step ?? .01)), min = Math.max(...candidate.legs.map(l => l.minQty ?? .01));
  const input = h("input", {type: "number", min, step, value: candidate.qty, "aria-label": "数量（BTC）", inputmode: "decimal"});
  const commit = value => { const q = Math.max(min, Math.round(value / step) * step); actions.setQuantity(Number(q.toFixed(6))); };
  input.addEventListener("change", () => commit(Number(input.value)));
  let n = 0;
  const out = [
    section(n++, "数量"),
    h("div", {style: {display: "flex", "align-items": "center", gap: "12px", "flex-wrap": "wrap"}},
      h("div.stepper", {}, h("button", {type: "button", "aria-label": "减少", onClick: () => commit(candidate.qty - step)}, "−"), input,
        h("button", {type: "button", "aria-label": "增加", onClick: () => commit(candidate.qty + step)}, "+")),
      h("span.muted", {text: {fixed: "固定数量（对全部候选生效）", budget: "按风险预算自动取整", holdings: "匹配现货持仓"}[candidate.quantityMode] ?? ""})),
  ];
  const budgetLeft = p?.budgetRemaining ?? s.riskBudget;
  if (Number.isFinite(m.maxLoss)) {
    const share = m.maxLoss / Math.max(1e-9, budgetLeft);
    out.push(section(n++, "风险预算"),
      h("dl.kv", {}, h("dt", {text: "本笔最大到期亏损"}), h("dd", {text: F.num(m.maxLoss, 2) + " USDT"}),
        h("dt", {text: p?.connected ? "剩余预算（扣除已有持仓）" : "风险预算"}), h("dd", {text: F.num(budgetLeft, 2) + " USDT"})),
      bar(Math.min(1, share), share > 1 ? "over" : share > .8 ? "warn" : ""),
      h("p.muted", {text: share > 1 ? "超出预算：交易模型 §5 建议 q ≤ 风险预算 ÷ (K − p)。" : `占用预算 ${F.pct(share * 100, 1)}。预算只约束到期亏损，不能阻止提前强平。`}));
  }
  const shortPut = candidate.legs.find(l => l.type === "PUT" && l.action === "SELL");
  if (shortPut && ["crash-put", "income-put", "budget-put", "vrp-put", "short-put", "bull-put"].includes(strategy.id)) {
    const reserve = Math.max(0, m.collateral ?? shortPut.strike * candidate.qty);
    const dip = shortPut.strike * candidate.qty;
    const dca = s.dcaDaily * candidate.dte;
    const total = reserve + dip + dca;
    const seg = (value, color, i) => {
      const node = h("i");
      node.style.width = (value / total * 100).toFixed(2) + "%";
      node.style.background = color;
      node.style.animationDelay = i * 120 + "ms";
      return node;
    };
    out.push(section(n++, "三账户资金规划 · 对话 #104"),
      h("div.stack", {}, seg(reserve, "var(--neg)", 0), seg(dip, "var(--accent)", 1), seg(dca, "var(--info)", 2)),
      h("div.stack-legend", {},
        h("div", {}, h("span", {style: {background: "var(--neg)"}}), strategy.collateral === "maxLoss" ? "期权最大亏损准备" : "Put 赔付准备金（K × 数量）", h("b", {text: F.num(reserve, 2)})),
        h("div", {}, h("span", {style: {background: "var(--accent)"}}), `独立抄底资金（在 ${F.price(shortPut.strike)} 买入同等 BTC）`, h("b", {text: F.num(dip, 2)})),
        h("div", {}, h("span", {style: {background: "var(--info)"}}), `未来 ${F.num(candidate.dte, 0)} 天定投（${s.dcaDaily} USDT/天）`, h("b", {text: F.num(dca, 2)})),
        h("div", {}, h("span"), h("strong", {text: "合计（不含生活应急金）"}), h("b", {text: F.num(total, 2) + " USDT"}))),
      h("p.muted", {text: "对话 #79：本金、抄底资金、定投资金三者隔离；卖 Put 时不能挪用已预留的抄底资金。"}));
  }
  out.push(section(n++, "资金与费用"),
    h("dl.kv", {},
      m.collateralBasis === "cash" && m.collateral !== null ? [h("dt", {text: "现金担保（足额赔付）"}), h("dd", {text: F.num(m.collateral, 2)})] : null,
      h("dt", {text: "开仓保证金（估算）"}), h("dd", {text: F.num(m.marginIm, 2)}),
      h("dt", {text: "开仓手续费"}), h("dd", {text: F.num(m.entryFees, 4)}),
      m.breakevens?.length ? [h("dt", {text: "到期盈亏平衡价"}), h("dd", {text: m.breakevens.map(F.price).join(" / ")})] : null,
      h("dt", {text: "盈亏平衡距离"}), h("dd", {class: F.tone(m.breakevenDist), text: F.signedPct(m.breakevenDist, 2)}),
      h("dt", {text: "组合 Delta / Theta / Vega"}), h("dd", {text: `${F.signed(m.delta, 4)} / ${F.signed(m.theta, 3)} / ${F.signed(m.vega, 3)}`})),
    h("p.muted", {text: "手续费按币安基础费率；VIP 与返佣不同。保证金按币安清算规则估算，实际以交易所计算为准。"}));
  return out;
}

function legsTab(candidate) {
  const age = ms => ms === null || ms === undefined ? "未知" : ms < 1500 ? "实时" : F.num(ms / 1000, 0) + " 秒";
  return [h("div", {style: {overflow: "auto"}}, h("table.mini", {}, h("thead", {}, h("tr", {}, ["腿", "买一 / 量", "卖一 / 量", "标记", "IV 买/标/卖", "Δ", "Θ", "Vega", "时效"].map(text => h("th", {text})))),
    h("tbody", {}, candidate.legs.map(leg => h("tr", {},
      h("td", {}, h("div", {text: (leg.action === "SELL" ? "卖 " : "买 ") + (leg.ratio !== 1 ? leg.ratio + "× " : "") + leg.symbol})),
      h("td", {text: `${F.num(leg.bid, 0)} / ${F.num(leg.bidQty, 2)}`}), h("td", {text: `${F.num(leg.ask, 0)} / ${F.num(leg.askQty, 2)}`}),
      h("td", {text: F.num(leg.mark, 1)}),
      h("td", {text: [leg.bidIv, leg.iv, leg.askIv].map(v => F.isNum(v) ? F.num(v * 100, 1) : "—").join(" / ")}),
      h("td", {text: F.num(leg.delta, 3)}), h("td", {text: F.num(leg.theta, 2)}), h("td", {text: F.num(leg.vega, 2)}), h("td", {class: leg.quoteFresh ? "" : "warn", text: age(leg.quoteAge)})))))),
    h("p.muted", {text: "价格单位 USDT / BTC；币安 BTC 期权 1 张 = 1 BTC，最小 0.01 张；到期 08:00 UTC（北京 16:00），现金结算。"})];
}

export function ticket(candidate, strategy) {
  const m = candidate.metrics;
  const lines = [`策略：${strategy.name}（${strategy.nameEn}）`,
    ...candidate.legs.map((leg, i) => `腿 ${i + 1}：${leg.action === "SELL" ? "卖出" : "买入"} ${leg.symbol} × ${Number((candidate.qty * leg.ratio).toFixed(4))} 张 @ ${leg.price}（${leg.action === "SELL" ? "买一" : "卖一"}）`),
    `到期：${F.expiry(candidate.expiryMs, {year: true})} 16:00（北京）· 剩余 ${F.dte(candidate.dte)}`,
    `净权利金：${F.signed(m.netCredit, 2)} USDT · 最大亏损：${m.maxLoss === Infinity ? "无上限" : F.num(m.maxLoss, 2) + " USDT"} · 盈亏平衡：${m.breakevens.map(F.price).join(" / ") || "—"}`,
    `提示：以上为看板筛选时的报价快照，请在币安确认实时价格、数量与保证金后自行决定。`];
  return lines.join("\n");
}

function tabBody(candidate, state, actions) {
  const tab = state.detailTab;
  return tab === "stress" ? stressTab(candidate, state) : tab === "funds" ? fundsTab(candidate, state, actions)
    : tab === "legs" ? legsTab(candidate) : rulesTab(candidate, state);
}

function emptyDetail(root) {
  refs = null;
  chart?.dispose();
  chart = null;
  fill(root, h("div.detail-empty", {},
    h("div", {}, enso({loop: false}),
      h("p", {text: "选择一个候选，查看到期损益、规则检查、压力测试与资金规划。"}),
      h("p.muted", {}, h("kbd", {text: "↑"}), " ", h("kbd", {text: "↓"}), " 在候选间移动"))));
}

function buildHead(candidate, strategy, actions) {
  const holdToExpiry = candidate.legs.some(leg => leg.action === "SELL" && leg.type === "PUT") && ["crash-put", "bull-put", "income-put", "budget-put"].includes(strategy.id);
  const seal = h("span.seal-stamp." + (candidate.passed ? "ok" : "no"), {text: candidate.passed ? "入选" : "差一条"});
  const node = h("div.detail-head", {},
    h("button.icon-btn.detail-close", {type: "button", "aria-label": "关闭详情", onClick: actions.closeDetail}, icon("close")),
    h("h2", {}, title(candidate, strategy), seal),
    h("div.meta", {text: `到期 ${F.expiry(candidate.expiryMs, {year: true})} 16:00 · 剩余 ${F.dte(candidate.dte)} · 数量 ${F.num(candidate.qty, 2)} BTC` + (holdToExpiry ? " · 持有到期（你的选择 A，对话 #77）" : "")}),
    h("div.leg-list", {}, candidate.legs.map(leg => h("div.leg-row", {},
      h("span.leg", {}, h("span.side." + (leg.action === "SELL" ? "s" : "b"), {text: leg.action === "SELL" ? "卖" : "买"})),
      h("div", {}, h("div.sym", {text: (leg.ratio !== 1 ? leg.ratio + "× " : "") + leg.symbol}),
        h("div.muted", {style: {"font-size": "11px"}, text: `价外 ${F.signedPct(leg.otmPct, 1)} · IV ${F.pct((leg.iv ?? NaN) * 100, 1)} · Δ ${F.num(leg.delta, 3)}`})),
      h("div.px", {}, F.num(leg.price, leg.price >= 100 ? 0 : 2), h("small", {text: leg.action === "SELL" ? "买一" : "卖一"}))))));
  return {node, seal};
}

function buildFoot(candidate, state, actions) {
  const watched = state.watch.has(candidate.key);
  return h("div.detail-foot", {},
    h("button.btn.primary", {type: "button", onClick: () => actions.copyTicket(candidate)}, icon("copy"), "复制订单参数"),
    h("span.spacer"),
    h("a.icon-btn", {href: "https://www.binance.com/zh-CN/eoptions/BTCUSDT", target: "_blank", rel: "noopener noreferrer", "aria-label": "在币安查看", "data-tip": "在币安查看|打开币安期权交易页面"}, icon("external")),
    h("button.icon-btn", {type: "button", "aria-pressed": String(watched), "aria-label": watched ? "移出观察" : "加入观察", onClick: () => actions.toggleWatch(candidate.key),
      "data-tip": watched ? "已观察|再次点击移出" : "观察|在列表中以 ★ 标记"}, icon("star")));
}

function rulesLabel(candidate) {
  const warnCount = candidate.checks.filter(c => c.status === "warn").length;
  return ["规则检查", warnCount ? h("span.badge.w", {text: String(warnCount)}) : null];
}

function drawChart(candidate, state, animate) {
  if (!chart || !state.detail) return;
  const overlay = state.strategy.overlay === "spot";
  chart.update({...state.detail, strikes: [...new Set(candidate.legs.map(leg => leg.strike))], breakevens: candidate.metrics.breakevens},
    {spot: state.market?.spot, combined: overlay && state.overlay}, {animate});
}

/**
 * A different candidate (or strategy) earns the entrance: seal stamp,
 * figures, then the brush. The same candidate refreshes in place over three
 * short frames (figures → chart → tab), so a live update never costs a
 * long frame or moves the scroll position.
 */
export function renderDetail(root, state, actions) {
  const candidate = state.selected, strategy = state.strategy;
  if (!candidate) { if (refs !== null || !root.querySelector(".detail-empty")) emptyDetail(root); return; }
  const fresh = !refs || refs.key !== candidate.key || refs.strategyId !== strategy.id;
  const overlay = strategy.overlay === "spot";

  if (!fresh && refs.scroll?.isConnected && !state.redrawChart && refs.hasChart === Boolean(state.detail) && refs.overlay === state.overlay) {
    const {node: head} = buildHead(candidate, strategy, actions);
    refs.head.replaceWith(head); refs.head = head;
    const figures = kpis(candidate, state);
    refs.kpis.replaceWith(figures); refs.kpis = figures;
    const model = modelLine(candidate, state);
    refs.model.replaceWith(model); refs.model = model;
    const foot = buildFoot(candidate, state, actions);
    refs.foot.replaceWith(foot); refs.foot = foot;
    fill(refs.tabs.get("rules"), ...rulesLabel(candidate));
    const key = candidate.key;
    // Deferred steps re-check that this candidate is still the one shown.
    const current = () => refs?.key === key && state.selected?.key === key;
    requestAnimationFrame(() => {
      if (!current()) return;
      drawChart(state.selected, state, false);
      requestAnimationFrame(() => {
        if (!current() || refs.body.contains(document.activeElement)) return;
        const top = refs.scroll.scrollTop;
        fill(refs.body, tabBody(state.selected, state, actions));
        refs.scroll.scrollTop = top;
      });
    });
    return;
  }

  const scroller = root.querySelector(".detail-scroll");
  const previousScroll = !fresh && scroller ? scroller.scrollTop : 0;
  const tabButtons = new Map(), ink = h("i.tab-ink", {"aria-hidden": "true"});
  const tabs = h("div.tabs", {role: "tablist", "aria-label": "详情"}, TABS.map(([id, label]) => {
    const button = h("button", {type: "button", role: "tab", id: "tab-" + id, "aria-controls": "tabPanel", "aria-selected": String(state.detailTab === id),
      onClick: () => actions.setDetailTab(id)}, ...(id === "rules" ? rulesLabel(candidate) : [label]));
    tabButtons.set(id, button);
    return button;
  }), ink);
  // A new candidate's tab body joins two frames later (after the chart); a
  // structural rebuild of the same candidate fills it at once.
  const body = h("div.tab-body", {role: "tabpanel", id: "tabPanel", "aria-labelledby": "tab-" + state.detailTab}, fresh ? null : tabBody(candidate, state, actions));
  if (fresh) {
    const key = candidate.key;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (refs?.key !== key || refs.body !== body || state.selected?.key !== key) return;
      fill(body, tabBody(state.selected, state, actions));
      inkIn(body.children, {step: 16, max: 6, from: .2, duration: 220});
    }));
  }

  if (fresh) { chart?.dispose(); chart = null; }
  if (state.detail && !chart) chart = createPayoffChart();
  const figures = kpis(candidate, state), model = modelLine(candidate, state);
  const {node: head, seal} = buildHead(candidate, strategy, actions);
  const chartBox = state.detail ? h("div.chart-box", {},
    h("div.chart-toolbar", {},
      h("span.key", {}, h("i" + (overlay && state.overlay ? ".comb" : "")), overlay && state.overlay ? "现货 + 期权（到期）" : "到期"),
      h("span.key", {}, h("i.now"), "当前盯市"),
      h("span.key", {"data-tip": "模型分布|对数正态，σ 为预测波动率（设置中可改）"}, h("i.dens"), "模型分布"),
      h("span.spacer"),
      overlay ? h("div.seg", {role: "group", "aria-label": "损益口径"},
        h("button", {type: "button", "aria-pressed": String(!state.overlay), onClick: () => actions.setOverlay(false)}, "仅期权"),
        h("button", {type: "button", "aria-pressed": String(state.overlay), onClick: () => actions.setOverlay(true)}, "含现货")) : null),
    chart.node) : h("div.chart-box", {}, h("div.loading", {style: {padding: "48px 0", height: "260px"}}, enso()));
  const scroll = h("div.detail-scroll", {}, head, figures, model, chartBox, tabs, body);
  const foot = buildFoot(candidate, state, actions);
  fill(root, scroll, foot);

  const drawnBefore = refs?.drawnKey === candidate.key;
  refs = {root, key: candidate.key, strategyId: strategy.id, tabs: tabButtons, ink, body, scroll, head, kpis: figures, model, foot,
    hasChart: Boolean(state.detail), drawnKey: state.detail ? candidate.key : refs?.drawnKey ?? null, overlay: state.overlay};
  if (state.detail) {
    const quick = performance.now() - lastFreshAt < 1200;
    const animate = !drawnBefore || state.redrawChart ? (quick ? 300 : 520) : false;
    // A new candidate's chart draws in the next frame: the stamp and
    // figures answer the click first, then the brush starts.
    if (fresh) requestAnimationFrame(() => { if (refs?.key === candidate.key && state.selected?.key === candidate.key) drawChart(candidate, state, animate); });
    else drawChart(candidate, state, animate);
  }
  placeInk(ink, tabButtons.get(state.detailTab), {axis: "x", instant: true});
  scroll.scrollTop = previousScroll;
  if (fresh) {
    lastFreshAt = performance.now();
    stamp(seal);
    inkIn([head.querySelector("h2"), head.querySelector(".meta"), ...head.querySelectorAll(".leg-row")], {step: 24, from: .2});
    inkIn([...figures.children, model], {step: 26, distance: 4, from: .2});
  }
}

/** Switches tabs in place: the ink glides, the body inks in. */
export function switchTab(state, actions) {
  if (!refs || !state.selected || refs.key !== state.selected.key) return false;
  for (const [id, button] of refs.tabs) button.setAttribute("aria-selected", String(id === state.detailTab));
  placeInk(refs.ink, refs.tabs.get(state.detailTab), {axis: "x"});
  refs.body.setAttribute("aria-labelledby", "tab-" + state.detailTab);
  // The ink moves in this frame; the (possibly large) body follows in the next.
  const tab = state.detailTab, key = refs.key;
  requestAnimationFrame(() => {
    if (!refs || refs.key !== key || state.detailTab !== tab || state.selected?.key !== key) return;
    fill(refs.body, tabBody(state.selected, state, actions));
    inkIn(refs.body.children, {step: 16, max: 8, from: .2, duration: 220});
  });
  return true;
}

export const originLabel = key => ORIGINS[key]?.label ?? "";
