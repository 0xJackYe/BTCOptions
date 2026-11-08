// Engine host: network + cache + engine. Runs in a dedicated Web Worker
// (preferred) or on the main thread. Market frames are revalidated with
// If-None-Match, failures back off exponentially with jitter, polling pauses
// while hidden or offline, and the last good frame boots the next visit.
import {createEngine} from "./engine.js";
import {decodeFrame, validFrame} from "../lib/market.mjs";
import {parseKlines, unpackBars} from "../lib/signals.mjs";

const KLINE_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];
const MAX_BACKOFF = 30_000;

/* -------------------------------------------------------------- IndexedDB */
function openStore() {
  return new Promise(resolve => {
    try {
      const request = indexedDB.open("btc-strategy-desk", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}
const storePromise = typeof indexedDB === "undefined" ? Promise.resolve(null) : openStore();
async function cacheGet(key) {
  const db = await storePromise;
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const request = db.transaction("kv", "readonly").objectStore("kv").get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function cacheSet(key, value) {
  const db = await storePromise;
  if (!db) return;
  try { db.transaction("kv", "readwrite").objectStore("kv").put(value, key); } catch { /* quota or private mode */ }
}

/* ------------------------------------------------------------------- host */
export function startHost(post, scope = globalThis) {
  const engine = createEngine(post);
  const net = {
    route: "site", localOrigin: null, hidden: false, online: scope.navigator?.onLine !== false, started: false,
    frame: null, etag: null, failures: 0, lastOk: 0, timer: 0, needDirect: false,
    klineEtag: null, klineTimer: 0, lastFrameSave: 0, live: false, inflight: false, again: false, klineInflight: false, klineAt: 0,
  };

  const report = extra => post({type: "transport", route: net.frame?.replay ? "replay" : net.route, failures: net.failures,
    lastOk: net.lastOk, online: net.online, hidden: net.hidden, ...extra});

  // The timeout covers the whole exchange, body included: a stalled body can
  // never wedge the poll loop.
  async function request(path, {etag = null, timeout = 10_000} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const local = net.route === "local" && net.localOrigin;
    const started = performance.now();
    try {
      const response = await fetch((local ? net.localOrigin : "") + path, {
        headers: etag ? {"If-None-Match": etag} : {}, cache: "no-store", redirect: "error", signal: controller.signal,
        credentials: local ? "omit" : "same-origin", ...(local ? {targetAddressSpace: "loopback"} : {}),
      });
      const latency = performance.now() - started, receivedAt = Date.now();
      const text = await response.text();
      return {response, text, latency, receivedAt};
    } finally {
      clearTimeout(timer);
    }
  }

  function accept(frame, timing, {cached = false} = {}) {
    let snapshot;
    try { snapshot = decodeFrame(frame, timing); } catch { return false; }
    if (cached) snapshot.cached = true;
    engine.handle({type: "snapshot", snapshot, source: cached ? "cache" : frame.replay ? "replay" : net.route});
    return true;
  }

  function nextDelay() {
    const base = net.route === "local" ? 3000 : 5000;
    if (!net.failures) return base;
    return Math.min(MAX_BACKOFF, base * 2 ** (net.failures - 1)) * (.75 + Math.random() * .5);
  }

  // One request at a time: a forced poll during a request runs right after
  // it, so there is never more than one timer chain.
  async function pollMarket(force = false) {
    if (net.inflight) { if (force) net.again = true; return; }
    clearTimeout(net.timer);
    if (!force && (net.hidden || !net.online)) return;
    net.inflight = true;
    try {
      const {response, text, latency, receivedAt} = await request("/api/strategy/market", {etag: net.frame ? net.etag : null});
      const servedHeader = Number(response.headers.get("X-Served-At"));
      const servedAt = Number.isFinite(servedHeader) && servedHeader > 0 ? servedHeader : receivedAt;
      if (response.status === 304 && net.frame) {
        // Unchanged quotes: nothing to decode or re-screen; only let ages
        // advance at the usual 15-second cadence.
        engine.handle({type: "tick", minInterval: 15_000});
      } else if (response.ok) {
        const frame = JSON.parse(text);
        if (!validFrame(frame)) throw new Error("行情帧格式无效");
        if (!frame.rows.s.length || !(frame.spot > 0)) throw new Error(frame.error ?? "行情服务暂无数据");
        net.frame = frame;
        net.etag = response.headers.get("ETag");
        accept(frame, {receivedAt, servedAt});
        if (receivedAt - net.lastFrameSave > 20_000) {
          net.lastFrameSave = receivedAt;
          cacheSet("frame", {text, receivedAt, servedAt, savedAt: receivedAt});
        }
      } else {
        throw new Error("HTTP " + response.status);
      }
      net.failures = 0;
      net.lastOk = Date.now();
      net.live = true;
      if (net.needDirect) { net.needDirect = false; post({type: "direct", active: false}); }
      report({ok: true, latency, error: null});
    } catch (error) {
      net.failures += 1;
      const message = error?.name === "AbortError" ? "行情服务响应超时" : net.route === "local" ? "无法连接本机连接器" : String(error?.message ?? "行情服务暂不可用");
      report({ok: false, error: message, retryIn: nextDelay()});
      // After two consecutive failures on the site route, the main thread
      // opens Binance's public WebSocket and feeds snapshots in directly.
      if (net.failures >= 2 && net.route === "site" && !net.needDirect) { net.needDirect = true; post({type: "direct", active: true}); }
    } finally {
      net.inflight = false;
      clearTimeout(net.timer);
      if (net.stopped) return;
      if (net.again) { net.again = false; net.timer = setTimeout(() => pollMarket(true), 0); }
      else net.timer = setTimeout(() => pollMarket(), nextDelay());
    }
  }

  async function directKlines(interval, limit) {
    for (const host of KLINE_HOSTS) {
      try {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
        let rows;
        try {
          const response = await fetch(`${host}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`,
            {cache: "no-store", credentials: "omit", signal: controller.signal});
          if (!response.ok) continue;
          rows = await response.json();
        } finally {
          clearTimeout(timer);
        }
        const bars = parseKlines(rows);
        if (bars.length >= 24) return bars;
      } catch { /* next host */ }
    }
    return [];
  }

  async function pollKlines() {
    if (net.klineInflight) return;
    clearTimeout(net.klineTimer);
    if (net.hidden) return;                       // resumed by the visibility handler
    net.klineInflight = true;
    try {
      const {response, text, receivedAt} = await request("/api/strategy/klines", {etag: net.klineEtag, timeout: 14_000});
      if (response.status !== 304) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        const body = JSON.parse(text);
        const hourly = unpackBars(body.hourly), daily = unpackBars(body.daily);
        if (!hourly.length && !daily.length) throw new Error("no klines");
        net.klineEtag = response.headers.get("ETag");
        engine.handle({type: "bars", hourly, daily, source: net.frame?.replay ? "replay" : net.route, at: receivedAt});
        cacheSet("bars", {body, at: receivedAt});
      }
    } catch {
      const [hourly, daily] = await Promise.all([directKlines("1h", 240), directKlines("1d", 120)]);
      if (hourly.length || daily.length) engine.handle({type: "bars", hourly, daily, source: "direct", at: Date.now()});
    } finally {
      net.klineInflight = false;
      net.klineAt = Date.now();
      clearTimeout(net.klineTimer);
      if (!net.stopped) net.klineTimer = setTimeout(pollKlines, 60_000);
    }
  }

  async function boot() {
    // Paint the last good state immediately (clearly labelled), then go live.
    const [frame, bars] = await Promise.all([cacheGet("frame"), cacheGet("bars")]);
    if (bars?.body && !engine.state.bars.hourly.length) {
      engine.handle({type: "bars", hourly: unpackBars(bars.body.hourly), daily: unpackBars(bars.body.daily), source: "cache", at: bars.at});
    }
    if (frame?.text && !net.live) {
      try {
        const parsed = JSON.parse(frame.text);
        if (validFrame(parsed) && accept(parsed, {receivedAt: frame.receivedAt, servedAt: frame.servedAt}, {cached: true})) {
          post({type: "boot", cached: true, savedAt: frame.savedAt});
        }
      } catch { /* ignore a damaged cache */ }
    }
  }

  // Ages and time-to-expiry keep moving between quotes; skip while hidden.
  const ticker = setInterval(() => { if (!net.hidden) engine.handle({type: "tick"}); }, 5000);
  scope.addEventListener?.("online", () => { net.online = true; pollMarket(true); });
  scope.addEventListener?.("offline", () => { net.online = false; report({ok: false, error: "网络已断开，恢复后自动重连"}); });

  return {
    /** Stops every timer (tests, or a host being replaced). */
    stop() {
      net.started = true;
      net.stopped = true;
      clearInterval(ticker);
      clearTimeout(net.timer);
      clearTimeout(net.klineTimer);
    },
    handle(message) {
      if (net.stopped) return;
      switch (message.type) {
        case "start":
          if (net.started) return;
          net.started = true;
          boot().finally(() => { pollMarket(true); pollKlines(); });
          return;
        case "route": {
          const route = message.local && message.origin ? "local" : "site", origin = route === "local" ? message.origin : null;
          if (route === net.route && origin === net.localOrigin) return;
          net.route = route;
          net.localOrigin = origin;
          net.etag = null; net.klineEtag = null; net.failures = 0;
          if (net.started) { pollMarket(true); clearTimeout(net.klineTimer); net.klineInflight = false; pollKlines(); }
          return;
        }
        case "visibility": {
          const wasHidden = net.hidden;
          net.hidden = Boolean(message.hidden);
          if (wasHidden && !net.hidden && net.started) {
            pollMarket(true);
            if (Date.now() - net.klineAt > 60_000) pollKlines();
          }
          return;
        }
        case "refresh":
          pollMarket(true);
          return;
        default:
          engine.handle(message);
      }
    },
  };
}
