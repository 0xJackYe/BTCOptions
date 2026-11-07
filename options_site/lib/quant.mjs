/**
 * Quantitative core for Binance BTC options.
 *
 * Binance BTCUSDT options are European, cash-settled in USDT against the
 * 30-minute average of the BTC index, with a contract unit of 1 BTC.
 * Everything here is a pure function: no I/O, no clock, no globals. The same
 * module runs in browsers, Node.js and Cloudflare Workers.
 *
 * Conventions
 *  - Prices are USDT per 1 BTC of underlying; quantities are contracts (unit 1).
 *  - Interest rates are zero (USDT-margined index options). Year = 365 days.
 *  - Volatility is a decimal (0.52 = 52 %). Vega is per 1 vol point, theta per day.
 *  - Signed quantity: + long, − short.
 */

export const DAY_MS = 86_400_000;
export const YEAR_DAYS = 365;
export const YEAR_MS = YEAR_DAYS * DAY_MS;

/* ------------------------------------------------------------------------ */
/* Normal distribution                                                       */
/* ------------------------------------------------------------------------ */

// Cephes rational approximations (identical coefficients to the audited
// dashboard/dist/risk-metrics.js). erfc keeps relative precision deep in the
// tails, which matters for far out-of-the-money option probabilities.
const ERF_T = [9.604973739870516, 90.02601972038427, 2232.005345946843, 7003.325141128051, 55592.3013010395];
const ERF_U = [33.56171416475031, 521.3579497801527, 4594.323829709801, 22629.000061389095, 49267.39426086359];
const ERFC_P = [2.461969814735305e-10, .5641895648310688, 7.463210564422699, 48.63719709856814, 196.5208329560771,
  526.4451949954773, 934.5285271719576, 1027.5518868951572, 557.5353353693993];
const ERFC_Q = [13.228195115474499, 86.70721408859897, 354.9377788878199, 975.7085017432055, 1823.9091668790974,
  2246.3376081871097, 1656.6630919416134, 557.5353408177277];
const ERFC_R = [.5641895835477551, 1.275366707599781, 5.019050422511805, 6.160210979930536, 7.4097426995044895, 2.9788666537210024];
const ERFC_S = [2.2605286322011726, 9.396035249380014, 12.048953980809666, 17.08144507475659, 9.608968090632859, 3.369076451000815];
const SQRT2 = Math.SQRT2;
const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

const polevl = (x, c) => { let v = 0; for (const k of c) v = v * x + k; return v; };
const p1evl = (x, c) => { let v = 1; for (const k of c) v = v * x + k; return v; };

export function erfc(x) {
  if (Number.isNaN(x)) return NaN;
  if (x < 0) return 2 - erfc(-x);
  if (x < 1) return 1 - x * polevl(x * x, ERF_T) / p1evl(x * x, ERF_U);
  if (x > 27.3) return 0;
  const ratio = x < 8 ? polevl(x, ERFC_P) / p1evl(x, ERFC_Q) : polevl(x, ERFC_R) / p1evl(x, ERFC_S);
  return Math.exp(-x * x) * ratio;
}

export const normCdf = z => z === Infinity ? 1 : z === -Infinity ? 0 : .5 * erfc(-z / SQRT2);
export const normSf = z => z === Infinity ? 0 : z === -Infinity ? 1 : .5 * erfc(z / SQRT2);
export const normPdf = z => Number.isFinite(z) ? INV_SQRT_2PI * Math.exp(-.5 * z * z) : 0;

/** P(low < Z < high) evaluated on the side that avoids cancellation. */
export function normInterval(low, high) {
  if (!(high > low)) return 0;
  return Math.max(0, low >= 0 ? normSf(low) - normSf(high) : normCdf(high) - normCdf(low));
}

// Acklam's inverse normal with one Halley refinement against the precise CDF.
const IA = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
const IB = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
const IC = [-.007784894002430293, -.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const ID = [.007784695709041462, .3224671290700398, 2.445134137142996, 3.754408661907416];
const IB_1 = [...IB, 1], ID_1 = [...ID, 1];

export function normInv(p) {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
  // Acklam's denominators end in a constant 1 (not a leading 1).
  let x;
  if (p < .02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = polevl(q, IC) / polevl(q, ID_1);
  } else if (p <= .97575) {
    const q = p - .5, r = q * q;
    x = polevl(r, IA) * q / polevl(r, IB_1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -polevl(q, IC) / polevl(q, ID_1);
  }
  const e = p < .5 ? normCdf(x) - p : (1 - p) - normSf(x);
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

/* ------------------------------------------------------------------------ */
/* Black–Scholes with zero rates                                             */
/* ------------------------------------------------------------------------ */

export const intrinsic = (type, S, K) => Math.max(type === "CALL" ? S - K : K - S, 0);

function validInputs(S, K, T, sigma) {
  return S > 0 && K > 0 && T >= 0 && sigma >= 0 && Number.isFinite(S + K + T + sigma);
}

/** Undiscounted European option value (USDT per 1 BTC). */
export function bsPrice(type, S, K, T, sigma) {
  if (!validInputs(S, K, T, sigma)) return NaN;
  const floor = intrinsic(type, S, K);
  if (T === 0 || sigma === 0) return floor;
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + .5 * v * v) / v, d2 = d1 - v;
  // Price the out-of-the-money side directly (no S − K cancellation); parity
  // with r = 0 is exact, so C(S, K) = P(K, S) holds for the mirrored inputs.
  const value = type === "PUT" ? K * normCdf(-d2) - S * normCdf(-d1) : S * normCdf(d1) - K * normCdf(d2);
  return Math.min(type === "PUT" ? K : S, Math.max(floor, value));
}

/**
 * Greeks in Binance's units: delta per BTC, gamma per USDT, vega USDT per
 * vol point, theta USDT per calendar day.
 */
export function bsGreeks(type, S, K, T, sigma) {
  if (!validInputs(S, K, T, sigma)) return {delta: NaN, gamma: NaN, vega: NaN, theta: NaN};
  if (T === 0 || sigma === 0) {
    const itm = type === "CALL" ? S > K : S < K;
    return {delta: itm ? (type === "CALL" ? 1 : -1) : 0, gamma: 0, vega: 0, theta: 0};
  }
  const sqrtT = Math.sqrt(T), v = sigma * sqrtT;
  const d1 = (Math.log(S / K) + .5 * v * v) / v, pdf = normPdf(d1);
  return {
    delta: type === "CALL" ? normCdf(d1) : -normCdf(-d1),
    gamma: pdf / (S * v),
    vega: S * pdf * sqrtT / 100,
    theta: -S * pdf * sigma / (2 * sqrtT) / YEAR_DAYS,
  };
}

/** Probability of finishing in the money under a driftless lognormal. */
export function probabilityItm(type, S, K, T, sigma, drift = 0) {
  if (!validInputs(S, K, T, sigma)) return NaN;
  if (T === 0 || sigma === 0) {
    const forward = S * Math.exp(drift * T);
    return (type === "CALL" ? forward > K : forward < K) ? 1 : 0;
  }
  const v = sigma * Math.sqrt(T);
  const d2 = (Math.log(S / K) + (drift - .5 * sigma * sigma) * T) / v;
  return type === "CALL" ? normCdf(d2) : normCdf(-d2);
}

/**
 * Implied volatility by safeguarded Newton–bisection. Returns null when the
 * price lies outside the no-arbitrage band or the solve does not converge.
 */
export function impliedVol(type, price, S, K, T, {low = 1e-4, high = 5, tolerance = 1e-9} = {}) {
  if (!(price > 0) || !validInputs(S, K, T, .1) || !(T > 0)) return null;
  const floor = intrinsic(type, S, K), ceiling = type === "CALL" ? S : K;
  if (price <= floor + 1e-12 || price >= ceiling) return null;
  let lo = low, hi = high;
  if (bsPrice(type, S, K, T, hi) < price || bsPrice(type, S, K, T, lo) > price) return null;
  let sigma = Math.min(hi, Math.max(lo, Math.sqrt(2 * Math.PI / T) * price / S));
  for (let i = 0; i < 100; i++) {
    const diff = bsPrice(type, S, K, T, sigma) - price;
    if (Math.abs(diff) <= tolerance * Math.max(1, price)) return sigma;
    if (diff > 0) hi = sigma; else lo = sigma;
    const vega = bsGreeks(type, S, K, T, sigma).vega * 100;
    let next = vega > 1e-12 ? sigma - diff / vega : NaN;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - sigma) < 1e-12) return next;
    sigma = next;
  }
  return Math.abs(bsPrice(type, S, K, T, sigma) - price) < 1e-6 * Math.max(1, price) ? sigma : null;
}

/* ------------------------------------------------------------------------ */
/* Binance fees and margin                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Base fee schedule from Binance's options fee FAQ. Trade fee
 * min(rate × index, cap × premium) per contract on entry and exit; exercise fee
 * min(rate × settlement, cap × intrinsic) on in-the-money expiry, charged to
 * both sides. VIP tiers or rebates differ and must be entered by the user.
 */
export const DEFAULT_FEES = Object.freeze({tradeRate: .00024, exerciseRate: .00015, cap: .10});

export const tradeFeePerUnit = (index, price, fees = DEFAULT_FEES) => Math.max(0, Math.min(fees.tradeRate * index, fees.cap * price));

export function exerciseFeePerUnit(type, strike, settlement, fees = DEFAULT_FEES) {
  const value = intrinsic(type, settlement, strike);
  return value > 0 ? Math.min(fees.exerciseRate * settlement, fees.cap * value) : 0;
}

/** Fallback risk parameters, used only when the live catalog is unavailable. */
export const DEFAULT_MARGIN_RULES = Object.freeze({
  initialMarginRate: .15, minInitialMarginRate: .10, maintenanceMarginRate: .075,
  minMaintenanceMarginRate: .05, liquidationFeeRate: .0019, estimated: true,
});

export function marginRules(row) {
  const pick = key => {
    const value = row?.[key];
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
  };
  const rules = {
    initialMarginRate: pick("initial_margin_rate"), minInitialMarginRate: pick("min_initial_margin_rate"),
    maintenanceMarginRate: pick("maintenance_margin_rate"), minMaintenanceMarginRate: pick("min_maintenance_margin_rate"),
    liquidationFeeRate: pick("liquidation_fee_rate"),
  };
  return Object.values(rules).every(value => value !== null) ? {...rules, estimated: false} : {...DEFAULT_MARGIN_RULES};
}

/** Out-of-the-money amount per Binance Clearing Procedures (Put: S−K, Call: K−S). */
export const otmAmount = (type, S, K) => Math.max(type === "CALL" ? K - S : S - K, 0);

export const marginBase = (type, S, K, rate, minimum) => Math.max(minimum * S, rate * S - otmAmount(type, S, K));

/** Initial margin a new short order needs per contract (strict > admission). */
export function shortOrderMargin(type, S, K, mark, premium, rules, fees = DEFAULT_FEES) {
  const base = marginBase(type, S, K, rules.initialMarginRate, rules.minInitialMarginRate);
  return Math.max(0, base + mark - premium) + tradeFeePerUnit(S, premium, fees);
}

export const shortPositionMargin = (type, S, K, mark, rules) =>
  marginBase(type, S, K, rules.initialMarginRate, rules.minInitialMarginRate) + mark;

/** Maintenance margin per contract including the liquidation-fee reserve (art. 28). */
export const shortMaintenanceMargin = (type, S, K, mark, rules) =>
  marginBase(type, S, K, rules.maintenanceMarginRate, rules.minMaintenanceMarginRate) + mark + rules.liquidationFeeRate * S;

/* ------------------------------------------------------------------------ */
/* Exact expiry payoff of a same-expiry position                             */
/* ------------------------------------------------------------------------ */

/**
 * Builds the exact settlement P&L of legs sharing one expiry, including
 * exercise fees, as a piecewise-linear function of the settlement price.
 *
 * legs: [{type: "PUT"|"CALL", strike, qty}] where qty is signed contracts.
 * upfront: net USDT received at entry (+) or paid (−), entry fees deducted.
 * Returns {segments: [{lo, hi, a, b}], value(S)} with P&L = a + b·S on (lo, hi).
 */
export function expiryPayoff(legs, upfront = 0, fees = DEFAULT_FEES) {
  if (!Array.isArray(legs) || !legs.length) throw new RangeError("至少需要一条期权腿");
  for (const leg of legs) {
    if (!(leg.type === "PUT" || leg.type === "CALL") || !(leg.strike > 0) || !Number.isFinite(leg.qty) || leg.qty === 0) {
      throw new RangeError("期权腿参数无效");
    }
  }
  if (!Number.isFinite(upfront)) throw new RangeError("期初现金流无效");
  const {exerciseRate: rate, cap} = fees;
  const crossover = leg => {
    if (leg.type === "PUT") return rate + cap > 0 ? leg.strike * cap / (rate + cap) : leg.strike;
    return cap > rate ? leg.strike * cap / (cap - rate) : Infinity;
  };
  const knots = [0];
  for (const leg of legs) {
    knots.push(leg.strike);
    const c = crossover(leg);
    if (Number.isFinite(c) && c > 0) knots.push(c);
  }
  const sorted = [...new Set(knots)].sort((x, y) => x - y);
  const segments = [];
  for (let i = 0; i < sorted.length; i++) {
    const lo = sorted[i], hi = i + 1 < sorted.length ? sorted[i + 1] : Infinity;
    const probe = hi === Infinity ? lo + Math.max(1, lo) : (lo + hi) / 2;
    let a = upfront, b = 0;
    for (const leg of legs) {
      const n = leg.qty, q = Math.abs(n), K = leg.strike, c = crossover(leg);
      if (leg.type === "PUT") {
        if (probe >= K) continue;
        if (probe >= c) { a += (n - q * cap) * K; b -= n - q * cap; }
        else { a += n * K; b += -n - q * rate; }
      } else {
        if (probe <= K) continue;
        if (probe <= c) { a -= (n - q * cap) * K; b += n - q * cap; }
        else { a -= n * K; b += n - q * rate; }
      }
    }
    segments.push({lo, hi, a, b});
  }
  const value = S => {
    let pnl = upfront;
    for (const leg of legs) {
      pnl += leg.qty * intrinsic(leg.type, S, leg.strike) - Math.abs(leg.qty) * exerciseFeePerUnit(leg.type, leg.strike, S, fees);
    }
    return pnl;
  };
  // Net call quantity is the structural slope as S → ∞. Exercise fees add a
  // tiny extra drift (rate × S per in-the-money leg) that never changes
  // whether a position's risk is bounded in economic terms.
  const netCallQty = legs.reduce((sum, leg) => sum + (leg.type === "CALL" ? leg.qty : 0), 0);
  return {segments, value, upfront, netCallQty};
}

/**
 * Max profit / loss, unbounded flags and break-even settlement prices.
 * Extremes of bounded positions are taken over the knots (0, strikes and fee
 * crossovers); beyond the last knot only the exercise-fee drift remains.
 */
export function payoffProfile(payoff) {
  const {segments} = payoff;
  const last = segments[segments.length - 1];
  const points = segments.map(s => s.a + s.b * s.lo);
  for (const s of segments) if (s.hi !== Infinity) points.push(s.a + s.b * s.hi);
  const structural = payoff.netCallQty ?? last.b;
  const tol = 1e-9;
  const profitUnbounded = structural > tol, lossUnbounded = structural < -tol;
  const maxProfit = profitUnbounded ? Infinity : Math.max(...points);
  const minPnl = lossUnbounded ? -Infinity : Math.min(...points);
  const breakevens = [];
  for (const s of segments) {
    if (Math.abs(s.b) <= 1e-12) continue;
    if (s.hi === Infinity && Math.abs(structural) <= tol) continue; // fee drift only
    const root = -s.a / s.b;
    if (root >= s.lo - 1e-9 && (s.hi === Infinity || root <= s.hi + 1e-9) && root >= 0 &&
        !breakevens.some(known => Math.abs(known - root) <= 1e-6 * Math.max(1, root))) breakevens.push(root);
  }
  breakevens.sort((x, y) => x - y);
  return {maxProfit, maxLoss: lossUnbounded ? Infinity : Math.max(0, -minPnl), minPnl,
    profitUnbounded, lossUnbounded, breakevens, valueAtZero: segments[0].a};
}

/* ------------------------------------------------------------------------ */
/* Lognormal statistics of a piecewise-linear payoff                         */
/* ------------------------------------------------------------------------ */

/**
 * Settlement distribution: ln S_T ~ N(ln S0 + (μ − σ²/2)T, σ²T).
 * These are assumption-driven model numbers, not forecasts. Real BTC returns
 * have fatter tails than a lognormal; stress scenarios complement them.
 */
export function lognormal(spot, years, sigma, drift = 0) {
  if (!(spot > 0) || !(years >= 0) || !(sigma >= 0) || !Number.isFinite(drift)) throw new RangeError("分布参数无效");
  const v = sigma * Math.sqrt(years);
  const m = Math.log(spot) + (drift - sigma * sigma / 2) * years;
  const mean = spot * Math.exp(drift * years);
  const z = x => x <= 0 ? -Infinity : x === Infinity ? Infinity : (Math.log(x) - m) / v;
  return {
    spot, years, sigma, drift, v, m, mean,
    probability: (lo, hi) => v === 0 ? (mean > lo && mean <= hi ? 1 : 0) : normInterval(z(lo), z(hi)),
    firstMoment: (lo, hi) => v === 0 ? (mean > lo && mean <= hi ? mean : 0) : mean * normInterval(z(lo) - v, z(hi) - v),
    quantile: p => v === 0 ? mean : Math.exp(m + v * normInv(p)),
  };
}

function clip(segment, threshold, below, strict) {
  // Sub-interval of the segment where a + b·S is below (or above) threshold.
  const {lo, hi, a, b} = segment;
  if (b === 0) {
    const inside = below ? (strict ? a < threshold : a <= threshold) : a > threshold;
    return inside ? [lo, hi] : null;
  }
  const root = (threshold - a) / b;
  let from = lo, to = hi;
  if ((b > 0) === below) to = Math.min(hi, root); else from = Math.max(lo, root);
  return to > from ? [from, to] : null;
}

/**
 * Exact expectation and profit probability of a piecewise-linear payoff under
 * a lognormal settlement distribution. Cheap enough for every screened combo.
 */
export function payoffMoments(payoff, dist) {
  let ev = 0, pop = 0, pLoss = 0;
  for (const s of payoff.segments) {
    ev += s.a * dist.probability(s.lo, s.hi) + s.b * dist.firstMoment(s.lo, s.hi);
    const win = clip(s, 0, false, false), lose = clip(s, 0, true, true);
    if (win) pop += dist.probability(win[0], win[1]);
    if (lose) pLoss += dist.probability(lose[0], lose[1]);
  }
  return {ev, pop: Math.min(1, pop), pLoss: Math.min(1, pLoss)};
}

/**
 * Exact VaR / expected shortfall (positive loss numbers, floored at zero when
 * even the tail is profitable). Handles probability atoms from flat segments.
 */
export function payoffTail(payoff, dist) {
  const {segments} = payoff;
  const cdf = (x, strict) => {
    let p = 0;
    for (const s of segments) {
      const part = clip(s, x, true, strict);
      if (part) p += dist.probability(part[0], part[1]);
    }
    return p;
  };
  const partialMean = x => {
    let total = 0;
    for (const s of segments) {
      const part = clip(s, x, true, true);
      if (part) total += s.a * dist.probability(part[0], part[1]) + s.b * dist.firstMoment(part[0], part[1]);
    }
    return total;
  };
  // Bracket the P&L over the support, then bisect for the α-quantile.
  const probes = [0, dist.quantile(1e-12), dist.quantile(1 - 1e-12)];
  for (const s of segments) { probes.push(s.lo); if (s.hi !== Infinity) probes.push(s.hi); }
  const values = probes.filter(Number.isFinite).map(payoff.value);
  const tail = alpha => {
    let lo = Math.min(...values) - 1, hi = Math.max(...values) + 1;
    for (let i = 0; i < 200 && hi - lo > 1e-10 * Math.max(1, Math.abs(lo), Math.abs(hi)); i++) {
      const mid = (lo + hi) / 2;
      if (cdf(mid, false) >= alpha) hi = mid; else lo = mid;
    }
    // Flat segments (and a zero-variance distribution) create probability
    // atoms; snap the quantile onto an atom inside the final bracket so ES is
    // exact instead of inheriting the bisection tolerance.
    let q = hi;
    const atoms = segments.filter(s => s.b === 0 && dist.probability(s.lo, s.hi) > 0).map(s => s.a);
    if (dist.v === 0) atoms.push(payoff.value(dist.mean));
    const span = Math.max(1e-9, hi - lo) * 4;
    for (const atom of atoms) if (atom >= lo - span && atom <= hi + span && cdf(atom, false) >= alpha) { q = atom; break; }
    const below = cdf(q, true);
    const es = -(partialMean(q) + q * (alpha - below)) / alpha;
    return {var: Math.max(0, -q), es: Math.max(0, es)};
  };
  const t95 = tail(.05), t99 = tail(.01);
  return {var95: t95.var, es95: t95.es, var99: t99.var, es99: t99.es};
}

export const payoffStats = (payoff, dist) => ({...payoffMoments(payoff, dist), ...payoffTail(payoff, dist)});

/**
 * Model-free fallback for non-linear horizon payoffs (e.g. calendars valued
 * at the near expiry). Stratified quantile sampling of the lognormal.
 */
export function sampledStats(pnlAt, dist, samples = 4096) {
  const values = new Float64Array(samples);
  let ev = 0, wins = 0, losses = 0;
  for (let i = 0; i < samples; i++) {
    const v = pnlAt(dist.quantile((i + .5) / samples));
    values[i] = v; ev += v;
    if (v > 0) wins++; else if (v < 0) losses++;
  }
  values.sort();
  const tail = alpha => {
    const n = Math.max(1, Math.round(alpha * samples));
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[i];
    return {var: Math.max(0, -values[n - 1]), es: Math.max(0, -sum / n)};
  };
  const t95 = tail(.05), t99 = tail(.01);
  return {ev: ev / samples, pop: wins / samples, pLoss: losses / samples, var95: t95.var, es95: t95.es, var99: t99.var, es99: t99.es};
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/** Round down to an exchange quantity step without binary drift. */
export function floorToStep(value, step) {
  if (!Number.isFinite(value) || value <= 0 || !(step > 0)) return 0;
  const text = String(step).toLowerCase();
  const [mantissa, exponent = "0"] = text.split("e");
  const digits = Math.max(0, Math.min(12, (mantissa.split(".")[1] ?? "").length - Number(exponent)));
  return Number((Math.floor(value / step + 1e-9) * step).toFixed(digits));
}

/** Variance-linear interpolation of ATM vol to a constant maturity. */
export function constantMaturityVol(points, targetYears) {
  const valid = points.filter(p => p.years > 0 && p.vol > 0).sort((x, y) => x.years - y.years);
  if (!valid.length || !(targetYears > 0)) return null;
  if (targetYears <= valid[0].years) return valid[0].vol;
  const lastPoint = valid[valid.length - 1];
  if (targetYears >= lastPoint.years) return lastPoint.vol;
  for (let i = 1; i < valid.length; i++) {
    const left = valid[i - 1], right = valid[i];
    if (targetYears <= right.years) {
      const w1 = left.vol ** 2 * left.years, w2 = right.vol ** 2 * right.years;
      const w = w1 + (w2 - w1) * (targetYears - left.years) / (right.years - left.years);
      return w > 0 ? Math.sqrt(w / targetYears) : null;
    }
  }
  return null;
}
