/**
 * Market regime signals: crash trigger (the conversation's "BTC 短时间跌 5%"),
 * realized volatility, the implied volatility surface (ATM term structure,
 * smile fit, 25Δ skew) and the volatility risk premium.
 */
import {constantMaturityVol, YEAR_DAYS} from "./quant.mjs";

export const HOUR_MS = 3_600_000;
export const DAY = 86_400_000;

/* ------------------------------------------------------------------------ */
/* Klines                                                                    */
/* ------------------------------------------------------------------------ */

/** Validates Binance klines [[openTime, o, h, l, c, v, closeTime, ...]]. */
export function parseKlines(rows) {
  if (!Array.isArray(rows)) return [];
  const bars = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const [t, o, h, l, c] = row.slice(0, 5).map(Number), closeTime = Number(row[6]);
    if (![t, o, h, l, c, closeTime].every(Number.isFinite) || !(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    if (h < l || h < Math.max(o, c) * (1 - 1e-9) || l > Math.min(o, c) * (1 + 1e-9) || closeTime <= t) continue;
    bars.set(t, {t, o, h, l, c, closeTime});
  }
  return [...bars.values()].sort((a, b) => a.t - b.t);
}

/** Compact transport form: parallel arrays keep JSON small. */
export const packBars = bars => ({t: bars.map(b => b.t), h: bars.map(b => b.h), l: bars.map(b => b.l), c: bars.map(b => b.c),
  ct: bars.map(b => b.closeTime)});

export function unpackBars(packed) {
  if (!packed || !Array.isArray(packed.t)) return [];
  const bars = [];
  for (let i = 0; i < packed.t.length; i++) {
    const bar = {t: packed.t[i], h: packed.h?.[i], l: packed.l?.[i], c: packed.c?.[i], closeTime: packed.ct?.[i]};
    if ([bar.t, bar.h, bar.l, bar.c, bar.closeTime].every(Number.isFinite) && bar.h >= bar.l && bar.c > 0) bars.push(bar);
  }
  return bars.sort((a, b) => a.t - b.t);
}

/** Zero-mean RMS of log returns, annualized (standard for short-horizon RV). */
export function realizedVol(closes, periodsPerYear) {
  if (!Array.isArray(closes) || closes.length < 3) return null;
  let sum = 0, n = 0;
  for (let i = 1; i < closes.length; i++) {
    if (!(closes[i] > 0 && closes[i - 1] > 0)) continue;
    const r = Math.log(closes[i] / closes[i - 1]);
    sum += r * r; n++;
  }
  return n >= 2 ? Math.sqrt(sum / n * periodsPerYear) : null;
}

/* ------------------------------------------------------------------------ */
/* Price moves and the crash trigger                                         */
/* ------------------------------------------------------------------------ */

/** Highest high over (now − hours, now], including the live price. */
export function windowHigh(bars, nowMs, hours, current) {
  const from = nowMs - hours * HOUR_MS;
  let high = current > 0 ? current : -Infinity, at = current > 0 ? nowMs : null;
  for (const bar of bars) {
    if (bar.closeTime <= from || bar.t > nowMs) continue;
    if (bar.h > high) { high = bar.h; at = bar.t; }
  }
  return Number.isFinite(high) ? {high, at} : null;
}

/** Close at or before the given time (bar whose close time is the latest ≤ time). */
function closeAt(bars, at) {
  let best = null;
  for (const bar of bars) if (bar.closeTime <= at + 1) best = bar;
  return best?.c ?? null;
}

export function drawdown(bars, nowMs, hours, current) {
  const peak = windowHigh(bars, nowMs, hours, current);
  if (!peak || !(current > 0)) return null;
  const covered = bars.some(bar => bar.t <= nowMs - hours * HOUR_MS + HOUR_MS);
  return {pct: Math.max(0, (1 - current / peak.high) * 100), high: peak.high, highAt: peak.at, complete: covered};
}

/**
 * Evaluates the crash trigger now and scans the recent history so the user
 * can see how often the rule fires. Uses closes for historical episodes.
 */
export function crashTrigger(hourly, nowMs, current, {windowHours = 24, thresholdPct = 5, lookbackHours = 168} = {}) {
  if (!hourly.length || !(current > 0)) {
    return {status: "unknown", windowHours, thresholdPct, drawdownPct: null, reason: "缺少小时 K 线或指数价格"};
  }
  const dd = drawdown(hourly, nowMs, windowHours, current);
  const episodes = [];
  let open = null;
  const start = nowMs - lookbackHours * HOUR_MS;
  for (let i = 0; i < hourly.length; i++) {
    const bar = hourly[i];
    if (bar.closeTime < start || bar.closeTime > nowMs) continue;
    let high = -Infinity;
    for (let j = i; j >= 0 && hourly[j].closeTime > bar.closeTime - windowHours * HOUR_MS; j--) high = Math.max(high, hourly[j].h);
    const value = (1 - bar.c / high) * 100;
    if (value >= thresholdPct) {
      if (!open) open = {start: bar.closeTime, end: bar.closeTime, maxDrawdownPct: value};
      else { open.end = bar.closeTime; open.maxDrawdownPct = Math.max(open.maxDrawdownPct, value); }
    } else if (open) { episodes.push(open); open = null; }
  }
  if (open) episodes.push(open);
  const triggered = dd !== null && dd.pct >= thresholdPct;
  const last = episodes[episodes.length - 1] ?? null;
  return {
    status: dd === null ? "unknown" : triggered ? "triggered" : "idle",
    windowHours, thresholdPct, drawdownPct: dd?.pct ?? null, high: dd?.high ?? null, highAt: dd?.highAt ?? null,
    progress: dd === null ? null : Math.min(1, dd.pct / thresholdPct),
    episodes, lastTriggeredAt: triggered ? nowMs : last?.end ?? null,
    hoursSinceTrigger: triggered ? 0 : last ? (nowMs - last.end) / HOUR_MS : null,
  };
}

export function priceMoves(hourly, daily, nowMs, current) {
  const change = (bars, hours) => {
    const past = closeAt(bars, nowMs - hours * HOUR_MS);
    return past && current > 0 ? (current / past - 1) * 100 : null;
  };
  const useHourly = hourly.length >= 2;
  const moves = {};
  for (const [label, hours] of [["1h", 1], ["4h", 4], ["24h", 24], ["72h", 72], ["7d", 168], ["30d", 720]]) {
    moves[label] = hours <= 168 && useHourly ? change(hourly, hours) : change(daily, hours);
  }
  const drawdowns = {};
  for (const hours of [4, 24, 72, 168]) {
    drawdowns[hours] = useHourly ? drawdown(hourly, nowMs, hours, current) : hours >= 72 ? drawdown(daily, nowMs, hours, current) : null;
  }
  return {returns: moves, drawdowns, resolution: useHourly ? "1h" : daily.length ? "1d" : null};
}

export function realizedVolSummary(hourly, daily) {
  const tail = (bars, n) => bars.slice(-n - 1).map(bar => bar.c);
  return {
    rv24h: hourly.length >= 25 ? realizedVol(tail(hourly, 24), 24 * YEAR_DAYS) : null,
    rv7: daily.length >= 8 ? realizedVol(tail(daily, 7), YEAR_DAYS) : hourly.length >= 169 ? realizedVol(tail(hourly, 168), 24 * YEAR_DAYS) : null,
    rv30: daily.length >= 31 ? realizedVol(tail(daily, 30), YEAR_DAYS) : null,
    rv90: daily.length >= 91 ? realizedVol(tail(daily, 90), YEAR_DAYS) : null,
  };
}

/* ------------------------------------------------------------------------ */
/* Implied volatility surface                                                */
/* ------------------------------------------------------------------------ */

function solve(matrix, vector) {
  // Gaussian elimination with partial pivoting for the small normal equations.
  const n = vector.length, a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

const basis = (k, size) => size === 4 ? [1, k, k * k, Math.min(k, 0) ** 2] : [1, k, k * k];

/**
 * Robust smile fit σ(k), k = ln(K/S): quadratic plus an extra put-wing
 * curvature term when there are enough points; Tukey reweighting limits the
 * influence of stale or mis-marked strikes.
 */
export function fitSmile(points) {
  const clean = points.filter(p => Number.isFinite(p.k) && p.iv > 0 && p.iv <= 5 && Math.abs(p.k) <= 1.5);
  const strikes = new Set(clean.map(p => p.k.toFixed(6)));
  if (clean.length < 4 || strikes.size < 4) return null;
  const size = clean.length >= 8 ? 4 : 3;
  let weights = clean.map(() => 1), coef = null;
  for (let iteration = 0; iteration < 3; iteration++) {
    const m = Array.from({length: size}, () => new Array(size).fill(0)), v = new Array(size).fill(0);
    clean.forEach((p, i) => {
      const x = basis(p.k, size), w = weights[i];
      for (let r = 0; r < size; r++) { v[r] += w * x[r] * p.iv; for (let c = 0; c < size; c++) m[r][c] += w * x[r] * x[c]; }
    });
    const next = solve(m, v);
    if (!next) break;
    coef = next;
    const residuals = clean.map(p => p.iv - basis(p.k, size).reduce((s, x, i) => s + x * coef[i], 0));
    const mad = [...residuals.map(Math.abs)].sort((x, y) => x - y)[Math.floor(residuals.length / 2)];
    const scale = 1.4826 * mad;
    if (!(scale > 1e-6)) break;
    weights = residuals.map(r => { const u = r / (4.685 * scale); return Math.abs(u) < 1 ? (1 - u * u) ** 2 : 0; });
  }
  if (!coef) return null;
  const evaluate = k => basis(k, size).reduce((s, x, i) => s + x * coef[i], 0);
  const residuals = clean.map(p => p.iv - evaluate(p.k));
  const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
  const ks = clean.map(p => p.k);
  return {coef, size, n: clean.length, rmse, kMin: Math.min(...ks), kMax: Math.max(...ks)};
}

export function smileIv(fit, k) {
  if (!fit) return null;
  const clamped = Math.min(fit.kMax, Math.max(fit.kMin, k));
  const value = basis(clamped, fit.size).reduce((s, x, i) => s + x * fit.coef[i], 0);
  return value > 0 ? value : null;
}

function interpolateBy(points, key, target) {
  const sorted = points.filter(p => Number.isFinite(p[key]) && p.iv > 0).sort((a, b) => a[key] - b[key]);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (target >= a[key] && target <= b[key]) {
      return b[key] === a[key] ? (a.iv + b.iv) / 2 : a.iv + (b.iv - a.iv) * (target - a[key]) / (b[key] - a[key]);
    }
  }
  return null;
}

/**
 * Builds the per-expiry surface from prepared market data. OTM options carry
 * the reference marks (puts below spot, calls at or above).
 */
export function buildSurface(market) {
  const expiries = [];
  for (const group of market.expiries) {
    if (!(group.years > 0)) continue;
    const otm = [...group.puts.filter(c => c.strike < market.spot), ...group.calls.filter(c => c.strike >= market.spot)]
      .filter(c => c.iv > 0 && c.mark > 0 && (c.delta === null || Math.abs(c.delta) >= .02));
    const points = otm.map(c => ({k: c.k, iv: c.iv, delta: c.delta, type: c.type}));
    const fit = fitSmile(points);
    const interpolated = interpolateBy(points, "k", 0);
    let atmIv = fit && fit.kMin <= 0 && fit.kMax >= 0 ? smileIv(fit, 0) : null;
    if (!(atmIv > 0) || interpolated && Math.abs(atmIv - interpolated) > .15) atmIv = interpolated ?? atmIv;
    if (!(atmIv > 0)) {
      const nearest = [...group.puts, ...group.calls].filter(c => c.iv > 0).sort((a, b) => Math.abs(a.k) - Math.abs(b.k))[0];
      atmIv = nearest?.iv ?? null;
    }
    const putWing = points.filter(p => p.type === "PUT" && p.delta !== null).map(p => ({...p, d: Math.abs(p.delta)}));
    const callWing = points.filter(p => p.type === "CALL" && p.delta !== null).map(p => ({...p, d: Math.abs(p.delta)}));
    const put25 = interpolateBy(putWing, "d", .25), call25 = interpolateBy(callWing, "d", .25);
    expiries.push({
      expiryMs: group.expiryMs, years: group.years, dte: group.dte, atmIv, fit,
      put25, call25, rr25: put25 && call25 ? call25 - put25 : null, putSkew25: put25 && atmIv ? put25 - atmIv : null,
      expectedMovePct: atmIv ? atmIv * Math.sqrt(group.years) * 100 : null,
      count: group.puts.length + group.calls.length,
    });
  }
  const usable = expiries.filter(e => e.atmIv > 0 && e.dte >= .5);
  const cm = target => constantMaturityVol(usable.map(e => ({years: e.years, vol: e.atmIv})), target / YEAR_DAYS);
  return {expiries, byExpiry: new Map(expiries.map(e => [e.expiryMs, e])), atmIv7: cm(7), atmIv30: cm(30), atmIv60: cm(60)};
}

/** Full regime summary used by the API and the regime strip. */
export function regime({hourly = [], daily = [], nowMs, spot, surface = null, trigger = {}}) {
  const moves = priceMoves(hourly, daily, nowMs, spot);
  const rv = realizedVolSummary(hourly, daily);
  const crash = crashTrigger(hourly.length ? hourly : daily, nowMs, spot, trigger);
  const iv30 = surface?.atmIv30 ?? null;
  return {
    asOf: nowMs, spot, moves, rv, crash,
    iv: surface ? {atm7: surface.atmIv7, atm30: iv30, atm60: surface.atmIv60,
      term: surface.expiries.filter(e => e.atmIv > 0).map(e => ({expiryMs: e.expiryMs, dte: e.dte, atmIv: e.atmIv, rr25: e.rr25, putSkew25: e.putSkew25}))} : null,
    vrp: iv30 && rv.rv30 ? {spread: (iv30 - rv.rv30) * 100, ratio: iv30 / rv.rv30} : null,
  };
}
