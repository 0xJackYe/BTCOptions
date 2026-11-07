import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {createStrategyHandler, readCredentials} from "../worker-strategy.mjs";
import {createReplayMarket} from "../replay.mjs";
import {relay} from "../worker-relay.mjs";

const origin = "http://127.0.0.1:8767";
const fixture = JSON.parse(readFileSync(new URL("../../analysis/put-20261030/snapshot.json", import.meta.url), "utf8"));
const capturedLocal = fixture.server_now_ms - fixture.exchange_clock_offset_ms;
const KEY = "A".repeat(32) + "b".repeat(32), SECRET = "s3cr3t".repeat(10) + "abcd";
const HOUR = 3_600_000;

function klineRows(count, intervalMs, end, price = 81000) {
  return Array.from({length: count}, (_, i) => {
    const t = end - (count - i) * intervalMs, p = price * (1 + .002 * Math.sin(i));
    return [t, String(p), String(p * 1.003), String(p * .997), String(p), "10", t + intervalMs - 1];
  });
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json", ...headers}});
}

function setup({fetcher, now = () => capturedLocal + 5_000, ...options} = {}) {
  const market = createReplayMarket(fixture, {now});
  const calls = [];
  const handler = createStrategyHandler({
    getMarket: async () => (await market(new Request(origin + "/api/market"))).json(),
    fetcher: async (url, init) => { calls.push({url: String(url), init}); return fetcher(String(url), init); },
    now, ...options,
  });
  return {handler, calls};
}

const spotFetcher = (url) => {
  const end = fixture.server_now_ms;
  if (url.includes("interval=1h")) return jsonResponse(klineRows(240, HOUR, end));
  if (url.includes("interval=1d")) return jsonResponse(klineRows(120, 24 * HOUR, end));
  return jsonResponse({}, 404);
};

const get = (handler, path, headers = {}) => handler(new Request(origin + path, {headers}));

test("credentials are read strictly from the environment", () => {
  assert.deepEqual(readCredentials({}), {configured: false, reason: "missing"});
  assert.deepEqual(readCredentials({BINANCE_API_KEY: "short", BINANCE_API_SECRET: SECRET}), {configured: false, reason: "invalid_format"});
  assert.equal(readCredentials({BINANCE_API_KEY: ` ${KEY} `, BINANCE_API_SECRET: SECRET}).configured, true);
});

test("catalog is public, cacheable and lists every strategy with citations", async () => {
  const {handler, calls} = setup({fetcher: spotFetcher});
  const response = await get(handler, "/api/strategy/catalog");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control"), /public/);
  const body = await response.json();
  assert.ok(body.strategies.length >= 15 && body.citations.m44 && body.metrics.annualYield);
  assert.equal(calls.length, 0, "no upstream request");
  assert.equal((await get(handler, "/api/strategy/catalog?x=1")).status, 400);
  assert.equal((await handler(new Request(origin + "/api/strategy/catalog", {method: "POST"}))).status, 405);
  assert.equal(await handler(new Request(origin + "/api/other")), null);
});

test("signals combine the IV surface with spot klines and pack them compactly", async () => {
  const {handler, calls} = setup({fetcher: spotFetcher});
  const body = await (await get(handler, "/api/strategy/signals")).json();
  assert.equal(body.replay, true);
  assert.ok(body.regime.iv.atm30 > .2 && body.regime.rv.rv30 > 0);
  assert.ok(["idle", "triggered"].includes(body.regime.crash.status));
  assert.equal(body.klines.hourly.t.length, 240);
  assert.equal(body.klines.daily.c.length, 120);
  assert.equal(body.sources.hourly.source, "api.binance.com");
  const before = calls.length;
  await get(handler, "/api/strategy/signals");
  assert.equal(calls.length, before, "klines are cached between polls");
});

test("kline transport falls back to the public data mirror and backs off on 429", async () => {
  let mirror = 0;
  const {handler} = setup({fetcher: url => {
    if (url.startsWith("https://api.binance.com")) return jsonResponse({}, 503);
    mirror++;
    return spotFetcher(url);
  }});
  const body = await (await get(handler, "/api/strategy/signals")).json();
  assert.equal(body.sources.daily.source, "data-api.binance.vision");
  assert.equal(mirror, 2);
  let time = capturedLocal;
  const limited = setup({now: () => time, fetcher: () => jsonResponse({code: -1003}, 429, {"Retry-After": "120"})});
  const first = await (await get(limited.handler, "/api/strategy/signals")).json();
  assert.equal(first.sources.hourly.error, "rate_limited");
  assert.equal(first.regime.crash.status, "unknown", "no klines → trigger unknown, never invented");
  const count = limited.calls.length;
  time += 90_000;
  await get(limited.handler, "/api/strategy/signals");
  assert.equal(limited.calls.length, count, "embargo respected");
});

test("server-side screening validates every query parameter", async () => {
  const {handler} = setup({fetcher: spotFetcher});
  const ok = await get(handler, "/api/strategy/screen?id=crash-put&dte=30~60&otm=20~32&limit=5&budget=1000");
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.strategyId, "crash-put");
  assert.ok(body.candidates.length >= 1 && body.candidates.length <= 5);
  assert.ok(body.candidates[0].checks.every(check => typeof check.text === "string" && check.label));
  for (const [path, code] of [
    ["/api/strategy/screen?id=nope", "unknown_strategy"],
    ["/api/strategy/screen?id=crash-put&width=3~5", "unknown_param"],
    ["/api/strategy/screen?id=crash-put&dte=<script>", "invalid_input"],
    ["/api/strategy/screen?id=crash-put&dte=1~2&dte=3~4", "invalid_input"],
    ["/api/strategy/screen?id=crash-put&" + "a=1&".repeat(600), "query_too_long"],
  ]) {
    const response = await get(handler, path);
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).error.code, code);
  }
});

function accountFetcher(record) {
  return (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/eapi/v1/time") return jsonResponse({serverTime: fixture.server_now_ms});
    record.push({url: parsed, apiKey: init.headers["X-MBX-APIKEY"]});
    const query = parsed.search.slice(1).replace(/&signature=.*$/, "");
    const expected = createHmac("sha256", SECRET).update(query).digest("hex");
    if (parsed.searchParams.get("signature") !== expected) return jsonResponse({code: -1022, msg: "bad signature"}, 400);
    if (parsed.pathname === "/eapi/v1/marginAccount") {
      return jsonResponse({asset: [{asset: "USDT", marginBalance: "1000", equity: "1012.5", available: "880", initialMargin: "120",
        maintMargin: "60", unrealizedPNL: "-3", adjustedEquity: "1000"}], time: fixture.server_now_ms});
    }
    if (parsed.pathname === "/eapi/v1/position") {
      return jsonResponse([{symbol: "BTC-261127-60000-P", side: "SHORT", quantity: "-0.01", entryPrice: "300", markPrice: "280",
        markValue: "-2.8", unrealizedPNL: "0.2", strikePrice: "60000", expiryDate: Date.UTC(2026, 10, 27, 8), quoteAsset: "USDT"}]);
    }
    return jsonResponse({}, 404);
  };
}

test("account route reports configuration state and signs with the server-held secret", async () => {
  const missing = setup({fetcher: spotFetcher});
  const none = await get(missing.handler, "/api/strategy/account");
  assert.deepEqual(await none.json(), {configured: false, reason: "missing", mode: "server"});
  assert.match(none.headers.get("Cache-Control"), /private, no-store/);

  const record = [];
  const credentials = readCredentials({BINANCE_API_KEY: KEY, BINANCE_API_SECRET: SECRET});
  const local = setup({fetcher: accountFetcher(record), credentials});
  const body = await (await get(local.handler, "/api/strategy/account")).json();
  assert.equal(body.configured, true);
  assert.equal(body.assets[0].equity, "1012.5");
  assert.equal(body.positions[0].symbol, "BTC-261127-60000-P");
  assert.equal(record.length, 2);
  assert.ok(record.every(call => call.apiKey === KEY && !call.url.href.includes(SECRET)), "secret never leaves the server");
  await get(local.handler, "/api/strategy/account");
  assert.equal(record.length, 2, "5-second memo shares one signed request between tabs");
});

test("public hosting fails closed without a valid bearer token", async () => {
  const credentials = readCredentials({BINANCE_API_KEY: KEY, BINANCE_API_SECRET: SECRET});
  const noToken = setup({fetcher: accountFetcher([]), credentials, hosted: true});
  const refused = await get(noToken.handler, "/api/strategy/account");
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).reason, "hosted_requires_token");
  const token = "t".repeat(30);
  const guarded = setup({fetcher: accountFetcher([]), credentials, hosted: true, accessToken: token});
  for (const header of [undefined, "Bearer wrong", "Basic " + token, "Bearer " + token + "x"]) {
    const response = await get(guarded.handler, "/api/strategy/account", header ? {Authorization: header} : {});
    assert.equal(response.status, 401, String(header));
    assert.equal(response.headers.get("WWW-Authenticate"), "Bearer");
  }
  const allowed = await get(guarded.handler, "/api/strategy/account", {Authorization: "Bearer " + token});
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).positions.length, 1);
});

test("Binance credential errors are mapped without echoing upstream details", async () => {
  const credentials = readCredentials({BINANCE_API_KEY: KEY, BINANCE_API_SECRET: "x".repeat(64)});
  const {handler} = setup({fetcher: accountFetcher([]), credentials});
  const response = await get(handler, "/api/strategy/account");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {configured: true, authorized: true, error: "credentials"});
});

test("replay freezes the exchange clock and preserves recorded quote ages", async () => {
  let time = capturedLocal + 10 * 86_400_000;
  const market = createReplayMarket(fixture, {now: () => time});
  const body = await (await market(new Request(origin + "/api/market"))).json();
  assert.equal(body.replay, true);
  assert.equal(body.status, "REPLAY");
  assert.equal(time + body.exchange_clock_offset_ms, fixture.server_now_ms);
  const row = body.options[0], original = fixture.options[0];
  assert.equal(time - row.field_updated_at.bid_price, capturedLocal - original.field_updated_at.bid_price);
  assert.equal(row.expiry_ms, original.expiry_ms, "exchange times unchanged");
  const focused = await (await market(new Request(origin + "/api/focused-market?symbols=" + original.symbol))).json();
  assert.deepEqual(focused.options.map(option => option.symbol), [original.symbol]);
  assert.equal((await market(new Request(origin + "/api/focused-market?symbols=bad"))).status, 400);
  assert.equal(await market(new Request(origin + "/api/strategy/catalog")), null);
  assert.throws(() => createReplayMarket({options: []}));
});

test("relay forwards strategy routes with strict validation and a bearer only for the account", async () => {
  const site = "https://btcopt.pages.dev", env = {BINANCE_RELAY_URL: "https://btcoptions.onrender.com"};
  const seen = [];
  const backend = async (url, init) => {
    seen.push({url: String(url), auth: init.headers.get("Authorization")});
    const path = new URL(url).pathname;
    if (path === "/api/strategy/account") return jsonResponse({configured: true, authorized: false, reason: "token_required", secret: "x"}, 401);
    if (path === "/api/strategy/screen") return jsonResponse({candidates: [], total: 0});
    if (path === "/api/strategy/catalog") return jsonResponse({strategies: [{id: "crash-put"}]});
    return jsonResponse({asOf: 1});
  };
  const screen = await relay(new Request(site + "/api/strategy/screen?id=crash-put&dte=30~60", {headers: {Authorization: "Bearer leak"}}), env, backend);
  assert.equal(screen.status, 200);
  assert.equal(seen.at(-1).auth, null, "public routes never forward credentials");
  const account = await relay(new Request(site + "/api/strategy/account", {headers: {Authorization: "Bearer " + "k".repeat(30)}}), env, backend);
  assert.equal(account.status, 401);
  assert.deepEqual(await account.json(), {configured: true, authorized: false, reason: "token_required"}, "unknown keys stripped");
  assert.equal(seen.at(-1).auth, "Bearer " + "k".repeat(30));
  assert.equal((await relay(new Request(site + "/api/strategy/screen?id=<x>"), env, backend)).status, 400);
  assert.equal((await relay(new Request(site + "/api/strategy/catalog?x=1"), env, backend)).status, 400);
  assert.equal((await relay(new Request(site + "/api/strategy/account", {headers: {Authorization: "Bearer bad token with spaces"}}), env, backend)).status, 400);
  const bad = await relay(new Request(site + "/api/strategy/catalog"), env, async () => jsonResponse({nope: true}));
  assert.equal(bad.status, 502);
});
