// Rail, regime strip, strategy header with parameter editors, results grid,
// empty-state diagnostics and the status bar.
import {h, icon, fill} from "./dom.js";
import * as F from "./format.js";
import {openPopover, closePopover} from "./ui.js";
import {strategyGlyph, termSparkline} from "./charts.js";
import {STRATEGIES, GROUPS, METRICS, ORIGINS, defaultParams} from "../lib/strategies.mjs";
import {CHECK_LABELS} from "../lib/screener.mjs";

const ORIGIN_LABEL = key => ORIGINS[key]?.label ?? "默认";
const shortOption = label => String(label).split("：")[0];

/* -------------------------------------------------------------------- rail */
export function renderRail(root, state, actions) {
  const filter = state.railFilter.trim().toLowerCase();
  const matches = s => !filter || [s.name, s.nameEn, s.tagline, s.id].some(text => String(text).toLowerCase().includes(filter));
  const groups = GROUPS.map(group => {
    const items = STRATEGIES.filter(s => s.group === group.id && matches(s));
    if (!items.length) return null;
    return h("section.rail-group", {}, h("header", {}, h("span", {text: group.label}), h("span", {text: String(items.length)})),
      items.map(s => h("button.strategy-item", {type: "button", role: "option", dataset: {id: s.id}, "aria-current": String(s.id === state.strategyId),
        "aria-selected": String(s.id === state.strategyId), title: s.tagline, onClick: () => actions.selectStrategy(s.id)},
      s.hotkey ? h("span.hk", {text: s.hotkey}) : strategyGlyph(s.id),
      h("span", {}, h("span.name", {text: s.name}), h("span.sub", {text: s.nameEn})),
      countBadge(state.counts[s.id]))));
  });
  fill(root, ...groups.filter(Boolean));
  if (!root.children.length) root.append(h("p.muted", {text: "没有匹配的策略", style: {padding: "10px"}}));
}

function countBadge(entry) {
  if (!entry) return h("span.count.busy", {text: "·", "aria-label": "计算中"});
  if (entry.error) return h("span.count", {text: "!"});
  if (entry.blocked) return h("span.count.gate", {text: String(entry.blockedCount ?? 0), "data-tip": "急跌未触发|严格模式下暂不给候选"});
  const gated = entry.gate === "idle";
  return h("span.count" + (entry.total ? gated ? ".gate" : ".has" : ""), {text: String(entry.total ?? 0),
    "data-tip": gated ? "观察名单|急跌条件尚未满足，候选仅供观察" : `${entry.total} 个候选满足全部条件`});
}

export function updateRailCounts(root, state) {
  for (const button of root.querySelectorAll(".strategy-item")) {
    const fresh = countBadge(state.counts[button.dataset.id]);
    const old = button.querySelector(".count");
    if (old && (old.textContent !== fresh.textContent || old.className !== fresh.className)) old.replaceWith(fresh);
  }
}

/* ------------------------------------------------------------------ regime */
export function renderRegime(root, state) {
  const r = state.regime, spot = state.ctx?.market?.spot;
  const block = (label, value, sub, tip, cls = "") => h("div.metric-block" + cls, {"data-tip": tip}, h("label", {}, label), value, sub ? h("small", {}, sub) : null);
  const ret = (key, label) => {
    const v = r?.moves?.returns?.[key];
    return h("div.ret", {}, h("span", {text: label}), h("b", {class: F.tone(v), text: F.signedPct(v, 2)}));
  };
  const change24 = r?.moves?.returns?.["24h"];
  const trigger = state.triggerView;
  const progress = trigger?.drawdownPct === null || trigger?.drawdownPct === undefined ? 0 : Math.min(1.25, trigger.drawdownPct / trigger.thresholdPct);
  const gauge = h("div.gauge" + (trigger?.status === "triggered" ? ".hot" : ""), {}, h("i"), h("b"));
  gauge.style.setProperty("--fill", Math.min(100, progress / 1.25 * 100).toFixed(1) + "%");
  gauge.style.setProperty("--mark", (100 / 1.25).toFixed(1) + "%");
  const stateLabel = trigger?.status === "triggered" ? h("span.trigger-state.on", {}, h("i"), "急跌已触发")
    : trigger?.status === "idle" ? h("span.trigger-state.off", {}, h("i"), "未触发") : h("span.trigger-state", {}, h("i"), "等待数据");
  const lastText = trigger?.status === "triggered" ? "现在满足条件"
    : trigger?.hoursSinceTrigger !== null && trigger?.hoursSinceTrigger !== undefined ? "上次触发 " + F.hours(trigger.hoursSinceTrigger) + "前" : "近 7 天未触发";
  const iv30 = r?.iv?.atm30, rv30 = r?.rv?.rv30, vrp = r?.vrp;
  const nearMonth = (r?.iv?.term ?? []).filter(t => t.dte >= 14).sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30))[0];
  const spark = termSparkline(r?.iv?.term);
  fill(root, 
    h("div.metric-block.hero", {"data-tip": "BTC 指数|币安期权的结算参考指数，到期结算价为到期前 30 分钟指数均价"},
      h("label", {}, "BTC 指数 · USDT"),
      h("div.hero-line", {}, h("strong", {text: F.price(spot)}), h("span.chg", {class: F.tone(change24), text: F.signedPct(change24, 2)}))),
    h("div.metric-block", {"data-tip": "涨跌幅|基于币安 BTCUSDT K 线与当前指数"}, h("label", {}, "涨跌"),
      h("div.returns", {}, ret("1h", "1小时"), ret("4h", "4小时"), ret("24h", "24小时"), ret("7d", "7天"))),
    h("div.metric-block.trigger-block", {"data-tip": `急跌触发器（对话 #44）|窗口 ${trigger?.windowHours ?? 24} 小时内从最高价回撤 ≥ ${trigger?.thresholdPct ?? 5}% 视为触发。对话 #76：这是观察信号，不是充分的入场信号。`},
      h("label", {}, icon("bolt"), `急跌触发 · ${trigger?.windowHours ?? 24}h ≥ ${trigger?.thresholdPct ?? 5}%`),
      h("div", {style: {display: "flex", "align-items": "center", gap: "10px"}}, stateLabel,
        h("strong.num", {text: trigger?.drawdownPct === null || trigger?.drawdownPct === undefined ? "—" : "−" + F.num(trigger.drawdownPct, 2) + "%", style: {"font-size": "13px"}})),
      gauge, h("small", {text: lastText})),
    block("已实现波动 RV30", h("strong", {text: F.pct(rv30 * 100, 1)}), "RV7 " + F.pct(r?.rv?.rv7 * 100, 1),
      "已实现波动率|过去 30 / 7 天日收益率的年化波动（零均值 RMS），365 天年化"),
    block("平值 IV · 30D", h("strong", {text: F.pct(iv30 * 100, 1)}), vrp ? h("span", {class: F.tone(vrp.spread)}, "IV−RV " + F.signed(vrp.spread, 1) + " 点") : "IV−RV —",
      "30 天恒定期限平值隐含波动率|按总方差在相邻到期日之间插值；IV−RV 为波动率风险溢价（对话 #65）"),
    block("25Δ 风险逆转", h("strong", {class: F.tone(nearMonth?.rr25), text: nearMonth?.rr25 === null || nearMonth?.rr25 === undefined ? "—" : F.signed(nearMonth.rr25 * 100, 1)}),
      nearMonth ? `${F.expiry(nearMonth.expiryMs)} · Put 溢价 ${F.signed((nearMonth.putSkew25 ?? 0) * 100, 1)}` : "—",
      "25Δ 风险逆转|25Δ Call IV − 25Δ Put IV。负值越大，市场为下跌保护支付的溢价越高"),
    h("div.metric-block", {"data-tip": "平值 IV 期限结构|各到期日平值隐含波动率（横轴为 √剩余天数）"}, h("label", {}, "IV 期限结构"), spark,
      h("small", {text: r?.iv?.term?.length ? `${F.pct(r.iv.term[0].atmIv * 100, 0)} → ${F.pct(r.iv.term.at(-1).atmIv * 100, 0)}` : "—"})),
    h("div.regime-spacer"),
    block("合约", h("strong", {text: state.ctx?.market?.ok ? String(state.ctx.market.contracts.length) : "—"}),
      state.ctx?.market?.ok ? `${state.ctx.market.expiries.length} 个到期日` : "等待行情", "当前可交易的 BTC 期权合约数"),
  );
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
  return h("div.origin-note", {}, h("i.origin-dot", {dataset: {origin: spec.origin}}),
    h("div", {}, h("b", {text: ORIGIN_LABEL(spec.origin) + "　"}), spec.help || ORIGINS[spec.origin]?.hint || ""));
}

function rangeEditor(spec, value, defaults, apply) {
  let [lo, hi] = value;
  const toPct = v => ((v - spec.min) / (spec.max - spec.min) * 100).toFixed(2) + "%";
  const fill = h("i.fill");
  const inputs = [lo, hi].map((v, i) => h("input", {type: "range", min: spec.min, max: spec.max, step: spec.step, value: v,
    "aria-label": spec.label + (i ? "上限" : "下限")}));
  const boxes = [lo, hi].map((v, i) => h("input.num-input", {type: "number", min: spec.min, max: spec.max, step: spec.step, value: v,
    "aria-label": spec.label + (i ? "上限" : "下限"), inputmode: "decimal"}));
  const sync = (source) => {
    if (lo > hi) [lo, hi] = source === 0 ? [hi, hi] : [lo, lo];
    inputs[0].value = lo; inputs[1].value = hi;
    if (document.activeElement !== boxes[0]) boxes[0].value = lo;
    if (document.activeElement !== boxes[1]) boxes[1].value = hi;
    fill.parentElement?.style.setProperty("--lo", toPct(lo));
    fill.parentElement?.style.setProperty("--hi", toPct(hi));
    apply([lo, hi]);
  };
  inputs.forEach((input, i) => input.addEventListener("input", () => { if (i) hi = Number(input.value); else lo = Number(input.value); sync(i); }));
  boxes.forEach((box, i) => box.addEventListener("change", () => {
    const v = Math.min(spec.max, Math.max(spec.min, Number(box.value)));
    if (!Number.isFinite(v)) return;
    if (i) hi = v; else lo = v;
    sync(i);
  }));
  const range = h("div.range", {}, h("i.track"), fill, inputs);
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

export function renderHead(root, state, actions) {
  const strategy = state.strategy, params = state.params, defaults = defaultParams(strategy);
  const riskTone = /极高|高/.test(strategy.view.risk) ? ".risk-high" : /中/.test(strategy.view.risk) ? ".risk-mid" : ".risk-low";
  const modifiedCount = strategy.params.filter(spec => JSON.stringify(params[spec.key]) !== JSON.stringify(defaults[spec.key])).length;
  const chips = strategy.params.filter(spec => spec.key !== "rank" && !(spec.key === "quantity" && params.quantityMode && params.quantityMode !== "fixed")
    && !(["dropWindow", "dropPct"].includes(spec.key) && params.trigger === "off")).map(spec => {
    const modified = JSON.stringify(params[spec.key]) !== JSON.stringify(defaults[spec.key]);
    const chip = h("button.chip" + (modified ? ".modified" : ""), {type: "button", "aria-expanded": "false", "aria-haspopup": "dialog",
      dataset: {key: spec.key}, "data-tip": `${spec.label}|${ORIGIN_LABEL(spec.origin)}：${spec.help || "可调整参数"}`},
    h("i.origin-dot", {dataset: {origin: spec.origin}}), h("span", {text: spec.label}), h("b", {text: paramText(spec, params[spec.key])}), icon("chevron"));
    chip.addEventListener("click", () => {
      const apply = value => actions.setParam(spec.key, value);
      const body = spec.type === "range" ? rangeEditor(spec, params[spec.key], defaults[spec.key], apply)
        : spec.type === "number" ? numberEditor(spec, params[spec.key], defaults[spec.key], apply) : selectEditor(spec, params[spec.key], apply);
      openPopover(chip, [h("h4", {}, h("i.origin-dot", {dataset: {origin: spec.origin}}), spec.label), body, originNote(spec)], {label: spec.label});
    });
    return chip;
  });
  const gate = state.result?.gate;
  fill(root, 
    h("div.title-row", {},
      h("h1", {}, strategy.name, h("small", {text: strategy.nameEn})),
      h("div.actions", {},
        h("button.btn", {type: "button", onClick: actions.copyLink, "data-tip": "复制链接|包含当前策略与参数，可分享或收藏"}, icon("link"), "链接"),
        h("button.btn", {type: "button", onClick: actions.exportCsv, "data-tip": "导出 CSV|全部候选与指标，Excel 可直接打开（快捷键 E）"}, icon("download"), "导出"),
        h("button.btn", {type: "button", "aria-pressed": String(state.frozen), onClick: actions.toggleFreeze,
          "data-tip": state.frozen ? "恢复实时|继续跟随最新行情（快捷键 F）" : "冻结快照|固定当前行情以便比较（快捷键 F）"}, icon(state.frozen ? "play" : "pause"), state.frozen ? "恢复实时" : "冻结"))),
    h("p.tagline", {text: strategy.tagline}),
    h("div.tags", {},
      h("span.tag", {}, "方向 ", h("b", {text: strategy.view.direction})),
      h("span.tag", {}, "波动率 ", h("b", {text: strategy.view.vol})),
      h("span.tag" + riskTone, {}, "风险 ", h("b", {text: strategy.view.risk})),
      ...strategy.citations.slice(0, 4).map(ref => {
        const quote = state.citations[ref];
        return h("span.tag", {"data-tip": `${typeof quote.ref === "number" ? "对话 #" + quote.ref : quote.ref === "model" ? "交易模型" : "工作台"} · ${quote.who}|${quote.quote}`},
          icon("layers"), typeof quote.ref === "number" ? "对话 #" + quote.ref : quote.ref === "model" ? "交易模型" : "工作台设置");
      })),
    gate ? gateBanner(gate, state, actions) : null,
    h("div.params", {}, chips,
      modifiedCount ? h("button.chip-reset", {type: "button", onClick: actions.resetParams, "data-tip": "恢复默认|恢复为对话中你的规则与默认值"}, "重置（" + modifiedCount + "）") : null),
  );
}

function gateBanner(gate, state, actions) {
  const progress = gate.drawdownPct === null ? 0 : Math.min(1, gate.drawdownPct / gate.thresholdPct);
  const gauge = h("div.gauge" + (gate.status === "triggered" ? ".hot" : ""), {}, h("i"), h("b"));
  gauge.style.setProperty("--fill", (progress * 80).toFixed(1) + "%");
  gauge.style.setProperty("--mark", "80%");
  const text = gate.status === "triggered"
    ? [h("strong", {text: "急跌条件已满足。"}), ` ${gate.windowHours} 小时回撤 ${F.num(gate.drawdownPct, 2)}%（阈值 ${gate.thresholdPct}%）。对话 #76：先观察 Put 报价与 IV，再决定是否卖出。`]
    : gate.status === "unknown" ? [h("strong", {text: "无法判断急跌条件。"}), " 缺少 K 线数据，候选按观察名单列出。"]
      : [h("strong", {text: gate.mode === "strict" ? "急跌未触发，严格模式不给候选。" : "急跌未触发，以下为观察名单。"}),
        ` ${gate.windowHours} 小时回撤 ${F.num(gate.drawdownPct, 2)}%，距阈值 ${gate.thresholdPct}% 还差 ${F.num(Math.max(0, gate.thresholdPct - gate.drawdownPct), 2)} 个百分点`,
        gate.hoursSinceTrigger !== null ? `；上次触发在 ${F.hours(gate.hoursSinceTrigger)}前。` : "；近 7 天未触发。"];
  return h("div.gate" + (gate.status === "triggered" ? ".on" : gate.status === "idle" ? ".off" : ""), {role: "status"},
    icon("bolt"), gauge, h("p", {}, text),
    gate.mode === "strict" && gate.status !== "triggered" ? h("button.btn", {type: "button", onClick: () => actions.setParam("trigger", "watch")}, "显示观察名单") : null);
}

/* ---------------------------------------------------------------- results */
const gridState = {rows: new Map(), columnsKey: ""};

export function columnsFor(strategy) {
  return strategy.columns;
}

function legSummary(candidate) {
  return h("div.legs", {}, candidate.legs.map(leg => h("span.leg", {},
    h("span.side." + (leg.action === "SELL" ? "s" : "b"), {text: (leg.action === "SELL" ? "卖" : "买") + (leg.ratio !== 1 ? "×" + leg.ratio : "")}),
    h("span.t", {text: leg.type === "PUT" ? "P" : "C"}), h("span.k", {text: F.price(leg.strike)}), h("span.e", {text: F.expiry(leg.expiryMs)}))));
}

function statusSummary(candidate) {
  const warn = candidate.checks.filter(c => c.status === "warn").length;
  const pass = candidate.checks.filter(c => c.status === "pass").length;
  return h("span.status-cell", {}, h("span.badge.ok", {text: "✓" + pass}), warn ? h("span.badge.w", {text: "!" + warn}) : null);
}

export function renderResults(state, actions, els) {
  const {strategy, result} = state;
  const columns = columnsFor(strategy);
  const rankMetric = result?.rank;
  const total = result?.total ?? 0;
  const rankSpec = strategy.params.find(p => p.key === "rank");
  // Results bar
  const summary = !state.ctx?.market?.ok ? h("span.summary", {text: "等待行情…"})
    : h("span.summary", {}, "符合条件 ", h("b", {text: String(result?.blocked ? 0 : total)}), " 个",
      h("span.muted", {text: ` · 已评估 ${result?.evaluated ?? 0} · 筛选 ${result?.elapsedMs ?? 0} ms`}),
      result?.truncated ? h("span.warn", {text: " · 已截断"}) : null);
  const rankSelect = h("select.select", {"aria-label": "排序依据"}, rankSpec.options.map(option =>
    h("option", {value: option.value, selected: option.value === state.params.rank ? true : null, text: "按" + option.label + (METRICS[option.value].better === "low" ? "（低→高）" : "（高→低）")})));
  rankSelect.addEventListener("change", () => actions.setParam("rank", rankSelect.value));
  fill(els.resultsBar, summary, h("span.spacer"),
    state.viewSort ? h("button.btn.ghost", {type: "button", onClick: () => actions.setSort(null)}, icon("reset"), "按排序依据") : null,
    rankSelect);

  // Empty / blocked
  const candidates = sortedView(state);
  const showEmpty = state.ctx?.market?.ok && (!candidates.length);
  els.empty.hidden = !showEmpty;
  els.grid.hidden = Boolean(showEmpty) || !state.ctx?.market?.ok;
  if (showEmpty) fill(els.empty, emptyState(state, actions));
  if (!state.ctx?.market?.ok) {
    els.empty.hidden = false;
    fill(els.empty, h("div.empty", {}, h("h3", {text: "正在连接币安期权行情"}),
      h("p", {text: state.transport.error ?? "首次加载需要读取合约目录与盘口，通常几秒内完成。"}),
      h("div.skeleton", {style: {width: "70%"}}), h("div.skeleton", {style: {width: "55%"}}), h("div.skeleton", {style: {width: "62%"}})));
  }

  // Header
  const columnsKey = strategy.id + "|" + columns.join(",") + "|" + rankMetric + "|" + JSON.stringify(state.viewSort);
  if (columnsKey !== gridState.columnsKey) {
    gridState.columnsKey = columnsKey;
    gridState.rows.clear();
    els.gridBody.replaceChildren();
    const th = (label, metric, cls = "") => {
      const sorted = state.viewSort?.metric === metric ? state.viewSort.dir : !state.viewSort && metric === rankMetric ? (METRICS[metric]?.better === "low" ? "asc" : "desc") : null;
      const cell = h("th" + cls, {scope: "col", "aria-sort": sorted ? (sorted === "asc" ? "ascending" : "descending") : null});
      if (!metric) { cell.textContent = label; return cell; }
      cell.append(h("button", {type: "button", "data-tip": `${METRICS[metric].label}|${METRICS[metric].help}`, onClick: () => actions.setSort(metric)},
        label, sorted ? icon(sorted === "asc" ? "up" : "down", "arrow") : null));
      return cell;
    };
    fill(els.gridHead, h("tr", {}, th("#", null, ".l"), th("合约 / 组合", null, ".l"),
      columns.map(key => th(METRICS[key].short, key))));
  }

  // Body (keyed rows, value flashes)
  const seen = new Set();
  const maxRank = Math.max(...candidates.map(c => Math.abs(c.metrics?.[rankMetric] ?? 0)).filter(Number.isFinite), 0);
  candidates.forEach((candidate, index) => {
    seen.add(candidate.key);
    let row = gridState.rows.get(candidate.key);
    if (!row) {
      const tr = h("tr", {role: "row", dataset: {key: candidate.key}, tabindex: "-1"});
      tr.addEventListener("click", () => actions.selectCandidate(candidate.key, {open: true}));
      const cells = new Map();
      const rank = h("td.rank.l"), legs = h("td.l");
      tr.append(rank, legs);
      for (const key of columns) { const td = h("td"); cells.set(key, td); tr.append(td); }
      row = {tr, rank, legs, cells, values: new Map()};
      gridState.rows.set(candidate.key, row);
    }
    row.candidate = candidate;
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
        if (Number.isFinite(previous) && Number.isFinite(value) && previous !== value && !state.reducedMotion) {
          td.classList.remove("flash-up", "flash-down");
          void td.offsetWidth;
          td.classList.add(value > previous ? "flash-up" : "flash-down");
        }
      }
      row.values.set(key, value);
      td.className = ["netCredit", "ev", "dailyPremium", "budgetPremium", "breakevenDist", "richness", "termSpread"].includes(key) ? F.tone(value) : "";
      if (key === rankMetric && maxRank > 0 && Number.isFinite(value)) {
        td.classList.add("heat");
        td.style.setProperty("--heat", (Math.abs(value) / maxRank).toFixed(3));
      }
      if (key === "maxLoss" && value === Infinity) td.classList.add("neg");
    }
    row.tr.setAttribute("aria-selected", String(candidate.key === state.selectedKey));
    if (els.gridBody.children[index] !== row.tr) els.gridBody.insertBefore(row.tr, els.gridBody.children[index] ?? null);
  });
  for (const [key, row] of gridState.rows) if (!seen.has(key)) { row.tr.remove(); gridState.rows.delete(key); }

  // Mobile cards
  fill(els.cards, ...candidates.slice(0, 60).map((candidate, index) => {
    const picks = columns.slice(0, 6);
    return h("button.cand-card", {type: "button", "aria-selected": String(candidate.key === state.selectedKey), onClick: () => actions.selectCandidate(candidate.key, {open: true})},
      h("div.row", {}, legSummary(candidate), h("span.count.has", {text: "#" + (index + 1)})),
      h("div.metrics", {}, picks.map(key => h("div", {}, h("span", {text: METRICS[key].short}), h("b", {class: F.tone(candidate.metrics?.[key]), text: F.metric(key, candidate.metrics?.[key])})))));
  }));
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
    return h("div.empty", {}, h("h3", {text: "急跌条件未触发（严格模式）"}),
      h("p", {text: `触发后当前将有 ${result.blockedCount ?? 0} 个候选。严格模式按你的规则只在急跌后给出卖 Put 候选。`}),
      h("div", {}, h("button.btn.primary", {type: "button", onClick: () => actions.setParam("trigger", "watch")}, "改为观察名单")));
  }
  const reasons = Object.entries(result?.rejected?.byCheck ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = Math.max(1, ...reasons.map(([, count]) => count));
  return h("div.empty", {},
    h("h3", {text: "当前没有合约同时满足全部条件"}),
    h("p", {text: `已评估 ${result?.evaluated ?? 0} 个候选。以下是被排除的主要原因（一个候选可能同时不满足多条）。`}),
    h("div.reasons", {}, reasons.map(([id, count]) => {
      const bar = h("div.bar", {}, h("i"));
      bar.firstChild.style.setProperty("--w", (count / max * 100).toFixed(1) + "%");
      return h("div.reason", {}, h("span", {text: CHECK_LABELS[id] ?? id}), bar, h("b", {text: String(count)}));
    })),
    result?.nearMisses?.length ? h("div.near", {}, h("header", {text: "差一点满足（只差一条规则）"}),
      result.nearMisses.map(miss => {
        const failed = miss.checks.find(check => check.hard && check.status === "fail");
        return h("button", {type: "button", onClick: () => actions.selectNearMiss(miss.key)},
          legSummary(miss), h("small", {text: (CHECK_LABELS[failed?.id] ?? failed?.id) + " · " + actions.describe(failed)}));
      })) : null,
    h("p.muted", {text: "提示：可点击上方参数放宽条件，或在近似候选中查看差距。币安 1–2 个月合约通常只挂到价外约 25%–30% 的行权价。"}));
}

/* -------------------------------------------------------------- statusbar */
export function renderStatus(root, state) {
  const t = state.transport, now = Date.now();
  const routes = {site: "网站线路", local: "本机连接器", direct: "币安直连（无合约规则）", replay: "回放快照"};
  const age = t.lastOk ? (now - t.lastOk) / 1000 : null;
  const signals = state.signalsMeta;
  fill(root, 
    h("span", {}, h("i.origin-dot", {style: {background: t.ok ? "var(--pos)" : "var(--neg)"}}), routes[t.route] ?? "连接中"),
    h("span", {}, "行情 ", h("b", {text: age === null ? "—" : age < 2 ? "刚刚" : F.num(age, 0) + " 秒前"})),
    t.latency ? h("span.wide", {}, "延迟 ", h("b", {text: F.num(t.latency, 0) + " ms"})) : null,
    h("span.wide", {}, "K 线 ", h("b", {text: signals?.source === "unavailable" ? "不可用" : signals ? ({site: "网站", direct: "直连", replay: "回放"}[signals.source] ?? signals.source) + " · " + F.ago(signals.at, now) : "—"})),
    state.ctx?.market?.quality?.replay ? h("span", {class: "meh"}, "回放快照 ", h("b", {text: F.beijing(Date.parse(state.ctx.market.quality.fetchedAt), {date: true, seconds: false})})) : null,
    h("span.spacer"),
    h("span.wide", {}, h("kbd", {text: "Ctrl K"}), " 命令"),
    h("span.wide", {}, h("kbd", {text: "↑"}), h("kbd", {text: "↓"}), " 选择"),
    h("span.wide", {}, h("kbd", {text: "["}), h("kbd", {text: "]"}), " 切换策略"),
    h("span.wide", {}, h("kbd", {text: "?"}), " 快捷键"),
  );
}
