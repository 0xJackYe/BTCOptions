import test from "node:test";
import assert from "node:assert/strict";
import {createMarketHandler} from "../worker-market.mjs";

const BASE = "https://btcoptions.example";
const PUT = "BTC-261225-70000-P";
const CALL = "BTC-261225-85000-C";
const NOW = Date.UTC(2026, 10, 7, 8);
const EXPIRY = Date.UTC(2026, 11, 25, 8);

function contract(symbol, overrides = {}) {
  return {
    symbol, underlying: "BTCUSDT", status: "TRADING", expiryDate: EXPIRY, unit: 1,
    side: symbol.endsWith("-P") ? "PUT" : "CALL", strikePrice: symbol.split("-")[2],
    quoteAsset: "USDT", minQty: "0.01", priceScale: 3, quantityScale: 2,
    filters: [{filterType: "LOT_SIZE", minQty: "0.01", maxQty: "200", stepSize: "0.01"},
      {filterType: "PRICE_FILTER", tickSize: "5.000"}],
    initialMargin: "0.15", maintenanceMargin: "0.075", minInitialMargin: "0.10",
    minMaintenanceMargin: "0.05", liquidationFeeRate: "0.0019", ...overrides,
  };
}

function fixture({
  transport = "websocket", cache = null, override = {}, frame = rows => rows, offset = 0,
} = {}) {
  let now = NOW;
  const calls = [];
  const methods = {
    exchangeInfo: () => Response.json({serverTime: now + offset, optionSymbols: [contract(PUT), contract(CALL),
      contract("ETH-261225-4000-P", {underlying: "ETHUSDT"}),
      contract("BTC-261106-50000-P", {expiryDate: NOW - 1}),
      contract("BTC-261225-95000-C", {status: "SETTLING"})]}),
    ticker: () => Response.json([PUT, CALL].map(symbol => ({symbol, bidPrice: "95", askPrice: "125",
      lastPrice: "105", volume: "1.5", amount: "157.5", closeTime: now - 3_600_000 + offset}))),
    index: () => Response.json({indexPrice: "75020.55", time: now + offset - 500}),
    mark: () => Response.json([PUT, CALL].map(symbol => ({symbol, markPrice: "110", markIV: "0.58",
      delta: "0.2", gamma: "0.0001", theta: "-2", vega: "3"}))),
    depth: () => Response.json({T: now + offset - 10, bids: [["110", "2.50"]], asks: [["115", "1.25"]]}),
    ...override,
  };
  const fetcher = async (raw, options) => {
    const url = new URL(raw);
    assert.equal(url.origin, "https://eapi.binance.com");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(new Headers(options.headers).has("X-MBX-APIKEY"), false);
    const key = url.pathname.split("/").at(-1);
    calls.push([key, url.search]);
    return methods[key](url, now);
  };
  const openSocket = url => {
    assert.equal(url, "wss://fstream.binance.com/market/stream?streams=btcusdt@optionMarkPrice");
    calls.push(["stream", ""]);
    const socket = new EventTarget();
    socket.close = () => {};
    queueMicrotask(() => {
      if (transport === "rest") return socket.dispatchEvent(new Event("error"));
      const data = frame([PUT, CALL].map(symbol => ({s: symbol, e: "markPrice", E: now + offset - 50,
        i: "75010.01", bo: "100", ao: "120", bq: "2", aq: "3", mp: "108", vo: "0.55",
        d: "0.2", g: "0.0001", t: "-1", v: "3", b: "0.5", a: "0.6"})));
      socket.dispatchEvent(new MessageEvent("message", {data: JSON.stringify({stream: "btcusdt@optionMarkPrice", data})}));
    });
    return socket;
  };
  const handler = createMarketHandler({fetcher, openSocket, now: () => now, cache});
  return {calls, setTime: value => {now = value;},
    get: (path = "/api/market", options) => handler(new Request(BASE + path, options))};
}

test("projects live bid, ask, sizes, IV, contract rules and distinct trade/source timestamps", async () => {
  const f = fixture({offset: 24_000});
  const response = await f.get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json();
  assert.equal(data.status, "SUCCESS");
  assert.equal(data.btc_index_price, "75010.01");
  assert.equal(data.index_updated_at, NOW);
  assert.equal(data.index_event_ms, NOW + 23_950);
  assert.equal(data.exchange_clock_offset_ms, 24_000);
  assert.equal(data.snapshot_served_at_ms, NOW);
  assert.equal(data.server_now_ms, NOW + 24_000);
  assert.equal(data.data_health.quote.status, "live");
  assert.equal(data.data_health.ticker.status, "fresh");
  assert.equal(data.error, null);
  assert.deepEqual(data.options.map(row => row.symbol), [PUT, CALL]);
  const row = data.options[0];
  assert.equal(row.bid_price, "100");
  assert.equal(row.ask_price, "120");
  assert.equal(row.bid_quantity, "2");
  assert.equal(row.ask_quantity, "3");
  assert.equal(row.quote_group_valid, true);
  assert.equal(row.quote_verification, null);
  assert.equal(row.mark_iv, "0.55");
  assert.equal(row.quantity_step, "0.01");
  assert.equal(row.tick_size, "5.000");
  assert.equal(row.min_maintenance_margin_rate, "0.05");
  assert.equal(row.field_updated_at.bid_quantity, NOW);
  assert.equal(row.field_event_ms.bid_quantity, NOW + 23_950);
  assert.equal(row.field_event_ms.volume_24h_contracts, null);
  assert.ok(Date.parse(row.last_trade_beijing) < row.quote_event_ms);
  assert.deepEqual(f.calls.map(([name]) => name).sort(), ["exchangeInfo", "stream", "ticker"]);
});

test("shares market snapshots through the edge cache and preserves the original receipt", async () => {
  const entries = new Map();
  const cache = {
    match: url => entries.get(String(url))?.clone(),
    put: (url, response) => entries.set(String(url), response.clone()),
  };
  const first = fixture({cache});
  await first.get();
  const second = fixture({cache});
  second.setTime(NOW + 8000);
  const data = await (await second.get("/api/market?refresh=1")).json();
  assert.equal(data.snapshot_served_at_ms, NOW + 8000);
  assert.equal(data.options[0].field_updated_at.ask_price, NOW);
  assert.equal(second.calls.length, 0);
  second.setTime(NOW + 11_000);
  const updated = await (await second.get()).json();
  assert.equal(updated.options[0].field_updated_at.ask_price, NOW + 11_000);
  assert.equal(updated.options[0].field_updated_at.volume_24h_contracts, NOW);
  assert.deepEqual(second.calls, [["stream", ""]]);
});

test("REST fallback has reference quotes only; focused read verifies actual book size", async () => {
  const f = fixture({transport: "rest"});
  const data = await (await f.get()).json();
  assert.equal(data.status, "PARTIAL");
  assert.equal(data.stale, true);
  assert.equal(data.btc_index_price, "75020.55");
  assert.equal(data.index_event_ms, NOW - 500);
  assert.equal(data.options[0].bid_price, "95");
  assert.equal(data.options[0].bid_quantity, null);
  assert.equal(data.options[0].quote_group_valid, false);
  assert.equal(data.options[0].field_event_ms.bid_price, null);
  const focus = await (await f.get("/api/focused-market?symbols=" + PUT)).json();
  assert.deepEqual(focus.options.map(row => row.symbol), [PUT]);
  assert.equal(focus.options[0].bid_price, "110");
  assert.equal(focus.options[0].bid_quantity, "2.50");
  assert.equal(focus.options[0].field_event_ms.bid_quantity, NOW - 10);
  assert.equal(focus.options[0].quote_group_valid, true);
  const watch = await (await f.get("/api/mark-watch?symbols=" + PUT)).json();
  assert.deepEqual(watch, {accepted: 1});
  assert.deepEqual(f.calls.filter(([name]) => name === "depth"), [["depth", "?symbol=" + PUT + "&limit=10"]]);
});

test("never certifies a crossed stream, stale depth or out-of-date source index", async () => {
  const f = fixture({
    frame: rows => rows.map(row => ({...row, ao: "10", E: NOW - 45_000})),
    override: {
      index: () => Response.json({indexPrice: "75000", time: NOW - 45_000}),
      depth: () => Response.json({T: NOW - 45_000, bids: [["110", "1"]], asks: [["120", "1"]]}),
    },
  });
  const response = await f.get("/api/focused-market?symbols=" + PUT);
  const data = await response.json();
  assert.equal(data.data_health.index.status, "stale");
  assert.equal(data.stale, true);
  assert.equal(data.options[0].quote_group_valid, false);
  assert.equal(data.options[0].bid_quantity, null);
});

test("rejects an invalid book even with a current event and retains good contracts", async () => {
  const f = fixture({frame: rows => rows.map(row => row.s === PUT ? {...row, ao: "90"} : row)});
  const data = await (await f.get()).json();
  assert.equal(data.data_health.quote.status, "partial");
  assert.equal(data.options[0].quote_group_valid, false);
  assert.equal(data.options[0].bid_price, "95");
  assert.equal(data.options[1].quote_group_valid, true);
});

test("limits symbols to the current catalogue and rejects unsupported input before upstream work", async () => {
  const f = fixture();
  assert.equal(await f.get("/api/anything"), null);
  assert.equal((await f.get("/api/market?debug=1")).status, 400);
  assert.equal((await f.get("/api/market", {method: "POST", body: "payload"})).status, 405);
  assert.equal((await f.get("/api/mark-watch?symbols=ETH-261225-6000-P")).status, 400);
  assert.equal((await f.get("/api/focused-market?symbols=" + Array(9).fill(PUT).join(","))).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.get("/api/focused-market?symbols=BTC-261106-50000-P")).status, 400);
  const focused = await (await f.get("/api/focused-market?symbols=" + CALL + "," + CALL)).json();
  assert.equal(focused.options.length, 1);
  assert.equal(f.calls.some(([name]) => name === "depth"), false);
});

test("respects Binance rate limits, and exposes a sanitised geographic restriction", async () => {
  const limited = fixture({transport: "rest", override: {
    exchangeInfo: () => new Response("sensitive upstream message", {status: 429, headers: {"Retry-After": "60"}}),
  }});
  const data = await (await limited.get()).json();
  assert.equal(data.status, "UNAVAILABLE");
  assert.equal(data.error.failed_endpoints.exchange_info.code, "rate_limited");
  assert.equal(JSON.stringify(data).includes("sensitive upstream message"), false);
  assert.equal(limited.calls.some(([name]) => name === "mark" || name === "index"), false);
  const blocked = fixture({transport: "rest", override: {
    exchangeInfo: () => new Response(null, {status: 451}),
  }});
  const denied = await (await blocked.get()).json();
  assert.equal(denied.error.failed_endpoints.exchange_info.http_status, 451);
  assert.match(denied.error.message, /限制/);
});

test("does not invent values or new observation times during a provider outage", async () => {
  const f = fixture({transport: "rest", override: {
    index: (_url, time) => time === NOW
      ? Response.json({indexPrice: "75000", time: NOW})
      : new Response("upstream error", {status: 502}),
    mark: (_url, time) => time === NOW
      ? Response.json([{symbol: PUT, markPrice: "101", markIV: "0.55", delta: "-0.1"}])
      : new Response("upstream error", {status: 502}),
  }});
  await f.get();
  f.setTime(NOW + 40_000);
  const data = await (await f.get()).json();
  assert.equal(data.index_event_ms, NOW);
  assert.equal(data.index_updated_at, NOW);
  assert.equal(data.data_health.index.status, "stale");
  assert.equal(data.options[0].mark_updated_at, NOW);
  assert.equal(data.options[1].mark_iv, null);
  assert.equal(data.data_health.mark.rest_refresh_failed, true);
});
