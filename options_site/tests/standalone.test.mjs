import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";
import {createRequire} from "node:module";
import {test} from "node:test";
const require = createRequire(import.meta.url);
const {screen} = require("../screener.js");
const {quoteIssue} = require("../../dashboard/dist/risk-ui.js");
const dist = new URL("../dist/", import.meta.url);

test("standalone build includes the original chain, portfolio, risk and account without terminal files", async () => {
  const markup = await readFile(new URL("index.html", dist), "utf8");
  for (const name of ["optionChain", "payoffDialog", "riskDialog", "siteScreenDialog"]) {
    assert.ok(markup.includes('id="' + name + '"'), name);
  }
  assert.match(markup, /portfolio-ui\.js/);
  assert.match(markup, /href="\.\/account.html"/);
  assert.doesNotMatch(markup, /terminal-embed|DeepSeek|apiKeyForm|option-ai-ui\.js/);
  // Extensionless page links are served as their .html file (Pages and the local bridge).
  const asset = name => name === "strategy" ? "strategy.html" : name;
  for (const [, name] of markup.matchAll(/(?:href|src)="\.\/([^"]+)"/g)) await readFile(new URL(asset(name), dist));
  assert.deepEqual((await readdir(new URL("_worker.js/", dist))).sort(),
    ["index.js", "lib", "worker-account.mjs", "worker-market.mjs", "worker-relay.mjs", "worker-strategy.mjs"]);
  assert.match(markup, /href="\.\/strategy"/, "links the desk without a .html redirect");
  assert.match(JSON.parse(await readFile(new URL("version.json", dist), "utf8")).commit, /^[a-f\d]{40}$/);
});

const now = Date.UTC(2026, 10, 7);
const snapshot = {btc_index_price: 80000, index_updated_at: now, index_source: "rest", options: []};
function contract(strike, side, delta, price, extra = {}) {
  return {
    symbol: "BTC-261121-" + strike + "-" + side[0], expiry_ms: now + 14 * 86400000,
    side, strike_price: strike, status: "TRADING", unit: 1, quote_asset: "USDT",
    min_qty: .01, max_qty: 10, quantity_scale: 2, delta,
    bid_price: price, ask_price: price * 1.05, bid_quantity: 2, ask_quantity: 2,
    quote_source: "rest", quote_updated_at: now, mark_updated_at: now, ...extra
  };
}
const settings = {side: "PUT", expiry: "ALL", quantity: .01, mode: "risk", risk: "LOW"};

test("the three ordering criteria can lead with different contracts", () => {
  const rows = [contract(63000, "PUT", -.04, 45), contract(65000, "PUT", -.08, 120), contract(67000, "PUT", -.15, 140)];
  const strike = mode => screen({...snapshot, options: rows}, {...settings, mode}, now, quoteIssue)[0]?.row.strike_price;
  assert.deepEqual(["risk", "balance", "premium"].map(strike), [63000, 65000, 67000]);
});

test("screen is symmetric for Calls and Puts and excludes stale, thin and mismatched markets", () => {
  const put = contract(65000, "PUT", -.09, 100);
  const call = contract(95000, "CALL", .09, 100);
  const options = [put, call, contract(60000, "PUT", -.04, 80, {bid_quantity: 0}),
    contract(100000, "CALL", .04, 80, {mark_updated_at: now - 31000}),
    contract(70000, "CALL", .08, 80), contract(64000, "PUT", -.07, 80, {ask_price: 125})];
  const selected = side => screen({...snapshot, options}, {...settings, side}, now, quoteIssue);
  assert.deepEqual(selected("PUT").map(r => r.row), [put]);
  assert.deepEqual(selected("CALL").map(r => r.row), [call]);
  assert.equal(selected("PUT")[0].daily, selected("CALL")[0].daily);
  assert.deepEqual(screen({...snapshot, options, stale: true}, settings, now, quoteIssue), []);
});

test("Worker routes health and rejects unknown endpoints without fetching Binance", async () => {
  const {default: worker} = await import("../dist/_worker.js/index.js");
  const origin = "https://btcopt.pages.dev";
  assert.deepEqual(await (await worker.fetch(new Request(origin + "/api/health"), {})).json(),
    {status: "ok", service: "btcoptions"});
  const missing = await worker.fetch(new Request(origin + "/api/missing"), {});
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("Cache-Control"), "no-store");
  assert.equal((await worker.fetch(new Request(origin + "/api/account"), {})).status, 405);
});

test("strategy desk ships every module its import graph needs, with no inline script", async () => {
  const page = await readFile(new URL("strategy.html", dist), "utf8");
  assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)[^>]*>/, "no inline scripts (CSP script-src 'self')");
  assert.doesNotMatch(page, /\son[a-z]+=/i, "no inline event handlers");
  const versions = new Set();
  for (const [, name, version] of page.matchAll(/(?:href|src)="\.\/([^"#?]+)(\?v=[0-9a-f]{10})?"/g)) {
    await readFile(new URL(name === "strategy" ? "strategy.html" : name, dist));
    if (name.startsWith("strategy/")) versions.add(version);
  }
  assert.equal(versions.size, 1, "every desk asset carries the same content version");
  assert.match([...versions][0] ?? "", /^\?v=[0-9a-f]{10}$/, "desk assets are versioned");
  const walk = async (entry, seen = new Set()) => {
    const visit = async url => {
      if (seen.has(url.href)) return;
      seen.add(url.href);
      const source = await readFile(url, "utf8");
      // Static imports and re-exports ("from" / bare "import"), never import(…).
      for (const [, spec] of source.matchAll(/\b(?:from|import)\s*["'](\.{1,2}\/[^"'?]+)(\?v=[0-9a-f]{10})?["']/g)) await visit(new URL(spec, url));
    };
    await visit(entry);
    return seen;
  };
  const ui = await walk(new URL("strategy/app.js", dist), await walk(new URL("strategy/boot.js", dist)));
  assert.ok([...ui].some(href => href.endsWith("/lib/strategies.mjs")) && ui.size >= 12, "the interface imports the strategy catalog");
  assert.ok(![...ui].some(href => /screener\.mjs|engine\.js|engine-host\.js/.test(href)), "the interface thread never loads the screening engine");
  const preloads = [...page.matchAll(/rel="modulepreload" href="\.\/([^"?]+)\?v=/g)].map(([, path]) => new URL(path, dist).href);
  assert.ok(preloads.length >= 10 && preloads.every(href => ui.has(href)), "modulepreload covers only the interface graph");
  const engine = await walk(new URL("strategy/engine.worker.js", dist));
  assert.ok([...engine].some(href => href.endsWith("/lib/screener.mjs")), "the engine worker resolves the screening library");
  const workerSeen = await walk(new URL("_worker.js/index.js", dist));
  assert.ok([...workerSeen].some(href => href.endsWith("_worker.js/lib/screener.mjs")), "Worker bundle resolves the shared library");
  const headers = await readFile(new URL("_headers", dist), "utf8");
  for (const route of ["/strategy/*", "/lib/*"]) {
    assert.match(headers, new RegExp(route.replace(/[/*]/g, "\\$&") + "\\n\\s+Cache-Control: public, max-age=31536000, immutable"), route + " is immutable");
  }
});
