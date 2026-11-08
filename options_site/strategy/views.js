// Rail, market strip, strategy header, results and status bar. Structures are
// built once and updated in place, so live data never interrupts focus or
// motion. Restraint is deliberate: one line per idea, details on demand.
import {h, icon, fill} from "./dom.js";
import * as F from "./format.js";
import {openPopover, closePopover, popoverOpen} from "./ui.js";
import {termSparkline, enso} from "./charts.js";
import {ticker, flip, inkIn, stamp, placeInk, reduced} from "./motion.js";
import {STRATEGIES, GROUPS, METRICS, ORIGINS, CITATIONS, defaultParams} from "../lib/strategies.mjs";
import {CHECK_LABELS} from "../lib/checks.mjs";

const ORIGIN_LABEL = key => ORIGINS[key]?.label ?? "默认";
const shortOption = label => String(label).split("：")[0];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* -------------------------------------------------------------------- rail */
export function renderRail(root, state, actions) {
  const filter = state.railFilter.trim().toLowerCase();
  const matches = s => !filter || [s.name, s.nameEn, s.tagline, s.id].some(text => String(text).toLowerCase().includes(filter));
  const groups = GROUPS.map(group => {
    const items = STRATEGIES.filter(s => s.group === group.id && matches(s));
    if (!items.length) return null;
    return h("section.rail-group", {}, h("header", {}, h("span", {text: group.label})),
      items.map(s => h("button.strategy-item", {type: "button", role: "option", dataset: {id: s.id}, "aria-current": String(s.id === state.strategyId),
        "aria-selected": String(s.id === state.strategyId), "data-tip": `${s.name}|${s.tagline}${s.hotkey ? " · 快捷键 " + s.hotkey : ""}`,
        onClick: () => actions.selectStrategy(s.id)},
      h("span.name", {text: s.name}), countBadge(state.counts[s.id]))));
  });
  fill(root, ...groups.filter(Boolean));
  if (!root.children.length) root.append(h("p.muted", {text: "没有匹配的策略", style: {padding: "10px 14px"}}));
}

function countBadge(entry) {
  if (!entry) return h("span.count.busy", {text: "·", "aria-label": "计算中"});
  if (entry.error) return h("span.count", {text: "!"});
  if (entry.blocked) return h("span.count.watch", {text: String(entry.blockedCount ?? 0), "data-tip": "急跌未触发|严格模式下暂不给候选"});
  const gated = entry.gate === "idle";
  return h("span.count" + (entry.total ? gated ? ".watch" : ".has" : ""), {text: String(entry.total ?? 0),
    "data-tip": gated ? "观察名单|急跌条件尚未满足，候选仅供观察" : `${entry.total} 个候选满足全部条件`});
}

/** Selection, counts and the sliding ink mark, without rebuilding the rail. */
export function updateRail(root, ink, state, {instant = false} = {}) {
  let current = null;
  for (const button of root.querySelectorAll(".strategy-item")) {
    const active = button.dataset.id === state.strategyId;
    button.setAttribute("aria-current", String(active));
    button.setAttribute("aria-selected", String(active));
    if (active) current = button;
    const fresh = countBadge(state.counts[button.dataset.id]);
    const old = button.querySelector(".count");
    if (old && (old.textContent !== fresh.textContent || old.className !== fresh.className)) {
      old.replaceWith(fresh);
      if (!reduced() && !fresh.classList.contains("busy")) fresh.animate([{transform: "scale(.7)", opacity: .3}, {transform: "none", opacity: 1}], {duration: 260, easing: "cubic-bezier(.3,1.4,.5,1)"});
    }
  }
  placeInk(ink, current, {instant});
}

/* ------------------------------------------------------------ market strip */
let regimeRefs = null;

function block(label, tip, extra = "") {
  const value = h("strong"), sub = h("small");
  const node = h("div.metric-block" + extra, {"data-tip": tip}, h("label", {}, label), value, sub);
  return {node, value, sub};
}

function buildRegime(root) {
  const price = h("span.hero-price.ticker", {"aria-label": "—"}), change = h("span.chg");
  const returns = Object.fromEntries(["1h", "24h", "7d"].map(key => [key, h("b")]));
  const triggerLabel = h("label"), stateNode = h("span.trigger-state"), drawdown = h("strong.num");
  const gauge = h("div.gauge", {}, h("i"), h("b")), last = h("small");
  const ripples = [h("i.ripple"), h("i.ripple.r2")];
  const trigger = h("div.metric-block.trigger-block", {}, triggerLabel,
    h("div.trigger-row", {}, stateNode, drawdown), gauge, last, ripples);
  const vol = block("波动率 · 30 天", "隐含与已实现波动率|平值 IV 按总方差插值到 30 天；RV30 为过去 30 天日收益年化波动。IV−RV 为波动率风险溢价（对话 #65）", ".vol-block");
  const rr = block("25Δ 风险逆转", "25Δ 风险逆转|25Δ Call IV − 25Δ Put IV。负值越大，市场为下跌保护支付的溢价越高", ".rr-block");
  const termHost = h("span"), termSub = h("small");
  fill(root,
    h("div.metric-block.hero", {"data-tip": "BTC 指数|币安期权的结算参考指数，到期结算价为到期前 30 分钟指数均价"},
      h("label", {}, "BTC 指数"), h("div.hero-line", {}, price, change)),
    h("div.metric-block.returns-block", {"data-tip": "涨跌幅|基于币安 BTCUSDT K 线与当前指数"}, h("label", {}, "涨跌"),
      h("div.returns", {}, Object.entries(returns).map(([key, node]) =>
        h("div.ret", {}, h("span", {text: {"1h": "1 小时", "24h": "24 小时", "7d": "7 天"}[key]}), node)))),
    trigger, vol.node, rr.node,
    h("div.metric-block.term-block", {"data-tip": "平值 IV 期限结构|各到期日平值隐含波动率（横轴为 √剩余天数）"}, h("label", {}, "IV 期限结构"), termHost, termSub));
  regimeRefs = {root, price, change, returns, trigger, triggerLabel, stateNode, drawdown, gauge, last, ripples, vol, rr, termHost, termSub,
    lastStatus: null, termKey: ""};
}

export function renderRegime(root, state) {
  if (!regimeRefs || regimeRefs.root !== root) buildRegime(root);
  const r = state.regime, refs = regimeRefs, spot = state.market?.spot;
  ticker(refs.price, F.price(spot));
  const change24 = r?.moves?.returns?.["24h"];
  refs.change.className = "chg " + F.tone(change24);
  refs.change.textContent = F.signedPct(change24, 2);
  for (const [key, node] of Object.entries(refs.returns)) {
    const v = r?.moves?.returns?.[key];
    node.className = F.tone(v);
    node.textContent = F.signedPct(v, 2);
  }

  const t = state.trigger, status = t?.status ?? null;
  refs.trigger.setAttribute("data-tip", `急跌触发器（对话 #44）|窗口 ${t?.windowHours ?? 24} 小时内从最高价回撤 ≥ ${t?.thresholdPct ?? 5}% 视为触发。对话 #76：这是观察信号，不是充分的入场信号。`);
  refs.triggerLabel.textContent = `急跌触发 · ${t?.windowHours ?? 24}h ≥ ${t?.thresholdPct ?? 5}%`;
  const label = status === "triggered" ? "已触发" : status === "idle" ? "未触发" : "待数据";
  if (refs.stateNode.dataset.status !== String(status)) {
    refs.stateNode.dataset.status = String(status);
    refs.stateNode.className = "trigger-state" + (status === "triggered" ? " on" : status === "idle" ? " off" : "");
    const seal = h("span.stamp", {text: label});
    fill(refs.stateNode, seal);
    if (status === "triggered" && refs.lastStatus === "idle") {
      stamp(seal);
      for (const ripple of refs.ripples) { ripple.classList.remove("go"); void ripple.offsetWidth; ripple.classList.add("go"); }
    }
  }
  refs.lastStatus = status;
  refs.drawdown.textContent = Number.isFinite(t?.drawdownPct) ? "−" + F.num(t.drawdownPct, 2) + "%" : "—";
  const progress = Number.isFinite(t?.drawdownPct) && t.thresholdPct > 0 ? Math.min(1.25, t.drawdownPct / t.thresholdPct) : 0;
  refs.gauge.classList.toggle("hot", status === "triggered");
  refs.gauge.style.setProperty("--p", (Math.min(1, progress / 1.25)).toFixed(4));
  refs.gauge.style.setProperty("--mark", (100 / 1.25).toFixed(1) + "%");
  refs.last.textContent = status === "triggered" ? "现在满足条件"
    : Number.isFinite(t?.hoursSinceTrigger) ? "上次触发 " + F.hours(t.hoursSinceTrigger) + "前" : status ? "近 7 天未触发" : "等待 K 线";

  const rv30 = r?.rv?.rv30, iv30 = r?.iv?.atm30, vrp = r?.vrp;
  fill(refs.vol.value, h("span", {}, "IV ", F.pct(iv30 * 100, 1)), h("span.dim", {}, " · RV ", F.pct(rv30 * 100, 1)));
  fill(refs.vol.sub, vrp ? h("span", {class: F.tone(vrp.spread)}, "IV−RV " + F.signed(vrp.spread, 1) + " 点") : "IV−RV —");
  const nearMonth = (r?.iv?.term ?? []).filter(x => x.dte >= 14).sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30))[0];
  refs.rr.value.className = F.tone(nearMonth?.rr25);
  refs.rr.value.textContent = Number.isFinite(nearMonth?.rr25) ? F.signed(nearMonth.rr25 * 100, 1) : "—";
  refs.rr.sub.textContent = nearMonth ? `${F.expiry(nearMonth.expiryMs)} 到期` : "—";
  const term = r?.iv?.term ?? [];
  const termKey = term.map(x => x.dte.toFixed(2) + ":" + (x.atmIv ?? 0).toFixed(4)).join("|");
  if (termKey !== refs.termKey) { refs.termKey = termKey; fill(refs.termHost, termSparkline(term)); }
  refs.termSub.textContent = term.length ? `${F.pct(term[0].atmIv * 100, 0)} → ${F.pct(term.at(-1).atmIv * 100, 0)}` : "—";
}

/* ---------------------------------------------------------- strategy head */
function paramText(spec, value) {
  if (spec.type === "range") return `${F.num(value[0], decimals(spec.step))}–${F.num(value[1], decimals(spec.step))}${unitText(spec.unit)}`;
  if (spec.type === "number") return `${F.num(value, decimals(spec.step))}${unitText(spec.unit)}`;
  const option = spec.options.find(item => String(item.value) === String(value));
  return shortOption(option?.label ?? value);
}
const decimals = step => Math.max(0, Math.min(4, (String(step).split(".")[1] ?? "").length));
const unitText = unit => !unit ? "" : unit === "%" || unit === "×" ? unit : " " + unit;

function originNote(spec) {
  return h("div.origin-note", {}, spec.origin === "user" ? h("i.origin-dot") : null,
    h("div", {}, h("b", {text: ORIGIN_LABEL(spec.origin) + "　"}), spec.help || ORIGINS[spec.origin]?.hint || ""));
}

function rangeEditor(spec, value, defaults, apply) {
  let [lo, hi] = value;
  const toPct = v => ((v - spec.min) / (spec.max - spec.min) * 100).toFixed(2) + "%";
  const inputs = [lo, hi].map((v, i) => h("input", {type: "range", min: spec.min, max: spec.max, step: spec.step, value: v,
    "aria-label": spec.label + (i ? "上限" : "下限")}));
  const boxes = [lo, hi].map((v, i) => h("input.num-input", {type: "number", min: spec.min, max: spec.max, step: spec.step, value: v,
    "aria-label": spec.label + (i ? "上限" : "下限"), inputmode: "decimal"}));
  const range = h("div.range", {}, h("i.track"), h("i.fill"), inputs);
  const sync = source => {
    if (lo > hi) [lo, hi] = source === 0 ? [hi, hi] : [lo, lo];
    inputs[0].value = lo; inputs[1].value = hi;
    if (document.activeElement !== boxes[0]) boxes[0].value = lo;
    if (document.activeElement !== boxes[1]) boxes[1].value = hi;
    range.style.setProperty("--lo", toPct(lo));
    range.style.setProperty("--hi", toPct(hi));
    apply([lo, hi]);
  };
  inputs.forEach((input, i) => input.addEventListener("input", () => { if (i) hi = Number(input.value); else lo = Number(input.value); sync(i); }));
  boxes.forEach((box, i) => box.addEventListener("change", () => {
    const v = Math.min(spec.max, Math.max(spec.min, Number(box.value)));
    if (!Number.isFinite(v)) return;
    if (i) hi = v; else lo = v;
    sync(i);
  }));
  range.style.setProperty("--lo", toPct(lo)); range.style.setProperty("--hi", toPct(hi));
  return [h("div.row", {}, boxes[0], h("span.muted", {text: "至", style: {flex: "0"}}), boxes[1]), range,
    h("div.row", {}, h("span.muted", {text: `范围 ${spec.min}–${spec.max}${unitText(spec.unit)}`}),
      h("button.btn.ghost", {type: "button", style: {flex: "0"}, onClick: () => { [lo, hi] = defaults; sync(0); }}, icon("reset"), "默认 " + paramText(spec, defaults)))];
}

function numberEditor(spec, value, fallback, apply) {
  const box = h("input.num-input", {type: "number", min: spec.min, max: spec.max, step: spec.step, value, "aria-label": spec.label, inputmode: "decimal"});
  const slider = h("input", {type: "range", min: spec.min, max: spec.max, step: spec.step, value, "aria-label": spec.label});
  const range = h("div.range", {}, h("i.track"), h("i.fill"), slider);
  const paint = v => { range.style.setProperty("--lo", "0%"); range.style.setProperty("--hi", ((v - spec.min) / (spec.max - spec.min) * 100).toFixed(2) + "%"); };
  paint(value);
  const set = v => { if (!Number.isFinite(v)) return; v = Math.min(spec.max, Math.max(spec.min, v)); box.value = v; slider.value = v; paint(v); apply(v); };
  box.addEventListener("change", () => set(Number(box.value)));
  slider.addEventListener("input", () => set(Number(slider.value)));
  return [h("div.row", {}, box, h("span.muted", {text: unitText(spec.unit) || " ", style: {flex: "0"}})), range,
    h("div.row", {}, h("span.muted", {text: `范围 ${spec.min}–${spec.max}`}),
      h("button.btn.ghost", {type: "button", style: {flex: "0"}, onClick: () => set(fallback)}, icon("reset"), "默认 " + paramText(spec, fallback)))];
}

function selectEditor(spec, value, apply) {
  return h("div.options", {role: "radiogroup", "aria-label": spec.label}, spec.options.map(option =>
    h("button.option", {type: "button", role: "radio", "aria-checked": String(String(option.value) === String(value)),
      onClick: () => { apply(option.value); closePopover(); }}, option.label)));
}

const visibleParams = (strategy, params) => strategy.params.filter(spec => spec.key !== "rank"
  && !(spec.key === "quantity" && params.quantityMode && params.quantityMode !== "fixed")
  && !(["dropWindow", "dropPct"].includes(spec.key) && params.trigger === "off"));

let headRefs = null;

/** Header for a strategy: name, one-line thesis, trigger status, parameters. */
export function renderHead(root, state, actions) {
  const strategy = state.strategy;
  const gate = h("div.gate-slot"), params = h("div.params");
  const sources = strategy.citations.slice(0, 4).map(ref => CITATIONS[ref]).filter(Boolean)
    .map(quote => typeof quote.ref === "number" ? "对话 #" + quote.ref : quote.ref === "model" ? "交易模型" : "工作台").join("、");
  fill(root,
    h("div.title-row", {},
      h("h1", {text: strategy.name}),
      h("div.actions", {},
        h("button.icon-btn", {type: "button", "aria-label": "复制链接", onClick: actions.copyLink, "data-tip": "复制链接|包含当前策略与参数，可分享或收藏"}, icon("link")),
        h("button.icon-btn", {type: "button", "aria-label": "导出 CSV", onClick: actions.exportCsv, "data-tip": "导出 CSV|全部候选与指标（快捷键 E）"}, icon("download")),
        h("button.icon-btn", {type: "button", id: "freezeButton", "aria-label": "冻结快照", "aria-pressed": String(state.frozen), onClick: actions.toggleFreeze,
          "data-tip": state.frozen ? "恢复实时|继续跟随最新行情（快捷键 F）" : "冻结快照|固定当前行情以便比较（快捷键 F）"}, icon(state.frozen ? "play" : "pause")))),
    h("p.tagline", {text: strategy.tagline, "data-tip": `${strategy.name} · ${strategy.nameEn}|方向 ${strategy.view.direction} · 波动率 ${strategy.view.vol} · 风险 ${strategy.view.risk}${sources ? " · 出处 " + sources : ""}`}),
    gate, params);
  headRefs = {root, strategyId: strategy.id, gate, params, gateKey: "", paramsKey: ""};
  updateHead(state, actions);
}

/** Live parts of the header: trigger status and parameter chips. */
export function updateHead(state, actions) {
  if (!headRefs || headRefs.strategyId !== state.strategyId) return;
  const gate = state.result?.strategyId === state.strategyId ? state.result.gate ?? null : null;
  const gateKey = gate ? [gate.status, gate.mode, gate.drawdownPct?.toFixed(2), gate.hoursSinceTrigger?.toFixed(1)].join("|") : "";
  if (gateKey !== headRefs.gateKey) {
    headRefs.gateKey = gateKey;
    fill(headRefs.gate, gate ? gateLine(gate, actions) : null);
  }
  const strategy = state.strategy, params = state.params, defaults = defaultParams(strategy);
  const specs = visibleParams(strategy, params);
  const modified = new Set(strategy.params.filter(spec => !same(params[spec.key], defaults[spec.key])).map(spec => spec.key));
  // Collapsed: only what you changed is on show; everything else is one click away.
  const shown = state.paramsOpen ? specs : specs.filter(spec => modified.has(spec.key));
  const paramsKey = shown.map(spec => spec.key).join(",") + "|" + state.paramsOpen;
  if (paramsKey !== headRefs.paramsKey) {
    const opening = state.paramsOpen && !headRefs.paramsKey.endsWith("|true");
    headRefs.paramsKey = paramsKey;
    if (popoverOpen()) closePopover();
    const toggle = h("button.chip.toggle", {type: "button", "aria-expanded": String(Boolean(state.paramsOpen)), onClick: actions.toggleParams},
      h("span", {text: "参数"}), h("b", {text: String(specs.length)}), icon("chevron"));
    fill(headRefs.params, toggle, shown.map(spec => {
      const chip = h("button.chip", {type: "button", "aria-expanded": "false", "aria-haspopup": "dialog", dataset: {key: spec.key},
        "data-tip": `${spec.label}|${ORIGIN_LABEL(spec.origin)}：${spec.help || "可调整参数"}`},
      spec.origin === "user" ? h("i.origin-dot", {"aria-label": "你的规则"}) : null, h("span", {text: spec.label}), h("b"));
      chip.addEventListener("click", () => {
        const current = state.params;
        const apply = value => actions.setParam(spec.key, value);
        const body = spec.type === "range" ? rangeEditor(spec, current[spec.key], defaults[spec.key], apply)
          : spec.type === "number" ? numberEditor(spec, current[spec.key], defaults[spec.key], apply) : selectEditor(spec, current[spec.key], apply);
        openPopover(chip, [h("h4", {}, spec.label), body, originNote(spec)], {label: spec.label});
      });
      return chip;
    }), h("button.chip-reset", {type: "button", hidden: true, onClick: actions.resetParams, "data-tip": "恢复默认|恢复为对话中你的规则与默认值"}));
    if (opening) inkIn(headRefs.params.querySelectorAll(".chip[data-key]"), {step: 12, max: 14, distance: 3, duration: 200});
  }
  for (const chip of headRefs.params.querySelectorAll(".chip[data-key]")) {
    const spec = strategy.params.find(p => p.key === chip.dataset.key);
    chip.querySelector("b").textContent = paramText(spec, params[spec.key]);
    chip.classList.toggle("modified", modified.has(spec.key));
  }
  const reset = headRefs.params.querySelector(".chip-reset");
  reset.hidden = !modified.size;
  reset.textContent = "重置 " + modified.size;
  const freeze = headRefs.root.querySelector("#freezeButton");
  if (freeze && freeze.getAttribute("aria-pressed") !== String(state.frozen)) {
    freeze.setAttribute("aria-pressed", String(state.frozen));
    freeze.setAttribute("data-tip", state.frozen ? "恢复实时|继续跟随最新行情（快捷键 F）" : "冻结快照|固定当前行情以便比较（快捷键 F）");
    fill(freeze, icon(state.frozen ? "play" : "pause"));
  }
}

function gateLine(gate, actions) {
  const progress = Number.isFinite(gate.drawdownPct) && gate.thresholdPct > 0 ? Math.min(1, gate.drawdownPct / gate.thresholdPct) : 0;
  const gauge = h("span.gauge" + (gate.status === "triggered" ? ".hot" : ""), {}, h("i"), h("b"));
  gauge.style.setProperty("--p", (progress * .8).toFixed(4));
  gauge.style.setProperty("--mark", "80%");
  const dd = Number.isFinite(gate.drawdownPct) ? gate.drawdownPct : 0;
  const status = gate.status === "triggered" ? "急跌已触发" : gate.status === "unknown" ? "急跌状态未知" : "急跌未触发";
  const detail = gate.status === "unknown" ? "缺少 K 线，候选按观察名单列出"
    : `${gate.windowHours} 小时回撤 ${F.num(dd, 2)}% / ${gate.thresholdPct}%`;
  const tip = gate.status === "triggered" ? "急跌条件已满足|对话 #76：先观察 Put 报价与 IV，再决定是否卖出。"
    : gate.status === "unknown" ? "无法判断急跌条件|缺少 K 线数据。"
      : `${gate.mode === "strict" ? "严格模式：未触发时不给候选" : "观察名单：候选仅供观察"}|距阈值还差 ${F.num(Math.max(0, gate.thresholdPct - dd), 2)} 个百分点${Number.isFinite(gate.hoursSinceTrigger) ? "；上次触发在 " + F.hours(gate.hoursSinceTrigger) + "前" : "；近 7 天未触发"}。`;
  return h("div.gate-line" + (gate.status === "triggered" ? ".on" : gate.status === "idle" ? ".off" : ""), {role: "status", "data-tip": tip},
    h("span.dot"), h("span.gate-text", {}, h("b", {text: status}), " · " + detail), gauge,
    gate.status === "idle" && gate.mode !== "strict" ? h("span.zen", {text: "静待时机"}) : null,
    gate.mode === "strict" && gate.status !== "triggered" ? h("button.btn.ghost", {type: "button", onClick: () => actions.setParam("trigger", "watch")}, "显示观察名单") : null);
}

/* ---------------------------------------------------------------- results */
const grid = {rows: new Map(), columnsKey: "", order: [], token: 0};
const PRIORITY = ["otm", "dte", "netCredit", "pop", "maxLoss", "moveToBe", "iv", "budgetPremium"];

/** Five columns by default: the ranking metric plus the essentials it has. */
export function columnsFor(state) {
  const strategy = state.strategy, all = strategy.columns;
  if (state.allColumns) return all;
  const rank = state.params.rank ?? state.result?.rank;
  const picked = new Set([rank, state.viewSort?.metric].filter(key => all.includes(key)));
  for (const key of PRIORITY) if (picked.size < 5 && all.includes(key)) picked.add(key);
  for (const key of all) if (picked.size < 5) picked.add(key);
  return all.filter(key => picked.has(key));
}

function legSummary(candidate) {
  return h("div.legs", {}, candidate.legs.map(leg => h("span.leg", {},
    h("span.side." + (leg.action === "SELL" ? "s" : "b"), {text: (leg.action === "SELL" ? "卖" : "买") + (leg.ratio !== 1 ? "×" + leg.ratio : "")}),
    h("span.t", {text: leg.type === "PUT" ? "P" : "C"}), h("span.k", {text: F.price(leg.strike)}), h("span.e", {text: F.expiry(leg.expiryMs)}))));
}

const TONED = new Set(["netCredit", "ev", "dailyPremium", "budgetPremium", "breakevenDist", "richness", "termSpread"]);

export function renderResults(state, actions, els, {fresh = false} = {}) {
  const {strategy, result} = state;
  const ready = Boolean(state.market?.ok) && Boolean(result) && result.strategyId === strategy.id;
  const columns = columnsFor(state);
  const rankMetric = result?.rank;
  const rankSpec = strategy.params.find(p => p.key === "rank");

  const summary = !ready ? h("span.summary", {text: state.market?.ok ? "正在筛选…" : "等待行情…"})
    : h("span.summary", {"data-tip": `筛选明细|已评估 ${result.evaluated ?? 0} 个组合 · 用时 ${F.num(result.elapsedMs ?? 0, 0)} ms${result.truncated ? " · 结果已截断" : ""}`},
      h("b", {text: String(result.blocked ? 0 : result.total)}), " 个候选");
  const rankSelect = h("select.select", {"aria-label": "排序依据"}, rankSpec.options.map(option =>
    h("option", {value: option.value, selected: option.value === state.params.rank ? true : null, text: "按" + option.label + (METRICS[option.value].better === "low" ? "（低→高）" : "（高→低）")})));
  rankSelect.addEventListener("change", () => actions.setParam("rank", rankSelect.value));
  fill(els.resultsBar, summary, h("span.spacer"),
    state.viewSort ? h("button.btn.ghost", {type: "button", onClick: () => actions.setSort(null)}, icon("reset"), "默认排序") : null,
    h("button.btn.ghost.columns-toggle", {type: "button", "aria-pressed": String(Boolean(state.allColumns)), onClick: actions.toggleColumns,
      "data-tip": state.allColumns ? "精简列|只显示排序依据与关键指标" : `全部 ${strategy.columns.length} 列|显示该策略的全部指标`},
    state.allColumns ? "精简" : "全部列"),
    rankSelect);

  if (!ready) {
    els.grid.hidden = true;
    els.cards.hidden = true;
    els.empty.hidden = false;
    const t = state.transport;
    const message = state.market?.ok ? "正在按规则筛选候选…" : t?.error ? t.error + (t.retryIn ? `，${F.num(t.retryIn / 1000, 0)} 秒后重试` : "") : "首次加载需要读取合约目录与盘口，通常几秒内完成。";
    if (els.empty.dataset.mode !== "loading") {
      els.empty.dataset.mode = "loading";
      fill(els.empty, h("div.loading", {role: "status"}, enso({label: "加载中"}), h("p", {id: "loadingText", text: message})));
    } else {
      const node = els.empty.querySelector("#loadingText");
      if (node) node.textContent = message;
    }
    return;
  }

  const candidates = sortedView(state);
  const showEmpty = !candidates.length;
  els.empty.hidden = !showEmpty;
  els.grid.hidden = showEmpty;
  els.cards.hidden = showEmpty;
  if (showEmpty) {
    const key = "empty:" + strategy.id + ":" + JSON.stringify(result.rejected?.byCheck ?? {}) + (result.nearMisses ?? []).map(c => c.key).join(",") + result.blocked;
    if (els.empty.dataset.mode !== key) {
      els.empty.dataset.mode = key;
      fill(els.empty, emptyState(state, actions));
      if (fresh) inkIn(els.empty.querySelectorAll(".empty > *"), {step: 30, max: 6});
    }
  } else {
    els.empty.dataset.mode = "";
  }

  // Header (rebuilt only when columns or sort change).
  const columnsKey = strategy.id + "|" + columns.join(",") + "|" + rankMetric + "|" + JSON.stringify(state.viewSort);
  if (columnsKey !== grid.columnsKey) {
    grid.columnsKey = columnsKey;
    grid.rows.clear();
    grid.order = [];
    els.gridBody.replaceChildren();
    const th = (label, metric, cls = "") => {
      const sorted = state.viewSort?.metric === metric ? state.viewSort.dir : !state.viewSort && metric === rankMetric ? (METRICS[metric]?.better === "low" ? "asc" : "desc") : null;
      const cell = h("th" + cls, {scope: "col", "aria-sort": sorted ? (sorted === "asc" ? "ascending" : "descending") : null});
      if (!metric) { cell.textContent = label; return cell; }
      cell.append(h("button", {type: "button", "data-tip": `${METRICS[metric].label}|${METRICS[metric].help}`, onClick: () => actions.setSort(metric)},
        label, sorted ? icon(sorted === "asc" ? "up" : "down", "arrow") : null));
      return cell;
    };
    fill(els.gridHead, h("tr", {}, th("#", null, ".l"), th("合约", null, ".l"), columns.map(key => th(METRICS[key].short, key))));
  }

  // Body: keyed rows; values wash on change; reorders glide (FLIP). A fresh
  // long list paints its first rows now and the rest over the next frames.
  const token = ++grid.token;
  const seen = new Set(), inserted = [];
  const maxRank = Math.max(...candidates.map(c => Math.abs(c.metrics?.[rankMetric] ?? 0)).filter(Number.isFinite), 0);
  const nextOrder = candidates.map(c => c.key);
  const reordered = grid.order.length && !fresh && nextOrder.some((key, i) => grid.order[i] !== key) && grid.rows.size;
  const animateRows = reordered ? [...grid.rows.values()].map(row => row.tr).filter(tr => tr.isConnected) : [];
  const upsert = (candidate, index) => {
    seen.add(candidate.key);
    let row = grid.rows.get(candidate.key);
    if (!row) {
      const tr = h("tr", {role: "row", dataset: {key: candidate.key}, tabindex: "-1"});
      tr.addEventListener("click", () => actions.selectCandidate(candidate.key, {open: true}));
      const cells = new Map(), rank = h("td.rank.l"), legs = h("td.l");
      tr.append(rank, legs);
      for (const key of columns) { const td = h("td"); cells.set(key, td); tr.append(td); }
      row = {tr, rank, legs, cells, values: new Map()};
      grid.rows.set(candidate.key, row);
      inserted.push(tr);
    }
    const warnings = candidate.checks.filter(c => c.status === "warn");
    fill(row.rank, String(candidate.rankIndex ?? index + 1),
      state.watch.has(candidate.key) ? h("span.wstar", {text: "★", "data-tip": "已加入观察"}) : null,
      warnings.length ? h("span.wdot", {"data-tip": warnings.length + " 条提示|" + warnings.map(w => CHECK_LABELS[w.id] ?? w.id).join("、")}) : null);
    if (!row.legs.firstChild) row.legs.append(legSummary(candidate));
    for (const key of columns) {
      const td = row.cells.get(key), value = candidate.metrics?.[key];
      const text = F.metric(key, value);
      if (td.textContent !== text) {
        const previous = row.values.get(key);
        td.textContent = text;
        if (Number.isFinite(previous) && Number.isFinite(value) && previous !== value && !reduced()) {
          td.classList.remove("flash-up", "flash-down");
          void td.offsetWidth;
          td.classList.add(value > previous ? "flash-up" : "flash-down");
        }
      }
      row.values.set(key, value);
      const cls = [TONED.has(key) ? F.tone(value) : "", key === "maxLoss" && value === Infinity ? "neg" : ""];
      if (key === rankMetric && maxRank > 0 && Number.isFinite(value)) {
        cls.push("heat");
        td.style.setProperty("--heat", (Math.abs(value) / maxRank).toFixed(3));
      }
      const keep = [...td.classList].filter(c => c === "flash-up" || c === "flash-down");
      td.className = [...cls, ...keep].filter(Boolean).join(" ");
    }
    row.tr.setAttribute("aria-selected", String(candidate.key === state.selectedKey));
    if (els.gridBody.children[index] !== row.tr) els.gridBody.insertBefore(row.tr, els.gridBody.children[index] ?? null);
  };
  const first = grid.rows.size === 0 && candidates.length > 40 ? 30 : candidates.length;
  const apply = () => {
    for (let i = 0; i < first; i++) upsert(candidates[i], i);
    if (first === candidates.length) for (const [key, row] of grid.rows) if (!seen.has(key)) { row.tr.remove(); grid.rows.delete(key); }
  };
  if (animateRows.length && animateRows.length <= 160) flip(animateRows, apply); else apply();
  grid.order = nextOrder;
  if (first < candidates.length) {
    let next = first;
    const more = () => {
      if (token !== grid.token) return;
      const end = Math.min(candidates.length, next + 40);
      for (; next < end; next++) upsert(candidates[next], next);
      if (next < candidates.length) requestAnimationFrame(more);
    };
    requestAnimationFrame(more);
  }
  if (fresh) inkIn(els.gridBody.children, {from: .15, distance: 3, step: 14, max: 10, duration: 220});
  else if (inserted.length && inserted.length < candidates.length) inkIn(inserted, {max: 6});

  // Cards (phones): the essentials of each candidate, three figures each;
  // the first ones now, the rest over the next frames.
  if (matchMedia("(max-width: 900px)").matches) {
    // The ranking figure first, then the two most telling essentials.
    const picks = [rankMetric, ...["otm", "netCredit", "pop", "dte", ...columns].filter(key => key !== rankMetric && columns.includes(key))]
      .filter((key, i, all) => key && all.indexOf(key) === i).slice(0, 3);
    const card = (candidate, index) => h("button.cand-card", {type: "button", dataset: {key: candidate.key}, "aria-selected": String(candidate.key === state.selectedKey),
      onClick: () => actions.selectCandidate(candidate.key, {open: true})},
    h("div.row", {}, legSummary(candidate), h("span.rank-no", {text: String(index + 1)})),
    h("div.metrics", {}, picks.map(key => h("div", {}, h("span", {text: METRICS[key].short}),
      h("b", {class: TONED.has(key) ? F.tone(candidate.metrics?.[key]) : "", text: F.metric(key, candidate.metrics?.[key])})))));
    const list = candidates.slice(0, 60);
    fill(els.cards, ...list.slice(0, 10).map(card));
    if (fresh) inkIn(els.cards.children, {from: .15, max: 6});
    let next = 10;
    const more = () => {
      if (token !== grid.token || next >= list.length) return;
      const end = Math.min(list.length, next + 16);
      els.cards.append(...list.slice(next, end).map((candidate, i) => card(candidate, next + i)));
      next = end;
      requestAnimationFrame(more);
    };
    if (list.length > 10) requestAnimationFrame(more);
  } else if (els.cards.firstChild) {
    els.cards.replaceChildren();
  }
}

/** Marks the selected row/card without re-rendering the grid. */
export function markSelection(els, key) {
  for (const tr of els.gridBody.children) tr.setAttribute("aria-selected", String(tr.dataset.key === key));
  for (const card of els.cards.children) card.setAttribute("aria-selected", String(card.dataset.key === key));
}

export function sortedView(state) {
  const list = state.result?.candidates ?? [];
  list.forEach((candidate, index) => { candidate.rankIndex = index + 1; });
  if (!state.viewSort) return list;
  const {metric, dir} = state.viewSort;
  return [...list].sort((a, b) => {
    const x = a.metrics?.[metric], y = b.metrics?.[metric];
    const fx = Number.isFinite(x) || x === Infinity, fy = Number.isFinite(y) || y === Infinity;
    if (fx !== fy) return fx ? -1 : 1;
    return dir === "asc" ? x - y : y - x;
  });
}

function emptyState(state, actions) {
  const result = state.result;
  if (result?.blocked) {
    return h("div.empty", {}, h("h3", {text: "急跌未触发 · 严格模式"}),
      h("p", {text: `触发后当前将有 ${result.blockedCount ?? 0} 个候选。严格模式只在急跌后给出卖 Put 候选——不急，等市场先动。`}),
      h("div", {}, h("button.btn.primary", {type: "button", onClick: () => actions.setParam("trigger", "watch")}, "改为观察名单")));
  }
  const reasons = Object.entries(result?.rejected?.byCheck ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = Math.max(1, ...reasons.map(([, count]) => count));
  return h("div.empty", {},
    h("h3", {text: "此刻没有合约同时满足全部条件"}),
    h("p", {text: `已评估 ${result?.evaluated ?? 0} 个候选。主要的排除原因：`}),
    h("div.reasons", {}, reasons.map(([id, count]) => {
      const barNode = h("div.bar", {}, h("i"));
      barNode.firstChild.style.setProperty("--p", (count / max).toFixed(4));
      return h("div.reason", {}, h("span", {text: CHECK_LABELS[id] ?? id}), barNode, h("b", {text: String(count)}));
    })),
    result?.nearMisses?.length ? h("div.near", {}, h("header", {text: "差一点满足 · 只差一条规则"}),
      result.nearMisses.map(miss => {
        const failed = miss.checks.find(check => check.hard && check.status === "fail");
        return h("button", {type: "button", onClick: () => actions.selectNearMiss(miss.key)},
          legSummary(miss), h("small", {text: (CHECK_LABELS[failed?.id] ?? failed?.id) + " · " + actions.describe(failed)}));
      })) : null);
}

/* -------------------------------------------------------------- statusbar */
let statusRefs = null;
export function renderStatus(root, state) {
  if (!statusRefs || statusRefs.root !== root) {
    const route = h("span"), age = h("b"), replay = h("span.meh");
    fill(root, route, h("span", {}, "行情 ", age), replay, h("span.spacer"),
      h("span.wide.hint", {}, h("kbd", {text: "?"}), " 快捷键"));
    statusRefs = {root, route, age, replay};
  }
  const t = state.transport ?? {}, now = Date.now(), refs = statusRefs, q = state.market?.quality;
  const routeName = state.source === "direct" ? "币安直连" : q?.replay ? "回放" : q?.cached ? "缓存"
    : {site: "网站线路", local: "本机连接器", replay: "回放"}[t.route] ?? "连接中";
  const healthy = state.source === "direct" ? state.direct.lastAt > now - 15_000 : t.ok;
  const routeKey = routeName + healthy;
  if (refs.route.dataset.key !== routeKey) {
    refs.route.dataset.key = routeKey;
    fill(refs.route, h("i.status-dot" + (healthy ? ".ok" : "")), routeName);
  }
  refs.route.setAttribute("data-tip", `数据|${Number.isFinite(t.latency) ? "延迟 " + F.num(t.latency, 0) + " ms · " : ""}K 线 ${state.barsSource ? ({site: "网站", local: "本机", direct: "直连", replay: "回放", cache: "缓存"}[state.barsSource] ?? state.barsSource) + " · " + F.ago(state.barsAt, now) : "—"} · 计算 ${state.engineMode === "worker" ? "后台线程" : state.engineMode === "main" ? "主线程" : "启动中"}${state.market?.ok ? " · " + state.market.contractCount + " 个合约 / " + state.market.expiryCount + " 个到期日" : ""}`);
  const lastOk = state.source === "direct" ? state.direct.lastAt : t.lastOk;
  const age = lastOk ? (now - lastOk) / 1000 : null;
  refs.age.textContent = age === null ? "—" : age < 2 ? "刚刚" : F.num(age, 0) + " 秒前";
  const replayText = q?.replay && q.fetchedAt ? "快照 " + F.beijing(Date.parse(q.fetchedAt), {date: true, seconds: false}) : "";
  if (refs.replay.textContent !== replayText) refs.replay.textContent = replayText;
}
