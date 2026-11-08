// Strategy Desk engine: market + klines + settings + account → screened,
// ranked, analyzed results. DOM-free so it runs in a Web Worker (preferred)
// or on the main thread. Inputs are coalesced; only the latest state is
// computed, and rail counts are filled in cancellable background slices.
import {createContext, screen, analyzeCandidate, mergeSettings} from "../lib/screener.mjs";
import {regime as computeRegime, unpackBars} from "../lib/signals.mjs";
import {STRATEGIES, getStrategy, normalizeParams, decodeParams} from "../lib/strategies.mjs";

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
  };
  for (const strategy of STRATEGIES) s.paramsById[strategy.id] = normalizeParams(strategy, {}).params;

  const params = id => s.paramsById[id] ?? normalizeParams(getStrategy(id), {}).params;

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

  function compute() {
    s.scheduled = false;
    const started = now();
    const generation = ++s.generation;
    if (!s.snapshot) {
      post({type: "result", seq: ++s.seq, waiting: true, market: summary()});
      return;
    }
    const localNow = s.frozen ? s.frozenAt : now();
    s.ctx = createContext({snapshot: s.snapshot, localNow, settings: s.settings, account: s.account,
      klines: {hourlyBars: s.bars.hourly, dailyBars: s.bars.daily}});
    const built = now();
    const m = s.ctx.market;
    const regime = m.ok ? computeRegime({hourly: s.bars.hourly, daily: s.bars.daily, nowMs: m.exchangeNow, spot: m.spot,
      surface: s.ctx.surface, trigger: triggerSettings()}) : null;
    let result = null;
    try { result = screen(s.ctx, s.strategyId, params(s.strategyId), {limit: 150}); } catch (error) {
      post({type: "error", where: "screen", message: String(error?.message ?? error)});
    }
    s.result = result;
    const screened = now();
    if (result && s.autoSelect && !result.candidates.some(c => c.key === s.selectedKey) && !result.nearMisses.some(c => c.key === s.selectedKey)) {
      s.selectedKey = result.candidates[0]?.key ?? null;
    }
    const detail = detailFor(s.selectedKey);
    s.lastComputeAt = now();
    post({
      type: "result", seq: ++s.seq, strategyId: s.strategyId, params: params(s.strategyId), selectedKey: s.selectedKey,
      market: summary(), portfolio: s.ctx.portfolio, rv: s.ctx.rv, regime, trigger: regime?.crash ?? null,
      result: result && {...result, candidates: result.candidates.map(strip), nearMisses: result.nearMisses.map(strip)},
      detail, source: s.source, barsSource: s.barsSource, barsAt: s.barsAt, frozen: s.frozen,
      timings: {context: built - started, screen: screened - built, total: now() - started},
    });
    countsFrom(generation);
  }

  // Rail counts: one strategy per slice, abandoned as soon as inputs change.
  function countsFrom(generation) {
    const queue = STRATEGIES.map(strategy => strategy.id).filter(id => id !== s.strategyId);
    const counts = {};
    if (s.result) counts[s.strategyId] = brief(s.result);
    const step = () => {
      if (generation !== s.generation || !s.ctx?.market?.ok) return;
      const id = queue.shift();
      if (id) {
        try { counts[id] = brief(screen(s.ctx, id, params(id), {limit: 1, nearMisses: 0, budgetMs: 300})); }
        catch { counts[id] = {error: true}; }
      }
      if (!queue.length || Object.keys(counts).length % 4 === 0) post({type: "counts", counts: {...counts}, done: !queue.length});
      if (queue.length) defer(step);
    };
    defer(step);
  }

  const brief = result => ({total: result.total, blocked: result.blocked, blockedCount: result.blockedCount ?? null,
    gate: result.gate?.status ?? null, best: result.candidates[0]?.metrics?.[result.rank] ?? null});

  function schedule() {
    if (s.scheduled) return;
    s.scheduled = true;
    defer(compute);
  }

  return {
    state: s,
    compute,
    /** Applies one message; everything except "select" schedules a recompute. */
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
          break;
        case "strategy":
          if (!getStrategy(message.strategyId)) return;
          s.strategyId = message.strategyId;
          s.selectedKey = message.selectedKey ?? null;
          break;
        case "params": {
          const strategy = getStrategy(message.strategyId ?? s.strategyId);
          if (!strategy) return;
          s.paramsById[strategy.id] = normalizeParams(strategy, message.params).params;
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
          break;
        case "account":
          s.account = message.data ?? null;
          break;
        case "freeze":
          s.frozen = Boolean(message.frozen);
          s.frozenAt = message.at ?? now();
          if (!s.frozen && s.pending) { s.snapshot = s.pending; s.pending = null; }
          break;
        case "snapshot":
          if (!message.snapshot || !Array.isArray(message.snapshot.options)) return;
          if (s.frozen) { s.pending = message.snapshot; return; }
          s.snapshot = message.snapshot;
          s.snapshotAt = now();
          s.source = message.source ?? null;
          break;
        case "bars":
          s.bars = {hourly: Array.isArray(message.hourly) ? message.hourly : unpackBars(message.hourly),
            daily: Array.isArray(message.daily) ? message.daily : unpackBars(message.daily)};
          s.barsSource = message.source ?? null;
          s.barsAt = message.at ?? now();
          break;
        case "tick":
          // Ages and time-to-expiry move even when quotes do not.
          if (s.frozen || !s.snapshot || now() - s.lastComputeAt < (message.minInterval ?? 15_000)) return;
          break;
        default:
          return;
      }
      schedule();
    },
  };
}
