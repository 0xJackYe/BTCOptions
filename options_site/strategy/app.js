// BTC 期权策略看板 — application shell.
// Pipeline: market + klines + settings + account → context → screen → render.
import {$, h, icon, isTyping, fill} from "./dom.js";
import * as F from "./format.js";
import {installTooltips, toast, copyText, download, load, save, loadSession, saveSession, closePopover, popoverOpen} from "./ui.js";
import {MarketFeed, SignalsFeed, readServerAccount, createBrowserSession, readBrowserAccount, accountErrorText} from "./transport.js";
import {renderRail, updateRailCounts, renderRegime, renderHead, renderResults, renderStatus, sortedView} from "./views.js";
import {renderDetail, ticket} from "./detail.js";
import {openSettings, openAccount, openHelp, openPalette} from "./panels.js";
import {STRATEGIES, METRICS, CITATIONS, getStrategy, defaultParams, normalizeParams, encodeParams, decodeParams} from "../lib/strategies.mjs";
import {createContext, screen, analyzeCandidate, mergeSettings, describeCheck, CHECK_UNITS} from "../lib/screener.mjs";
import {regime as computeRegime, crashTrigger} from "../lib/signals.mjs";

const els = {
  desk: $("#desk"), rail: $("#rail"), regime: $("#regime"), head: $("#strategyHead"), resultsBar: $("#resultsBar"), banner: $("#banner"),
  grid: $("#grid"), gridHead: $("#gridHead"), gridBody: $("#gridBody"), cards: $("#cardList"), empty: $("#emptyState"), tableWrap: $("#tableWrap"),
  detail: $("#detail"), status: $("#statusbar"), pill: $("#livePill"), clock: $("#clock"), accountChip: $("#accountChip"), accountChipText: $("#accountChipText"),
  palette: $("#paletteDialog"), settings: $("#settingsDialog"), account: $("#accountDialog"), help: $("#helpDialog"),
};

const narrow = () => matchMedia("(max-width: 1260px)").matches;
const mobile = () => matchMedia("(max-width: 900px)").matches;

const state = {
  strategyId: "crash-put", params: {}, selectedKey: null, selected: null, viewSort: null,
  snapshot: null, pending: null, frozen: false, frozenAt: 0, lastBuildAt: 0,
  bars: {hourly: [], daily: []}, signalsMeta: null, regime: null, triggerView: null, lastTriggerStatus: null,
  settings: mergeSettings(load("settings", {})), ctx: null, result: null, detail: null, counts: {},
  detailTab: "rules", overlay: true, railFilter: "", watch: new Set(load("watch", [])), alerts: load("alerts", false),
  account: {mode: "none", data: null, error: null, server: undefined, session: null}, accountTab: "server", accountToken: loadSession("token"),
  transport: {ok: false, route: "site", error: null, lastOk: 0, latency: null},
  citations: CITATIONS, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  get strategy() { return getStrategy(this.strategyId); },
  get params() { return this.paramsById[this.strategyId]; },
};
state.paramsById = Object.fromEntries(STRATEGIES.map(s => [s.id, normalizeParams(s, load("params:" + s.id, {})).params]));

/* ------------------------------------------------------------------ theme */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("#themeButton use").setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
  save("theme", theme);
}
applyTheme(load("theme", matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));

/* -------------------------------------------------------------- url state */
function readHash() {
  const match = /^#\/([a-z-]+)(?:\?(.*))?$/.exec(location.hash);
  const strategy = match && getStrategy(match[1]);
  if (!strategy) return false;
  state.strategyId = strategy.id;
  if (match[2] !== undefined) state.paramsById[strategy.id] = decodeParams(strategy, match[2]).params;
  return true;
}
function writeHash() {
  const query = encodeParams(state.strategy, state.params);
  const hash = "#/" + state.strategyId + (query ? "?" + query : "");
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

/* --------------------------------------------------------------- pipeline */
function triggerSettings() {
  const p = state.params;
  return p.trigger !== undefined && p.trigger !== "off" ? {windowHours: Number(p.dropWindow), thresholdPct: Number(p.dropPct)} : {windowHours: 24, thresholdPct: 5};
}

function rebuild() {
  if (!state.snapshot) { renderAll(); return; }
  const localNow = state.frozen ? state.frozenAt : Date.now();
  state.ctx = createContext({snapshot: state.snapshot, localNow, settings: state.settings, account: state.account.data,
    klines: {hourlyBars: state.bars.hourly, dailyBars: state.bars.daily}});
  state.lastBuildAt = Date.now();
  refreshRegime();
  rescreen();
  scheduleCounts();
  checkTriggerAlert();
}

function refreshRegime() {
  const m = state.ctx?.market;
  state.regime = m?.ok ? computeRegime({hourly: state.bars.hourly, daily: state.bars.daily, nowMs: m.exchangeNow, spot: m.spot, surface: state.ctx.surface, trigger: triggerSettings()}) : null;
  state.triggerView = state.regime?.crash ?? null;
  renderRegime(els.regime, state);
}

function rescreen({head = true} = {}) {
  if (!state.ctx) { renderAll(); return; }
  state.result = screen(state.ctx, state.strategyId, state.params, {limit: 150});
  state.counts[state.strategyId] = {total: state.result.total, blocked: state.result.blocked, blockedCount: state.result.blockedCount, gate: state.result.gate?.status ?? null};
  const visible = sortedView(state);
  const pool = [...state.result.candidates, ...state.result.nearMisses];
  state.selected = pool.find(c => c.key === state.selectedKey) ?? null;
  if (!state.selected && !mobile()) state.selected = visible[0] ?? null;
  state.selectedKey = state.selected?.key ?? null;
  state.detail = state.selected ? analyzeCandidate(state.ctx, state.selected) : null;
  if (head && !popoverOpen()) renderHead(els.head, state, actions); else refreshChips();
  renderBanner();
  renderResults(state, actions, els);
  renderDetail(els.detail, state, actions);
  updateRailCounts(els.rail, state);
  renderStatus(els.status, state);
  writeHash();
}

function refreshChips() {
  const defaults = defaultParams(state.strategy);
  for (const chip of els.head.querySelectorAll(".chip[data-key]")) {
    const spec = state.strategy.params.find(p => p.key === chip.dataset.key);
    if (!spec) continue;
    const value = state.params[spec.key];
    const text = spec.type === "range" ? `${F.num(value[0], dp(spec.step))}–${F.num(value[1], dp(spec.step))}${unit(spec.unit)}`
      : spec.type === "number" ? `${F.num(value, dp(spec.step))}${unit(spec.unit)}` : String(spec.options.find(o => String(o.value) === String(value))?.label ?? value).split("：")[0];
    chip.querySelector("b").textContent = text;
    chip.classList.toggle("modified", JSON.stringify(value) !== JSON.stringify(defaults[spec.key]));
  }
}
const dp = step => Math.max(0, Math.min(4, (String(step).split(".")[1] ?? "").length));
const unit = u => !u ? "" : u === "%" || u === "×" ? u : " " + u;

let countsToken = 0;
const idle = fn => window.requestIdleCallback ? requestIdleCallback(fn, {timeout: 700}) : setTimeout(() => fn({timeRemaining: () => 12}), 30);
function scheduleCounts() {
  if (!state.ctx?.market?.ok) return;
  const token = ++countsToken, queue = STRATEGIES.map(s => s.id).filter(id => id !== state.strategyId);
  const step = deadline => {
    if (token !== countsToken || !state.ctx) return;
    let done = 0;
    while (queue.length && (done === 0 || (deadline?.timeRemaining?.() ?? 0) > 6)) {
      const id = queue.shift();
      try {
        const r = screen(state.ctx, id, state.paramsById[id], {limit: 1, nearMisses: 0, budgetMs: 300});
        state.counts[id] = {total: r.total, blocked: r.blocked, blockedCount: r.blockedCount, gate: r.gate?.status ?? null};
      } catch { state.counts[id] = {error: true}; }
      done++;
    }
    updateRailCounts(els.rail, state);
    if (queue.length) idle(step);
  };
  idle(step);
}

function renderBanner() {
  const q = state.ctx?.market?.quality;
  const nodes = [];
  if (q?.replay) nodes.push(h("div.banner.replay", {role: "note"}, icon("layers"),
    `回放模式：显示 ${q.fetchedAt ? F.beijing(Date.parse(q.fetchedAt), {date: true, seconds: false}) + "（北京）" : "历史"} 记录的币安真实快照，时间冻结在快照时刻，不是实时报价。`));
  else if (state.transport.route === "direct") nodes.push(h("div.banner.stale", {role: "note"}, "网站线路不可用，正在使用币安直连行情：缺少合约规则与 24h 统计，保证金按默认费率估算。"));
  else if (q?.stale) nodes.push(h("div.banner.stale", {role: "note"}, "部分行情字段已过期：候选会标注报价时效，请以币安实时盘口为准。"));
  if (state.frozen) nodes.push(h("div.banner.stale", {role: "note"}, `已冻结在 ${F.beijing(state.frozenAt)} 的快照，便于比较；新行情暂不应用。`,
    h("button", {type: "button", onClick: actions.toggleFreeze}, "恢复实时")));
  fill(els.banner, ...nodes);
}

function renderPill() {
  const t = state.transport, q = state.ctx?.market?.quality;
  const age = t.lastOk ? (Date.now() - t.lastOk) / 1000 : Infinity;
  let cls = "", text = "连接中";
  if (state.frozen) { cls = "frozen"; text = "已冻结"; }
  else if (q?.replay) { cls = "replay"; text = "回放"; }
  else if (!t.ok && !state.snapshot) { cls = "down"; text = "离线"; }
  else if (age > 30 || !t.ok) { cls = "stale"; text = "延迟 " + (Number.isFinite(age) ? F.num(age, 0) + "s" : ""); }
  else if (q?.stale || t.route === "direct") { cls = "stale"; text = t.route === "direct" ? "直连" : "部分延迟"; }
  else if (state.snapshot) { cls = "live"; text = "实时"; }
  els.pill.className = "pill " + cls;
  els.pill.lastElementChild.textContent = text;
  els.pill.setAttribute("data-tip", `行情状态|${{site: "网站线路", local: "本机连接器", direct: "币安直连", replay: "回放快照"}[t.route] ?? ""}${t.latency ? " · 延迟 " + F.num(t.latency, 0) + " ms" : ""}`);
}

function renderAccountChip() {
  const data = state.account.data;
  const usdt = data?.assets?.find(a => a.asset === "USDT") ?? data?.assets?.[0];
  els.accountChip.classList.toggle("connected", Boolean(data));
  fill(els.accountChipText, data ? h("span", {}, "权益 ", h("b", {text: F.num(Number(usdt?.equity), 2)})) : "账户未连接");
}

function renderAll() {
  renderRail(els.rail, state, actions);
  renderRegime(els.regime, state);
  renderHead(els.head, state, actions);
  renderBanner();
  renderResults(state, actions, els);
  renderDetail(els.detail, state, actions);
  renderStatus(els.status, state);
  renderPill();
  renderAccountChip();
}

/* ----------------------------------------------------------------- alerts */
function checkTriggerAlert() {
  const view = state.triggerView, status = view?.status ?? null;
  if (state.alerts && state.lastTriggerStatus === "idle" && status === "triggered") {
    const body = `BTC ${view.windowHours} 小时回撤 ${F.num(view.drawdownPct, 2)}%，达到 ${view.thresholdPct}% 阈值。对话 #76：先观察 Put 报价与 IV，再决定。`;
    toast("warn", "急跌触发", body, {timeout: 15000});
    try { if ("Notification" in window && Notification.permission === "granted") new Notification("BTC 急跌触发", {body, tag: "btc-crash"}); } catch { /* ignore */ }
  }
  state.lastTriggerStatus = status;
}

/* ---------------------------------------------------------------- account */
let accountTimer = 0;
function scheduleAccount() {
  clearTimeout(accountTimer);
  if (state.account.mode === "none") return;
  accountTimer = setTimeout(async () => { if (!document.hidden) await actions.refreshAccount({quiet: true}); scheduleAccount(); },
    state.account.mode === "server" ? 30_000 : 60_000);
}
function acceptAccount(mode, data, session = null) {
  state.account = {...state.account, mode, data, session, error: null};
  renderAccountChip();
  rebuild();
  scheduleAccount();
}
async function checkServerAccount({silent = true} = {}) {
  try {
    const info = await readServerAccount({token: state.accountToken, local: market.local});
    state.account.server = info;
    if (info.configured && info.authorized && Array.isArray(info.assets)) acceptAccount("server", info);
    else if (!silent && info.error) state.account.error = accountErrorText(info.error);
  } catch {
    state.account.server = null;
  }
}

/* ---------------------------------------------------------------- actions */
const actions = {
  selectStrategy(id) {
    if (!getStrategy(id)) return;
    closePopover();
    state.strategyId = id;
    state.selectedKey = null; state.viewSort = null;
    els.tableWrap.scrollTop = 0;
    renderRail(els.rail, state, actions);
    els.rail.querySelector(`[data-id="${id}"]`)?.scrollIntoView({block: "nearest", inline: "nearest"});
    if (state.ctx) { refreshRegime(); rescreen(); } else renderAll();
  },
  setParam(key, value) {
    const next = normalizeParams(state.strategy, {...state.params, [key]: value}).params;
    state.paramsById[state.strategyId] = next;
    save("params:" + state.strategyId, next);
    if (key === "trigger" || key === "dropWindow" || key === "dropPct") refreshRegime();
    rescreen({head: !popoverOpen()});
    state.counts[state.strategyId] = {total: state.result?.total ?? 0, blocked: state.result?.blocked, blockedCount: state.result?.blockedCount, gate: state.result?.gate?.status ?? null};
  },
  resetParams() {
    closePopover();
    state.paramsById[state.strategyId] = defaultParams(state.strategy);
    save("params:" + state.strategyId, state.params);
    refreshRegime();
    rescreen();
    toast("ok", "已恢复默认参数", "按对话中的规则与默认值重新筛选");
  },
  setQuantity(q) {
    const next = normalizeParams(state.strategy, {...state.params, quantityMode: "fixed", quantity: q}).params;
    state.paramsById[state.strategyId] = next;
    save("params:" + state.strategyId, next);
    rescreen();
  },
  selectCandidate(key, {open = false} = {}) {
    state.selectedKey = key;
    const pool = [...(state.result?.candidates ?? []), ...(state.result?.nearMisses ?? [])];
    state.selected = pool.find(c => c.key === key) ?? null;
    state.detail = state.selected ? analyzeCandidate(state.ctx, state.selected) : null;
    for (const tr of els.gridBody.children) tr.setAttribute("aria-selected", String(tr.dataset.key === key));
    for (const card of els.cards.children) card.setAttribute("aria-selected", "false");
    renderDetail(els.detail, state, actions);
    if (open && narrow()) openDrawer();
  },
  selectNearMiss(key) { actions.selectCandidate(key, {open: true}); },
  setSort(metric) {
    if (!metric) state.viewSort = null;
    else if (state.viewSort?.metric === metric) state.viewSort = {metric, dir: state.viewSort.dir === "asc" ? "desc" : "asc"};
    else state.viewSort = {metric, dir: METRICS[metric]?.better === "low" ? "asc" : "desc"};
    renderResults(state, actions, els);
  },
  toggleFreeze() {
    state.frozen = !state.frozen;
    if (state.frozen) { state.frozenAt = Date.now(); toast("info", "已冻结快照", "新行情暂不应用，可安心比较；再按 F 恢复"); }
    else {
      if (state.pending) { state.snapshot = state.pending; state.pending = null; }
      toast("ok", "已恢复实时行情");
    }
    rebuild();
    renderPill();
  },
  exportCsv() {
    const list = sortedView(state);
    if (!list.length) { toast("warn", "没有可导出的候选"); return; }
    const strategy = state.strategy, columns = strategy.columns;
    const cell = value => {
      let text = value === null || value === undefined ? "" : String(value);
      if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    const raw = (key, value) => !Number.isFinite(value) ? (value === Infinity ? "无上限" : "") : key === "pop" ? (value * 100).toFixed(3) : Number(value.toPrecision(10));
    const header = ["排名", "策略", "结构", "合约腿", "到期（北京）", "剩余天数", "数量BTC", ...columns.map(k => `${METRICS[k].label}${METRICS[k].unit ? "(" + METRICS[k].unit + ")" : ""}`),
      "最大盈利(USDT)", "盈亏平衡价", "警告", "快照时间"];
    const rows = list.map((c, i) => [i + 1, strategy.name, c.structure, c.legs.map(l => `${l.action === "SELL" ? "卖" : "买"}${l.ratio !== 1 ? l.ratio + "×" : ""} ${l.symbol} @${l.price}`).join(" + "),
      F.expiry(c.expiryMs, {year: true}) + " 16:00", Number(c.dte.toFixed(3)), c.qty, ...columns.map(k => raw(k, c.metrics[k])),
      raw("maxProfit", c.metrics.maxProfit), c.metrics.breakevens.map(b => Math.round(b)).join(" / "),
      c.checks.filter(x => x.status === "warn").map(x => describe(x)).join("；"), state.ctx.market.quality.fetchedAt ?? ""]);
    const csv = "﻿" + [header, ...rows].map(row => row.map(cell).join(",")).join("\r\n");
    const stamp = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 16).replace(/[-:T]/g, "");
    download(`btc-${strategy.id}-${stamp}.csv`, csv);
    toast("ok", "已导出 CSV", `${list.length} 个候选 · ${strategy.name}`);
  },
  async copyLink() {
    writeHash();
    toast((await copyText(location.href)) ? "ok" : "err", "已复制当前策略链接", "包含参数，可分享或收藏");
  },
  async copyTicket(candidate) {
    toast((await copyText(ticket(candidate, state.strategy))) ? "ok" : "err", "已复制订单参数", "请在币安确认实时价格后自行下单");
  },
  toggleWatch(key) {
    if (state.watch.has(key)) state.watch.delete(key); else state.watch.add(key);
    save("watch", [...state.watch].slice(-200));
    renderDetail(els.detail, state, actions);
    renderResults(state, actions, els);
    toast("info", state.watch.has(key) ? "已加入观察" : "已移出观察", "观察的候选在列表中以 ★ 标记");
  },
  setDetailTab(tab) { state.detailTab = tab; renderDetail(els.detail, state, actions); },
  setOverlay(value) { state.overlay = value; renderDetail(els.detail, state, actions); },
  closeDetail() { els.desk.classList.remove("detail-open"); document.querySelector(".scrim")?.remove(); },
  toggleTheme() { applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); if (state.selected) renderDetail(els.detail, state, actions); },
  openSettings() { openSettings(els.settings, state, actions); },
  saveSettings(settings) { state.settings = settings; save("settings", settings); rebuild(); },
  openAccount() {
    openAccount(els.account, state, actions);
    if (state.account.server === undefined || !state.account.data) checkServerAccount().then(() => { if (els.account.open) openAccount(els.account, state, actions); });
  },
  setAccountTab(tab) { state.accountTab = tab; openAccount(els.account, state, actions); },
  async connectServer(token) {
    state.accountToken = token; saveSession("token", token);
    state.account.error = null;
    await checkServerAccount({silent: false});
    if (state.account.data) toast("ok", "账户已连接", "服务器密钥 · 只读");
    else if (state.account.server?.reason === "token_required") state.account.error = "访问令牌不正确或缺失。";
    openAccount(els.account, state, actions);
  },
  async checkServer() { state.account.server = undefined; openAccount(els.account, state, actions); await checkServerAccount(); openAccount(els.account, state, actions); },
  async connectBrowser(apiKey, secret) {
    try {
      const session = await createBrowserSession(apiKey, secret);
      const data = await readBrowserAccount(session, {local: market.local});
      acceptAccount("browser", data, session);
      toast("ok", "账户已连接", "浏览器内签名 · 只读，关闭页面即失效");
    } catch (error) {
      state.account.error = error.message;
    }
    openAccount(els.account, state, actions);
  },
  async refreshAccount({quiet = false} = {}) {
    try {
      if (state.account.mode === "server") {
        const info = await readServerAccount({token: state.accountToken, local: market.local});
        if (info.configured && info.authorized && Array.isArray(info.assets)) acceptAccount("server", info);
        else throw new Error(info.error ? accountErrorText(info.error) : "服务器账户不可用");
      } else if (state.account.mode === "browser" && state.account.session) {
        acceptAccount("browser", await readBrowserAccount(state.account.session, {local: market.local}), state.account.session);
      }
      if (!quiet) toast("ok", "账户已刷新");
    } catch (error) {
      state.account.error = error.message;
      if (!quiet) toast("err", "账户刷新失败", error.message);
    }
    if (els.account.open) openAccount(els.account, state, actions);
  },
  disconnectAccount() {
    clearTimeout(accountTimer);
    state.account = {mode: "none", data: null, error: null, server: state.account.server, session: null};
    renderAccountChip();
    rebuild();
    openAccount(els.account, state, actions);
    toast("info", "已断开账户", "内存中的签名密钥已丢弃");
  },
  openHelp() { openHelp(els.help); },
  openPalette() { closePopover(); openPalette(els.palette, state, actions); },
  async toggleAlerts() {
    state.alerts = !state.alerts;
    save("alerts", state.alerts);
    $("#alertsButton").setAttribute("aria-pressed", String(state.alerts));
    if (state.alerts && "Notification" in window && Notification.permission === "default") { try { await Notification.requestPermission(); } catch { /* ignore */ } }
    toast("info", state.alerts ? "已开启急跌提醒" : "已关闭急跌提醒", state.alerts ? "满足急跌条件时弹出提醒（浏览器需保持打开）" : "");
  },
  canUseLocal: () => Boolean(window.BTCOptionsBridge),
  usingLocal: () => market.local,
  toggleLocal() { market.setLocal(!market.local); toast("info", market.local ? "改用本机连接器" : "改用网站线路"); },
  describe: check => describe(check),
};
const describe = check => describeCheck(check, id => CHECK_UNITS[id] ?? "");

function openDrawer() {
  els.desk.classList.add("detail-open");
  if (!document.querySelector(".scrim")) {
    const scrim = h("div.scrim", {onClick: actions.closeDetail});
    document.body.append(scrim);
  }
  els.detail.querySelector(".detail-close")?.focus({preventScroll: true});
}

/* ---------------------------------------------------------------- keyboard */
function moveSelection(delta) {
  const list = sortedView(state);
  if (!list.length) return;
  const index = list.findIndex(c => c.key === state.selectedKey);
  const next = list[Math.max(0, Math.min(list.length - 1, index < 0 ? 0 : index + delta))];
  actions.selectCandidate(next.key);
  els.gridBody.querySelector(`tr[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({block: "nearest"});
}

document.addEventListener("keydown", event => {
  const key = event.key;
  if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "k") { event.preventDefault(); actions.openPalette(); return; }
  if (isTyping(event) || document.querySelector("dialog[open]") || event.ctrlKey || event.metaKey || event.altKey) return;
  if (key === "Escape") { if (popoverOpen()) closePopover(); else actions.closeDetail(); return; }
  if (popoverOpen()) return;
  const playbook = STRATEGIES.find(s => s.hotkey === key);
  if (playbook) { event.preventDefault(); actions.selectStrategy(playbook.id); return; }
  const index = STRATEGIES.findIndex(s => s.id === state.strategyId);
  const handlers = {
    "/": actions.openPalette, "?": actions.openHelp,
    "[": () => actions.selectStrategy(STRATEGIES[(index - 1 + STRATEGIES.length) % STRATEGIES.length].id),
    "]": () => actions.selectStrategy(STRATEGIES[(index + 1) % STRATEGIES.length].id),
    ArrowDown: () => moveSelection(1), j: () => moveSelection(1), ArrowUp: () => moveSelection(-1), k: () => moveSelection(-1),
    Enter: () => { if (state.selected && narrow()) openDrawer(); },
    f: actions.toggleFreeze, F: actions.toggleFreeze, e: actions.exportCsv, t: actions.toggleTheme, s: actions.openSettings, a: actions.openAccount,
  };
  if (handlers[key]) { event.preventDefault(); handlers[key](); }
});

/* ------------------------------------------------------------------ wiring */
$("#omnibox").addEventListener("click", actions.openPalette);
$("#omniKey").textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";
$("#themeButton").addEventListener("click", actions.toggleTheme);
$("#settingsButton").addEventListener("click", actions.openSettings);
$("#accountChip").addEventListener("click", actions.openAccount);
$("#alertsButton").addEventListener("click", actions.toggleAlerts);
$("#alertsButton").setAttribute("aria-pressed", String(state.alerts));
$("#railFilter").addEventListener("input", event => { state.railFilter = event.target.value; renderRail(els.rail, state, actions); });
addEventListener("hashchange", () => { if (readHash()) { closePopover(); renderRail(els.rail, state, actions); if (state.ctx) { refreshRegime(); rescreen(); } } });
installTooltips();

const market = new MarketFeed({
  onSnapshot(snapshot) {
    if (state.frozen) { state.pending = snapshot; return; }
    state.snapshot = snapshot;
    rebuild();
    renderPill();
  },
  onStatus(status) {
    state.transport = {...state.transport, ...status, error: status.ok ? null : status.error};
    if (status.ok) state.transport.lastOk = status.at;
    renderPill();
    renderStatus(els.status, state);
    if (!state.snapshot) renderResults(state, actions, els);
  },
});
const signals = new SignalsFeed({
  getLocal: () => market.local,
  onSignals(data) {
    state.bars = {hourly: data.hourly, daily: data.daily};
    state.signalsMeta = {source: data.source, at: data.at, sources: data.sources};
    if (state.snapshot && !state.frozen) rebuild(); else renderStatus(els.status, state);
  },
});

setInterval(() => {
  els.clock.firstChild.textContent = F.beijing(Date.now());
  renderPill();
  renderStatus(els.status, state);
  if (state.snapshot && !state.frozen && Date.now() - state.lastBuildAt > 15_000 && !popoverOpen()) rebuild();
}, 1000);

readHash();
renderAll();
market.start();
signals.start();
checkServerAccount();
