/**
 * Strategy screening engine.
 *
 * screen(ctx, strategyId, params) enumerates candidate positions for one
 * strategy, prices them at executable quotes (SELL → best bid, BUY → best ask),
 * computes exact expiry economics and model statistics, applies the strategy's
 * rules as explicit checks and ranks the survivors. analyzeCandidate() adds
 * the heavier detail analytics (payoff curves, stress grid, liquidation point).
 *
 * Read-only by design: nothing here can place or modify orders.
 */
import * as Q from "./quant.mjs";
import {prepareMarket} from "./market.mjs";
import {buildSurface, smileIv, crashTrigger, realizedVolSummary, parseKlines, unpackBars} from "./signals.mjs";
import {METRICS, getStrategy, normalizeParams} from "./strategies.mjs";
import {DEFAULT_SETTINGS, mergeSettings, CHECK_LABELS, CHECK_UNITS, describeCheck} from "./checks.mjs";

// Settings and check vocabulary live in checks.mjs so the interface thread can
// load them without the screening engine; re-exported for existing callers.
export {DEFAULT_SETTINGS, mergeSettings, CHECK_LABELS, CHECK_UNITS, describeCheck};

/* ------------------------------------------------------------------------ */
/* Context                                                                   */
/* ------------------------------------------------------------------------ */

const SYMBOL = /^BTC-(\d{6})-(\d+(?:\.\d+)?)-([CP])$/;

/**
 * Exact combined expiry risk of account positions (per expiry, summed), so
 * hedged spreads are not double counted. Unknown expiries are skipped.
 */
export function summarizePortfolio(account, market, settings) {
  const spot = market.spot;
  const holdingsBtc = settings.holdingsBtc ?? (spot > 0 ? settings.holdingsUsd / spot : 0);
  const base = {connected: false, equity: null, available: null, positions: [], openShortPuts: 0, openShortPutQty: 0,
    openMaxLoss: 0, openLossUnbounded: false, payoutTotal: 0, holdingsBtc, holdingsValue: holdingsBtc * (spot ?? 0)};
  base.payoutCap = base.holdingsValue * settings.payoutCapPct / 100;
  base.budgetRemaining = settings.riskBudget;
  if (!account || !Array.isArray(account.positions)) return base;
  const usdt = (account.assets ?? []).find(asset => asset.asset === "USDT") ?? account.assets?.[0];
  const result = {...base, connected: true, equity: Number(usdt?.equity ?? usdt?.marginBalance) || null,
    available: Number(usdt?.available) || null};
  const byExpiry = new Map();
  for (const position of account.positions) {
    const match = SYMBOL.exec(position.symbol ?? "");
    const quantity = Number(position.quantity);
    if (!match || !Number.isFinite(quantity) || quantity === 0) continue;
    const type = match[3] === "P" ? "PUT" : "CALL", strike = Number(match[2]);
    const entry = Number(position.entryPrice) || 0;
    const contract = market.bySymbol.get(position.symbol);
    const expiryMs = Number(position.expiryDate) || contract?.expiryMs || null;
    const row = {symbol: position.symbol, type, strike, qty: quantity, entry, expiryMs, mark: Number(position.markPrice) || contract?.mark || null,
      unrealized: Number(position.unrealizedPNL) || 0};
    result.positions.push(row);
    if (type === "PUT" && quantity < 0) {
      result.openShortPuts += 1;
      result.openShortPutQty += -quantity;
      result.payoutTotal += strike * -quantity;
    }
    if (expiryMs) {
      const group = byExpiry.get(expiryMs) ?? [];
      group.push(row);
      byExpiry.set(expiryMs, group);
    }
  }
  for (const rows of byExpiry.values()) {
    const upfront = rows.reduce((sum, row) => sum - row.qty * row.entry, 0);
    const profile = Q.payoffProfile(Q.expiryPayoff(rows.map(row => ({type: row.type, strike: row.strike, qty: row.qty})), upfront, settings.fees));
    if (profile.lossUnbounded) result.openLossUnbounded = true;
    else result.openMaxLoss += profile.maxLoss;
  }
  result.budgetRemaining = result.openLossUnbounded ? 0 : Math.max(0, settings.riskBudget - result.openMaxLoss);
  return result;
}

/**
 * Builds the shared evaluation context once per market update.
 * klines: {hourly, daily} as raw Binance rows or packed arrays (optional).
 */
export function createContext({snapshot, localNow = Date.now(), klines = null, settings = {}, account = null} = {}) {
  const market = prepareMarket(snapshot, localNow);
  const merged = mergeSettings(settings);
  const toBars = value => Array.isArray(value) ? parseKlines(value) : unpackBars(value);
  const hourly = klines?.hourlyBars ?? (klines?.hourly ? toBars(klines.hourly) : []);
  const daily = klines?.dailyBars ?? (klines?.daily ? toBars(klines.daily) : []);
  const surface = market.ok ? buildSurface(market) : null;
  const rv = realizedVolSummary(hourly, daily);
  return {market, surface, hourly, daily, rv, settings: merged, account,
    portfolio: market.ok ? summarizePortfolio(account, market, merged) : null};
}

/* ------------------------------------------------------------------------ */
/* Checks                                                                    */
/* ------------------------------------------------------------------------ */

const EPS = 1e-9;

function inRange(id, value, [lo, hi], hard = true) {
  const pass = Number.isFinite(value) && value >= lo - EPS && value <= hi + EPS;
  const width = Math.max(hi - lo, Math.abs(lo) * .1, 1e-6);
  const violation = pass ? 0 : !Number.isFinite(value) ? Infinity : value < lo ? (lo - value) / width : (value - hi) / width;
  return {id, kind: "range", status: pass ? "pass" : "fail", hard, value, lo, hi, violation};
}

function atLeast(id, value, min, hard = true) {
  const pass = Number.isFinite(value) && value >= min - EPS;
  const violation = pass ? 0 : !Number.isFinite(value) ? Infinity : (min - value) / Math.max(Math.abs(min), 1);
  return {id, kind: "min", status: pass ? "pass" : "fail", hard, value, min, violation};
}

function atMost(id, value, max, hard = true) {
  const pass = Number.isFinite(value) && value <= max + EPS;
  const violation = pass ? 0 : !Number.isFinite(value) ? Infinity : (value - max) / Math.max(Math.abs(max), 1);
  return {id, kind: "max", status: pass ? "pass" : "fail", hard, value, max, violation};
}

const flag = (id, status, extra = {}) => ({id, kind: "flag", status, hard: status === "fail", violation: status === "fail" ? Infinity : 0, ...extra});

/* ------------------------------------------------------------------------ */
/* Candidate evaluation                                                      */
/* ------------------------------------------------------------------------ */

const SIGN = {BUY: 1, SELL: -1};
const legPrice = leg => leg.action === "SELL" ? leg.c.bid : leg.c.ask;
const legDepth = leg => leg.action === "SELL" ? leg.c.bidQty : leg.c.askQty;
export const spreadPct = c => c.bid > 0 && c.ask > 0 ? (c.ask - c.bid) / ((c.ask + c.bid) / 2) * 100 : null;

function forecastVol(ctx, expiryAtm) {
  const {settings, rv} = ctx;
  if (settings.evVol === "custom") return {sigma: settings.evVolCustom, source: "custom"};
  if (settings.evVol === "rv7" && rv.rv7) return {sigma: rv.rv7, source: "rv7"};
  if (settings.evVol === "rv30" && rv.rv30) return {sigma: rv.rv30, source: "rv30"};
  if (settings.evVol !== "atm" && rv.rv30) return {sigma: rv.rv30, source: "rv30"};
  return {sigma: expiryAtm ?? settings.evVolCustom, source: expiryAtm ? "atm" : "custom"};
}

/**
 * Prices a same-expiry or calendar structure for one unit of base quantity.
 * Returns null when any leg lacks an executable price.
 */
function priceStructure(ctx, legs) {
  const {market, settings} = ctx, S = market.spot, fees = settings.fees;
  let upfront = 0, gross = 0, entryFees = 0, imPerUnit = 0;
  for (const leg of legs) {
    const price = legPrice(leg);
    if (!(price > 0)) return null;
    const fee = Q.tradeFeePerUnit(S, price, fees) * leg.ratio;
    entryFees += fee;
    gross += (leg.action === "SELL" ? 1 : -1) * price * leg.ratio;
    upfront += (leg.action === "SELL" ? price : -price) * leg.ratio - fee;
    imPerUnit += leg.action === "SELL"
      ? Q.shortOrderMargin(leg.c.type, S, leg.c.strike, leg.c.mark ?? price, price, leg.c.rules, fees) * leg.ratio
      : price * leg.ratio + fee;
  }
  return {upfront, gross, entryFees, imPerUnit};
}

function calendarModel(ctx, legs, priced) {
  const near = legs.find(leg => leg.action === "SELL"), far = legs.find(leg => leg.action === "BUY");
  const fees = ctx.settings.fees, K = near.c.strike, type = near.c.type;
  const tau = far.c.years - near.c.years, sigmaFar = far.c.iv ?? ctx.surface?.byExpiry.get(far.c.expiryMs)?.atmIv;
  if (!(tau > 0) || !(sigmaFar > 0)) return null;
  const qNear = near.ratio, qFar = far.ratio;
  const pnl = S => {
    const farValue = Q.bsPrice(type, S, K, tau, sigmaFar);
    return priced.upfront - qNear * (Q.intrinsic(type, S, K) + Q.exerciseFeePerUnit(type, K, S, fees))
      + qFar * (farValue - Q.tradeFeePerUnit(S, farValue, fees));
  };
  const S0 = ctx.market.spot, v = Math.max(.05, (near.c.iv ?? sigmaFar) * Math.sqrt(near.c.years));
  let maxProfit = -Infinity, minPnl = Infinity;
  const grid = [S0 * 1e-6, S0 * 50];
  for (let i = 0; i <= 200; i++) grid.push(S0 * Math.exp(-6 * v + 12 * v * i / 200));
  for (const S of grid) { const value = pnl(S); maxProfit = Math.max(maxProfit, value); minPnl = Math.min(minPnl, value); }
  return {pnl, maxProfit, maxLoss: Math.max(0, -minPnl), sigmaFar, tau, horizonYears: near.c.years};
}

function evaluate(ctx, strategy, params, legs, extraChecks = [], options = {}) {
  const {market, surface, settings, rv, portfolio} = ctx, S = market.spot;
  const expiryMs = Math.min(...legs.map(leg => leg.c.expiryMs));
  const sameExpiry = legs.every(leg => leg.c.expiryMs === legs[0].c.expiryMs);
  const horizonYears = Math.min(...legs.map(leg => leg.c.years)), dte = horizonYears * 365;
  const surfaceRow = surface?.byExpiry.get(expiryMs);
  const atm = surfaceRow?.atmIv ?? null;
  const main = legs.find(leg => leg.role === "main") ?? legs.find(leg => leg.action === "SELL") ?? legs[0];
  const checks = [...extraChecks];
  const priced = priceStructure(ctx, legs);
  const candidate = {
    key: strategy.id + "|" + legs.map(leg => leg.action[0] + leg.ratio + ":" + leg.c.symbol).join("+"),
    strategyId: strategy.id, expiryMs, dte, structure: options.structure ?? strategy.builder,
    legs: legs.map(leg => ({symbol: leg.c.symbol, type: leg.c.type, action: leg.action, ratio: leg.ratio, role: leg.role ?? null,
      strike: leg.c.strike, expiryMs: leg.c.expiryMs, dte: leg.c.dte, price: legPrice(leg), bid: leg.c.bid, ask: leg.c.ask,
      bidQty: leg.c.bidQty, askQty: leg.c.askQty, mark: leg.c.mark, iv: leg.c.iv, bidIv: leg.c.bidIv, askIv: leg.c.askIv,
      delta: leg.c.delta, gamma: leg.c.gamma, theta: leg.c.theta, vega: leg.c.vega, otmPct: leg.c.otmPct,
      spreadPct: spreadPct(leg.c), quoteAge: leg.c.quoteAge, quoteFresh: leg.c.quoteFresh, minQty: leg.c.minQty, step: leg.c.step,
      volume24h: leg.c.volume24h})),
    checks, metrics: null, qty: null, passed: false,
  };
  // Far outside the parametric rules: skip pricing. Such candidates are
  // rejected anyway and are too far off to be shown as near misses.
  const preFailed = checks.filter(check => check.hard && check.status === "fail");
  if (preFailed.length >= 2 || preFailed.reduce((sum, check) => sum + Math.min(check.violation, 10), 0) >= 1.5) return finish(candidate);
  // Executable quotes are a precondition for every economic number.
  if (!priced) {
    checks.push(flag("quote", "fail", {detail: legs.filter(leg => !(legPrice(leg) > 0)).map(leg => leg.c.symbol + (leg.action === "SELL" ? " 无买一" : " 无卖一")).join("；")}));
    return finish(candidate);
  }
  // Per-unit economics (everything is linear in quantity, including fees).
  let profile, payoff = null, calendar = null;
  if (sameExpiry) {
    payoff = Q.expiryPayoff(legs.map(leg => ({type: leg.c.type, strike: leg.c.strike, qty: SIGN[leg.action] * leg.ratio})), priced.upfront, settings.fees);
    profile = Q.payoffProfile(payoff);
  } else {
    calendar = calendarModel(ctx, legs, priced);
    if (!calendar) { checks.push(flag("quote", "fail", {detail: "远月 IV 缺失，无法估值"})); return finish(candidate); }
    profile = {maxProfit: calendar.maxProfit, maxLoss: calendar.maxLoss, profitUnbounded: false, lossUnbounded: false,
      breakevens: [], valueAtZero: calendar.pnl(S * 1e-6)};
  }
  // Market-implied POP: the risk leg's own mark IV keeps put skew in single
  // legs, verticals and ratios; long-volatility structures use the ATM IV.
  const atmStructure = ["straddle", "strangle", "calendar"].includes(options.structure);
  const popSigma = atmStructure ? (atm ?? main.c.iv) : (main.c.iv ?? atm);
  const forecast = forecastVol(ctx, atm);
  let pop = null, ev1 = null;
  if (popSigma > 0 && forecast.sigma > 0) {
    const popDist = Q.lognormal(S, horizonYears, popSigma, 0), evDist = Q.lognormal(S, horizonYears, forecast.sigma, settings.drift);
    if (payoff) {
      pop = Q.payoffMoments(payoff, popDist).pop;
      ev1 = Q.payoffMoments(payoff, evDist).ev;
    } else {
      pop = Q.sampledStats(calendar.pnl, popDist, 384).pop;
      ev1 = Q.sampledStats(calendar.pnl, evDist, 384).ev;
    }
  }
  // Break-even cushion relative to today's index.
  const valueNow = payoff ? payoff.value(S) : calendar.pnl(S);
  const nearestBe = profile.breakevens.length ? profile.breakevens.reduce((best, be) => Math.abs(be - S) < Math.abs(best - S) ? be : best) : null;
  const beDistance = nearestBe ? Math.abs(nearestBe - S) / S * 100 : null;
  const cushion = beDistance === null ? null : valueNow >= 0 ? beDistance : -beDistance;
  // Capital base per unit.
  const liabilityAtZero = payoff ? Math.max(0, priced.upfront - payoff.value(0)) : null;
  const collateralPerUnit = strategy.collateral === "cash" ? liabilityAtZero
    : strategy.collateral === "maxLoss" ? (profile.lossUnbounded ? null : profile.maxLoss)
      : strategy.collateral === "notional" ? S * (legs.find(leg => leg.action === "SELL")?.ratio ?? 1)
        : Math.max(0, -priced.upfront);

  // Quantity resolution.
  const minQty = Math.max(...legs.map(leg => leg.c.minQty ?? .01));
  const step = Math.max(...legs.map(leg => leg.c.step ?? .01));
  const mode = options.quantityMode ?? params.quantityMode ?? "fixed";
  const budgetLeft = portfolio?.budgetRemaining ?? settings.riskBudget;
  const budgetQty = profile.lossUnbounded || !(profile.maxLoss > 0) ? null : Q.floorToStep(budgetLeft / profile.maxLoss, step);
  let qty;
  if (mode === "budget") qty = budgetQty ?? Q.floorToStep(params.quantity ?? minQty, step);
  else if (mode === "holdings") qty = Q.floorToStep(portfolio?.holdingsBtc ?? 0, step);
  else qty = Q.floorToStep(params.quantity ?? minQty, step) || minQty;
  candidate.qty = qty;
  candidate.quantityMode = mode;
  if (!(qty >= minQty - EPS)) {
    checks.push(flag("quantity", "fail", {detail: mode === "budget" ? `剩余预算 ${budgetLeft.toFixed(2)} USDT 不足以开最小数量 ${minQty}`
      : mode === "holdings" ? `现货持仓不足最小数量 ${minQty} BTC` : `数量低于最小数量 ${minQty}`}));
  }
  const q = Math.max(qty, 0);

  // Liquidity and depth.
  for (const leg of legs) {
    const depth = legDepth(leg), need = q * leg.ratio;
    if (depth !== null && depth < need - EPS) {
      checks.push(flag("depth", "fail", {detail: `${leg.c.symbol} ${leg.action === "SELL" ? "买一" : "卖一"}仅 ${depth} 张，需 ${Number(need.toFixed(4))} 张`}));
      break;
    }
    if (depth === null) { checks.push(flag("depth", "warn", {detail: `${leg.c.symbol} 盘口数量未知`})); break; }
  }
  const spreads = legs.map(leg => spreadPct(leg.c));
  const worstSpread = spreads.some(value => value === null) ? null : Math.max(...spreads);
  if (params.maxSpread !== undefined) {
    if (worstSpread === null) checks.push(flag("spread", "warn", {detail: "单边报价缺失，无法计算价差"}));
    else checks.push(atMost("spread", worstSpread, params.maxSpread));
  }

  // Volatility context.
  const mainIv = ["straddle", "strangle"].includes(options.structure)
    ? legs.reduce((s, leg) => s + (leg.c.iv ?? 0), 0) / legs.length : main.c.iv;
  const ivRv = mainIv > 0 && rv.rv30 ? mainIv / rv.rv30 : null;
  const fit = surfaceRow?.fit ?? null;
  const fair = fit ? smileIv(fit, main.c.k) : null;
  const richness = main.action === "SELL"
    ? (main.c.bidIv > 0 && fair ? (main.c.bidIv - fair) * 100 : main.c.bidIv > 0 && main.c.iv > 0 ? (main.c.bidIv - main.c.iv) * 100 : null)
    : (main.c.askIv > 0 && fair ? (fair - main.c.askIv) * 100 : null);

  // Scale to quantity.
  const credit = priced.upfront * q, maxProfit = profile.profitUnbounded ? Infinity : profile.maxProfit * q;
  const maxLoss = profile.lossUnbounded ? Infinity : profile.maxLoss * q;
  const collateral = collateralPerUnit === null ? null : collateralPerUnit * q;
  const greek = key => legs.reduce((sum, leg) => {
    let value = leg.c[key];
    if (value === null && leg.c.iv > 0) value = Q.bsGreeks(leg.c.type, S, leg.c.strike, leg.c.years, leg.c.iv)[key];
    return sum + SIGN[leg.action] * leg.ratio * q * (value ?? 0);
  }, 0);
  const expectedMove = atm ? atm * Math.sqrt(horizonYears) * 100 : null;
  const moveToBe = cushion !== null && cushion < 0 ? -cushion : cushion !== null ? 0 : null;
  const metrics = {
    netCredit: credit, grossPremium: priced.gross * q, entryFees: priced.entryFees * q,
    maxProfit, maxLoss, profitUnbounded: profile.profitUnbounded, lossUnbounded: profile.lossUnbounded,
    breakevens: profile.breakevens, breakevenDist: cushion, valueNow: valueNow * q,
    collateral, collateralBasis: strategy.collateral,
    periodYield: credit > 0 && collateral > 0 ? credit / collateral * 100 : null,
    annualYield: credit > 0 && collateral > 0 && dte > 0 ? credit / collateral * 365 / dte * 100 : null,
    dailyPremium: dte > 0 ? credit / dte : null,
    returnOnRisk: Number.isFinite(maxProfit) && maxLoss > 0 && Number.isFinite(maxLoss) ? maxProfit / maxLoss * 100 : null,
    pop, ev: ev1 === null ? null : ev1 * q, evSigma: forecast.sigma, evSigmaSource: forecast.source, popSigma,
    pItm: main.c.iv > 0 ? Q.probabilityItm(main.c.type, S, main.c.strike, main.c.years, main.c.iv) * 100 : null,
    otm: main.c.otmPct, dte, iv: mainIv ? mainIv * 100 : null, ivRv, richness,
    delta: greek("delta"), gamma: greek("gamma"), theta: greek("theta"), vega: greek("vega"),
    spread: worstSpread, marginIm: priced.imPerUnit * q,
    costAnnual: credit < 0 && dte > 0 ? -credit / (S * q) * 365 / dte * 100 : null,
    protection: options.structure === "protective" ? (S - main.c.strike + Math.max(0, -priced.upfront)) / S * 100 : null,
    termSpread: options.structure === "calendar" ? ((legs.find(l => l.action === "SELL").c.iv ?? 0) - (legs.find(l => l.action === "BUY").c.iv ?? 0)) * 100 : null,
    budgetQty, budgetPremium: budgetQty ? priced.upfront * budgetQty : null,
    expectedMove, moveToBe, moveRatio: moveToBe !== null && expectedMove ? moveToBe / expectedMove : null,
    width: options.width ?? null,
  };
  metrics.annualRor = metrics.returnOnRisk !== null && dte > 0 ? metrics.returnOnRisk * 365 / dte : null;
  metrics.evRisk = metrics.ev !== null && maxLoss > 0 && Number.isFinite(maxLoss) ? metrics.ev / maxLoss * 100 : null;
  metrics.es99 = null;
  candidate.metrics = metrics;
  candidate.model = {payoff, calendar, horizonYears, atm, forecast};

  // Strategy economics checks.
  const sells = legs.some(leg => leg.action === "SELL");
  if (options.requireCredit ?? (sells && strategy.collateral !== "premium")) checks.push(atLeast("credit", credit, 1e-9));
  if (options.requireDebit) checks.push(atLeast("debit", -credit, 1e-9));
  if (params.minAnnual !== undefined) checks.push(atLeast("minAnnual", metrics.annualYield ?? -Infinity, params.minAnnual));
  if (params.minRor !== undefined) checks.push(atLeast("minRor", metrics.returnOnRisk ?? -Infinity, params.minRor));
  if (params.maxCostAnnual !== undefined) checks.push(atMost("maxCostAnnual", metrics.costAnnual ?? Infinity, params.maxCostAnnual));
  for (const [key, test] of [["minIvRv", atLeast], ["maxIvRv", atMost]]) {
    if (params[key] === undefined) continue;
    if (ivRv === null) checks.push(flag(key, "warn", {detail: "缺少 30 日已实现波动率，未检查"}));
    else checks.push(test(key, ivRv, params[key]));
  }
  if (params.minRichness !== undefined) {
    if (richness === null) checks.push(flag("minRichness", "warn", {detail: "该到期日微笑拟合不足，未检查"}));
    else checks.push(atLeast("minRichness", richness, params.minRichness));
  }

  // Data quality.
  const staleLegs = legs.filter(leg => !leg.c.quoteFresh);
  if (market.quality.replay) checks.push(flag("replay", "info", {detail: "回放快照，非实时报价"}));
  else if (staleLegs.length) checks.push(flag("freshness", "warn", {detail: staleLegs.map(leg => `${leg.c.symbol} 报价 ${leg.c.quoteAge === null ? "时间未知" : Math.round(leg.c.quoteAge / 1000) + " 秒前"}`).join("；")}));
  else if (legs.some(leg => !leg.c.quoteVerified)) checks.push(flag("freshness", "warn", {detail: "盘口快照待核验"}));
  if (legs.some(leg => !leg.c.rulesVerified)) checks.push(flag("rules", "warn", {detail: "合约规则未核验，保证金按默认费率估算"}));

  // Portfolio discipline (warnings unless the user enforces them).
  const hardDiscipline = settings.enforceDiscipline;
  const disc = (id, ok, detail) => checks.push(ok ? flag(id, "pass", {detail}) : flag(id, hardDiscipline ? "fail" : "warn", {detail}));
  const coveredBySpot = strategy.covered && q <= (portfolio?.holdingsBtc ?? 0) + EPS;
  if (Number.isFinite(maxLoss)) disc("budget", maxLoss <= budgetLeft + EPS, `最大亏损 ${maxLoss.toFixed(2)} / 剩余预算 ${budgetLeft.toFixed(2)} USDT`);
  else if (coveredBySpot) checks.push(flag("budget", "info", {detail: `上涨亏损由 ${(portfolio?.holdingsBtc ?? 0).toFixed(4)} BTC 现货在经济上覆盖；币安仍需独立 USDT 保证金`}));
  else disc("budget", false, "理论亏损无上限，任何有限预算都不能覆盖");
  // Naked short-put exposure (net short puts) drives the count and size
  // limits; the payout cap (对话 #107) also applies to spreads via K·q netting.
  const nakedPuts = legs.filter(leg => leg.c.type === "PUT").reduce((sum, leg) => sum - SIGN[leg.action] * leg.ratio * q, 0);
  if (nakedPuts > EPS) {
    disc("openPuts", (portfolio?.openShortPuts ?? 0) + 1 <= settings.maxOpenShortPuts,
      `已有 ${portfolio?.openShortPuts ?? 0} 笔未到期卖 Put，上限 ${settings.maxOpenShortPuts} 笔`);
    disc("putQty", (portfolio?.openShortPutQty ?? 0) + nakedPuts <= settings.maxShortPutQty + EPS,
      `合计 ${((portfolio?.openShortPutQty ?? 0) + nakedPuts).toFixed(2)} BTC，上限 ${settings.maxShortPutQty} BTC`);
  }
  const putPayout = legs.filter(leg => leg.c.type === "PUT").reduce((sum, leg) => sum - SIGN[leg.action] * leg.c.strike * leg.ratio * q, 0);
  if (putPayout > EPS && portfolio?.payoutCap > 0) {
    disc("payoutCap", (portfolio.payoutTotal ?? 0) + putPayout <= portfolio.payoutCap + EPS,
      `最大赔付 ${((portfolio.payoutTotal ?? 0) + putPayout).toFixed(0)} / 上限 ${portfolio.payoutCap.toFixed(0)} USDT`);
  }
  if (portfolio?.connected && portfolio.available !== null && sells) {
    checks.push(metrics.marginIm < portfolio.available ? flag("margin", "pass", {detail: `需约 ${metrics.marginIm.toFixed(2)} / 可用 ${portfolio.available.toFixed(2)} USDT`})
      : flag("margin", hardDiscipline ? "fail" : "warn", {detail: `需约 ${metrics.marginIm.toFixed(2)} USDT，可用仅 ${portfolio.available.toFixed(2)} USDT`}));
  }
  return finish(candidate);
}

function finish(candidate) {
  const failed = candidate.checks.filter(check => check.hard && check.status === "fail");
  candidate.passed = failed.length === 0;
  candidate.failed = failed.map(check => check.id);
  candidate.violation = failed.reduce((sum, check) => sum + Math.min(check.violation, 10), 0);
  candidate.warnings = candidate.checks.filter(check => check.status === "warn").length;
  return candidate;
}

/* ------------------------------------------------------------------------ */
/* Builders                                                                  */
/* ------------------------------------------------------------------------ */

const slackRange = ([lo, hi], fraction = .35, minimum = 2) => {
  const pad = Math.max((hi - lo) * fraction, minimum);
  return [lo - pad, hi + pad];
};

function expiriesIn(ctx, range) {
  const [lo, hi] = slackRange(range, .35, 3);
  return ctx.market.expiries.filter(group => group.dte >= lo && group.dte <= hi);
}

function* buildSingle(ctx, strategy, params) {
  const {action, type} = strategy.leg;
  const otmSlack = params.otm ? slackRange(params.otm, .5, 4) : null;
  for (const group of expiriesIn(ctx, params.dte)) {
    for (const c of type === "PUT" ? group.puts : group.calls) {
      if (otmSlack && (c.otmPct < otmSlack[0] || c.otmPct > otmSlack[1])) continue;
      const checks = [inRange("dte", c.dte, params.dte)];
      if (params.otm) checks.push(inRange("otm", c.otmPct, params.otm));
      if (params.delta) checks.push(c.delta === null ? flag("delta", "fail", {detail: "Delta 缺失"}) : inRange("delta", Math.abs(c.delta), params.delta));
      yield {legs: [{c, action, ratio: 1, role: "main"}], checks,
        options: {structure: strategy.id === "protective-put" ? "protective" : "single"}};
    }
  }
}

function* buildVertical(ctx, strategy, params) {
  const {type, kind} = strategy.vertical, S = ctx.market.spot;
  const widthSlack = slackRange(params.width, .35, 2);
  for (const group of expiriesIn(ctx, params.dte)) {
    const list = type === "PUT" ? group.puts : group.calls;
    if (kind === "credit") {
      const shortSlack = slackRange(params.shortOtm, .35, 3);
      for (const short of list) {
        if (short.otmPct < shortSlack[0] || short.otmPct > shortSlack[1]) continue;
        for (const long of list) {
          const width = (type === "PUT" ? short.strike - long.strike : long.strike - short.strike) / S * 100;
          if (!(width > 0) || width < widthSlack[0] || width > widthSlack[1]) continue;
          yield {legs: [{c: short, action: "SELL", ratio: 1, role: "main"}, {c: long, action: "BUY", ratio: 1, role: "hedge"}],
            checks: [inRange("dte", short.dte, params.dte), inRange("shortOtm", short.otmPct, params.shortOtm), inRange("width", width, params.width)],
            options: {structure: "vertical", width, requireCredit: true}};
        }
      }
    } else {
      const longSlack = slackRange(params.longOtm, .35, 3);
      for (const long of list) {
        if (long.otmPct < longSlack[0] || long.otmPct > longSlack[1]) continue;
        for (const short of list) {
          const width = (type === "CALL" ? short.strike - long.strike : long.strike - short.strike) / S * 100;
          if (!(width > 0) || width < widthSlack[0] || width > widthSlack[1]) continue;
          yield {legs: [{c: long, action: "BUY", ratio: 1, role: "main"}, {c: short, action: "SELL", ratio: 1, role: "hedge"}],
            checks: [inRange("dte", long.dte, params.dte), inRange("longOtm", long.otmPct, params.longOtm), inRange("width", width, params.width)],
            options: {structure: "vertical", width, requireCredit: false, requireDebit: true}};
        }
      }
    }
  }
}

function* buildBudget(ctx, strategy, params) {
  const S = ctx.market.spot;
  const shortSlack = slackRange(params.shortOtm, .35, 3), widthSlack = slackRange(params.width, .35, 2);
  for (const group of expiriesIn(ctx, params.dte)) {
    for (const short of group.puts) {
      if (short.otmPct < shortSlack[0] || short.otmPct > shortSlack[1]) continue;
      const base = [inRange("dte", short.dte, params.dte), inRange("shortOtm", short.otmPct, params.shortOtm)];
      if (params.structures !== "spread") {
        yield {legs: [{c: short, action: "SELL", ratio: 1, role: "main"}], checks: [...base],
          options: {structure: "naked", quantityMode: "budget", requireCredit: true}};
      }
      if (params.structures === "naked") continue;
      for (const long of group.puts) {
        const width = (short.strike - long.strike) / S * 100;
        if (!(width > 0) || width < widthSlack[0] || width > widthSlack[1]) continue;
        yield {legs: [{c: short, action: "SELL", ratio: 1, role: "main"}, {c: long, action: "BUY", ratio: 1, role: "hedge"}],
          checks: [...base, inRange("width", width, params.width)],
          options: {structure: "vertical", width, quantityMode: "budget", requireCredit: true}};
      }
    }
  }
}

function* buildStraddle(ctx, strategy, params) {
  const S = ctx.market.spot;
  for (const group of expiriesIn(ctx, params.dte)) {
    for (const strike of group.strikes) {
      const pair = group.byStrike.get(strike);
      if (!pair.CALL || !pair.PUT) continue;
      const distance = Math.abs(strike / S - 1) * 100;
      if (distance > params.atmBand * 2 + 2) continue;
      yield {legs: [{c: pair.CALL, action: "BUY", ratio: 1, role: "main"}, {c: pair.PUT, action: "BUY", ratio: 1}],
        checks: [inRange("dte", group.dte, params.dte), atMost("atmBand", distance, params.atmBand)],
        options: {structure: "straddle", requireCredit: false, requireDebit: true}};
    }
  }
}

function* buildStrangle(ctx, strategy, params) {
  const S = ctx.market.spot, [lo, hi] = params.delta, slack = slackRange(params.delta, .5, .05);
  for (const group of expiriesIn(ctx, params.dte)) {
    const puts = group.puts.filter(c => c.strike < S && c.delta !== null && Math.abs(c.delta) >= slack[0] && Math.abs(c.delta) <= slack[1]);
    const calls = group.calls.filter(c => c.strike > S && c.delta !== null && c.delta >= slack[0] && c.delta <= slack[1]);
    for (const put of puts) for (const call of calls) {
      const imbalance = Math.abs(Math.abs(call.delta) - Math.abs(put.delta));
      if (imbalance > params.balance * 2 + .05) continue;
      yield {legs: [{c: call, action: "BUY", ratio: 1, role: "main"}, {c: put, action: "BUY", ratio: 1}],
        checks: [inRange("dte", group.dte, params.dte), inRange("delta", Math.abs(put.delta), [lo, hi]),
          inRange("delta", Math.abs(call.delta), [lo, hi]), atMost("balance", imbalance, params.balance)],
        options: {structure: "strangle", requireCredit: false, requireDebit: true}};
    }
  }
}

function* buildCalendar(ctx, strategy, params) {
  const S = ctx.market.spot;
  const nears = expiriesIn(ctx, params.nearDte), fars = expiriesIn(ctx, params.farDte);
  for (const near of nears) for (const far of fars) {
    if (far.expiryMs <= near.expiryMs) continue;
    for (const strike of near.strikes) {
      const distance = Math.abs(strike / S - 1) * 100;
      if (distance > params.atmBand * 2 + 2) continue;
      const type = params.optionType === "AUTO" ? (strike >= S ? "CALL" : "PUT") : params.optionType;
      const n = near.byStrike.get(strike)?.[type], f = far.byStrike.get(strike)?.[type];
      if (!n || !f) continue;
      yield {legs: [{c: n, action: "SELL", ratio: 1, role: "main"}, {c: f, action: "BUY", ratio: 1}],
        checks: [inRange("nearDte", near.dte, params.nearDte), inRange("farDte", far.dte, params.farDte), atMost("atmBand", distance, params.atmBand)],
        options: {structure: "calendar", requireCredit: false, requireDebit: true}};
    }
  }
}

function* buildRatio(ctx, strategy, params) {
  const longSlack = slackRange(params.longOtm, .35, 3), shortSlack = slackRange(params.shortOtm, .35, 3);
  for (const group of expiriesIn(ctx, params.dte)) {
    for (const long of group.puts) {
      if (long.otmPct < longSlack[0] || long.otmPct > longSlack[1]) continue;
      for (const short of group.puts) {
        if (short.strike >= long.strike || short.otmPct < shortSlack[0] || short.otmPct > shortSlack[1]) continue;
        yield {legs: [{c: long, action: "BUY", ratio: 1}, {c: short, action: "SELL", ratio: params.ratio, role: "main"}],
          checks: [inRange("dte", group.dte, params.dte), inRange("longOtm", long.otmPct, params.longOtm), inRange("shortOtm", short.otmPct, params.shortOtm)],
          options: {structure: "ratio", requireCredit: false}};
      }
    }
  }
}

const BUILDERS = {single: buildSingle, vertical: buildVertical, budget: buildBudget, straddle: buildStraddle,
  strangle: buildStrangle, calendar: buildCalendar, ratio: buildRatio};

/* ------------------------------------------------------------------------ */
/* Screening                                                                 */
/* ------------------------------------------------------------------------ */

function rankValue(candidate, metric) {
  const value = candidate.metrics?.[metric];
  return Number.isFinite(value) ? value : null;
}

export function sortCandidates(list, metric) {
  const better = METRICS[metric]?.better ?? "high";
  return list.sort((a, b) => {
    const x = rankValue(a, metric), y = rankValue(b, metric);
    if ((x === null) !== (y === null)) return x === null ? 1 : -1;
    if (x !== null && x !== y) return better === "low" ? x - y : y - x;
    return (b.metrics?.ev ?? -Infinity) - (a.metrics?.ev ?? -Infinity) || a.key.localeCompare(b.key);
  });
}

function attachTail(ctx, candidate) {
  const {model, metrics, qty} = candidate;
  if (!model || !metrics || metrics.es99 !== null) return;
  const dist = Q.lognormal(ctx.market.spot, model.horizonYears, model.forecast.sigma, ctx.settings.drift);
  const tail = model.payoff ? Q.payoffTail(model.payoff, dist) : Q.sampledStats(model.calendar.pnl, dist, 2048);
  metrics.es99 = tail.es99 * qty;
  metrics.var99 = tail.var99 * qty;
}

/** Evaluates the strategy's trigger gate (crash trigger) for the given params. */
export function evaluateGate(ctx, params) {
  if (params.trigger === undefined || params.trigger === "off") return null;
  const bars = ctx.hourly.length ? ctx.hourly : ctx.daily;
  const result = crashTrigger(bars, ctx.market.exchangeNow, ctx.market.spot,
    {windowHours: Number(params.dropWindow), thresholdPct: Number(params.dropPct)});
  return {...result, mode: params.trigger, resolution: ctx.hourly.length ? "1h" : bars.length ? "1d" : null};
}

/**
 * Screens one strategy. Returns ranked candidates plus full diagnostics:
 * rejection counts per rule and the nearest misses when nothing qualifies.
 */
export function screen(ctx, strategyId, rawParams = {}, {limit = 150, nearMisses = 6, budgetMs = 1500} = {}) {
  const started = Date.now();
  const strategy = getStrategy(strategyId);
  if (!strategy) throw new RangeError("未知策略：" + strategyId);
  const {params, issues} = normalizeParams(strategy, rawParams);
  const result = {strategyId, params, issues, gate: null, blocked: false, candidates: [], total: 0, evaluated: 0,
    rejected: {total: 0, byCheck: {}}, nearMisses: [], quality: ctx.market.quality, spot: ctx.market.spot,
    exchangeNow: ctx.market.exchangeNow, truncated: false, model: null, elapsedMs: 0};
  if (!ctx.market.ok) { result.elapsedMs = Date.now() - started; return result; }
  const gate = evaluateGate(ctx, params);
  result.gate = gate;
  const builder = BUILDERS[strategy.builder];
  const passed = [], misses = [];
  for (const draft of builder(ctx, strategy, params)) {
    if (Date.now() - started > budgetMs) { result.truncated = true; break; }
    const gateCheck = gate ? flag("trigger", gate.status === "triggered" ? "pass" : gate.status === "unknown" ? "info" : "warn",
      {detail: gate.drawdownPct === null ? "无法计算回撤" : `${gate.windowHours}h 回撤 ${gate.drawdownPct.toFixed(2)}%，阈值 ${gate.thresholdPct}%`}) : null;
    const candidate = evaluate(ctx, strategy, params, draft.legs, gateCheck ? [gateCheck, ...draft.checks] : draft.checks, draft.options);
    result.evaluated++;
    if (candidate.passed) passed.push(candidate);
    else {
      result.rejected.total++;
      for (const id of candidate.failed) result.rejected.byCheck[id] = (result.rejected.byCheck[id] ?? 0) + 1;
      if (candidate.failed.length === 1 && candidate.violation < 1.5 && candidate.metrics) misses.push(candidate);
    }
  }
  const rank = params.rank ?? strategy.params.find(p => p.key === "rank")?.default;
  sortCandidates(passed, rank);
  result.total = passed.length;
  if (gate?.mode === "strict" && gate.status !== "triggered") {
    result.blocked = true;
    result.blockedCount = passed.length;
  } else {
    result.candidates = passed.slice(0, limit);
  }
  misses.sort((a, b) => a.violation - b.violation || (b.metrics?.ev ?? 0) - (a.metrics?.ev ?? 0));
  const seen = new Set();
  for (const miss of misses) {
    const key = miss.failed[0] + "|" + miss.legs.map(leg => leg.symbol).join("+");
    if (seen.has(key)) continue;
    seen.add(key);
    result.nearMisses.push(miss);
    if (result.nearMisses.length >= nearMisses) break;
  }
  for (const candidate of [...result.candidates.slice(0, 60), ...result.nearMisses]) attachTail(ctx, candidate);
  result.rank = rank;
  result.model = {popSource: "合约标记 IV（多腿用到期日平值 IV）", evSource: ctx.settings.evVol, rv: ctx.rv, atmIv30: ctx.surface?.atmIv30 ?? null};
  result.elapsedMs = Date.now() - started;
  return result;
}

/** Counts qualifying candidates for every strategy (for the strategy rail). */
export function screenAll(ctx, paramsById = {}, options = {}) {
  const counts = {};
  for (const strategy of options.strategies ?? []) {
    try {
      const result = screen(ctx, strategy.id, paramsById[strategy.id] ?? {}, {limit: 1, nearMisses: 0, budgetMs: options.budgetMs ?? 400});
      counts[strategy.id] = {total: result.total, blocked: result.blocked, gate: result.gate?.status ?? null,
        best: result.candidates[0] ?? null, truncated: result.truncated};
    } catch {
      counts[strategy.id] = {total: null, error: true};
    }
  }
  return counts;
}

/* ------------------------------------------------------------------------ */
/* Detail analytics                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Heavy analytics for one candidate: payoff curves (expiry and T+0), model
 * density, expiry scenarios, mark-to-market stress grid with margin ratio and
 * an estimated liquidation move. Cheap enough to recompute on every tick.
 */
export function analyzeCandidate(ctx, candidate, {points = 241, moves, ivShifts, equity} = {}) {
  const strategy = getStrategy(candidate.strategyId);
  const {market, settings, portfolio} = ctx, S = market.spot, q = candidate.qty, fees = settings.fees;
  const legs = candidate.legs.map(leg => ({...leg, c: market.bySymbol.get(leg.symbol)}));
  if (legs.some(leg => !leg.c) || !(q > 0)) return null;
  const model = candidate.model;
  const elapsed = Math.min(settings.stressElapsedDays, candidate.dte * .999) / 365;
  const horizon = model.horizonYears;
  const anchor = leg => {
    const sigma = leg.c.iv ?? model.atm ?? .6;
    const base = Q.bsPrice(leg.c.type, S, leg.c.strike, leg.c.years, sigma);
    const mark = leg.c.mark ?? base;
    return (spot, shift = 0, years = leg.c.years) => {
      const value = Q.bsPrice(leg.c.type, spot, leg.c.strike, Math.max(0, years), Math.min(5, Math.max(.01, sigma + shift)));
      return Math.max(Q.intrinsic(leg.c.type, spot, leg.c.strike), mark + value - base);
    };
  };
  const pricers = legs.map(anchor);
  const upfront = candidate.metrics.netCredit;
  const mtm = (spot, shift = 0, dt = 0) => legs.reduce((sum, leg, i) =>
    sum + SIGN[leg.action] * leg.ratio * q * pricers[i](spot, shift, leg.c.years - dt), upfront);
  const expiryValue = spot => model.payoff ? model.payoff.value(spot) * q : model.calendar.pnl(spot) * q;
  // Chart domain: ±max(4σ, 45%) around spot, always including strikes and break-evens.
  const sigma = model.atm ?? model.forecast.sigma ?? .6;
  const span = Math.max(.45, 4 * sigma * Math.sqrt(horizon));
  const strikes = legs.map(leg => leg.strike);
  let low = Math.min(S * Math.exp(-span), ...strikes.map(k => k * .9), ...candidate.metrics.breakevens.map(b => b * .95));
  let high = Math.max(S * Math.exp(span * .8), ...strikes.map(k => k * 1.1), ...candidate.metrics.breakevens.map(b => b * 1.05));
  low = Math.max(S * .02, low); high = Math.min(S * 6, high);
  const dist = Q.lognormal(S, horizon, model.forecast.sigma, settings.drift);
  // Strategies defined against spot holdings (protective put, covered call)
  // also show the combined spot + option result, as in conversation #26.
  const overlayQty = strategy?.overlay === "spot" ? q : 0;
  const spotPnl = spot => overlayQty * (spot - S);
  const point = (spot, knot = false) => {
    const z = (Math.log(spot) - dist.m) / (dist.v || 1);
    const expiry = expiryValue(spot), now = mtm(spot);
    return {spot, expiry, now, density: knot || !(dist.v > 0) ? 0 : Q.normPdf(z) / (spot * dist.v), knot,
      ...(overlayQty ? {spotOnly: spotPnl(spot), combined: expiry + spotPnl(spot)} : {})};
  };
  const curve = [];
  for (let i = 0; i < points; i++) curve.push(point(low + (high - low) * i / (points - 1)));
  for (const k of [...new Set([...strikes, ...candidate.metrics.breakevens])]) {
    if (k > low && k < high) curve.push(point(k, true));
  }
  curve.sort((a, b) => a.spot - b.spot);
  const tail = model.payoff ? Q.payoffTail(model.payoff, dist) : Q.sampledStats(model.calendar.pnl, dist, 4096);
  const stressMoves = moves ?? strategy?.stress?.moves ?? [-.2, -.4, -.6];
  const shifts = ivShifts ?? strategy?.stress?.ivShifts ?? [0, .2, .6];
  const scenarioMoves = [...new Set([...stressMoves, -.6, -.4, -.3, -.2, -.1, 0, .1, .2, .3])].sort((a, b) => a - b);
  const scenarios = scenarioMoves.map(move => {
    const spot = S * (1 + move), pnl = expiryValue(spot);
    return {move, spot, pnl, ...(overlayQty ? {spotOnly: spotPnl(spot), combined: pnl + spotPnl(spot)} : {})};
  });
  // Margin stress (standard account: short legs margined individually).
  const startEquity = equity ?? (portfolio?.connected && portfolio.equity ? portfolio.equity : settings.riskBudget);
  const adjusted = startEquity + upfront;
  const shorts = legs.map((leg, i) => ({leg, i})).filter(item => item.leg.action === "SELL");
  const marginRatio = (spot, shift) => {
    if (!shorts.length || !(adjusted > 0)) return shorts.length ? Infinity : 0;
    const mm = shorts.reduce((sum, {leg, i}) => sum + Q.shortMaintenanceMargin(leg.c.type, spot, leg.c.strike,
      pricers[i](spot, shift, leg.c.years - elapsed), leg.c.rules) * leg.ratio * q, 0);
    return mm / adjusted;
  };
  const grid = stressMoves.map(move => ({move, cells: shifts.map(shift => {
    const spot = S * (1 + move), pnl = mtm(spot, shift, elapsed), ratio = marginRatio(spot, shift);
    return {shift, spot, pnl, marginRatio: ratio, state: ratio >= 1 ? "liquidation" : ratio >= .8 ? "warning" : "normal",
      ...(overlayQty ? {combined: pnl + spotPnl(spot)} : {})};
  })}));
  // Smallest adverse move that pushes MM above equity, at +IV shift.
  let liquidation = null;
  if (shorts.length) {
    const down = candidate.metrics.delta >= 0;
    const shift = settings.stressIvShift;
    const ratioAt = m => marginRatio(S * (1 + (down ? -m : m)), shift);
    const now = marginRatio(S, 0);
    if (ratioAt(0) >= 1) liquidation = {move: 0, direction: down ? "down" : "up", ivShift: shift, immediate: true};
    else {
      const limitMove = down ? .98 : 3;
      if (ratioAt(limitMove) >= 1) {
        let lo = 0, hi = limitMove;
        for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (ratioAt(mid) >= 1) hi = mid; else lo = mid; }
        liquidation = {move: down ? -hi : hi, spot: S * (1 + (down ? -hi : hi)), direction: down ? "down" : "up", ivShift: shift};
      } else liquidation = {move: null, direction: down ? "down" : "up", ivShift: shift, safe: true};
    }
    liquidation.currentRatio = now;
    liquidation.equity = startEquity;
    liquidation.equitySource = equity ? "custom" : portfolio?.connected && portfolio.equity ? "account" : "budget";
  }
  return {curve, domain: [low, high], overlay: overlayQty ? {qty: overlayQty, label: "现货 + 期权"} : null,
    tail: {var95: tail.var95 * q, es95: tail.es95 * q, var99: tail.var99 * q, es99: tail.es99 * q},
    scenarios, grid, shifts, liquidation, elapsedDays: elapsed * 365, distribution: {sigma: model.forecast.sigma, source: model.forecast.source, years: horizon}};
}

/** JSON-safe projection of a screening result for the HTTP API. */
export function serializeResult(result) {
  const clean = value => typeof value === "number" && !Number.isFinite(value) ? (value > 0 ? "Infinity" : value < 0 ? "-Infinity" : null) : value;
  const candidate = c => ({key: c.key, strategyId: c.strategyId, structure: c.structure, expiryMs: c.expiryMs, dte: c.dte, qty: c.qty,
    quantityMode: c.quantityMode, legs: c.legs, passed: c.passed, failed: c.failed,
    metrics: Object.fromEntries(Object.entries(c.metrics ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v : clean(v)])),
    checks: c.checks.map(check => ({id: check.id, label: CHECK_LABELS[check.id] ?? check.id, status: check.status, hard: check.hard,
      text: describeCheck(check, id => CHECK_UNITS[id] ?? "")}))});
  return {strategyId: result.strategyId, params: result.params, issues: result.issues, rank: result.rank, spot: result.spot,
    exchangeNow: result.exchangeNow, quality: result.quality, gate: result.gate, blocked: result.blocked, blockedCount: result.blockedCount ?? null,
    total: result.total, evaluated: result.evaluated, truncated: result.truncated, rejected: result.rejected,
    candidates: result.candidates.map(candidate), nearMisses: result.nearMisses.map(candidate), model: result.model, elapsedMs: result.elapsedMs};
}
