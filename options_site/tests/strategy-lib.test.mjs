import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import * as Q from "../lib/quant.mjs";
import {STRATEGIES, METRICS, CITATIONS, getStrategy, defaultParams, normalizeParams, encodeParams, decodeParams, catalog} from "../lib/strategies.mjs";
import {parseKlines, realizedVol, crashTrigger, fitSmile, smileIv, packBars, unpackBars, HOUR_MS} from "../lib/signals.mjs";
import {prepareMarket} from "../lib/market.mjs";
import {createContext, screen, screenAll, analyzeCandidate, serializeResult, summarizePortfolio, mergeSettings} from "../lib/screener.mjs";

const close = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected}, got ${actual}`);
const NO_FEES = {tradeRate: 0, exerciseRate: 0, cap: 0};

/* ------------------------------------------------------------------ quant */

test("Black-Scholes reproduces the conversation's IV table and implied vols (msg 62)", () => {
  const T40 = 40 / 365, T10 = 10 / 365;
  const prices = [.35, .45, .5, .55, .6, .7].map(sigma => Number(Q.bsPrice("PUT", 80000, 55000, T40, sigma).toFixed(2)));
  assert.deepEqual(prices, [1.25, 18.84, 44.56, 87.39, 150.28, 341.53]);
  close(Q.impliedVol("PUT", 5, 80000, 70000, T10), .306, .0005, "IV A");
  close(Q.impliedVol("PUT", 25, 80000, 55000, T40), .465, .0005, "IV B");
  for (const [type, S, K, T, sigma] of [["CALL", 81000, 95000, .1, .55], ["PUT", 81000, 60000, .3, .8], ["CALL", 50000, 40000, 1, .4]]) {
    const price = Q.bsPrice(type, S, K, T, sigma);
    close(Q.impliedVol(type, price, S, K, T), sigma, 1e-7, "IV round trip");
  }
  assert.equal(Q.impliedVol("PUT", 0, 80000, 55000, T40), null);
  assert.equal(Q.impliedVol("CALL", 90000, 80000, 90000, T40), null, "above the no-arbitrage ceiling");
});

test("put-call parity holds at zero rates and Greeks match finite differences", () => {
  const S = 81805, K = 79000, T = 30 / 365, sigma = .52, h = .5;
  close(Q.bsPrice("CALL", S, K, T, sigma) - Q.bsPrice("PUT", S, K, T, sigma), S - K, 1e-6, "parity");
  for (const type of ["CALL", "PUT"]) {
    const g = Q.bsGreeks(type, S, K, T, sigma);
    close(g.delta, (Q.bsPrice(type, S + h, K, T, sigma) - Q.bsPrice(type, S - h, K, T, sigma)) / (2 * h), 1e-6, type + " delta");
    close(g.vega, (Q.bsPrice(type, S, K, T, sigma + 1e-4) - Q.bsPrice(type, S, K, T, sigma - 1e-4)) / 2e-4 / 100, 1e-5, type + " vega");
    close(g.theta, (Q.bsPrice(type, S, K, T - 1e-5, sigma) - Q.bsPrice(type, S, K, T + 1e-5, sigma)) / 2e-5 / 365, 1e-3, type + " theta");
  }
});

test("inverse normal is accurate deep into both tails", () => {
  for (const p of [1e-15, 1e-10, 1e-4, .025, .5, .975, 1 - 1e-6]) {
    const x = Q.normInv(p);
    const error = p < .5 ? Math.abs(Q.normCdf(x) - p) / p : Math.abs(Q.normSf(x) - (1 - p)) / (1 - p);
    assert.ok(error < 1e-12, `p=${p} error ${error}`);
  }
  assert.equal(Q.normInv(0), -Infinity);
  assert.ok(Number.isNaN(Q.normInv(1.5)));
});

test("expiry payoff reproduces the 0.1-contract table and spread loss formula (msgs 129, 146)", () => {
  const naked = Q.expiryPayoff([{type: "PUT", strike: 55000, qty: -.1}], 800, NO_FEES);
  assert.deepEqual([80000, 55000, 50000, 40000, 30000, 0].map(naked.value), [800, 800, 300, -700, -1700, -4700]);
  const one = Q.payoffProfile(Q.expiryPayoff([{type: "PUT", strike: 55000, qty: -1}], 25, NO_FEES));
  assert.deepEqual([one.maxProfit, one.maxLoss, one.breakevens], [25, 54975, [54975]]);
  const spread = Q.payoffProfile(Q.expiryPayoff([{type: "PUT", strike: 55000, qty: -.1}, {type: "PUT", strike: 40000, qty: .1}], 120, NO_FEES));
  close(spread.maxLoss, 1500 - 120, 1e-9, "spread max loss");
  assert.equal(spread.lossUnbounded, false);
});

test("piecewise segments equal the direct payoff with Binance exercise fees", () => {
  const legs = [{type: "PUT", strike: 60000, qty: -.3}, {type: "PUT", strike: 50000, qty: .1}, {type: "CALL", strike: 90000, qty: -.2},
    {type: "CALL", strike: 100000, qty: .2}];
  const payoff = Q.expiryPayoff(legs, 42, Q.DEFAULT_FEES);
  for (let S = 0; S <= 250000; S += 13.7) {
    const segment = payoff.segments.find(s => S >= s.lo && S <= s.hi);
    close(segment.a + segment.b * S, payoff.value(S), 1e-7, "S=" + S);
  }
  // Exercise fee crossover: min(0.015% × S, 10% × intrinsic).
  close(Q.exerciseFeePerUnit("PUT", 60000, 59990, Q.DEFAULT_FEES), 1, 1e-9, "capped by 10% of intrinsic");
  close(Q.exerciseFeePerUnit("PUT", 60000, 40000, Q.DEFAULT_FEES), 6, 1e-9, "0.015% of settlement");
  assert.equal(Q.exerciseFeePerUnit("CALL", 60000, 59000, Q.DEFAULT_FEES), 0);
});

test("fee drift never turns a bounded call spread into an unbounded loss", () => {
  const bullCall = Q.payoffProfile(Q.expiryPayoff([{type: "CALL", strike: 88000, qty: .1}, {type: "CALL", strike: 108000, qty: -.1}], -190, Q.DEFAULT_FEES));
  assert.equal(bullCall.lossUnbounded, false);
  assert.equal(bullCall.profitUnbounded, false);
  assert.ok(bullCall.breakevens.length === 1 && bullCall.breakevens[0] < 108000, "no spurious far break-even");
  const shortCall = Q.payoffProfile(Q.expiryPayoff([{type: "CALL", strike: 100000, qty: -.01}], 3, Q.DEFAULT_FEES));
  assert.equal(shortCall.lossUnbounded, true);
  assert.equal(shortCall.maxLoss, Infinity);
  const longCall = Q.payoffProfile(Q.expiryPayoff([{type: "CALL", strike: 90000, qty: .01}], -15, Q.DEFAULT_FEES));
  assert.equal(longCall.profitUnbounded, true);
});

/** Independent check: E[f(S)] by fine Simpson integration over z. */
function integrate(fn, dist, n = 120000, lo = -12, hi = 12) {
  const h = (hi - lo) / n;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const z = lo + i * h, weight = i === 0 || i === n ? 1 : i % 2 ? 4 : 2;
    sum += weight * fn(Math.exp(dist.m + dist.v * z)) * Q.normPdf(z);
  }
  return sum * h / 3;
}

test("exact lognormal expectation, POP and tail risk match independent integration", () => {
  const payoff = Q.expiryPayoff([{type: "PUT", strike: 60000, qty: -.1}, {type: "PUT", strike: 50000, qty: .1}], 30, Q.DEFAULT_FEES);
  const dist = Q.lognormal(80000, 45 / 365, .55, .05);
  const stats = Q.payoffStats(payoff, dist);
  close(stats.ev, integrate(payoff.value, dist), 1e-6, "EV");
  // Monotone payoff: profit iff S > break-even, so POP = P(S > BE) independently.
  let lo = 40000, hi = 70000;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (payoff.value(mid) > 0) hi = mid; else lo = mid; }
  close(stats.pop, 1 - Q.normCdf((Math.log(hi) - dist.m) / dist.v), 1e-12, "POP");
  // ES99: average loss in the worst 1 % of settlement outcomes (monotone payoff).
  const q99 = dist.quantile(.01);
  const tail = integrate(payoff.value, dist, 120000, -12, Q.normInv(.01)) / .01;
  close(stats.es99, -tail, 1e-6, "ES99");
  close(stats.var99, -payoff.value(q99), 1e-3, "VaR99");
  const deterministic = Q.payoffStats(Q.expiryPayoff([{type: "PUT", strike: 60000, qty: -1}], 100, NO_FEES), Q.lognormal(50000, 0, .5));
  assert.deepEqual([deterministic.ev, deterministic.pop, deterministic.es99], [-9900, 0, 9900]);
});

test("quantity flooring respects exchange steps without binary drift", () => {
  assert.equal(Q.floorToStep(1000 / 54975, .01), .01);
  assert.equal(Q.floorToStep(.29999999, .01), .29);
  assert.equal(Q.floorToStep(0.3, .01), .3);
  assert.equal(Q.floorToStep(-1, .01), 0);
  close(Q.constantMaturityVol([{years: 10 / 365, vol: .5}, {years: 40 / 365, vol: .45}], 30 / 365), .4558, 1e-4);
});

test("Binance margin follows the clearing-procedure formula", () => {
  const rules = Q.DEFAULT_MARGIN_RULES;
  // Put 20% OTM: base = max(0.10 × S, 0.15 × S − (S − K)).
  const S = 80000, K = 64000;
  close(Q.marginBase("PUT", S, K, rules.initialMarginRate, rules.minInitialMarginRate), 8000, 1e-9);
  close(Q.shortMaintenanceMargin("PUT", S, K, 400, rules), 4000 + 400 + .0019 * S, 1e-9);
  close(Q.shortOrderMargin("PUT", S, K, 400, 380, rules), 8000 + 20 + Math.min(.00024 * S, 38), 1e-9);
  assert.deepEqual(Q.marginRules({initial_margin_rate: "0.2", min_initial_margin_rate: "0.1", maintenance_margin_rate: "0.1",
    min_maintenance_margin_rate: "0.05", liquidation_fee_rate: "0.0019"}).estimated, false);
  assert.equal(Q.marginRules({}).estimated, true);
});

/* ------------------------------------------------------------- strategies */

test("every strategy is well formed, cited and uses registered metrics", () => {
  assert.ok(STRATEGIES.length >= 15);
  const ids = new Set();
  for (const strategy of STRATEGIES) {
    assert.ok(!ids.has(strategy.id), "duplicate " + strategy.id); ids.add(strategy.id);
    assert.ok(strategy.name && strategy.tagline && strategy.rules.length, strategy.id);
    for (const key of strategy.columns) assert.ok(METRICS[key], `${strategy.id} column ${key}`);
    for (const ref of strategy.citations) assert.ok(CITATIONS[ref], `${strategy.id} citation ${ref}`);
    const rank = strategy.params.find(param => param.key === "rank");
    assert.ok(rank, strategy.id + " has no rank");
    for (const option of rank.options) assert.ok(METRICS[option.value], `${strategy.id} rank ${option.value}`);
    for (const param of strategy.params) {
      if (param.type === "range") assert.ok(param.default[0] >= param.min && param.default[1] <= param.max && param.default[0] <= param.default[1], `${strategy.id}.${param.key}`);
      if (param.type === "number") assert.ok(param.default >= param.min && param.default <= param.max, `${strategy.id}.${param.key}`);
      if (param.type === "select") assert.ok(param.options.some(option => option.value === param.default), `${strategy.id}.${param.key}`);
    }
  }
  const playbook = STRATEGIES.filter(strategy => strategy.group === "playbook").map(strategy => strategy.hotkey);
  assert.deepEqual(playbook, ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.ok(JSON.stringify(catalog()).length < 120_000);
});

test("the crash put encodes the user's own rules from msg 44", () => {
  const params = defaultParams(getStrategy("crash-put"));
  assert.deepEqual(params.dte, [30, 60]);
  assert.deepEqual(params.otm, [20, 32]);
  assert.equal(params.dropPct, 5);
  assert.equal(getStrategy("crash-put").params.find(p => p.key === "dropPct").origin, "user");
});

test("parameters are clamped, validated and survive URL round trips", () => {
  const strategy = getStrategy("crash-put");
  const {params, issues} = normalizeParams(strategy, {dte: [90, 10], otm: "5~500", dropPct: "abc", trigger: "nope", quantity: 0, extra: 1});
  assert.deepEqual(params.dte, [10, 90]);
  assert.deepEqual(params.otm, [5, 80]);
  assert.equal(params.dropPct, 5);
  assert.equal(params.trigger, "watch");
  assert.equal(params.quantity, .01, "quantity clamps to the minimum");
  assert.equal(issues.length, 2);
  assert.ok(!("extra" in params));
  const changed = {...defaultParams(strategy), dte: [35, 55], trigger: "strict", rank: "ev"};
  const text = encodeParams(strategy, changed);
  assert.match(text, /dte=35~55/);
  assert.deepEqual(decodeParams(strategy, text).params, changed);
  assert.equal(encodeParams(strategy, defaultParams(strategy)), "");
});

/* ---------------------------------------------------------------- signals */

function hourlyBars(prices, end) {
  return prices.map((price, i) => {
    const t = end - (prices.length - i) * HOUR_MS;
    return [t, String(price), String(price * 1.001), String(price * .999), String(price), "1", t + HOUR_MS - 1];
  });
}

test("klines are validated and packed losslessly", () => {
  const end = Date.UTC(2026, 10, 7);
  const rows = [...hourlyBars([100, 101, 102], end), ["x"], [1, "0", "1", "1", "1", "1", 2], hourlyBars([100], end)[0]];
  const bars = parseKlines(rows);
  assert.equal(bars.length, 3, "malformed rows dropped, duplicate open time deduplicated");
  assert.deepEqual(unpackBars(packBars(bars)).map(bar => bar.c), [100, 101, 100], "the later duplicate wins");
  close(realizedVol([100, 110, 99], 365), Math.sqrt((Math.log(1.1) ** 2 + Math.log(.9) ** 2) / 2 * 365), 1e-12);
  assert.equal(realizedVol([100], 365), null);
});

test("crash trigger fires on a 5% drawdown within the window and records episodes", () => {
  const end = Date.UTC(2026, 10, 7, 12);
  const calm = parseKlines(hourlyBars(Array.from({length: 48}, () => 80000), end));
  const idle = crashTrigger(calm, end, 79000, {windowHours: 24, thresholdPct: 5});
  assert.equal(idle.status, "idle");
  close(idle.drawdownPct, (1 - 79000 / 80080) * 100, 1e-9);
  const crash = parseKlines(hourlyBars([...Array.from({length: 40}, () => 80000), 78000, 77000, 76000, 75500, 75000, 75200, 75100, 75000], end));
  const fired = crashTrigger(crash, end, 75000, {windowHours: 24, thresholdPct: 5});
  assert.equal(fired.status, "triggered");
  assert.ok(fired.episodes.length >= 1 && fired.episodes.at(-1).maxDrawdownPct >= 5);
  assert.equal(crashTrigger([], end, 75000).status, "unknown");
});

test("smile fit recovers a known skewed smile and ignores an outlier", () => {
  const truth = k => .5 - .3 * k + .8 * k * k + 1.2 * Math.min(k, 0) ** 2;
  const points = Array.from({length: 15}, (_, i) => {const k = -.6 + i * .07; return {k, iv: truth(k)};});
  points[3] = {...points[3], iv: points[3].iv + .25};
  const fit = fitSmile(points);
  for (const k of [-.5, -.2, 0, .2]) close(smileIv(fit, k), truth(k), .003, "k=" + k);
  assert.equal(fitSmile(points.slice(0, 3)), null);
});

/* --------------------------------------------------------------- screener */

const fixture = JSON.parse(readFileSync(new URL("../../analysis/put-20261030/snapshot.json", import.meta.url), "utf8"));
const daily = JSON.parse(readFileSync(new URL("../../analysis/put-20261030/spot_daily.json", import.meta.url), "utf8")).klines;
const fixtureNow = fixture.server_now_ms - fixture.exchange_clock_offset_ms;
const realContext = (settings = {}, account = null) => createContext({snapshot: fixture, localNow: fixtureNow, klines: {daily}, settings, account});

test("real Binance snapshot: every strategy screens with consistent economics", () => {
  const ctx = realContext();
  assert.equal(ctx.market.contracts.length, 694);
  assert.ok(ctx.surface.atmIv30 > .2 && ctx.surface.atmIv30 < 1.5);
  for (const strategy of STRATEGIES) {
    const result = screen(ctx, strategy.id, {});
    assert.ok(result.total >= 1, `${strategy.id} found nothing`);
    for (const candidate of result.candidates) {
      const m = candidate.metrics;
      assert.ok(candidate.passed && candidate.qty >= .01, strategy.id);
      if (m.annualYield !== null) close(m.annualYield, m.netCredit / m.collateral * 365 / m.dte * 100, 1e-9, strategy.id + " annual");
      if (Number.isFinite(m.maxLoss) && m.maxLoss > 0 && Number.isFinite(m.maxProfit)) close(m.returnOnRisk, m.maxProfit / m.maxLoss * 100, 1e-9);
      assert.ok(m.pop === null || m.pop >= 0 && m.pop <= 1);
    }
    for (let i = 1; i < result.candidates.length; i++) {
      const metric = result.rank, better = METRICS[metric].better;
      const a = result.candidates[i - 1].metrics[metric], b = result.candidates[i].metrics[metric];
      if (Number.isFinite(a) && Number.isFinite(b)) assert.ok(better === "low" ? a <= b + 1e-12 : a >= b - 1e-12, `${strategy.id} ranking`);
    }
  }
});

test("crash put honours the conversation's DTE, OTM and cash-secured yield", () => {
  const result = screen(realContext(), "crash-put", {});
  for (const candidate of result.candidates) {
    const [leg] = candidate.legs, m = candidate.metrics;
    assert.equal(leg.action, "SELL");
    assert.ok(candidate.dte >= 30 && candidate.dte <= 60 && leg.otmPct >= 20 && leg.otmPct <= 32);
    close(m.collateral, leg.strike * candidate.qty, 1e-6, "cash-secured base K × q");
    assert.ok(m.annualYield >= 3);
    assert.equal(leg.price, leg.bid, "sells at the best bid");
  }
  assert.equal(result.gate.status, "idle");
  const strict = screen(realContext(), "crash-put", {trigger: "strict"});
  assert.equal(strict.blocked, true);
  assert.equal(strict.candidates.length, 0);
  assert.equal(strict.blockedCount, result.total);
});

test("budget sizing keeps every structure's expiry loss inside the risk budget", () => {
  const result = screen(realContext({riskBudget: 1000}), "budget-put", {});
  assert.ok(result.candidates.some(c => c.structure === "naked") && result.candidates.some(c => c.structure === "vertical"));
  for (const candidate of result.candidates) {
    assert.ok(candidate.metrics.maxLoss <= 1000 + 1e-6, candidate.key);
    assert.ok(candidate.metrics.maxLoss + candidate.metrics.maxLoss / candidate.qty * .01 > 1000 - 1e-6 ||
      candidate.legs.some(leg => (leg.action === "SELL" ? leg.bidQty : leg.askQty) < candidate.qty + .02), "uses the budget");
  }
});

test("near misses explain empty results and a no-bid contract cannot be sold", () => {
  const ctx = realContext();
  const tight = screen(ctx, "crash-put", {otm: [27.5, 30]});
  assert.equal(tight.total, 0);
  assert.ok(tight.nearMisses.length >= 1);
  assert.deepEqual(tight.nearMisses[0].failed, ["otm"]);
  const snapshot = structuredClone(fixture);
  for (const row of snapshot.options) if (row.side === "PUT") row.bid_price = "0";
  const empty = screen(createContext({snapshot, localNow: fixtureNow, klines: {daily}}), "crash-put", {});
  assert.equal(empty.total, 0);
  assert.ok(empty.rejected.byCheck.quote >= 1);
});

test("stale quotes are flagged and account positions consume the budget and discipline", () => {
  const stale = screen(createContext({snapshot: fixture, localNow: fixtureNow + 60_000, klines: {daily}}), "crash-put", {});
  assert.ok(stale.candidates.every(c => c.checks.some(check => check.id === "freshness" && check.status === "warn")));
  const account = {assets: [{asset: "USDT", equity: "1500", available: "900"}],
    positions: [{symbol: "BTC-261127-60000-P", quantity: "-0.01", entryPrice: "300", markPrice: "280", expiryDate: Date.UTC(2026, 10, 27, 8)}]};
  const ctx = realContext({}, account);
  assert.equal(ctx.portfolio.openShortPuts, 1);
  close(ctx.portfolio.openMaxLoss, 600 - 3 + 60000 * .01 * 0, 1, "60000 × 0.01 − 3 premium");
  const result = screen(ctx, "crash-put", {});
  const check = result.candidates[0].checks.find(c => c.id === "openPuts");
  assert.equal(check.status, "warn");
  const enforced = screen(realContext({enforceDiscipline: true}, account), "crash-put", {});
  assert.equal(enforced.total, 0);
  assert.ok(enforced.rejected.byCheck.openPuts >= 1);
  assert.equal(summarizePortfolio(null, ctx.market, mergeSettings({})).connected, false);
});

test("detail analytics: curves match the payoff, overlays add spot and liquidation is found", () => {
  const ctx = realContext();
  const [put] = screen(ctx, "income-put", {quantityMode: "fixed", quantity: .1}).candidates;
  const detail = analyzeCandidate(ctx, put);
  for (const point of detail.curve) close(point.expiry, put.model.payoff.value(point.spot) * put.qty, 1e-6);
  assert.ok(detail.liquidation && detail.liquidation.move < 0 && detail.liquidation.move > -.6, "0.1 BTC on 1,000 USDT liquidates on a deep drop");
  assert.ok(detail.grid.every(row => row.cells.every(cell => Number.isFinite(cell.marginRatio))));
  const [hedge] = screen(ctx, "protective-put", {}).candidates;
  const overlay = analyzeCandidate(ctx, hedge);
  assert.ok(overlay.overlay);
  const crash = overlay.scenarios.find(row => row.move === -.4);
  close(crash.combined, crash.pnl + hedge.qty * (crash.spot - ctx.market.spot), 1e-9);
  assert.ok(crash.combined > crash.spotOnly, "the hedge reduces the crash loss");
  const json = serializeResult(screen(ctx, "short-call", {}));
  assert.equal(json.candidates[0].metrics.maxLoss, "Infinity");
  assert.doesNotThrow(() => JSON.stringify(json));
});

test("screenAll summarises every strategy for the rail", () => {
  const counts = screenAll(realContext(), {}, {strategies: STRATEGIES});
  assert.equal(Object.keys(counts).length, STRATEGIES.length);
  assert.ok(Object.values(counts).every(entry => entry.total >= 1));
});

test("unavailable market data yields an explicit empty result", () => {
  const ctx = createContext({snapshot: {options: [], btc_index_price: null}, localNow: fixtureNow});
  assert.equal(ctx.market.quality.status, "unavailable");
  const result = screen(ctx, "crash-put", {});
  assert.deepEqual([result.total, result.candidates.length], [0, 0]);
  assert.equal(prepareMarket(null).ok, false);
});

/* ------------------------------------------------------------ frame codec */
import {encodeFrame, decodeFrame, validFrame, contentHash} from "../lib/market.mjs";

test("compact frame round-trips the real snapshot exactly and is far smaller", () => {
  const frame = encodeFrame(fixture, fixtureNow);
  const body = JSON.stringify(frame);
  assert.ok(body.length < JSON.stringify(fixture).length / 15, "at least 15× smaller than the full snapshot");
  const decoded = decodeFrame(JSON.parse(body), {receivedAt: fixtureNow, servedAt: fixtureNow});
  const original = prepareMarket(fixture, fixtureNow), roundTrip = prepareMarket(decoded, fixtureNow);
  assert.equal(roundTrip.contracts.length, original.contracts.length);
  for (const contract of original.contracts) {
    const other = roundTrip.bySymbol.get(contract.symbol);
    for (const [key, value] of Object.entries(contract)) {
      if (key === "rules") assert.deepEqual(other.rules, value);
      else if (typeof value === "number") close(other[key], value, 1e-9, contract.symbol + "." + key);
      else assert.deepEqual(other[key], value, contract.symbol + "." + key);
    }
  }
  assert.equal(roundTrip.quality.status, original.quality.status);
});

test("frame decoding carries ages forward and re-anchors both clocks", () => {
  const frame = encodeFrame(fixture, fixtureNow);
  const receivedAt = fixtureNow + 3_600_000;                       // client clock one hour ahead of the server
  const fresh = prepareMarket(decodeFrame(frame, {receivedAt, servedAt: fixtureNow}), receivedAt);
  const later = prepareMarket(decodeFrame(frame, {receivedAt, servedAt: fixtureNow + 30_000}), receivedAt);
  const original = prepareMarket(fixture, fixtureNow);
  const symbol = original.contracts[0].symbol;
  close(fresh.bySymbol.get(symbol).quoteAge, original.bySymbol.get(symbol).quoteAge, 1, "skew-independent age");
  close(later.bySymbol.get(symbol).quoteAge, original.bySymbol.get(symbol).quoteAge + 30_000, 1, "unchanged frame ages with time");
  close(fresh.exchangeNow, original.exchangeNow, 1, "exchange clock unaffected by local skew");
});

test("frame validation rejects malformed or inconsistent payloads", () => {
  const frame = encodeFrame(fixture, fixtureNow);
  assert.equal(validFrame(frame), true);
  for (const broken of [null, {...frame, v: 2}, {...frame, rows: {...frame.rows, k: frame.rows.k.slice(1)}},
    {...frame, rows: {...frame.rows, t: frame.rows.t + "P"}}, {...frame, rules: [[1, 2]]}, {...frame, builtAt: "x"}]) {
    assert.equal(validFrame(broken), false);
  }
  assert.throws(() => decodeFrame({v: 1}, {receivedAt: 0, servedAt: 0}), TypeError);
  assert.equal(contentHash("abc"), contentHash("abc"));
  assert.notEqual(contentHash("abc"), contentHash("abd"));
  assert.equal(JSON.stringify(encodeFrame(fixture, fixtureNow)), JSON.stringify(frame), "deterministic encoding");
});
