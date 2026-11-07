"use strict";

(() => {
  const MARK_STREAM = "btcusdt@optionMarkPrice";
  const INDEX_STREAM = "btcusdt@optionIndexPrice";
  const URL = `wss://fstream.binance.com/market/stream?streams=${MARK_STREAM}/${INDEX_STREAM}`;
  const SYMBOL = /^BTC-(\d{2})(\d{2})(\d{2})-(\d{1,12}(?:\.\d{1,4})?)-([CP])$/;
  const QUOTE_FIELDS = {bo: "bid_price", ao: "ask_price", bq: "bid_quantity", aq: "ask_quantity"};
  const MARK_FIELDS = {mp: "mark_price", vo: "mark_iv", b: "bid_iv", a: "ask_iv", d: "delta", g: "gamma", t: "theta", v: "vega"};
  const CORE_MARK_FIELDS = ["mark_price", "mark_iv", "delta", "gamma", "theta", "vega"];
  const MAX_FRAME = 4 * 1024 * 1024;
  const MAX_ROWS = 4000;
  const MAX_AGE = 20_000;
  const FUTURE_SKEW = 5_000;

  function decimal(value, minimum = -Infinity) {
    if (typeof value !== "number" && (typeof value !== "string" || value.length > 48 ||
        !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value))) return null;
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= minimum ? String(value) : null;
  }

  function currentEvent(value, received, offset = 0) {
    const time = typeof value === "string" && /^\d{13}$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(time) && time >= received + offset - MAX_AGE && time <= received + offset + FUTURE_SKEW ? time : null;
  }

  function beijing(time) {
    return new Date(time + 28_800_000).toISOString().replace("Z", "+08:00");
  }

  function readSymbol(symbol, now) {
    const match = typeof symbol === "string" && SYMBOL.exec(symbol);
    if (!match || Number(match[4]) <= 0) return null;
    const [, year, month, day, strike, suffix] = match;
    // The public symbol encodes the expiry day. Binance BTC options use 08:00 UTC.
    // Exchange status and trading rules still require a separate catalog read.
    const expiry = Date.UTC(2000 + Number(year), Number(month) - 1, Number(day), 8);
    if (expiry <= now || !new Date(expiry).toISOString().startsWith(`20${year}-${month}-${day}T`)) return null;
    return {symbol, expiry_ms: expiry, expiry_beijing: beijing(expiry), expiry_inferred: true,
      strike_price: strike, side: suffix === "P" ? "PUT" : "CALL"};
  }

  function consistentSide(price, size) {
    return price !== null && size !== null && (Number(price) > 0) === (Number(size) > 0);
  }

  function writeGroup(row, group, fields, values, event, received) {
    let present = false;
    for (const field of Object.values(fields)) {
      row[field] = values[field];
      if (values[field] === null) continue;
      present = true;
      row.field_updated_at[field] = received;
      row.field_event_ms[field] = event;
      row.field_source[field] = "websocket";
    }
    row[`${group}_updated_at`] = present ? received : null;
    row[`${group}_event_ms`] = present ? event : null;
    row[`${group}_source`] = present ? "websocket" : null;
  }

  function buildRow(contract, wire, event, received) {
    const row = {...contract, status: null, rules_verified: false, quote_asset: null,
      unit: null, min_qty: null, max_qty: null, quantity_step: null, tick_size: null, price_scale: null,
      quantity_scale: null, initial_margin_rate: null, maintenance_margin_rate: null,
      min_initial_margin_rate: null, min_maintenance_margin_rate: null, liquidation_fee_rate: null,
      last_price: null, last_trade_beijing: null, volume_24h_contracts: null, amount_24h_quote: null,
      has_ticker: false, ticker_source: null, ticker_updated_at: null, ticker_event_ms: null,
      quote_verification: null, quote_verified_at: null, field_updated_at: {}, field_event_ms: {}, field_source: {}};
    const quote = Object.fromEntries(Object.entries(QUOTE_FIELDS).map(([key, field]) => [field, decimal(wire[key], 0)]));
    const bidValid = consistentSide(quote.bid_price, quote.bid_quantity);
    const askValid = consistentSide(quote.ask_price, quote.ask_quantity);
    const crossed = Number(quote.bid_price) > Number(quote.ask_price) && Number(quote.ask_price) > 0;
    if (crossed || !bidValid) quote.bid_price = quote.bid_quantity = null;
    if (crossed || !askValid) quote.ask_price = quote.ask_quantity = null;
    writeGroup(row, "quote", QUOTE_FIELDS, quote, event, received);
    row.quote_group_valid = bidValid && askValid && !crossed;
    const mark = Object.fromEntries(Object.entries(MARK_FIELDS).map(([key, field]) =>
      [field, decimal(wire[key], ["mp", "vo", "b", "a"].includes(key) ? 0 : -Infinity)]));
    writeGroup(row, "mark", MARK_FIELDS, mark, event, received);
    row.has_mark = row.mark_price !== null;
    return row;
  }

  function groupHealth(rows, fields, now, offset) {
    let present = 0, fresh = 0, oldest = null;
    for (const row of rows) {
      for (const field of fields) {
        const time = row.field_updated_at[field];
        if (!time) continue;
        present++;
        if (now - time <= MAX_AGE && currentEvent(row.field_event_ms[field], now, offset) !== null) fresh++;
        oldest = oldest === null ? time : Math.min(time, oldest);
      }
    }
    const total = rows.length * fields.length;
    return {status: !present ? "unavailable" : !fresh ? "stale" : fresh < total ? "partial" : "live",
      source: present ? "websocket" : null, oldest_at: oldest, total_fields: total,
      fresh_fields: fresh, missing_fields: total - present, rest_refresh_failed: false};
  }

  function connect(onSnapshot, onError) {
    if (typeof onSnapshot !== "function" || typeof onError !== "function") throw new TypeError("Market callbacks are required");
    const rows = new Map();
    let socket, timer, index, clockOffset = null, closed = false;

    function close() {
      if (closed) return;
      closed = true;
      window.clearTimeout(timer);
      if (socket) {
        socket.onmessage = socket.onerror = socket.onclose = null;
        socket.close();
      }
    }

    function fail(message) {
      if (closed) return;
      close();
      onError(new Error(message));
    }

    function watch(delay) {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fail("暂未收到币安直连行情，请检查网络和系统时间。"), delay);
    }

    function observeEvent(value, received) {
      const event = typeof value === "string" && /^\d{13}$/.test(value) ? Number(value) : value;
      if (!Number.isSafeInteger(event)) return null;
      if (clockOffset === null) {
        if (Math.abs(event - received) > 120_000) return null;
        // Anchor this connection to its first event and preserve original source
        // times. Age checks then tolerate a bounded Windows clock offset.
        clockOffset = event - received;
      }
      return currentEvent(event, received, clockOffset);
    }

    function updateIndex(value, event, received) {
      const price = decimal(value, 0);
      if (Number(price) <= 0 || index && event <= index.event) return false;
      index = {price, event, received};
      return true;
    }

    function emit(received) {
      if (!index || !rows.size) return;
      const exchangeNow = received + (clockOffset ?? 0);
      const options = [...rows.values()].filter(row => row.expiry_ms > exchangeNow).map(row => ({...row,
        days_to_expiry: (row.expiry_ms - exchangeNow) / 86_400_000,
        otm_pct: 100 * (row.side === "PUT" ? 1 - Number(row.strike_price) / Number(index.price)
          : Number(row.strike_price) / Number(index.price) - 1)}));
      if (!options.length) return;
      const indexFresh = currentEvent(index.event, received, clockOffset) !== null && received - index.received <= MAX_AGE;
      onSnapshot({browser_direct: true, source: "binance_public_websocket", status: "PARTIAL", stale: true,
        options, btc_contracts_total: options.length, selected_contracts: options.length,
        fetched_at: beijing(received), server_now_ms: exchangeNow, snapshot_served_at_ms: received,
        exchange_clock_offset_ms: clockOffset, error: null,
        btc_index_price: index.price, index_updated_at: index.received, index_event_ms: index.event,
        index_source: "websocket", catalog_updated_at: null,
        data_health: {quote: groupHealth(options, Object.values(QUOTE_FIELDS), received, clockOffset),
          mark: groupHealth(options, CORE_MARK_FIELDS, received, clockOffset),
          index: {status: indexFresh ? "live" : "stale", rest_refresh_failed: false},
          catalog: {status: "unavailable", last_verified_at: null, rest_refresh_failed: false},
          ticker: {status: "unavailable", rest_refresh_failed: false}},
        realtime: {transport: "websocket", connected: true, last_message_at: received}});
    }

    try {socket = new window.WebSocket(URL);}
    catch {
      window.queueMicrotask(() => fail("浏览器无法连接币安公开行情。"));
      return {close};
    }
    socket.onerror = () => fail("浏览器无法连接币安公开行情。");
    socket.onclose = () => fail("币安公开行情连接已断开。");
    socket.onmessage = event => {
      if (closed || typeof event.data !== "string" || event.data.length > MAX_FRAME) return;
      let frame;
      try {frame = JSON.parse(event.data);} catch {return;}
      const received = Date.now();
      if (frame?.stream === INDEX_STREAM) {
        const wire = frame.data;
        if (wire?.e !== "indexPrice" || wire.s !== "BTCUSDT" || !(Number(decimal(wire.p, 0)) > 0)) return;
        const time = observeEvent(wire.E, received);
        if (time !== null && updateIndex(wire.p, time, received)) emit(received);
        return;
      }
      if (frame?.stream !== MARK_STREAM || !Array.isArray(frame.data) || frame.data.length > MAX_ROWS) return;
      for (const [symbol, row] of rows) if (row.expiry_ms <= received + (clockOffset ?? 0)) rows.delete(symbol);
      let accepted = false;
      for (const wire of frame.data) {
        if (wire?.e !== "markPrice") continue;
        const contract = readSymbol(wire.s, received + (clockOffset ?? 0));
        if (!contract) continue;
        const time = observeEvent(wire.E, received);
        if (time === null) continue;
        const old = rows.get(contract.symbol);
        if (old ? time <= old.time : rows.size >= MAX_ROWS) continue;
        const row = buildRow(contract, wire, time, received);
        if (!row.has_mark && row.quote_source === null) continue;
        rows.set(contract.symbol, {...row, time});
        updateIndex(wire.i, time, received);
        accepted = true;
      }
      if (accepted) {
        watch(25_000);
        emit(received);
      }
    };
    watch(12_000);
    return {close};
  }

  window.BTCOptionsBrowserMarket = Object.freeze({connect});
})();
