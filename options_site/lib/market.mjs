/**
 * Normalizes a /api/market snapshot into typed contracts grouped by expiry.
 * Keeps the receipt clock (local) and the exchange clock (expiry, events)
 * separate, exactly like the original dashboard does.
 */
import {DAY_MS, YEAR_MS, marginRules} from "./quant.mjs";

export const QUOTE_MAX_AGE = {websocket: 20_000, rest: 30_000};
const SYMBOL = /^BTC-(\d{6})-(\d+(?:\.\d+)?)-([CP])$/;

export const num = value => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const time = value => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value) {
    const n = /^\d{13}$/.test(value) ? Number(value) : Date.parse(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

function ageOf(row, field, groupKey, localNow) {
  const received = time(row.field_updated_at?.[field]) ?? time(row[groupKey + "_updated_at"]);
  return received === null ? null : Math.max(0, localNow - received);
}

/**
 * @param snapshot  /api/market payload (already aligned to the caller's clock)
 * @param localNow  caller clock in ms (Date.now() in browsers)
 */
export function prepareMarket(snapshot, localNow = Date.now()) {
  const spot = num(snapshot?.btc_index_price);
  const offset = num(snapshot?.exchange_clock_offset_ms) ?? 0;
  const exchangeNow = localNow + offset;
  const notes = [];
  const replay = Boolean(snapshot?.replay);
  const browserDirect = Boolean(snapshot?.browser_direct);
  const catalogVerified = !browserDirect && snapshot?.data_health?.catalog?.status !== "unavailable" && Boolean(snapshot?.catalog_updated_at);
  const contracts = [], bySymbol = new Map(), groups = new Map();
  if (!(spot > 0) || !Array.isArray(snapshot?.options)) {
    return {ok: false, spot: null, exchangeNow, localNow, offset, contracts, bySymbol, expiries: [],
      quality: {status: "unavailable", stale: true, replay, browserDirect, catalogVerified: false, notes: ["等待有效的 BTC 指数与期权行情"]}};
  }
  for (const row of snapshot.options) {
    const match = typeof row?.symbol === "string" ? SYMBOL.exec(row.symbol) : null;
    if (!match) continue;
    const type = match[3] === "P" ? "PUT" : "CALL";
    const strike = num(row.strike_price) ?? Number(match[2]);
    const expiryMs = time(row.expiry_ms) ?? time(row.expiry_beijing);
    if (row.side && row.side !== type || !(strike > 0) || expiryMs === null || expiryMs <= exchangeNow) continue;
    if (row.status && row.status !== "TRADING") continue;
    const unit = num(row.unit) ?? 1;
    if (unit !== 1) continue;
    const bid = num(row.bid_price), ask = num(row.ask_price);
    const bidQty = num(row.bid_quantity), askQty = num(row.ask_quantity);
    const minQty = num(row.min_qty) ?? .01;
    const scale = num(row.quantity_scale);
    const step = num(row.quantity_step) ?? (scale !== null && scale >= 0 && scale <= 8 ? 10 ** -scale : minQty);
    const quoteSource = row.field_source?.bid_price ?? row.quote_source ?? null;
    const quoteAge = ageOf(row, "bid_price", "quote", localNow);
    const markAge = ageOf(row, "mark_price", "mark", localNow);
    const quoteLimit = QUOTE_MAX_AGE[quoteSource === "websocket" ? "websocket" : "rest"];
    const markLimit = QUOTE_MAX_AGE[row.field_source?.mark_price === "websocket" ? "websocket" : "rest"];
    const years = (expiryMs - exchangeNow) / YEAR_MS;
    const contract = {
      symbol: row.symbol, type, strike, expiryMs, years, dte: years * 365,
      bid: bid > 0 ? bid : null, ask: ask > 0 ? ask : null,
      bidQty: bidQty !== null && bidQty >= 0 ? bidQty : null, askQty: askQty !== null && askQty >= 0 ? askQty : null,
      mark: num(row.mark_price), iv: num(row.mark_iv), bidIv: num(row.bid_iv), askIv: num(row.ask_iv),
      delta: num(row.delta), gamma: num(row.gamma), theta: num(row.theta), vega: num(row.vega),
      volume24h: num(row.volume_24h_contracts), amount24h: num(row.amount_24h_quote),
      minQty, maxQty: num(row.max_qty), step, rules: marginRules(row),
      otmPct: (type === "PUT" ? 1 - strike / spot : strike / spot - 1) * 100,
      k: Math.log(strike / spot),
      quoteAge, markAge, quoteSource,
      quoteFresh: quoteAge !== null && quoteAge <= quoteLimit,
      markFresh: markAge !== null && markAge <= markLimit,
      quoteVerified: row.quote_group_valid !== false,
      rulesVerified: catalogVerified && row.status === "TRADING",
    };
    if (contract.iv !== null && !(contract.iv > 0 && contract.iv <= 5)) contract.iv = null;
    if (contract.bidIv !== null && !(contract.bidIv > 0 && contract.bidIv <= 5)) contract.bidIv = null;
    if (contract.askIv !== null && !(contract.askIv > 0 && contract.askIv <= 5)) contract.askIv = null;
    if (contract.bid !== null && contract.ask !== null && contract.bid > contract.ask) { contract.bid = contract.ask = null; }
    contracts.push(contract);
    bySymbol.set(contract.symbol, contract);
    let group = groups.get(expiryMs);
    if (!group) groups.set(expiryMs, group = {expiryMs, years, dte: years * 365, puts: [], calls: [], byStrike: new Map()});
    (type === "PUT" ? group.puts : group.calls).push(contract);
    const pair = group.byStrike.get(strike) ?? {};
    pair[type] = contract;
    group.byStrike.set(strike, pair);
  }
  const expiries = [...groups.values()].sort((a, b) => a.expiryMs - b.expiryMs);
  for (const group of expiries) {
    group.puts.sort((a, b) => a.strike - b.strike);
    group.calls.sort((a, b) => a.strike - b.strike);
    group.strikes = [...group.byStrike.keys()].sort((a, b) => a - b);
  }
  const quoteStatus = snapshot.data_health?.quote?.status;
  let status = replay ? "replay" : snapshot.stale ? "stale" : quoteStatus === "partial" ? "partial" : "live";
  if (!contracts.length) status = "unavailable";
  const cached = Boolean(snapshot.cached) && contracts.length > 0;
  if (cached) { status = "cached"; notes.push("显示上次保存的行情，正在连接实时数据；报价仅供参考"); }
  if (browserDirect) notes.push("浏览器直连行情：缺少合约规则与 24h 统计，保证金按默认费率估算");
  if (replay) notes.push("回放模式：使用已记录的历史快照，时间冻结在快照时刻，不是实时行情");
  if (snapshot.stale && !replay) notes.push("行情非实时：部分字段已过期，候选仅供参考");
  return {ok: contracts.length > 0, spot, exchangeNow, localNow, offset, contracts, bySymbol, expiries,
    quality: {status, stale: (Boolean(snapshot.stale) && !replay) || cached, cached, replay, browserDirect, catalogVerified, notes,
      fetchedAt: snapshot.fetched_at ?? null, indexAgeMs: time(snapshot.index_updated_at) === null ? null : Math.max(0, localNow - time(snapshot.index_updated_at))}};
}

export const expiryLabel = expiryMs => {
  const date = new Date(expiryMs + 8 * 3_600_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
};

export const daysBetween = (from, to) => (to - from) / DAY_MS;

/* ------------------------------------------------------------------------ */
/* Compact frame: columnar, number-typed encoding for the Strategy Desk.     */
/* ------------------------------------------------------------------------ */

export const FRAME_VERSION = 1;
const FRAME_NUMERIC = [
  ["b", "bid_price"], ["a", "ask_price"], ["bq", "bid_quantity"], ["aq", "ask_quantity"],
  ["m", "mark_price"], ["iv", "mark_iv"], ["biv", "bid_iv"], ["aiv", "ask_iv"],
  ["d", "delta"], ["g", "gamma"], ["th", "theta"], ["vg", "vega"],
  ["v", "volume_24h_contracts"], ["n", "amount_24h_quote"], ["u", "unit"],
  ["min", "min_qty"], ["max", "max_qty"], ["step", "quantity_step"],
];
const FRAME_RULES = ["initial_margin_rate", "min_initial_margin_rate", "maintenance_margin_rate", "min_maintenance_margin_rate", "liquidation_fee_rate"];
const SOURCE_CODE = {websocket: "w", rest: "r"};
const SOURCE_NAME = {w: "websocket", r: "rest"};
const HEALTH = ["quote", "mark", "index", "catalog", "ticker"];

/**
 * Encodes a market snapshot (server clock) into a compact frame. Receipt
 * times become ages at builtAt, so the same market state always produces the
 * same body and a stable content hash for ETag / 304 revalidation.
 */
export function encodeFrame(snapshot, builtAt) {
  const rows = (Array.isArray(snapshot?.options) ? snapshot.options : []).filter(row => typeof row?.symbol === "string" && SYMBOL.test(row.symbol));
  const expiryOf = row => time(row.expiry_ms) ?? time(row.expiry_beijing);
  const expiries = [...new Set(rows.map(expiryOf).filter(value => value !== null))].sort((x, y) => x - y);
  const expiryIndex = new Map(expiries.map((value, index) => [value, index]));
  const rules = [], ruleIndex = new Map();
  const cols = {s: [], e: [], k: [], t: "", st: "", qs: "", ms: "", qv: "", qa: [], ma: [], r: []};
  for (const [key] of FRAME_NUMERIC) cols[key] = [];
  const age = value => value === null ? null : Math.max(0, Math.round(builtAt - value));
  for (const row of rows) {
    cols.s.push(row.symbol);
    cols.e.push(expiryIndex.get(expiryOf(row)) ?? -1);
    cols.k.push(num(row.strike_price));
    cols.t += row.symbol.endsWith("-P") ? "P" : "C";
    cols.st += row.status === "TRADING" ? "T" : row.status ? "X" : "-";
    cols.qs += SOURCE_CODE[row.field_source?.bid_price ?? row.quote_source] ?? "-";
    cols.ms += SOURCE_CODE[row.field_source?.mark_price ?? row.mark_source] ?? "-";
    cols.qv += row.quote_group_valid === true ? "1" : row.quote_group_valid === false ? "0" : "-";
    cols.qa.push(age(time(row.field_updated_at?.bid_price) ?? time(row.quote_updated_at)));
    cols.ma.push(age(time(row.field_updated_at?.mark_price) ?? time(row.mark_updated_at)));
    for (const [key, field] of FRAME_NUMERIC) cols[key].push(num(row[field]));
    const tuple = FRAME_RULES.map(key => num(row[key]));
    if (tuple.every(value => value !== null)) {
      const id = tuple.join(",");
      if (!ruleIndex.has(id)) { ruleIndex.set(id, rules.length); rules.push(tuple); }
      cols.r.push(ruleIndex.get(id));
    } else cols.r.push(-1);
  }
  return {
    v: FRAME_VERSION, builtAt, spot: num(snapshot?.btc_index_price), offset: num(snapshot?.exchange_clock_offset_ms) ?? 0,
    indexAge: age(time(snapshot?.index_updated_at)), indexSource: snapshot?.index_source ?? null,
    status: snapshot?.status ?? null, stale: Boolean(snapshot?.stale), replay: Boolean(snapshot?.replay),
    fetchedAt: snapshot?.fetched_at ?? null, catalogAt: snapshot?.catalog_updated_at ?? null,
    health: Object.fromEntries(HEALTH.map(key => [key, snapshot?.data_health?.[key]?.status ?? null])),
    error: snapshot?.error?.message ?? null, expiries, rules, rows: cols,
  };
}

/** Structural validation; a malformed frame must never reach the screener. */
export function validFrame(frame) {
  if (!frame || frame.v !== FRAME_VERSION || !Number.isFinite(frame.builtAt) || !frame.rows || !Array.isArray(frame.expiries)) return false;
  const n = frame.rows.s?.length;
  if (!Number.isInteger(n) || n > 4000) return false;
  const arrays = ["e", "k", "qa", "ma", "r", ...FRAME_NUMERIC.map(([key]) => key)];
  const strings = ["t", "st", "qs", "ms", "qv"];
  return arrays.every(key => Array.isArray(frame.rows[key]) && frame.rows[key].length === n)
    && strings.every(key => typeof frame.rows[key] === "string" && frame.rows[key].length === n)
    && Array.isArray(frame.rules) && frame.rules.every(rule => Array.isArray(rule) && rule.length === FRAME_RULES.length);
}

/**
 * Rebuilds a snapshot in the caller's clock. servedAt is the server clock
 * when the response left the server (X-Served-At), receivedAt the local
 * clock on arrival; ages are carried forward exactly.
 */
export function decodeFrame(frame, {receivedAt, servedAt}) {
  if (!validFrame(frame)) throw new TypeError("行情帧格式无效");
  const shift = receivedAt - servedAt, carried = Math.max(0, servedAt - frame.builtAt);
  const at = ageValue => ageValue === null ? null : receivedAt - (ageValue + carried);
  const c = frame.rows, options = new Array(c.s.length);
  for (let i = 0; i < c.s.length; i++) {
    const row = {symbol: c.s[i], side: c.t[i] === "P" ? "PUT" : "CALL", expiry_ms: frame.expiries[c.e[i]] ?? null, strike_price: c.k[i],
      status: c.st[i] === "T" ? "TRADING" : c.st[i] === "X" ? "HALTED" : null,
      quote_updated_at: at(c.qa[i]), mark_updated_at: at(c.ma[i]),
      quote_source: SOURCE_NAME[c.qs[i]] ?? null, field_source: {bid_price: SOURCE_NAME[c.qs[i]] ?? null, mark_price: SOURCE_NAME[c.ms[i]] ?? null}};
    if (c.qv[i] !== "-") row.quote_group_valid = c.qv[i] === "1";
    for (const [key, field] of FRAME_NUMERIC) row[field] = c[key][i];
    const rule = frame.rules[c.r[i]];
    if (rule) FRAME_RULES.forEach((key, index) => { row[key] = rule[index]; });
    options[i] = row;
  }
  return {
    options, btc_index_price: frame.spot, exchange_clock_offset_ms: frame.offset - shift,
    index_updated_at: at(frame.indexAge), index_source: frame.indexSource, status: frame.status, stale: frame.stale,
    replay: frame.replay, fetched_at: frame.fetchedAt, catalog_updated_at: frame.catalogAt,
    data_health: Object.fromEntries(HEALTH.map(key => [key, {status: frame.health?.[key] ?? null}])),
    error: frame.error ? {message: frame.error} : null, browser_direct: false,
  };
}

/** 53-bit FNV-1a style content hash (two interleaved 32-bit lanes). */
export function contentHash(text) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 16777619);
    h2 = Math.imul(h2 ^ code, 2246822519);
  }
  return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)).padStart(14, "0");
}
