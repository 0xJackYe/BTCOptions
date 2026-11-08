// Strategy Desk engine: market + klines + settings + account → screened,
// ranked, analyzed results. DOM-free so it runs in a Web Worker (preferred)
// or on the main thread.
//
// Latency design: after the visible strategy is answered, every other
// strategy is screened in cancellable background slices and kept with the
// analysis of its leading candidate, so switching strategies is answered
// from memory in about a millisecond. Cached answers are keyed by the data
// version and the strategy's parameters; a parameter change re-screens only
// that strategy and reuses the market context.
import {createContext, screen, analyzeCandidate, mergeSettings} from "../lib/screener.mjs";
import {regime as computeRegime, unpackBars} from "../lib/signals.mjs";
import {STRATEGIES, getStrategy, normalizeParams, decodeParams} from "../lib/strategies.mjs";
import {contentHash} from "../lib/market.mjs";

const strip = candidate => {
  if (!candidate) return null;
  const {model, ...plain} = candidate;
  return plain;
};

export function createEngine(post, {now = () => Date.now(), defer = fn => setTimeout(fn, 0)} = {}) {
  const s = {
    snapshot: null, snapshotAt: 0, source: null, bars: {hourly: [], daily: []}, barsSource: null, barsAt: 0,
    settings: mergeSettings({}), account: null, paramsById: {}, strategyId: STRATEGIES[0].id, selectedKey: null, pending: null,
    autoSelect: true, frozen: false, frozenAt: 0, ctx: null, result: null, seq: 0, scheduled: false, generation: 0, lastComputeAt: 0,
    inputsVersion: 1, ctxVersion: 0, dataVersion: 0, cache: new Map(), lastSig: "",
  };
  for (const strategy of STRATEGIES) s.paramsById[strategy.id] = normalizeParams(strategy, {}).params;

  const params = id => s.paramsById[id] ?? normalizeParams(getStrategy(id), {}).params;
  const paramsKey = id => JSON.stringify(params(id));

  function triggerSettings() {
    const p = params(s.strategyId);
    return p.trigger !== undefined && p.trigger !== "off" ? {windowHours: Number(p.dropWindow), thresholdPct: Number(p.dropPct)} : {windowHours: 24, thresholdPct: 5};
  }

  function detailFor(key) {
    if (!s.ctx || !s.result || !key) return null;
    const candidate = [...s.result.candidates, ...s.result.nearMisses].find(c => c.key === key);
    if (!candidate) return null;
    try { return analyzeCandidate(s.ctx, candidate); } catch { return null; }
  }

  function summary() {
    const m = s.ctx?.market;
    return m ? {ok: m.ok, spot: m.spot, exchangeNow: m.exchangeNow, localNow: m.localNow, contractCount: m.contracts.length,
      expiryCount: m.expiries.length, quality: m.quality} : {ok: false, quality: {status: "unavailable", notes: []}};
  }

  const brief = result => ({total: result.total, blocked: result.blocked, blockedCount: result.blockedCount ?? null,
    gate: result.gate?.status ?? null, best: result.candidates[0]?.metrics?.[result.rank] ?? null});

  function remember(id, result) {
    const top = result.candidates[0] ?? null;
    const entry = {dataVersion: s.dataVersion, paramsKey: paramsKey(id), result, topKey: top?.key ?? null, detail: undefined};
    s.cache.set(id, entry);
    return entry;
  }
  const fresh = id => {
    const entry = s.cache.get(id);
    return entry && entry.dataVersion === s.dataVersion && entry.paramsKey === paramsKey(id) ? entry : null;
  };

  /** Posts the visible strategy's answer; sig lets the interface skip identical repaints. */
  function postResult(detail, timings, extra = {}) {
    const m = s.ctx.market;
    const regime = m.ok ? computeRegime({hourly: s.bars.hourly, daily: s.bars.daily, nowMs: m.exchangeNow, spot: m.spot,
      surface: s.ctx.surface, trigger: triggerSettings()}) : null;
    const result = s.result && {...s.result, candidates: s.result.candidates.map(strip), nearMisses: s.result.nearMisses.map(strip)};
    const sig = result ? contentHash(JSON.stringify([s.strategyId, result.candidates, result.nearMisses, result.total, result.blocked, result.gate,
      result.rejected, s.selectedKey])) : "";
    // An unchanged answer travels without its candidates and analysis, so
    // the interface thread never deserialises data it already shows.
    const same = Boolean(sig) && sig === s.lastSig;
    s.lastSig = sig;
    post({
      type: "result", seq: ++s.seq, strategyId: s.strategyId, params: params(s.strategyId), selectedKey: s.selectedKey,
      market: summary(), portfolio: s.ctx.portfolio, rv: s.ctx.rv, regime, trigger: regime?.crash ?? null,
      result: same ? null : result, detail: same ? null : detail, same, sig,
      source: s.source, barsSource: s.barsSource, barsAt: s.barsAt, frozen: s.frozen, timings, ...extra,
    });
  }

  function compute() {
    s.scheduled = false;
    const started = now();
    const generation = ++s.generation;
    if (!s.snapshot) {
      post({type: "result", seq: ++s.seq, waiting: true, market: summary()});
      return;
    }
    // The market context is rebuilt only when its inputs changed; a
    // parameter edit re-screens against the context already in memory.
    if (s.ctxVersion !== s.inputsVersion || !s.ctx) {
      const localNow = s.frozen ? s.frozenAt : now();
      s.ctx = createContext({snapshot: s.snapshot, localNow, settings: s.settings, account: s.account,
        klines: {hourlyBars: s.bars.hourly, dailyBars: s.bars.daily}});
      s.ctxVersion = s.inputsVersion;
      s.dataVersion += 1;
    }
    const built = now();
    let entry = fresh(s.strategyId);
    if (!entry) {
      try { entry = remember(s.strategyId, screen(s.ctx, s.strategyId, params(s.strategyId), {limit: 150})); } catch (error) {
        post({type: "error", where: "screen", message: String(error?.message ?? error)});
      }
    }
    s.result = entry?.result ?? null;
    const screened = now();
    if (s.result && s.autoSelect && !s.result.candidates.some(c => c.key === s.selectedKey) && !s.result.nearMisses.some(c => c.key === s.selectedKey)) {
      s.selectedKey = s.result.candidates[0]?.key ?? null;
    }
    const detail = entry && s.selectedKey === entry.topKey && entry.detail !== undefined ? entry.detail : detailFor(s.selectedKey);
    if (entry && s.selectedKey === entry.topKey) entry.detail = detail;
    s.lastComputeAt = now();
    postResult(detail, {context: built - started, screen: screened - built, total: now() - started});
    precompute(generation);
  }

  // Every other strategy, one per slice, abandoned as soon as inputs change;
  // the answers double as the rail counts.
  function precompute(generation) {
    const counts = {};
    const queue = [];
    for (const strategy of STRATEGIES) {
      const entry = fresh(strategy.id);
      if (entry) counts[strategy.id] = brief(entry.result);
      else queue.push(strategy.id);
    }
    if (Object.keys(counts).length) post({type: "counts", counts: {...counts}, done: !queue.length});
    const step = () => {
      if (generation !== s.generation || !s.ctx?.market?.ok) return;
      const id = queue.shift();
      if (id) {
        try {
          const entry = remember(id, screen(s.ctx, id, params(id), {limit: 150}));
          const top = entry.result.candidates[0];
          if (top) { try { entry.detail = analyzeCandidate(s.ctx, top); } catch { entry.detail = null; } }
          counts[id] = brief(entry.result);
        } catch { counts[id] = {error: true}; }
      }
      if (!queue.length || Object.keys(counts).length % 4 === 0) post({type: "counts", counts: {...counts}, done: !queue.length});
      if (queue.length) defer(step);
    };
    if (queue.length) defer(step);
  }

  function schedule() {
    if (s.scheduled) return;
    s.scheduled = true;
    defer(compute);
  }

  const changed = () => { s.inputsVersion += 1; };

  return {
    state: s,
    compute,
    /** Applies one message; most schedule a (coalesced) recompute. */
    handle(message) {
      switch (message.type) {
        case "init":
          s.settings = mergeSettings(message.settings ?? {});
          for (const [id, value] of Object.entries(message.paramsById ?? {})) {
            const strategy = getStrategy(id);
            if (strategy) s.paramsById[id] = normalizeParams(strategy, value).params;
          }
          if (getStrategy(message.strategyId)) s.strategyId = message.strategyId;
          // A shared link (#/strategy?params) wins over stored state, exactly as in the interface.
          if (typeof message.hash === "string") {
            const match = /^#\/([a-z-]+)(?:\?(.*))?$/.exec(message.hash);
            const linked = match && getStrategy(match[1]);
            if (linked) {
              s.strategyId = linked.id;
              if (match[2] !== undefined) s.paramsById[linked.id] = decodeParams(linked, match[2]).params;
            }
          }
          s.selectedKey = message.selectedKey ?? null;
          s.autoSelect = message.autoSelect !== false;
          s.account = message.account ?? null;
          changed();
          break;
        case "strategy": {
          if (!getStrategy(message.strategyId)) return;
          s.strategyId = message.strategyId;
          s.selectedKey = message.selectedKey ?? null;
          // Answer from memory when this strategy was already screened on the
          // current data; otherwise fall through to a fresh computation.
          const entry = s.ctx && s.ctxVersion === s.inputsVersion ? fresh(s.strategyId) : null;
          s.lastSig = "";
          if (!entry) break;
          const started = now();
          s.result = entry.result;
          if (s.autoSelect && !s.selectedKey) s.selectedKey = entry.topKey;
          let detail;
          if (s.selectedKey && s.selectedKey === entry.topKey) {
            if (entry.detail === undefined) entry.detail = detailFor(s.selectedKey);
            detail = entry.detail;
          } else detail = detailFor(s.selectedKey);
          postResult(detail, {context: 0, screen: 0, total: now() - started, cached: true});
          return;
        }
        case "params": {
          const strategy = getStrategy(message.strategyId ?? s.strategyId);
          if (!strategy) return;
          s.paramsById[strategy.id] = normalizeParams(strategy, message.params).params;
          if (strategy.id !== s.strategyId) return;     // answered on demand when shown
          break;
        }
        case "select":
          s.selectedKey = message.key ?? null;
          post({type: "detail", key: s.selectedKey, detail: detailFor(s.selectedKey)});
          return;
        case "autoselect":
          s.autoSelect = Boolean(message.value);
          return;
        case "settings":
          s.settings = mergeSettings(message.settings ?? {});
          changed();
          break;
        case "account":
          s.account = message.data ?? null;
          changed();
          break;
        case "freeze":
          s.frozen = Boolean(message.frozen);
          s.frozenAt = message.at ?? now();
          if (!s.frozen && s.pending) { s.snapshot = s.pending; s.pending = null; }
          changed();
          break;
        case "snapshot":
          if (!message.snapshot || !Array.isArray(message.snapshot.options)) return;
          if (s.frozen) { s.pending = message.snapshot; return; }
          s.snapshot = message.snapshot;
          s.snapshotAt = now();
          s.source = message.source ?? null;
          changed();
          break;
        case "bars":
          s.bars = {hourly: Array.isArray(message.hourly) ? message.hourly : unpackBars(message.hourly),
            daily: Array.isArray(message.daily) ? message.daily : unpackBars(message.daily)};
          s.barsSource = message.source ?? null;
          s.barsAt = message.at ?? now();
          changed();
          break;
        case "tick":
          // Ages and time-to-expiry move even when quotes do not.
          if (s.frozen || !s.snapshot || now() - s.lastComputeAt < (message.minInterval ?? 15_000)) return;
          changed();
          break;
        default:
          return;
      }
      schedule();
    },
  };
}
