import test from "node:test";
import assert from "node:assert/strict";
import {relay} from "../worker-relay.mjs";

const SITE = "https://btcopt.pages.dev";
const BACKEND = "https://btcoptions.onrender.com";
const ENV = {BINANCE_RELAY_URL: BACKEND};
const SYMBOL = "BTC-261225-70000-P";
const credentials = {apiKey: "a".repeat(64), timestamp: Date.now(),
  signatures: {account: "b".repeat(64), positions: "c".repeat(64)}};

function request(path, init = {}) {return new Request(SITE + path, init);}
function post(body = credentials, headers = {}) {
  return request("/api/account", {method: "POST", headers: {Origin: SITE,
    "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...headers}, body: JSON.stringify(body)});
}

test("unconfigured relay and unhandled routes leave the existing Worker in control", async () => {
  const forbidden = () => {throw new Error("Unexpected upstream request");};
  assert.equal(await relay(request("/api/market"), {}, forbidden), null);
  assert.equal(await relay(request("/api/health"), ENV, forbidden), null);
  assert.equal(await relay(request("/anything"), ENV, forbidden), null);
});

test("public GET routes use only the fixed Render backend and strip caller headers", async () => {
  const cases = [
    ["/api/market?refresh=1", {options: [], stale: true}],
    ["/api/focused-market?symbols=" + SYMBOL, {options: [{symbol: SYMBOL}]}],
    ["/api/mark-watch?symbols=" + SYMBOL, {accepted: 1}],
  ];
  for (const [path, data] of cases) {
    let calls = 0;
    const response = await relay(request(path, {headers: {Cookie: "private-cookie", Authorization: "private-token",
      "X-MBX-APIKEY": "private-key", "CF-Connecting-IP": "192.0.2.1"}}), ENV, async (url, init) => {
      calls++;
      assert.equal(url, BACKEND + path);
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "manual");
      assert.equal(init.body, undefined);
      assert.deepEqual([...init.headers], []);
      assert.ok(init.signal instanceof AbortSignal);
      return Response.json(data, {headers: {"Access-Control-Allow-Origin": "*", "Set-Cookie": "private",
        "Cache-Control": "public, max-age=900", "X-Private-Header": "hidden"}});
    });
    assert.equal(calls, 1);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), data);
    assert.match(response.headers.get("Cache-Control"), /private, no-store/);
    for (const name of ["Set-Cookie", "Access-Control-Allow-Origin", "X-Private-Header"]) {
      assert.equal(response.headers.get(name), null, name);
    }
  }
});

test("signed account body stays on its exact route and never enters a header or URL", async () => {
  const response = await relay(post(), ENV, async (url, init) => {
    assert.equal(url, BACKEND + "/api/account");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.deepEqual([...init.headers], [["content-type", "application/json"], ["origin", SITE]]);
    assert.deepEqual(JSON.parse(init.body), credentials);
    assert.equal(url.includes(credentials.apiKey), false);
    return Response.json({assets: [], positions: [], receivedAt: Date.now()});
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control"), /no-store/);

  const clock = await relay(request("/api/account/time", {headers: {Origin: SITE, "Sec-Fetch-Site": "same-origin"}}),
    ENV, async (url, init) => {
      assert.equal(url, BACKEND + "/api/account/time");
      assert.deepEqual([...init.headers], [["origin", SITE]]);
      return Response.json({serverTime: 1_800_000_000_000});
    });
  assert.deepEqual(await clock.json(), {serverTime: 1_800_000_000_000});
});

test("invalid configured targets cannot become arbitrary outbound requests", async () => {
  for (const target of [
    "http://btcoptions.onrender.com", "https://other.example", "https://user:password@btcoptions.onrender.com",
    BACKEND + "/api/market", BACKEND + "?token=hidden", BACKEND + "#secret",
    "https://btcoptions.onrender.com.evil.example", "https://btcoptions.onrender.com:8443",
    "https://127.0.0.1", " " + BACKEND,
  ]) {
    const response = await relay(request("/api/market"), {BINANCE_RELAY_URL: target},
      () => {throw new Error("invalid configuration reached upstream");});
    assert.equal(response.status, 503, target);
  }
  const trailing = await relay(request("/api/market"), {BINANCE_RELAY_URL: BACKEND + "/"},
    async url => {
      assert.equal(url, BACKEND + "/api/market");
      return Response.json({options: []});
    });
  assert.equal(trailing.status, 200);
});

test("account cross-origin, wrong methods and non-whitelisted query parameters are rejected before forwarding", async () => {
  const inputs = [
    [post(credentials, {Origin: "https://attacker.example"}), 403],
    [post(credentials, {"Sec-Fetch-Site": "cross-site"}), 403],
    [request("/api/account", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(credentials)}), 403],
    [request("/api/account/time", {headers: {Origin: "null"}}), 403],
    [request("/api/account/time", {headers: {"Sec-Fetch-Site": "cross-site"}}), 403],
    [request("/api/account"), 405],
    [request("/api/market", {method: "POST", body: "{}"}), 405],
    [request("/api/account/time?token=private"), 400],
    [request("/api/market?url=https://attacker.example"), 400],
    [request("/api/focused-market?symbols=ETH-261225-4000-P"), 400],
    [request("/api/mark-watch?symbols=" + SYMBOL + "&symbols=" + SYMBOL), 400],
  ];
  for (const [input, status] of inputs) {
    let called = false;
    const response = await relay(input, ENV, () => {called = true; throw new Error();});
    assert.equal(called, false, input.url);
    assert.equal(response.status, status, input.url);
  }
});

test("only the small, fixed account JSON shape may cross the relay boundary", async () => {
  const inputs = [
    post({...credentials, secret: "never-forward-this"}),
    post({...credentials, signatures: {...credentials.signatures, route: "withdraw"}}),
    post({...credentials, apiKey: "bad"}),
    post({...credentials, timestamp: "1800000000000"}),
    post({...credentials, signatures: {account: "not-hex", positions: "d".repeat(64)}}),
    request("/api/account", {method: "POST", headers: {Origin: SITE, "Content-Type": "application/json"},
      body: " ".repeat(1025)}),
    request("/api/account", {method: "POST", headers: {Origin: SITE, "Content-Type": "application/json"},
      body: "{broken"}),
    post(credentials, {"Content-Type": "text/plain"}),
  ];
  for (const input of inputs) {
    let calls = 0;
    const response = await relay(input, ENV, () => {calls++; throw new Error();});
    assert.equal(calls, 0);
    assert.ok([400, 415].includes(response.status));
  }
});

test("redirects, HTML startup pages and transport errors become sanitized failures", async () => {
  for (const fetcher of [
    async () => new Response("upstream secret", {status: 302, headers: {Location: "https://attacker.example"}}),
    async () => new Response("<html>Starting up</html>", {headers: {"Content-Type": "text/html"}}),
    async () => {throw new Error("secret-url-and-token");},
  ]) {
    const response = await relay(post(), ENV, fetcher);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {error: "unavailable"});
    assert.equal(response.headers.get("Location"), null);
  }
});

test("private responses are bounded and backend errors are normalized without reflecting private details", async () => {
  const oversized = await relay(post(), ENV, async () => new Response("x".repeat(1024 * 1024 + 1),
    {headers: {"Content-Type": "application/json"}}));
  assert.equal(oversized.status, 502);
  assert.deepEqual(await oversized.json(), {error: "invalid_response"});
  const known = await relay(post(), ENV, async () => Response.json({error: "credentials"}, {status: 403}));
  assert.equal(known.status, 403);
  assert.deepEqual(await known.json(), {error: "credentials"});
  const unknown = await relay(post(), ENV, async () => Response.json({error: credentials.apiKey}, {status: 403}));
  assert.equal(unknown.status, 403);
  assert.deepEqual(await unknown.json(), {error: "unavailable"});
  const limited = await relay(request("/api/market"), ENV, async () => Response.json({error: "private"},
    {status: 429, headers: {"Retry-After": "secret"}}));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.match((await limited.json()).error.message, /限流/);
});

test("public response length and successful response schemas are validated", async () => {
  const oversized = await relay(request("/api/market"), ENV, async () => new Response("x",
    {headers: {"Content-Type": "application/json", "Content-Length": String(8 * 1024 * 1024 + 1)}}));
  assert.equal(oversized.status, 502);
  for (const [path, body] of [["/api/market", {}], ["/api/account/time", {serverTime: "bad"}],
    ["/api/mark-watch?symbols=" + SYMBOL, {accepted: 999}]]) {
    const response = await relay(request(path), ENV, async () => Response.json(body));
    assert.equal(response.status, 502);
  }
});
