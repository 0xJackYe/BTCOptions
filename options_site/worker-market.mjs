// Public market data only. This module cannot accept credentials or send orders.
const API = "https://eapi.binance.com/eapi/v1/";
const STREAM = "wss://fstream.binance.com/market/stream?streams=btcusdt@optionMarkPrice";
const SYMBOL = /^BTC-\d{6}-\d{1,12}(?:\.\d{1,4})?-[CP]$/;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 4000;
const MAX_CACHE_AGE = 600_000;
const REST_AGE = 30_000;
const STREAM_AGE = 20_000;
const MAX_SKEW = 2_000;
const ROUTES = new Set(["/api/market", "/api/focused-market", "/api/mark-watch"]);
const QUOTE = {bo: "bid_price", ao: "ask_price", bq: "bid_quantity", aq: "ask_quantity"};
const MARK = {markPrice: "mark_price", markIV: "mark_iv", bidIV: "bid_iv", askIV: "ask_iv", delta: "delta", gamma: "gamma", theta: "theta", vega: "vega"};
const STREAM_MARK = {mp: "markPrice", vo: "markIV", b: "bidIV", a: "askIV", d: "delta", g: "gamma", t: "theta", v: "vega"};
const TICKER = {lastPrice: "last_price", volume: "volume_24h_contracts", amount: "amount_24h_quote", priceChange: "price_change", priceChangePercent: "price_change_percent"};
const RULES = {initialMargin: "initial_margin_rate", minInitialMargin: "min_initial_margin_rate", maintenanceMargin: "maintenance_margin_rate", minMaintenanceMargin: "min_maintenance_margin_rate", liquidationFeeRate: "liquidation_fee_rate"};
const QUOTE_FIELDS = Object.entries(QUOTE);
const STREAM_MARK_FIELDS = Object.entries(STREAM_MARK).map(([wire, rest]) => [wire, MARK[rest]]);
const REST_MARK_FIELDS = Object.entries(MARK);
const TICKER_FIELDS = Object.entries(TICKER);
const RULE_FIELDS = Object.entries(RULES);
const PRICE_FIELDS = [["bidPrice", "bid_price"], ["askPrice", "ask_price"]];
const DEPTH_FIELDS = [["bid", "bid_price"], ["ask", "ask_price"], ["bidSize", "bid_quantity"], ["askSize", "ask_quantity"]];
const BOOK_FIELDS = Object.values(QUOTE);
const MARK_HEALTH_FIELDS = ["mark_price", "mark_iv", "delta", "gamma", "theta", "vega"];
const TICKER_HEALTH_FIELDS = ["volume_24h_contracts", "amount_24h_quote"];
const JSON_HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "application/json"};
const MESSAGES = {
  restricted: "币安限制了当前行情服务器的访问。",
  rate_limited: "币安公开接口正在限流。",
  busy: "行情刷新频率受限，稍后自动重试。",
  unavailable: "币安公开行情接口暂不可用。",
  invalid: "币安公开行情响应结构异常。",
};

class MarketError extends Error {
  constructor(code, status = null, wait = 5_000) {
    super(MESSAGES[code]);
    this.code = code;
    this.status = status;
    this.wait = wait;
  }
}

function json(value, status = 200) {
  return Response.json(value, {status, headers: JSON_HEADERS});
}

function decimal(value, min = -Infinity) {
  if (typeof value !== "number" && (typeof value !== "string" ||
      !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value))) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? String(value) : null;
}

function positive(value) {
  const text = decimal(value);
  return Number(text) > 0 ? text : null;
}

function stamp(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d{13}$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 946_684_800_000 && n < 4_102_444_800_000 ? n : null;
}

function sourceFresh(sourceTime, observedAt, now, offset, maxAge) {
  return sourceTime !== null && sourceTime <= observedAt + offset + MAX_SKEW
    && sourceTime >= now + offset - maxAge;
}

function beijing(time) {
  return new Date(time + 28_800_000).toISOString().replace("Z", "+08:00");
}

async function boundedJson(response) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_BYTES || !response.body) throw new MarketError("invalid");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", {fatal: true});
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new MarketError("invalid");
      chunks.push(decoder.decode(value, {stream: true}));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(""));
  } catch {
    await reader.cancel().catch(() => {});
    throw new MarketError("invalid");
  }
}

function retryDelay(value, status, now) {
  const n = value === null ? NaN : Number(value);
  const seconds = Number.isFinite(n) ? n : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.max(5, Math.min(900, seconds)) * 1000
    : status === 418 ? 120_000 : 60_000;
}

function validateArray(data) {
  return Array.isArray(data) && data.length > 0 && data.length <= MAX_ROWS
    && data.every(row => row && typeof row.symbol === "string");
}

function bookIsValid(values) {
  const [bid, ask, bidSize, askSize] = values;
  return values.every(value => value !== null) &&
    (Number(bid) > 0) === (Number(bidSize) > 0) && (Number(ask) > 0) === (Number(askSize) > 0)
    && (!Number(bid) || !Number(ask) || Number(bid) <= Number(ask));
}

function depthBook(data) {
  if (!Array.isArray(data?.bids) || !Array.isArray(data.asks) || !stamp(data.T)) return null;
  const best = levels => levels.length === 0 ? ["0", "0"] : Array.isArray(levels[0])
    ? [positive(levels[0][0]), positive(levels[0][1])] : [null, null];
  const [bid, bidSize] = best(data.bids), [ask, askSize] = best(data.asks);
  return bookIsValid([bid, ask, bidSize, askSize]) ? {bid, ask, bidSize, askSize} : null;
}

function readStream(openSocket, now) {
  return new Promise((resolve, reject) => {
    let socket;
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {socket?.close(1000, "snapshot complete");} catch {}
      if (error) reject(error);
      else resolve(result);
    };
    const fail = () => finish(new MarketError("unavailable"));
    const timer = setTimeout(fail, 2800);
    try {
      socket = openSocket(STREAM);
      socket.addEventListener("error", fail);
      socket.addEventListener("close", fail);
      socket.addEventListener("message", ({data}) => {
        if (typeof data !== "string" || data.length > MAX_BYTES) return;
        try {
          const packet = JSON.parse(data);
          const rows = packet.stream === "btcusdt@optionMarkPrice" ? packet.data : null;
          if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) return;
          if (rows.some(row => row?.e === "markPrice" && SYMBOL.test(row.s) && stamp(row.E))) {
            finish(null, {data: rows, at: now()});
          }
        } catch {}
      });
    } catch {fail();}
  });
}

function selectFields(target, values, mapping, group, received, source, event, min) {
  let present = false;
  for (const [wire, field] of mapping) {
    const value = decimal(values?.[wire], min?.[wire]);
    target[field] = value;
    if (value === null) continue;
    present = true;
    target.field_updated_at[field] = received;
    target.field_source[field] = source;
    target.field_event_ms[field] = event;
  }
  target[group + "_updated_at"] = present ? received : null;
  target[group + "_source"] = present ? source : null;
  target[group + "_event_ms"] = present ? event : null;
}

function uniqueRows(rows, key) {
  const map = new Map(), duplicates = new Set();
  for (const row of rows ?? []) {
    const symbol = row?.[key];
    if (!SYMBOL.test(symbol)) continue;
    if (map.has(symbol)) duplicates.add(symbol);
    map.set(symbol, row);
  }
  for (const symbol of duplicates) map.delete(symbol);
  return map;
}

function buildRow(contract, records, now, offset, indexPrice) {
  const {symbol} = contract;
  const expiry = stamp(contract.expiryDate);
  const strike = positive(contract.strikePrice);
  const side = contract.side;
  if (contract.underlying !== "BTCUSDT" || contract.status !== "TRADING" || expiry === null ||
      expiry <= now + offset || strike === null || side !== (symbol.endsWith("-P") ? "PUT" : "CALL")) return null;
  const lots = (Array.isArray(contract.filters) ? contract.filters : []).filter(item => item?.filterType === "LOT_SIZE");
  const lot = lots.length === 1 ? lots[0] : {};
  const priceFilters = (Array.isArray(contract.filters) ? contract.filters : []).filter(item => item?.filterType === "PRICE_FILTER");
  const ticker = records.tickers.get(symbol);
  const restMark = records.marks.get(symbol);
  const event = records.stream.get(symbol);
  const eventTime = stamp(event?.E);
  const streamAt = records.streamAt;
  const fromStream = event?.e === "markPrice" && sourceFresh(eventTime, streamAt, now, offset, STREAM_AGE);
  const row = {
    symbol, side, expiry_ms: expiry, expiry_beijing: records.dates.get(expiry) ?? beijing(expiry),
    days_to_expiry: (expiry - now - offset) / 86_400_000, strike_price: strike,
    otm_pct: indexPrice === null ? null : (side === "PUT" ? 1 - Number(strike) / Number(indexPrice) : Number(strike) / Number(indexPrice) - 1) * 100,
    unit: positive(contract.unit), min_qty: positive(lot.minQty) ?? positive(contract.minQty),
    max_qty: positive(lot.maxQty), quantity_step: positive(lot.stepSize),
    tick_size: priceFilters.length === 1 ? positive(priceFilters[0].tickSize) : null,
    status: contract.status, quote_asset: contract.quoteAsset === "USDT" ? "USDT" : null,
    price_scale: Number.isInteger(contract.priceScale) ? contract.priceScale : null,
    quantity_scale: Number.isInteger(contract.quantityScale) ? contract.quantityScale : null,
    last_trade_beijing: stamp(ticker?.closeTime) === null ? null : beijing(stamp(ticker.closeTime)),
    field_updated_at: {}, field_event_ms: {}, field_source: {},
    quote_group_valid: false, quote_verification: null, quote_verified_at: null,
  };
  records.dates.set(expiry, row.expiry_beijing);
  for (const [wire, field] of RULE_FIELDS) row[field] = decimal(contract[wire], 0);
  const streamQuote = fromStream && [decimal(event.bo, 0), decimal(event.ao, 0), decimal(event.bq, 0), decimal(event.aq, 0)];
  if (streamQuote && bookIsValid(streamQuote)) {
    selectFields(row, event, QUOTE_FIELDS, "quote", streamAt, "websocket", eventTime, {bo: 0, ao: 0, bq: 0, aq: 0});
    row.quote_group_valid = true;
  } else {
    selectFields(row, ticker, PRICE_FIELDS, "quote", records.tickerAt, "rest", null, {bidPrice: 0, askPrice: 0});
    row.bid_quantity = null;
    row.ask_quantity = null;
  }
  const streamMark = fromStream && decimal(event.mp, 0) !== null && positive(event.vo) !== null;
  selectFields(row, streamMark ? event : restMark, streamMark ? STREAM_MARK_FIELDS : REST_MARK_FIELDS,
    "mark", streamMark ? streamAt : records.markAt, streamMark ? "websocket" : "rest",
    streamMark ? eventTime : null, {mp: 0, vo: 0, b: 0, a: 0, markPrice: 0, markIV: 0, bidIV: 0, askIV: 0});
  selectFields(row, ticker, TICKER_FIELDS, "ticker", records.tickerAt, "rest", null, {lastPrice: 0, volume: 0, amount: 0});
  row.has_mark = row.mark_price !== null;
  row.has_ticker = !!ticker;
  return row;
}

function health(rows, fields, now, offset, failure) {
  let fresh = 0, present = 0, streamCount = 0, oldest = null;
  for (const row of rows) {
    for (const field of fields) {
      const received = row.field_updated_at[field];
      if (row[field] === null || !received) continue;
      present++;
      const fromStream = row.field_source[field] === "websocket";
      const event = row.field_event_ms[field];
      const limit = fromStream ? STREAM_AGE : REST_AGE;
      if (now - received <= limit && (!event || sourceFresh(event, received, now, offset, limit))) {
        fresh++;
        if (fromStream) streamCount++;
      }
      oldest = oldest === null ? received : Math.min(oldest, received);
    }
  }
  const total = rows.length * fields.length;
  const status = !present ? "unavailable" : !fresh ? "stale" : fresh < total ? "partial" : streamCount === total ? "live" : "fresh";
  return {status, source: streamCount === total && total ? "websocket" : streamCount ? "mixed" : present ? "rest" : null,
    oldest_at: oldest, total_fields: total, fresh_fields: fresh, missing_fields: total - present,
    rest_refresh_failed: Boolean(failure)};
}

function indexFrom(stream, rest, now, offset) {
  let best = null;
  for (const row of stream?.data ?? []) {
    const price = positive(row?.i), event = stamp(row?.E);
    if (row?.e !== "markPrice" || !SYMBOL.test(row.s) || price === null ||
        !sourceFresh(event, stream.at, now, offset, STREAM_AGE) || best && event <= best.event) continue;
    best = {price, event, at: stream.at, source: "websocket"};
  }
  const price = positive(rest?.data?.indexPrice), event = stamp(rest?.data?.time);
  if (price !== null && event !== null && event <= rest.at + offset + MAX_SKEW && (!best || event > best.event)) {
    best = {price, event, at: rest.at, source: "rest"};
  }
  return best;
}

function invalidMarket(message) {
  return {options: [], stale: true, status: "UNAVAILABLE", error: {message}};
}

/**
 * Portable edge handler. Pass an injected transport when testing. Cloudflare's
 * Cache API shares bounded endpoint snapshots within each edge location.
 */
export function createMarketHandler({
  fetcher = (...args) => fetch(...args),
  openSocket = url => new WebSocket(url),
  now = () => Date.now(),
  cache = globalThis.caches?.default,
} = {}) {
  const memory = new Map();
  const attempts = [];
  const streamAttempts = [];
  let embargo = 0;
  let marketResponse = null;

  function remember(key, entry) {
    memory.delete(key);
    memory.set(key, entry);
    if (memory.size > 128) memory.delete(memory.keys().next().value);
  }

  async function cacheRead(key, url) {
    const prior = memory.get(key);
    if (prior && (now() < prior.next || !cache)) return prior;
    try {
      const response = await cache?.match(url);
      const other = response ? await response.json() : null;
      if (other && typeof other.next === "number" && (!prior || other.next > prior.next)) {
        remember(key, other);
        return other;
      }
    } catch {}
    return prior;
  }

  async function cacheSave(key, url, value) {
    remember(key, value);
    try {
      await cache?.put(url, Response.json(value, {headers: {"Cache-Control": "public, max-age=1200"}}));
    } catch {}
  }

  async function take(origin, key, ttl, collect) {
    const url = new URL("/.btc-options-cache/v1/" + key, origin).href;
    const prior = await cacheRead(key, url);
    if (prior && now() < prior.next) return prior;
    let value;
    try {
      const result = await collect();
      value = {...result, error: null, next: result.at + ttl};
    } catch (cause) {
      const error = cause instanceof MarketError ? cause : new MarketError("unavailable");
      const at = prior?.at ?? 0;
      value = {data: now() - at <= MAX_CACHE_AGE ? prior?.data ?? null : null, at,
        next: now() + error.wait, error: {message: error.message, http_status: error.status, code: error.code}};
    }
    await cacheSave(key, url, value);
    return value;
  }

  async function upstream(path, weight, validate) {
    const began = now();
    while (attempts.length && attempts[0][0] <= began - 60_000) attempts.shift();
    if (began < embargo) throw new MarketError("rate_limited", null, embargo - began);
    if (attempts.reduce((sum, [, used]) => sum + used, 0) + weight > 280) throw new MarketError("busy");
    attempts.push([began, weight]);
    const response = await fetcher(API + path, {method: "GET", redirect: "error",
      headers: {Accept: "application/json"}, signal: AbortSignal.timeout(2700)});
    if (response.status === 429 || response.status === 418) {
      const wait = retryDelay(response.headers.get("retry-after"), response.status, now());
      embargo = Math.max(embargo, now() + wait);
      await response.body?.cancel().catch(() => {});
      throw new MarketError("rate_limited", response.status, wait);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 451) throw new MarketError("restricted", 451, 60_000);
      throw new MarketError("unavailable", response.status);
    }
    const data = await boundedJson(response);
    if (!validate(data)) throw new MarketError("invalid");
    return {data, at: now(), offset: stamp(data?.serverTime) === null ? null :
      Math.round(Number(data.serverTime) - (began + now()) / 2)};
  }

  function sampleStream() {
    const began = now();
    while (streamAttempts.length && streamAttempts[0] <= began - 60_000) streamAttempts.shift();
    if (streamAttempts.length >= 12) throw new MarketError("busy");
    streamAttempts.push(began);
    return readStream(openSocket, now);
  }

  async function readMarket(origin) {
    // One lightweight full-chain sample carries bid/ask sizes. The REST ticker
    // has prices but no sizes, so it cannot certify executable depth.
    const [catalog, ticker, stream] = await Promise.all([
      take(origin, "catalog", 300_000, () => upstream("exchangeInfo", 1, data =>
        validateArray(data?.optionSymbols) && data.optionSymbols.some(row => row.underlying === "BTCUSDT"))),
      take(origin, "ticker", 15_000, () => upstream("ticker", 40, validateArray)),
      take(origin, "stream", 10_000, sampleStream),
    ]);
    const probeNow = now();
    const offset = Number.isFinite(catalog.offset) && Math.abs(catalog.offset) <= 120_000 ? catalog.offset : 0;
    const readyStream = stream.data?.some(row => row?.e === "markPrice" && SYMBOL.test(row.s) &&
      positive(row.i) !== null && sourceFresh(stamp(row.E), stream.at, probeNow, offset, STREAM_AGE));
    const [restIndex, restMark] = readyStream ? [null, null] : await Promise.all([
      take(origin, "index", 10_000, () => upstream("index?underlying=BTCUSDT", 1, data => positive(data?.indexPrice) !== null && stamp(data?.time) !== null)),
      take(origin, "mark", 10_000, () => upstream("mark", 5, validateArray)),
    ]);
    const current = now();
    const usable = entry => entry?.data && current - entry.at <= MAX_CACHE_AGE ? entry : null;
    const index = indexFrom(usable(stream), usable(restIndex), current, offset);
    const rules = uniqueRows(usable(catalog)?.data.optionSymbols, "symbol");
    const records = {dates: new Map(), tickers: uniqueRows(usable(ticker)?.data, "symbol"), tickerAt: ticker.at,
      stream: uniqueRows(usable(stream)?.data, "s"), streamAt: stream.at,
      marks: uniqueRows(usable(restMark)?.data, "symbol"), markAt: restMark?.at ?? 0};
    const rows = [];
    for (const contract of rules.values()) {
      const row = buildRow(contract, records, current, offset, index?.price ?? null);
      if (row) rows.push(row);
    }
    rows.sort((a, b) => a.expiry_ms - b.expiry_ms || Number(a.strike_price) - Number(b.strike_price) || a.side.localeCompare(b.side));
    const quoteHealth = health(rows, BOOK_FIELDS, current, offset, ticker.error && !readyStream);
    const markHealth = health(rows, MARK_HEALTH_FIELDS, current, offset, restMark?.error);
    const tickerHealth = health(rows, TICKER_HEALTH_FIELDS, current, offset, ticker.error);
    const indexFresh = index && sourceFresh(index.event, index.at, current, offset, index.source === "websocket" ? STREAM_AGE : REST_AGE);
    const freshCatalog = usable(catalog) && current - catalog.at <= 360_000;
    const failed = {};
    for (const [name, entry] of Object.entries({exchange_info: catalog, ticker, index: restIndex, mark: restMark})) {
      if (entry?.error) failed[name] = entry.error;
    }
    const received = Math.max(catalog.at, ticker.at, stream.at, restIndex?.at ?? 0, restMark?.at ?? 0);
    const isCurrent = [quoteHealth.status, markHealth.status].every(status => status === "live" || status === "fresh") && indexFresh && freshCatalog;
    const message = Object.values(failed).find(error => error.code === "restricted")?.message
      ?? (!rows.length || !index ? "币安公开行情暂不可用。" : "部分币安公开行情刷新失败。");
    const snapshot = {
      options: rows, status: rows.length && index ? isCurrent ? "SUCCESS" : "PARTIAL" : "UNAVAILABLE",
      stale: !isCurrent, error: Object.keys(failed).length || !rows.length || !index ? {message, failed_endpoints: failed} : null,
      source: "binance_public_api", fetched_at: received ? beijing(received) : null,
      btc_index_price: index?.price ?? null, btc_contracts_total: rows.length, selected_contracts: rows.length,
      server_now_ms: current + offset, snapshot_served_at_ms: current, exchange_clock_offset_ms: offset,
      index_updated_at: index?.at ?? null, index_event_ms: index?.event ?? null, index_source: index?.source ?? null,
      catalog_updated_at: catalog.at ? beijing(catalog.at) : null,
      data_health: {quote: quoteHealth, mark: markHealth, ticker: tickerHealth,
        index: {status: indexFresh ? index.source === "websocket" ? "live" : "fresh" : index ? "stale" : "unavailable",
          rest_refresh_failed: Boolean(restIndex?.error)},
        catalog: {status: freshCatalog ? "fresh" : rows.length ? "stale" : "unavailable",
          last_verified_at: catalog.at || null, rest_refresh_failed: Boolean(catalog.error)}},
      realtime: {transport: "snapshot", connected: false, last_message_at: readyStream ? stream.at : null},
    };
    const indexDeadline = indexFresh ? index.event - offset + (index.source === "websocket" ? STREAM_AGE : REST_AGE) : Infinity;
    const next = Math.min(catalog.next, ticker.next, stream.next, restIndex?.next ?? Infinity,
      restMark?.next ?? Infinity, indexDeadline, isCurrent ? current + 10_000 : current + 2_000,
      (rows[0]?.expiry_ms ?? Infinity) - offset);
    return {snapshot, next};
  }

  return async function handleMarket(request) {
    const url = new URL(request.url);
    if (!ROUTES.has(url.pathname)) return null;
    if (request.method !== "GET") return new Response(null, {status: 405, headers: {Allow: "GET", "Cache-Control": "no-store"}});
    let symbols = [];
    if (url.pathname === "/api/market") {
      if (url.search && url.search !== "?refresh=1") return json({error: "行情参数无效。"}, 400);
    } else {
      const params = [...url.searchParams];
      if (params.length !== 1 || params[0][0] !== "symbols") return json({error: "请提供 1 至 8 个 BTC 期权合约。"}, 400);
      symbols = params[0][1].split(",");
      if (!symbols.length || symbols.length > 8 || symbols.some(symbol => !SYMBOL.test(symbol))) {
        return json({error: "请提供 1 至 8 个 BTC 期权合约。"}, 400);
      }
      symbols = [...new Set(symbols)];
    }
    try {
      if (url.pathname === "/api/market" && marketResponse && now() < marketResponse.next) {
        const current = now();
        // Hot-path readers share an immutable serialized frame without a second
        // full-chain map or JSON encoding. Each response still shows its own clock.
        return new Response(`{"server_now_ms":${current + marketResponse.offset},"snapshot_served_at_ms":${current},${marketResponse.tail}`,
          {headers: JSON_HEADERS});
      }
      const {snapshot, next} = await readMarket(url.origin);
      if (url.pathname === "/api/market") {
        const {server_now_ms, snapshot_served_at_ms, ...body} = snapshot;
        const tail = JSON.stringify(body).slice(1);
        marketResponse = {next, offset: snapshot.exchange_clock_offset_ms, tail};
        return new Response(`{"server_now_ms":${server_now_ms},"snapshot_served_at_ms":${snapshot_served_at_ms},${tail}`,
          {headers: JSON_HEADERS});
      }
      if (!snapshot.options.length) return json({error: snapshot.error?.message ?? MESSAGES.unavailable}, 503);
      const bySymbol = new Map(snapshot.options.map(row => [row.symbol, row]));
      if (symbols.some(symbol => !bySymbol.has(symbol))) return json({error: "只能读取当前目录中尚未到期的 BTC 期权。"}, 400);
      if (url.pathname === "/api/mark-watch") return json({accepted: symbols.length});
      const options = [];
      for (let start = 0; start < symbols.length; start += 4) {
        const group = await Promise.all(symbols.slice(start, start + 4).map(async symbol => {
          const row = bySymbol.get(symbol);
          if (row.quote_group_valid && now() - row.quote_updated_at <= STREAM_AGE) return row;
          const depth = await take(url.origin, "depth/" + symbol, 15_000,
            () => upstream("depth?symbol=" + encodeURIComponent(symbol) + "&limit=10", 1, depthBook));
          const book = depthBook(depth.data);
          const event = stamp(depth.data?.T);
          if (!book || !sourceFresh(event, depth.at, now(), snapshot.exchange_clock_offset_ms, REST_AGE)) return row;
          selectFields(row, book, DEPTH_FIELDS,
            "quote", depth.at, "rest", event, {bid: 0, ask: 0, bidSize: 0, askSize: 0});
          row.quote_group_valid = true;
          return row;
        }));
        options.push(...group);
      }
      return json({...snapshot, options, selected_contracts: options.length});
    } catch {
      return json(url.pathname === "/api/market" ? invalidMarket(MESSAGES.unavailable) : {error: MESSAGES.unavailable},
        url.pathname === "/api/market" ? 200 : 503);
    }
  };
}

export const handleMarket = createMarketHandler();
