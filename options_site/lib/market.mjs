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
  if (browserDirect) notes.push("浏览器直连行情：缺少合约规则与 24h 统计，保证金按默认费率估算");
  if (replay) notes.push("回放模式：使用已记录的历史快照，时间冻结在快照时刻，不是实时行情");
  if (snapshot.stale && !replay) notes.push("行情非实时：部分字段已过期，候选仅供参考");
  return {ok: contracts.length > 0, spot, exchangeNow, localNow, offset, contracts, bySymbol, expiries,
    quality: {status, stale: Boolean(snapshot.stale) && !replay, replay, browserDirect, catalogVerified, notes,
      fetchedAt: snapshot.fetched_at ?? null, indexAgeMs: time(snapshot.index_updated_at) === null ? null : Math.max(0, localNow - time(snapshot.index_updated_at))}};
}

export const expiryLabel = expiryMs => {
  const date = new Date(expiryMs + 8 * 3_600_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
};

export const daysBetween = (from, to) => (to - from) / DAY_MS;
