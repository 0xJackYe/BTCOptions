// BTC 期权策略看板 — interface thread.
// The engine (network, decoding, screening, analytics) runs in a Web Worker
// that boot.js starts before this module graph has even finished loading.
// This thread renders on animation frames, animates, and holds account keys.
import {engine, listen, local} from "./boot.js";
import {$, h, icon, isTyping, fill} from "./dom.js";
import * as F from "./format.js";
import {installTooltips, toast, copyText, download, load, save, loadSession, saveSession, closePopover, popoverOpen} from "./ui.js";
import {readServerAccount, createBrowserSession, readBrowserAccount, accountErrorText} from "./transport.js";
import {renderRail, updateRail, renderRegime, renderHead, updateHead, renderResults, markSelection, renderStatus, sortedView} from "./views.js";
import {renderDetail, switchTab, ticket} from "./detail.js";
import {openSettings, openAccount, openHelp, openPalette} from "./panels.js";
import {viewTransition, inkDrop, inkIn} from "./motion.js";
import {STRATEGIES, METRICS, getStrategy, defaultParams, normalizeParams, encodeParams, decodeParams} from "../lib/strategies.mjs";
import {mergeSettings, describeCheck, CHECK_UNITS} from "../lib/checks.mjs";

const els = {
  desk: $("#desk"), main: $("#main"), rail: $("#rail"), railInk: $("#railInk"), regime: $("#regime"), head: $("#strategyHead"),
  resultsBar: $("#resultsBar"), banner: $("#banner"), grid: $("#grid"), gridHead: $("#gridHead"), gridBody: $("#gridBody"),
  cards: $("#cardList"), empty: $("#emptyState"), tableWrap: $("#tableWrap"), detail: $("#detail"), status: $("#statusbar"),
  pill: $("#livePill"), clock: $("#clock"), accountChip: $("#accountChip"), accountChipText: $("#accountChipText"),
  palette: $("#paletteDialog"), settings: $("#settingsDialog"), account: $("#accountDialog"), help: $("#helpDialog"),
};

const narrowQuery = matchMedia("(max-width: 1260px)"), mobileQuery = matchMedia("(max-width: 900px)");
const narrow = () => narrowQuery.matches;

const state = {
  strategyId: "crash-put", selectedKey: null, selected: null, detail: null, viewSort: null, frozen: false, frozenAt: 0,
  market: null, regime: null, trigger: null, portfolio: null, result: null, counts: {}, source: null, barsSource: null, barsAt: 0, timings: null,
  transport: {ok: false, route: local ? "local" : "site", error: null, lastOk: 0, latency: null, online: navigator.onLine !== false},
  direct: {active: false, lastAt: 0}, engineMode: null, boot: null, switching: false, redrawChart: false,
  settings: mergeSettings(load("settings", {})), detailTab: "rules", overlay: true, railFilter: "",
  watch: new Set(load("watch", [])), alerts: load("alerts", false), lastTriggerStatus: null,
  account: {mode: "none", data: null, error: null, server: undefined, session: null}, accountTab: "server", accountToken: loadSession("token"),
  get strategy() { return getStrategy(this.strategyId); },
  get params() { return this.paramsById[this.strategyId]; },
};
state.paramsById = Object.fromEntries(STRATEGIES.map(s => [s.id, normalizeParams(s, load("params:" + s.id, {})).params]));

/* ------------------------------------------------------------------ render */
// Everything is drawn on the next animation frame; repeated invalidations
// within a frame (a burst of engine messages) cost a single render.
const dirty = new Set();
let frame = 0;
function invalidate(...parts) {
  for (const part of parts) dirty.add(part);
  if (!frame) frame = requestAnimationFrame(flush);
}
function flushNow() {
  if (frame) cancelAnimationFrame(frame);
  flush();
}
const detailBusy = () => {
  const active = document.activeElement;
  return active instanceof HTMLInputElement && els.detail.contains(active);
};
function flush() {
  frame = 0;
  const parts = new Set(dirty);
  dirty.clear();
  if (parts.has("rail")) renderRail(els.rail, state, actions);
  if (parts.has("rail") || parts.has("counts")) updateRail(els.rail, els.railInk, state, {instant: parts.has("instant")});
  if (parts.has("regime")) renderRegime(els.regime, state);
  if (parts.has("head")) renderHead(els.head, state, actions);
  else if (parts.has("headLive")) updateHead(state, actions);
  if (parts.has("banner")) renderBanner();
  if (parts.has("results")) renderResults(state, actions, els, {fresh: parts.has("fresh")});
  if (parts.has("detail")) {
    if (detailBusy()) dirty.add("detail");      // never yank an input out from under the user
    else { renderDetail(els.detail, state, actions); state.redrawChart = false; }
  }
  if (parts.has("status")) renderStatus(els.status, state);
  if (parts.has("pill")) renderPill();
  if (parts.has("account")) renderAccountChip();
}
els.detail.addEventListener("focusout", () => { if (dirty.has("detail")) setTimeout(() => invalidate(), 0); });

/* ------------------------------------------------------------------ theme */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("#themeButton use").setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0f0e0c" : "#f1ece1");
  save("theme", theme);
  try { localStorage.setItem("btc-options-anthropic-light-theme", JSON.stringify(theme === "light")); } catch { /* private mode */ }
}
applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");

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

/* ------------------------------------------------------------ engine link */
let switchWaiter = null, detailTimer = 0;

function handleEngineMessage(message) {
  switch (message?.type) {
    case "ready":
      state.engineMode = message.mode;
      invalidate("status");
      return;
    case "result":
      onResult(message);
      return;
    case "counts":
      Object.assign(state.counts, message.counts);
      invalidate("counts");
      return;
    case "detail":
      if (message.key !== state.selectedKey) return;
      clearTimeout(detailTimer);
      state.detail = message.detail;
      invalidate("detail");
      return;
    case "transport":
      state.transport = {...state.transport, ...message};
      invalidate("pill", "status", "banner");
      if (!state.market?.ok) invalidate("results");
      return;
    case "direct":
      setDirect(message.active);
      return;
    case "boot":
      state.boot = message;
      invalidate("banner");
      return;
    case "error":
      if (message.where === "screen") toast("err", "筛选出错", message.message, {timeout: 8000});
      return;
    default:
  }
}

function onResult(message) {
  state.market = message.market;
  if (message.waiting) { invalidate("results", "status", "pill", "regime"); return; }
  state.regime = message.regime;
  state.trigger = message.trigger;
  state.portfolio = message.portfolio;
  state.source = message.source;
  state.barsSource = message.barsSource;
  state.barsAt = message.barsAt;
  state.timings = message.timings;
  invalidate("regime", "status", "pill", "banner");
  checkTriggerAlert();
  // A result computed for the previous strategy (raced a click) is dropped.
  if (message.strategyId !== state.strategyId || !message.result) return;
  const fresh = state.result?.strategyId !== message.strategyId;
  state.result = message.result;
  const r = message.result;
  state.counts[state.strategyId] = {total: r.total, blocked: r.blocked, blockedCount: r.blockedCount ?? null, gate: r.gate?.status ?? null};
  const pool = [...r.candidates, ...r.nearMisses];
  if (state.selectedKey && pool.some(c => c.key === state.selectedKey)) {
    if (message.selectedKey === state.selectedKey) state.detail = message.detail;
    else engine.post({type: "select", key: state.selectedKey});
  } else if (!mobileQuery.matches) {
    state.selectedKey = message.selectedKey ?? null;
    state.detail = message.detail;
  } else {
    state.selectedKey = null;
    state.detail = null;
  }
  state.selected = pool.find(c => c.key === state.selectedKey) ?? null;
  invalidate("headLive", "results", "detail", "counts");
  if (fresh && !state.switching) dirty.add("fresh");
  els.main.classList.remove("pending");
  if (switchWaiter) { switchWaiter(); switchWaiter = null; }
}

/* ----------------------------------------------- direct Binance fallback */
// The worker asks for this after two failed site polls: Binance's public
// WebSocket runs here (it is already loaded for the chain page) and its
// snapshots are handed to the engine at most every two seconds.
let direct = null, directTimer = 0, directPending = null, directPostedAt = 0;
function setDirect(active) {
  state.direct.active = Boolean(active);
  const market = window.BTCOptionsBrowserMarket;
  if (state.direct.active && !direct && market && !local) {
    direct = market.connect(snapshot => {
      state.direct.lastAt = Date.now();
      directPending = snapshot;
      if (directTimer) return;
      directTimer = setTimeout(() => {
        directTimer = 0;
        directPostedAt = Date.now();
        if (state.direct.active && directPending) engine.post({type: "snapshot", snapshot: directPending, source: "direct"});
        directPending = null;
      }, Math.max(0, 2000 - (Date.now() - directPostedAt)));
    }, () => {
      direct = null;
      if (state.direct.active) setTimeout(() => { if (state.direct.active) setDirect(true); }, 5000);
    });
  } else if (!state.direct.active && direct) {
    direct.close();
    direct = null;
    clearTimeout(directTimer);
    directTimer = 0;
    directPending = null;
  }
  invalidate("pill", "status", "banner");
}

/* -------------------------------------------------------- banner and pill */
let bannerKey = "";
function renderBanner() {
  const q = state.market?.quality, t = state.transport;
  const nodes = [];
  if (q?.replay) nodes.push(["replay", h("div.banner.replay", {role: "note"}, icon("layers"),
    `回放模式：显示 ${q.fetchedAt ? F.beijing(Date.parse(q.fetchedAt), {date: true, seconds: false}) + "（北京）" : "历史"} 记录的币安真实快照，时间冻结在快照时刻，不是实时报价。`)]);
  else if (state.source === "direct") nodes.push(["direct", h("div.banner.stale", {role: "note"}, "网站线路暂不可用，正在使用币安直连行情：缺少合约规则与 24h 统计，保证金按默认费率估算。")]);
  else if (q?.cached) nodes.push(["cached", h("div.banner.cached", {role: "note"},
    `显示上次保存的行情${state.boot?.savedAt ? "（" + F.ago(state.boot.savedAt) + "保存）" : ""}，正在连接实时数据；报价仅供参考。`)]);
  else if (t.online === false) nodes.push(["offline", h("div.banner.down", {role: "note"}, "网络已断开：显示的是最后收到的行情，恢复后自动重连。")]);
  else if (q?.stale) nodes.push(["stale", h("div.banner.stale", {role: "note"}, "部分行情字段已过期：候选会标注报价时效，请以币安实时盘口为准。")]);
  if (state.frozen) nodes.push(["frozen" + state.frozenAt, h("div.banner.stale", {role: "note"}, `已冻结在 ${F.beijing(state.frozenAt)} 的快照，便于比较；新行情暂不应用。`,
    h("button", {type: "button", onClick: actions.toggleFreeze}, "恢复实时"))]);
  const key = nodes.map(([k]) => k).join("|");
  if (key === bannerKey) return;
  bannerKey = key;
  fill(els.banner, ...nodes.map(([, node]) => node));
}

function renderPill() {
  const t = state.transport, q = state.market?.quality, now = Date.now();
  const lastOk = state.source === "direct" ? state.direct.lastAt : t.lastOk;
  const age = lastOk ? (now - lastOk) / 1000 : Infinity;
  let cls = "", text = "连接中";
  if (state.frozen) { cls = "frozen"; text = "已冻结"; }
  else if (q?.replay) { cls = "replay"; text = "回放"; }
  else if (t.online === false) { cls = "down"; text = "断网"; }
  else if (q?.cached) { cls = "cached"; text = "缓存"; }
  else if (state.source === "direct") { cls = age < 15 ? "stale" : "down"; text = age < 15 ? "直连" : "延迟"; }
  else if (!state.market?.ok && t.failures) { cls = "down"; text = "离线"; }
  else if (age > 30 || (!t.ok && t.failures)) { cls = "stale"; text = Number.isFinite(age) ? "延迟 " + F.num(age, 0) + "s" : "连接中"; }
  else if (q?.stale) { cls = "stale"; text = "部分延迟"; }
  else if (state.market?.ok) { cls = "live"; text = "实时"; }
  const className = "pill " + cls;
  if (els.pill.className !== className) els.pill.className = className;
  if (els.pill.lastElementChild.textContent !== text) els.pill.lastElementChild.textContent = text;
  const route = state.source === "direct" ? "币安直连" : {site: "网站线路", local: "本机连接器", replay: "回放快照"}[t.route] ?? "";
  els.pill.setAttribute("data-tip", `行情状态|${route}${Number.isFinite(t.latency) ? " · 延迟 " + F.num(t.latency, 0) + " ms" : ""}${t.retryIn && !t.ok ? " · " + F.num(t.retryIn / 1000, 0) + " 秒后重试" : ""}`);
}

function renderAccountChip() {
  const data = state.account.data;
  const usdt = data?.assets?.find(a => a.asset === "USDT") ?? data?.assets?.[0];
  els.accountChip.classList.toggle("connected", Boolean(data));
  fill(els.accountChipText, data ? h("span", {}, "权益 ", h("b", {text: F.num(Number(usdt?.equity), 2)})) : "账户未连接");
}

/* ----------------------------------------------------------------- alerts */
function checkTriggerAlert() {
  const view = state.trigger, status = view?.status ?? null;
  if (state.alerts && state.lastTriggerStatus === "idle" && status === "triggered") {
    const body = `BTC ${view.windowHours} 小时回撤 ${F.num(view.drawdownPct, 2)}%，达到 ${view.thresholdPct}% 阈值。对话 #76：先观察 Put 报价与 IV，再决定。`;
    toast("warn", "急跌触发", body, {timeout: 15000});
    try { if ("Notification" in window && Notification.permission === "granted") new Notification("BTC 急跌触发", {body, tag: "btc-crash"}); } catch { /* ignore */ }
  }
  if (status) state.lastTriggerStatus = status;
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
  engine.post({type: "account", data});
  invalidate("account");
  scheduleAccount();
}
async function checkServerAccount({silent = true} = {}) {
  try {
    const info = await readServerAccount({token: state.accountToken, local});
    state.account.server = info;
    if (info.configured && info.authorized && Array.isArray(info.assets)) acceptAccount("server", info);
    else if (!silent && info.error) state.account.error = accountErrorText(info.error);
  } catch {
    state.account.server = null;
  }
}

/* ------------------------------------------------------- strategy switch */
function switchView() {
  if (!state.market?.ok) { invalidate("head", "results", "detail", "banner"); return; }
  els.main.classList.add("pending");
  state.switching = true;
  // The new strategy's header and first results appear together, cross-
  // fading like ink on paper; a slow engine never holds the frame > 240 ms.
  viewTransition(async () => {
    await new Promise(resolve => {
      // The engine may already have answered before the transition began.
      if (state.result?.strategyId === state.strategyId && !els.main.classList.contains("pending")) { resolve(); return; }
      switchWaiter = resolve;
      setTimeout(resolve, 240);
    });
    switchWaiter = null;
    state.switching = false;
    invalidate("head", "results", "detail", "banner");
    flushNow();
  }, {className: "vt-strategy"});
}

/* ---------------------------------------------------------------- actions */
const describe = check => describeCheck(check, id => CHECK_UNITS[id] ?? "");
const postParams = () => {
  save("params:" + state.strategyId, state.params);
  engine.post({type: "params", strategyId: state.strategyId, params: state.params});
  writeHash();
};

const actions = {
  selectStrategy(id) {
    if (!getStrategy(id) || id === state.strategyId) return;
    closePopover();
    state.strategyId = id;
    state.selectedKey = null; state.selected = null; state.detail = null; state.viewSort = null;
    els.tableWrap.scrollTop = 0;
    engine.post({type: "strategy", strategyId: id, selectedKey: null});
    writeHash();
    invalidate("counts");
    flushNow();
    els.rail.querySelector(`[data-id="${id}"]`)?.scrollIntoView({block: "nearest", inline: "nearest"});
    switchView();
  },
  setParam(key, value) {
    state.paramsById[state.strategyId] = normalizeParams(state.strategy, {...state.params, [key]: value}).params;
    postParams();
    invalidate("headLive");
  },
  resetParams() {
    closePopover();
    state.paramsById[state.strategyId] = defaultParams(state.strategy);
    postParams();
    invalidate("head");
    toast("ok", "已恢复默认参数", "按对话中的规则与默认值重新筛选");
  },
  setQuantity(q) {
    state.paramsById[state.strategyId] = normalizeParams(state.strategy, {...state.params, quantityMode: "fixed", quantity: q}).params;
    postParams();
    invalidate("headLive");
  },
  selectCandidate(key, {open = false} = {}) {
    const pool = [...(state.result?.candidates ?? []), ...(state.result?.nearMisses ?? [])];
    const changed = key !== state.selectedKey;
    state.selectedKey = key;
    state.selected = pool.find(c => c.key === key) ?? null;
    markSelection(els, key);
    if (changed) {
      state.detail = null;
      engine.post({type: "select", key});
      // The analysis usually lands within a frame or two; if it is slower,
      // show the candidate now and let the chart draw in when it arrives.
      clearTimeout(detailTimer);
      detailTimer = setTimeout(() => invalidate("detail"), 90);
    }
    if (open && narrow()) openDrawer();
  },
  selectNearMiss(key) { actions.selectCandidate(key, {open: true}); },
  setSort(metric) {
    if (!metric) state.viewSort = null;
    else if (state.viewSort?.metric === metric) state.viewSort = {metric, dir: state.viewSort.dir === "asc" ? "desc" : "asc"};
    else state.viewSort = {metric, dir: METRICS[metric]?.better === "low" ? "asc" : "desc"};
    invalidate("results");
  },
  toggleFreeze() {
    state.frozen = !state.frozen;
    state.frozenAt = Date.now();
    engine.post({type: "freeze", frozen: state.frozen, at: state.frozenAt});
    if (state.frozen) toast("info", "已冻结快照", "新行情暂不应用，可安心比较；再按 F 恢复");
    else toast("ok", "已恢复实时行情");
    invalidate("pill", "banner", "headLive");
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
      c.checks.filter(x => x.status === "warn").map(x => describe(x)).join("；"), state.market?.quality?.fetchedAt ?? ""]);
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
    invalidate("detail", "results");
    toast("info", state.watch.has(key) ? "已加入观察" : "已移出观察", "观察的候选在列表中以 ★ 标记");
  },
  setDetailTab(tab) {
    if (state.detailTab === tab) return;
    state.detailTab = tab;
    if (!switchTab(state, actions)) invalidate("detail");
  },
  setOverlay(value) { state.overlay = value; state.redrawChart = true; invalidate("detail"); },
  closeDetail() {
    els.desk.classList.remove("detail-open");
    const scrim = document.querySelector(".scrim");
    if (scrim) { scrim.style.animation = "fadeOut 200ms ease both"; setTimeout(() => scrim.remove(), 200); }
  },
  toggleTheme(event) {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    const box = (event?.currentTarget instanceof Element ? event.currentTarget : $("#themeButton")).getBoundingClientRect();
    inkDrop(() => applyTheme(next), {x: box.left + box.width / 2, y: box.top + box.height / 2});
  },
  openSettings() { openSettings(els.settings, state, actions); },
  saveSettings(settings) {
    state.settings = settings;
    save("settings", settings);
    engine.post({type: "settings", settings});
  },
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
      const data = await readBrowserAccount(session, {local});
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
        const info = await readServerAccount({token: state.accountToken, local});
        if (info.configured && info.authorized && Array.isArray(info.assets)) acceptAccount("server", info);
        else throw new Error(info.error ? accountErrorText(info.error) : "服务器账户不可用");
      } else if (state.account.mode === "browser" && state.account.session) {
        acceptAccount("browser", await readBrowserAccount(state.account.session, {local}), state.account.session);
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
    engine.post({type: "account", data: null});
    invalidate("account");
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
  usingLocal: () => local,
  toggleLocal() {
    save("useLocal", !local);
    toast("info", local ? "正在切回网站线路" : "正在改用本机连接器", "页面将重新载入");
    setTimeout(() => location.reload(), 500);
  },
  describe,
};

function openDrawer() {
  els.desk.classList.add("detail-open");
  if (!document.querySelector(".scrim")) document.body.append(h("div.scrim", {onClick: actions.closeDetail}));
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
  if (isTyping(event) || document.querySelector("dialog[open]:not(.closing)") || event.ctrlKey || event.metaKey || event.altKey) return;
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
    f: actions.toggleFreeze, F: actions.toggleFreeze, e: actions.exportCsv, t: () => actions.toggleTheme(), s: actions.openSettings, a: actions.openAccount,
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
$("#railFilter").addEventListener("input", event => { state.railFilter = event.target.value; invalidate("rail", "instant"); });
addEventListener("hashchange", () => {
  const previous = state.strategyId;
  if (!readHash()) return;
  closePopover();
  engine.post({type: "params", strategyId: state.strategyId, params: state.params});
  if (state.strategyId !== previous) {
    const id = state.strategyId;
    state.strategyId = previous;
    actions.selectStrategy(id);
  } else invalidate("head");
});
mobileQuery.addEventListener("change", () => { engine.post({type: "autoselect", value: !mobileQuery.matches}); invalidate("results", "counts", "instant"); });
narrowQuery.addEventListener("change", () => { if (!narrow()) actions.closeDetail(); invalidate("counts", "instant"); });
addEventListener("resize", () => invalidate("counts", "instant"));
installTooltips();

// Clock, ages and the live pill tick on the second boundary.
(function tick() {
  els.clock.firstChild.textContent = F.beijing(Date.now());
  renderPill();
  renderStatus(els.status, state);
  setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
})();

readHash();
invalidate("rail", "instant", "regime", "head", "banner", "results", "detail", "status", "pill", "account");
flushNow();
// First paint: the strip and the rail arrive like successive brush strokes.
inkIn(els.regime.children, {step: 36, blur: false, max: 12});
inkIn(els.rail.querySelectorAll(".strategy-item"), {step: 16, max: 20, blur: false, distance: 4});
// Messages the engine sent while this module graph was loading are replayed now.
listen(handleEngineMessage);
checkServerAccount();
