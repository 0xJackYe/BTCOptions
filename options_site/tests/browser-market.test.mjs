import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";

const source = await readFile(new URL("../browser-market.js", import.meta.url), "utf8");
const NOW = Date.UTC(2026, 10, 7, 8);
const PUT = "BTC-261225-70000-P";
const CALL = "BTC-261225-85000-C";
const MARK = "btcusdt@optionMarkPrice";
const INDEX = "btcusdt@optionIndexPrice";

function wire(overrides = {}) {
  return {e: "markPrice", s: PUT, E: NOW, i: "75000.5", bo: "100", ao: "120",
    bq: "2.50", aq: "3.50", mp: "110", vo: "0.55", b: "0.5", a: "0.6",
    d: "-0.15", g: "0.000015", t: "-1.5", v: "3.1", ...overrides};
}

function fixture({throws = false} = {}) {
  let now = NOW;
  let nextTimer = 0;
  const timers = new Map(), sockets = [], snapshots = [], errors = [], microtasks = [];
  class Clock extends Date {
    constructor(...args) {super(...(args.length ? args : [now]));}
    static now() {return now;}
  }
  class Socket {
    constructor(url) {
      if (throws) throw new Error("provider failure");
      this.url = url;
      this.closed = 0;
      sockets.push(this);
    }
    close() {this.closed++;}
  }
  const window = {
    WebSocket: Socket,
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, {callback, delay});
      return id;
    },
    clearTimeout: id => timers.delete(id),
    queueMicrotask: callback => microtasks.push(callback),
  };
  runInNewContext(source, {window, Date: Clock});
  const api = window.BTCOptionsBrowserMarket;
  const connection = api.connect(snapshot => snapshots.push(JSON.parse(JSON.stringify(snapshot))), error => errors.push(error));
  return {
    api, connection, sockets, snapshots, errors, timers,
    setTime(value) {now = value;},
    send(rows, stream = MARK) {
      sockets[0].onmessage?.({data: JSON.stringify({stream, data: rows})});
    },
    raw(data) {sockets[0].onmessage?.({data});},
    expire() {
      assert.equal(timers.size, 1);
      const [{callback}] = timers.values();
      callback();
    },
    flushMicrotasks() {while (microtasks.length) microtasks.shift()();},
    timerDelay() {return [...timers.values()][0]?.delay;},
  };
}

test("fresh option frames expose real prices, sizes, Greeks and original event time", () => {
  const f = fixture();
  assert.equal(f.sockets[0].url,
    "wss://fstream.binance.com/market/stream?streams=btcusdt@optionMarkPrice/btcusdt@optionIndexPrice");
  assert.equal(f.timerDelay(), 12_000);
  f.send([wire({E: NOW - 50}), wire({s: CALL, E: NOW - 30, d: "0.20"})]);
  assert.equal(f.snapshots.length, 1);
  const data = f.snapshots[0], row = data.options.find(option => option.symbol === PUT);
  assert.equal(data.browser_direct, true);
  assert.equal(data.btc_index_price, "75000.5");
  assert.equal(data.index_event_ms, NOW - 30);
  assert.equal(data.index_updated_at, NOW);
  assert.equal(data.snapshot_served_at_ms, NOW);
  assert.equal(data.data_health.quote.status, "live");
  assert.equal(data.data_health.mark.status, "live");
  assert.equal(data.data_health.index.status, "live");
  assert.equal(row.bid_price, "100");
  assert.equal(row.ask_price, "120");
  assert.equal(row.bid_quantity, "2.50");
  assert.equal(row.ask_quantity, "3.50");
  assert.equal(row.delta, "-0.15");
  assert.equal(row.mark_iv, "0.55");
  assert.equal(row.field_updated_at.bid_quantity, NOW);
  assert.equal(row.field_event_ms.bid_quantity, NOW - 50);
  assert.equal(row.field_source.bid_quantity, "websocket");
  assert.equal(row.expiry_ms, Date.UTC(2026, 11, 25, 8));
  assert.equal(data.exchange_clock_offset_ms, -50);
  assert.equal(row.days_to_expiry, (row.expiry_ms - (NOW - 50)) / 86_400_000);
  assert.equal(row.quote_group_valid, true);
  assert.equal(f.timers.size, 1);
  assert.equal(f.timerDelay(), 25_000);
  f.connection.close();
});

test("browser quotes never fabricate a verified catalog, trading rules or 24-hour statistics", () => {
  const f = fixture();
  f.send([wire()]);
  const data = f.snapshots[0], row = data.options[0];
  assert.equal(data.status, "PARTIAL");
  assert.equal(data.stale, true);
  assert.equal(data.catalog_updated_at, null);
  assert.equal(data.data_health.catalog.status, "unavailable");
  assert.equal(data.data_health.ticker.status, "unavailable");
  assert.equal(row.expiry_inferred, true);
  assert.equal(row.rules_verified, false);
  for (const name of ["status", "unit", "quote_asset", "min_qty", "max_qty", "quantity_step", "tick_size",
    "quantity_scale", "initial_margin_rate", "maintenance_margin_rate", "min_initial_margin_rate",
    "min_maintenance_margin_rate", "liquidation_fee_rate", "volume_24h_contracts", "amount_24h_quote",
    "last_price", "last_trade_beijing", "quote_verification", "quote_verified_at"]) {
    assert.equal(row[name], null, name);
  }
  assert.equal(row.has_ticker, false);
  assert.deepEqual(Object.keys(row.field_updated_at).filter(name => name.startsWith("volume")), []);
  f.connection.close();
});

test("malformed, expired and unsupported symbols do not produce rows or renew the timeout", () => {
  const f = fixture();
  const originalTimer = [...f.timers.keys()][0];
  f.raw("{invalid");
  f.raw(new Uint8Array([1, 2]));
  f.raw(" ".repeat(4 * 1024 * 1024 + 1));
  f.send([wire()], "some-other-stream");
  f.send([wire()], INDEX);
  f.send({not: "an array"});
  f.send([wire({s: "ETH-261225-4000-P"}), wire({s: "BTC-261106-70000-P"}),
    wire({s: "BTC-261332-70000-P"}), wire({s: "BTC-270229-70000-P"}),
    wire({s: "BTC-261225-0-P"}), wire({e: "trade"})]);
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.errors.length, 0);
  assert.deepEqual([...f.timers.keys()], [originalTimer]);
  f.connection.close();
});

test("old, future, duplicate and out-of-order events cannot renew quote observations", () => {
  const f = fixture();
  f.send([wire({E: NOW - 120_001}), wire({E: NOW + 120_001}), wire({E: true})]);
  assert.equal(f.snapshots.length, 0);
  f.send([wire({E: String(NOW)})]);
  assert.equal(f.snapshots.length, 1);
  const activeTimer = [...f.timers.keys()][0];
  f.setTime(NOW + 1000);
  f.send([wire({E: NOW - 20_001, bo: "999"}), wire({E: NOW + 6001, bo: "999"}),
    wire({E: NOW - 1, bo: "999"}), wire({E: NOW, bo: "999"})]);
  assert.equal(f.snapshots.length, 1);
  assert.deepEqual([...f.timers.keys()], [activeTimer]);
  f.send([wire({E: NOW + 1000, bo: "105"})]);
  assert.equal(f.snapshots.length, 2);
  assert.equal(f.snapshots[1].options[0].bid_price, "105");
  assert.equal(f.snapshots[1].options[0].field_updated_at.bid_price, NOW + 1000);
  assert.equal(f.snapshots[1].options[0].field_event_ms.bid_price, NOW + 1000);
  f.connection.close();
});

test("calibrates a bounded 24-second browser clock difference without changing source timestamps", () => {
  const f = fixture();
  f.send([wire({E: NOW + 24_000})]);
  assert.equal(f.snapshots.length, 1);
  const data = f.snapshots[0], row = data.options[0];
  assert.equal(data.exchange_clock_offset_ms, 24_000);
  assert.equal(data.server_now_ms, NOW + 24_000);
  assert.equal(data.snapshot_served_at_ms, NOW);
  assert.equal(data.index_event_ms, NOW + 24_000);
  assert.equal(data.index_updated_at, NOW);
  assert.equal(row.field_event_ms.bid_price, NOW + 24_000);
  assert.equal(row.field_updated_at.bid_price, NOW);
  assert.equal(row.days_to_expiry, (row.expiry_ms - NOW - 24_000) / 86_400_000);
  assert.equal(data.data_health.quote.status, "live");
  assert.equal(data.stale, true);
  f.connection.close();

  const beyondLimit = fixture();
  beyondLimit.send([wire({E: NOW + 120_001}), wire({E: NOW - 120_001})]);
  assert.equal(beyondLimit.snapshots.length, 0);
  assert.equal(beyondLimit.timerDelay(), 12_000);
  beyondLimit.connection.close();
});

test("crossed and incomplete books keep unknown depth and cannot become certified", () => {
  const f = fixture();
  f.send([wire({ao: "90"}), wire({s: CALL, bq: "-1", d: "0.2"})]);
  const rows = f.snapshots[0].options;
  assert.equal(rows[0].bid_price, null);
  assert.equal(rows[0].ask_price, null);
  assert.equal(rows[0].bid_quantity, null);
  assert.equal(rows[0].quote_group_valid, false);
  assert.equal(rows[0].quote_updated_at, null);
  assert.equal(rows[0].field_updated_at.bid_price, undefined);
  assert.equal(rows[1].bid_price, null);
  assert.equal(rows[1].bid_quantity, null);
  assert.equal(rows[1].ask_price, "120");
  assert.equal(rows[1].quote_group_valid, false);
  assert.equal(f.snapshots[0].data_health.quote.status, "partial");
  assert.equal(rows[0].mark_price, "110");
  f.connection.close();
});

test("missing prices and Greeks stay unknown while an explicit empty book side stays empty", () => {
  const f = fixture();
  f.send([wire({bo: "0", bq: "0", mp: undefined, vo: undefined, d: undefined,
    g: undefined, t: undefined, v: undefined, b: undefined, a: undefined})]);
  const row = f.snapshots[0].options[0];
  assert.equal(row.bid_price, "0");
  assert.equal(row.bid_quantity, "0");
  assert.equal(row.quote_group_valid, true);
  assert.equal(row.has_mark, false);
  for (const name of ["mark_price", "mark_iv", "delta", "gamma", "theta", "vega"]) {
    assert.equal(row[name], null, name);
    assert.equal(row.field_updated_at[name], undefined, name);
  }
  assert.equal(f.snapshots[0].data_health.mark.status, "unavailable");
  f.connection.close();
});

test("independent index observations preserve quote times and reveal stale option fields", () => {
  const f = fixture();
  f.send([wire()]);
  f.setTime(NOW + 21_000);
  const timer = [...f.timers.keys()][0];
  f.send({e: "indexPrice", s: "BTCUSDT", E: NOW + 21_000, p: "76000"}, INDEX);
  const data = f.snapshots[1];
  assert.equal(data.btc_index_price, "76000");
  assert.equal(data.index_event_ms, NOW + 21_000);
  assert.equal(data.data_health.index.status, "live");
  assert.equal(data.options[0].quote_updated_at, NOW);
  assert.equal(data.options[0].field_event_ms.bid_price, NOW);
  assert.equal(data.data_health.quote.status, "stale");
  assert.equal(data.data_health.mark.status, "stale");
  assert.deepEqual([...f.timers.keys()], [timer]);
  f.send({e: "indexPrice", s: "BTCUSDT", E: NOW + 20_999, p: "999"}, INDEX);
  f.send({e: "indexPrice", s: "ETHUSDT", E: NOW + 21_000, p: "999"}, INDEX);
  f.send({e: "indexPrice", s: "BTCUSDT", E: NOW + 21_001, p: "-1"}, INDEX);
  assert.equal(f.snapshots.length, 2);
  f.connection.close();
});

test("manual close clears timers, closes once and ignores queued callbacks", () => {
  const f = fixture();
  const message = f.sockets[0].onmessage;
  const error = f.sockets[0].onerror;
  const close = f.sockets[0].onclose;
  f.connection.close();
  f.connection.close();
  assert.equal(f.sockets[0].closed, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.sockets[0].onmessage, null);
  assert.equal(f.sockets[0].onerror, null);
  assert.equal(f.sockets[0].onclose, null);
  message({data: JSON.stringify({stream: MARK, data: [wire()]})});
  error();
  close();
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.errors.length, 0);
  assert.equal(f.timers.size, 0);
});

test("timeouts and transport errors report once and release all connection resources", () => {
  const silent = fixture();
  silent.expire();
  assert.equal(silent.errors.length, 1);
  assert.match(silent.errors[0].message, /暂未收到/);
  assert.equal(silent.timers.size, 0);
  assert.equal(silent.sockets[0].closed, 1);
  silent.connection.close();
  assert.equal(silent.errors.length, 1);

  const failed = fixture();
  const close = failed.sockets[0].onclose;
  failed.sockets[0].onerror();
  close();
  assert.equal(failed.errors.length, 1);
  assert.match(failed.errors[0].message, /无法连接/);
  assert.equal(failed.timers.size, 0);
  assert.equal(failed.sockets[0].closed, 1);

  const constructor = fixture({throws: true});
  assert.equal(constructor.errors.length, 0);
  constructor.flushMicrotasks();
  assert.equal(constructor.errors.length, 1);
  assert.equal(constructor.timers.size, 0);
  assert.throws(() => constructor.api.connect(null, () => {}), /callbacks/);
});
