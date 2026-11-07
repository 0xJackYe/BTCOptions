import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { handleAccount } from "../worker-account.mjs";

const origin = "https://options.test";
const instant = 1793994120000;
const apiKey = "k".repeat(64);
const secret = "s".repeat(64);
const signature = window => createHmac("sha256", secret)
  .update("timestamp=" + instant + "&recvWindow=" + window).digest("hex");
const account = {
  asset: [{ asset: "USDT", marginBalance: "1000.00", equity: "999.25", available: "923.15",
    initialMargin: "75.50", maintMargin: "25.00", unrealizedPNL: "-0.75", adjustedEquity: "1000.00",
    privateNote: "drop this" }],
  time: instant, canTrade: true,
};
const positions = [
  { symbol: "BTC-261127-60000-P", side: "SHORT", quantity: "-0.01", entryPrice: "45",
    markPrice: "120", markValue: "-1.2", unrealizedPNL: "-0.75", strikePrice: "60000",
    expiryDate: instant + 3600000000, quoteAsset: "USDT", extraField: "drop this" },
  { symbol: "BTC-261127-64000-P", side: "LONG", quantity: "0.0000" },
];
let id = 1;

function payload(changes = {}) {
  return { apiKey, timestamp: instant, signatures: { account: signature(5000), positions: signature(4900) }, ...changes };
}

function post(body = payload(), settings = {}) {
  const { method = "POST", url = "/api/account", headers = {}, ip = "192.0.2." + id++ } = settings;
  return new Request(origin + url, {
    method,
    headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json",
      "CF-Connecting-IP": ip, ...headers },
    body: method === "POST" ? typeof body === "string" ? body : JSON.stringify(body) : undefined,
  });
}

function upstream(result = {}) {
  const calls = [];
  const fetcher = async (raw, settings) => {
    const url = new URL(raw);
    assert.equal(url.origin, "https://eapi.binance.com");
    assert.equal(settings.method, "GET");
    assert.equal(settings.redirect, "manual");
    calls.push({ url, settings });
    if (url.pathname === "/eapi/v1/time") {
      assert.equal(settings.headers["X-MBX-APIKEY"], undefined);
      return result.clock || Response.json({ serverTime: instant });
    }
    assert.equal(settings.headers["X-MBX-APIKEY"], apiKey);
    assert.deepEqual([...url.searchParams.keys()], ["timestamp", "recvWindow", "signature"]);
    assert.equal(url.searchParams.get("timestamp"), String(instant));
    if (url.pathname === "/eapi/v1/marginAccount") {
      assert.equal(url.searchParams.get("recvWindow"), "5000");
      assert.equal(url.searchParams.get("signature"), signature(5000));
      return result.account || Response.json(account);
    }
    assert.equal(url.pathname, "/eapi/v1/position");
    assert.equal(url.searchParams.get("recvWindow"), "4900");
    assert.equal(url.searchParams.get("signature"), signature(4900));
    return result.positions || Response.json(positions);
  };
  return { calls, fetcher, now: () => instant + 100 };
}

test("normalizes only selected fields and never returns either credential", async () => {
  const options = upstream();
  const response = await handleAccount(post(), options);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.has("access-control-allow-origin"), false);
  const data = await response.json();
  assert.equal(data.assets[0].available, "923.15");
  assert.equal(data.positions[0].quantity, "-0.01");
  assert.equal(data.positions.length, 1);
  assert.equal(data.receivedAt, instant + 100);
  for (const value of [apiKey, secret, "privateNote", "extraField", "canTrade", signature(5000)]) {
    assert.ok(!JSON.stringify(data).includes(value));
  }
  assert.equal(options.calls.length, 2);
});

test("clock carries no credentials and sends a bounded uncached GET", async () => {
  const options = upstream();
  const response = await handleAccount(post(null, { method: "GET", url: "/api/account/time" }), options);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { serverTime: instant });
  assert.equal(options.calls[0].url.search, "");
  assert.equal(options.calls[0].settings.cf.cacheTtl, 0);
});

test("wrong method, query string, cross-site and missing Origin never reach Binance", async () => {
  const options = upstream();
  for (const [request, status] of [
    [post(null, { method: "OPTIONS" }), 405],
    [post(null, { method: "GET" }), 405],
    [post(payload(), { url: "/api/account?foo=bar" }), 400],
    [post(payload(), { headers: { Origin: "https://evil.test" } }), 403],
    [post(payload(), { headers: { "Sec-Fetch-Site": "same-site" } }), 403],
    [post(payload(), { headers: { Origin: "null" } }), 403],
    [new Request(origin + "/api/account", { method: "POST", body: JSON.stringify(payload()) }), 403],
    [post(payload(), { headers: { "Content-Type": "text/plain" } }), 415],
  ]) {
    assert.equal((await handleAccount(request, options)).status, status);
  }
  assert.equal(options.calls.length, 0);
});

test("malformed, expired and oversized requests never reach Binance", async () => {
  const options = upstream();
  for (const body of [
    "{",
    "X".repeat(2000),
    payload({ secret }),
    payload({ apiKey: "k" }),
    payload({ signatures: { account: signature(5000), positions: "wrong" } }),
    payload({ timestamp: instant - 5000 }),
    payload({ timestamp: instant + 3000 }),
  ]) {
    const response = await handleAccount(post(body), options);
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes(secret));
  }
  assert.equal(options.calls.length, 0);
});

test("exchange permission, regional, timestamp and throttling errors remain sanitized", async () => {
  for (const [up, status, error] of [
    [Response.json({ code: -2015, msg: secret }, { status: 401 }), 403, "credentials"],
    [Response.json({ code: -1021, msg: secret }, { status: 400 }), 400, "timestamp"],
    [Response.json({ code: -21001, msg: secret }, { status: 400 }), 403, "account_unavailable"],
    [new Response(secret, { status: 451 }), 503, "region"],
    [new Response(secret, { status: 429 }), 429, "throttled"],
  ]) {
    const response = await handleAccount(post(), upstream({ positions: up }));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
    if (status === 429) assert.equal(response.headers.get("retry-after"), "60");
  }
});

test("empty positions remain distinguishable from malformed responses", async () => {
  const empty = await handleAccount(post(), upstream({ positions: Response.json([]) }));
  assert.deepEqual((await empty.json()).positions, []);
  for (const positions of [
    [{ symbol: "BTC-261127-60000-P", side: "LONG", quantity: "-0.01" }],
    [{ symbol: "<script>", side: "SHORT", quantity: "-0.01" }],
    { code: 0, positions: [] },
  ]) {
    const response = await handleAccount(post(), upstream({ positions: Response.json(positions) }));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "invalid_response" });
  }
});

test("rejects oversized or redirected upstream responses", async () => {
  const large = new Response("x".repeat(600000));
  const redirect = new Response(null, { status: 302, headers: { Location: "https://evil.test/" } });
  assert.equal((await handleAccount(post(), upstream({ account: large }))).status, 502);
  assert.equal((await handleAccount(post(), upstream({ account: redirect }))).status, 503);
});

test("limits valid requests per address and resets after the rate window", async () => {
  const options = upstream();
  const ip = "198.51.100.40";
  for (let count = 0; count < 6; count += 1) {
    assert.equal((await handleAccount(post(payload(), { ip }), options)).status, 200);
  }
  assert.equal((await handleAccount(post(payload(), { ip }), options)).status, 429);
  assert.equal(options.calls.length, 12);
  const after = instant + 70_000;
  const last = await handleAccount(post(payload({ timestamp: after }), { ip }), {
    now: () => after,
    fetcher: async url => Response.json(url.includes("marginAccount") ? account : []),
  });
  assert.equal(last.status, 200);
});


async function browserHarness({bridge = true, preference = null, storageThrows = false, onClock,
  failPost = false} = {}) {
  const inputs = new Map();
  const listeners = {};
  const makeElement = () => ({
    listeners: {}, children: [], value: "", checked: false, hidden: false, disabled: false, textContent: "",
    classList: { add() {}, remove() {} },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    setAttribute() {}, removeAttribute() {},
    replaceChildren(...elements) { this.children = elements; },
    append(element) { this.children.push(element); },
    reset() { inputs.get("apiKey").value = inputs.get("apiSecret").value = ""; },
  });
  const document = {
    getElementById(id) {
      if (!inputs.has(id)) inputs.set(id, makeElement());
      return inputs.get(id);
    },
    createElement: makeElement, createDocumentFragment: makeElement,
  };
  const messages = [];
  const saved = new Map([["btc-options-account-local-bridge", preference]]);
  const options = upstream();
  const routeFetch = async (transport, path, settings) => {
    assert.equal(inputs.get("apiKey").value, "");
    assert.equal(inputs.get("apiSecret").value, "");
    assert.equal(settings.cache, "no-store");
    messages.push({transport, path, body: settings.body || ""});
    if (path === "/api/account/time") await onClock?.({inputs, messages, saved});
    if (failPost && path === "/api/account") return Response.json({error: "credentials"}, {status: 403});
    const request = settings.method === "POST"
      ? post(settings.body, {url: path})
      : post(null, {method: "GET", url: path});
    return handleAccount(request, options);
  };
  const window = {
    isSecureContext: true,
    addEventListener: (name, handler) => { listeners[name] = handler; },
    localStorage: {
      getItem(name) {
        if (storageThrows) throw new Error("storage unavailable");
        return saved.get(name) ?? null;
      },
      setItem(name, value) {
        if (storageThrows) throw new Error("storage unavailable");
        saved.set(name, value);
      },
    },
  };
  if (bridge) window.BTCOptionsBridge = Object.freeze({
    fetch: (path, settings) => routeFetch("local", path, settings),
  });
  const context = vm.createContext({
    document, crypto: webcrypto, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout,
    window,
    fetch: (path, settings) => routeFetch("cloud", path, settings),
  });
  const source = await readFile(new URL("../account.js", import.meta.url), "utf-8");
  vm.runInContext(source, context);
  const submit = async () => {
    inputs.get("apiKey").value = apiKey;
    inputs.get("apiSecret").value = secret;
    await inputs.get("accountForm").listeners.submit({preventDefault() {}});
  };
  return {inputs, listeners, messages, saved, submit};
}

test("browser prefers cloud when a local bridge exists, signs and clears private data", async () => {
  const page = await browserHarness();
  assert.equal(page.inputs.get("useLocalConnector").checked, false);
  assert.match(page.inputs.get("privacyNote").textContent, /云端/);
  await page.submit();
  assert.equal(page.inputs.get("accountStatus").textContent, "账户快照已读取。");
  assert.equal(page.inputs.get("result").hidden, false);
  assert.deepEqual(page.messages.map(({transport, path}) => [transport, path]), [
    ["cloud", "/api/account/time"], ["cloud", "/api/account"],
  ]);
  assert.deepEqual(JSON.parse(page.messages[1].body), payload());
  assert.ok(!JSON.stringify(page.messages).includes(secret));
  page.listeners.pagehide();
  assert.equal(page.inputs.get("result").hidden, true);
  assert.equal(page.inputs.get("positionRows").children.length, 0);
  assert.equal(page.inputs.get("assetRows").children.length, 0);
  assert.equal(page.inputs.get("useLocalConnector").disabled, false);
});

test("explicit local selection routes both clock and signed query only to local connector", async () => {
  const page = await browserHarness();
  const choice = page.inputs.get("useLocalConnector");
  choice.checked = true;
  choice.listeners.change();
  assert.equal(page.saved.get("btc-options-account-local-bridge"), "true");
  assert.equal(page.inputs.get("localRelayNote").hidden, false);
  assert.match(page.inputs.get("privacyNote").textContent, /本机连接器/);
  await page.submit();
  assert.equal(page.inputs.get("accountStatus").textContent, "账户快照已读取。");
  assert.deepEqual(page.messages.map(row => row.transport), ["local", "local"]);
  assert.equal(choice.checked, true);
});

test("an in-flight route stays fixed when its checkbox is changed after the clock GET", async () => {
  for (const initiallyLocal of [false, true]) {
    const page = await browserHarness({
      preference: JSON.stringify(initiallyLocal),
      onClock({inputs, saved}) {
        const choice = inputs.get("useLocalConnector");
        assert.equal(choice.disabled, true);
        choice.checked = !initiallyLocal;
        choice.listeners.change();
        assert.equal(saved.get("btc-options-account-local-bridge"), JSON.stringify(initiallyLocal));
      },
    });
    await page.submit();
    assert.equal(page.inputs.get("accountStatus").textContent, "账户快照已读取。");
    assert.deepEqual(page.messages.map(row => row.transport),
      initiallyLocal ? ["local", "local"] : ["cloud", "cloud"]);
  }
});

test("blocked or malformed storage defaults to cloud and missing bridge ignores saved local choice", async () => {
  for (const settings of [{preference: "{"}, {storageThrows: true}, {bridge: false, preference: "true"}]) {
    const page = await browserHarness(settings);
    assert.equal(page.inputs.get("useLocalConnector").checked, false);
    await page.submit();
    assert.deepEqual(page.messages.map(row => row.transport), ["cloud", "cloud"]);
  }
  const restored = await browserHarness({preference: "true"});
  assert.equal(restored.inputs.get("useLocalConnector").checked, true);
});

test("failed signed queries stay on the selected route without retrying elsewhere", async () => {
  for (const local of [false, true]) {
    const page = await browserHarness({preference: JSON.stringify(local), failPost: true});
    await page.submit();
    assert.match(page.inputs.get("accountStatus").textContent, /币安拒绝读取/);
    assert.equal(page.inputs.get("result").hidden, true);
    assert.deepEqual(page.messages.map(row => row.transport), local ? ["local", "local"] : ["cloud", "cloud"]);
    assert.equal(page.inputs.get("apiKey").value, "");
    assert.equal(page.inputs.get("apiSecret").value, "");
  }
});
