import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {createEngine} from "../strategy/engine.js";
import {startHost} from "../strategy/engine-host.js";
import {encodeFrame, decodeFrame} from "../lib/market.mjs";
import {parseKlines, packBars} from "../lib/signals.mjs";
import {getStrategy, defaultParams, encodeParams} from "../lib/strategies.mjs";

const fixture = JSON.parse(readFileSync(new URL("../../analysis/put-20261030/snapshot.json", import.meta.url), "utf8"));
const dailyRaw = JSON.parse(readFileSync(new URL("../../analysis/put-20261030/spot_daily.json", import.meta.url), "utf8")).klines;
const fixtureNow = fixture.server_now_ms - fixture.exchange_clock_offset_ms;
const frameText = JSON.stringify(encodeFrame(fixture, fixtureNow));
const daily = parseKlines(dailyRaw);

function harness() {
  const posts = [], queue = [];
  const engine = createEngine(message => posts.push(message), {now: () => fixtureNow, defer: fn => queue.push(fn)});
  const drain = () => { let guard = 0; while (queue.length && guard++ < 1000) queue.shift()(); };
  const snapshot = () => decodeFrame(JSON.parse(frameText), {receivedAt: fixtureNow, servedAt: fixtureNow});
  return {engine, posts, drain, snapshot, last: type => posts.filter(m => m.type === type).at(-1)};
}

test("engine screens a decoded frame and posts structured-cloneable results", () => {
  const {engine, posts, drain, snapshot, last} = harness();
  engine.handle({type: "init", settings: {}, paramsById: {}, strategyId: "crash-put", autoSelect: true});
  engine.handle({type: "bars", hourly: [], daily, source: "replay", at: fixtureNow});
  engine.handle({type: "snapshot", snapshot: snapshot(), source: "replay"});
  drain();
  const result = last("result");
  assert.equal(result.strategyId, "crash-put");
  assert.ok(result.market.ok && result.market.contractCount > 500, "market summary");
  assert.ok(result.result.candidates.length > 0, "candidates");
  assert.ok(result.result.candidates.every(c => !("model" in c)), "heavy model objects stay in the worker");
  assert.equal(result.selectedKey, result.result.candidates[0].key, "auto-selects the leader");
  assert.ok(result.detail?.curve?.length > 100, "detail for the selection");
  for (const message of posts) assert.doesNotThrow(() => structuredClone(message), message.type + " crosses the worker boundary");
  const counts = last("counts");
  assert.equal(counts.done, true, "rail counts finish");
  assert.ok(Object.keys(counts.counts).length >= 17, "every strategy counted");
});

test("engine coalesces bursts, honours freeze and answers selections", () => {
  const {engine, posts, drain, snapshot, last} = harness();
  engine.handle({type: "snapshot", snapshot: snapshot(), source: "replay"});
  for (const otm of [[10, 20], [12, 22], [15, 30]]) engine.handle({type: "params", strategyId: "crash-put", params: {...defaultParams(getStrategy("crash-put")), otm}});
  drain();
  const results = posts.filter(m => m.type === "result");
  assert.equal(results.length, 1, "three parameter changes, one computation");
  assert.deepEqual(results[0].params.otm, [15, 30]);

  engine.handle({type: "freeze", frozen: true, at: fixtureNow});
  drain();
  const frozenCount = posts.filter(m => m.type === "result").length;
  engine.handle({type: "snapshot", snapshot: snapshot(), source: "replay"});
  drain();
  assert.equal(posts.filter(m => m.type === "result").length, frozenCount, "snapshots wait while frozen");
  engine.handle({type: "freeze", frozen: false});
  drain();
  assert.ok(posts.filter(m => m.type === "result").length > frozenCount, "unfreezing applies the held snapshot");

  const second = last("result").result.candidates[1];
  engine.handle({type: "select", key: second.key});
  const detail = last("detail");
  assert.equal(detail.key, second.key);
  assert.ok(detail.detail.curve.length > 100);
});

test("engine decodes a shared link exactly like the interface", () => {
  const {engine, drain, snapshot, last} = harness();
  const strategy = getStrategy("vrp-put");
  const query = encodeParams(strategy, {...defaultParams(strategy), dte: [20, 50]});
  engine.handle({type: "init", settings: {}, paramsById: {}, strategyId: "crash-put", hash: "#/vrp-put?" + query});
  engine.handle({type: "snapshot", snapshot: snapshot(), source: "replay"});
  drain();
  const result = last("result");
  assert.equal(result.strategyId, "vrp-put");
  assert.deepEqual(result.params.dte, [20, 50]);
});

test("host revalidates with ETag, aligns clocks, and asks for the direct route after two failures", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  let mode = "ok";
  const klines = JSON.stringify({hourly: packBars([]), daily: packBars(daily), sources: {}});
  globalThis.fetch = async (url, options = {}) => {
    calls.push({url: String(url), etag: options.headers?.["If-None-Match"] ?? null});
    if (mode === "down") throw new TypeError("network down");
    if (String(url).endsWith("/api/strategy/klines")) return new Response(klines, {status: 200, headers: {ETag: '"k1"'}});
    if (options.headers?.["If-None-Match"] === '"f1"') return new Response(null, {status: 304, headers: {ETag: '"f1"', "X-Served-At": String(Date.now())}});
    return new Response(frameText, {status: 200, headers: {ETag: '"f1"', "X-Served-At": String(Date.now())}});
  };
  const posts = [];
  const host = startHost(message => posts.push(message), {});
  const settle = async (predicate, label) => {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), label);
  };
  try {
    host.handle({type: "start"});
    await settle(() => posts.some(m => m.type === "result" && m.market?.ok), "first frame screened");
    assert.equal(calls.find(c => c.url.endsWith("/market")).etag, null, "first request is unconditional");

    host.handle({type: "refresh"});
    await settle(() => calls.filter(c => c.url.endsWith("/market")).length >= 2, "second poll");
    await settle(() => posts.filter(m => m.type === "transport" && m.ok).length >= 2, "304 accepted");
    assert.equal(calls.filter(c => c.url.endsWith("/market"))[1].etag, '"f1"', "revalidates with the ETag");

    mode = "down";
    host.handle({type: "refresh"});
    await settle(() => posts.some(m => m.type === "transport" && m.ok === false), "first failure reported");
    assert.ok(!posts.some(m => m.type === "direct"), "one failure does not switch routes");
    host.handle({type: "refresh"});
    await settle(() => posts.some(m => m.type === "direct" && m.active), "two failures ask for the direct route");
    const failure = posts.filter(m => m.type === "transport" && m.ok === false).at(-1);
    assert.ok(failure.retryIn >= 5000 * .75 && failure.retryIn <= 30_000, "exponential backoff with jitter");

    mode = "ok";
    host.handle({type: "refresh"});
    await settle(() => posts.some(m => m.type === "direct" && m.active === false), "recovery releases the direct route");
  } finally {
    host.stop();
    globalThis.fetch = realFetch;
  }
});
