/**
 * Strategy Desk API. Portable request → response handlers for Node.js (local
 * connector and the Render backend) and Cloudflare Workers.
 *
 *   GET /api/strategy/catalog   strategy definitions, metrics and citations
 *   GET /api/strategy/signals   regime: crash trigger, realized vol, IV surface, klines
 *   GET /api/strategy/screen    server-side screening (?id=crash-put&dte=30~60…)
 *   GET /api/strategy/account   account snapshot signed with server-held credentials
 *
 * Public market data needs no API key. The account route only works when the
 * operator configures BINANCE_API_KEY / BINANCE_API_SECRET; on a public host it
 * additionally requires BTCOPT_ACCESS_TOKEN as a bearer token (fail closed).
 * No route can place, change or cancel orders.
 */
import {catalog, getStrategy} from "./lib/strategies.mjs";
import {createContext, screen, serializeResult} from "./lib/screener.mjs";
import {parseKlines, packBars, regime} from "./lib/signals.mjs";
import {QueryError, binanceJson, normalizeAccount, normalizePositions} from "./worker-account.mjs";

const SPOT_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];
const ROUTES = new Set(["/api/strategy/catalog", "/api/strategy/signals", "/api/strategy/screen", "/api/strategy/account"]);
const KLINE_LIMIT = 768 * 1024;
const PUBLIC_HEADERS = {"Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"};
const PRIVATE_HEADERS = {...PUBLIC_HEADERS, "Cache-Control": "private, no-store, max-age=0", "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, noarchive"};
const SETTING_KEYS = new Set(["id", "limit", "budget", "holdings", "vol", "customVol"]);
const KEY_PATTERN = /^[A-Za-z0-9]{64}$/;

const json = (value, status = 200, headers = PUBLIC_HEADERS) => new Response(JSON.stringify(value), {status, headers});
const fail = (status, code, message, headers = PUBLIC_HEADERS, extra = {}) =>
  json({error: {code, message}}, status, {...headers, ...extra});

async function boundedJson(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > limit || !response.body) throw new Error("oversized");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", {fatal: true});
  let size = 0, text = "";
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("oversized");
      text += decoder.decode(value, {stream: true});
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

/** Reads server-held credentials; malformed values count as not configured. */
export function readCredentials(env = {}) {
  const apiKey = typeof env.BINANCE_API_KEY === "string" ? env.BINANCE_API_KEY.trim() : "";
  const apiSecret = typeof env.BINANCE_API_SECRET === "string" ? env.BINANCE_API_SECRET.trim() : "";
  if (!apiKey && !apiSecret) return {configured: false, reason: "missing"};
  if (!KEY_PATTERN.test(apiKey) || !KEY_PATTERN.test(apiSecret)) return {configured: false, reason: "invalid_format"};
  return {configured: true, apiKey, apiSecret};
}

async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Constant-time bearer comparison over SHA-256 digests. */
async function tokenMatches(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 300) return false;
  const [a, b] = await Promise.all([digest(header.slice(7).trim()), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function createStrategyHandler({
  getMarket,
  fetcher = (...args) => fetch(...args),
  now = Date.now,
  credentials = {configured: false, reason: "missing"},
  accessToken = null,
  hosted = false,
  replayKlines = null,
} = {}) {
  if (typeof getMarket !== "function") throw new TypeError("getMarket is required");
  const klineCache = new Map();
  let embargo = 0, clock = {offset: 0, at: 0}, signingKey = null, accountFlight = null, accountMemo = null;
  const catalogBody = JSON.stringify(catalog());

  async function loadKlines(interval, limit, ttl) {
    if (replayKlines) {
      const rows = interval === "1h" ? replayKlines.hourly : replayKlines.daily;
      return {bars: parseKlines(rows ?? []), at: now(), stale: false, source: "replay"};
    }
    const prior = klineCache.get(interval);
    if (prior?.pending) return prior.pending;
    if (prior && now() - prior.at < ttl) return prior;
    const pending = (async () => {
      let lastError = "unavailable";
      if (now() < embargo) lastError = "rate_limited";
      else {
        for (const host of SPOT_HOSTS) {
          try {
            const response = await fetcher(`${host}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`,
              {method: "GET", headers: {Accept: "application/json"}, redirect: "manual", signal: AbortSignal.timeout(4500)});
            if (response.status === 429 || response.status === 418) {
              embargo = now() + (Number(response.headers.get("retry-after")) || 60) * 1000;
              await response.body?.cancel().catch(() => {});
              lastError = "rate_limited";
              break;
            }
            if (!response.ok) { await response.body?.cancel().catch(() => {}); lastError = response.status === 451 ? "restricted" : "unavailable"; continue; }
            const bars = parseKlines(await boundedJson(response, KLINE_LIMIT));
            if (bars.length < Math.min(24, limit)) { lastError = "invalid"; continue; }
            const entry = {bars, at: now(), stale: false, source: new URL(host).hostname};
            klineCache.set(interval, entry);
            return entry;
          } catch { lastError = "unavailable"; }
        }
      }
      // Keep the last good series for 15 minutes, clearly marked stale.
      if (prior?.bars && now() - prior.at <= 900_000) {
        const entry = {...prior, stale: true, error: lastError, pending: undefined};
        klineCache.set(interval, {...entry, at: prior.at});
        return entry;
      }
      klineCache.delete(interval);
      return {bars: [], at: null, stale: true, error: lastError, source: null};
    })();
    klineCache.set(interval, {...(prior ?? {}), pending});
    try { return await pending; } finally {
      const current = klineCache.get(interval);
      if (current?.pending === pending) klineCache.set(interval, {...current, pending: undefined});
    }
  }

  async function marketAndKlines() {
    const [snapshot, hourly, daily] = await Promise.all([getMarket(), loadKlines("1h", 240, 60_000), loadKlines("1d", 120, 1_800_000)]);
    return {snapshot, hourly, daily};
  }

  async function signals() {
    const {snapshot, hourly, daily} = await marketAndKlines();
    const ctx = createContext({snapshot, localNow: now(), klines: {hourlyBars: hourly.bars, dailyBars: daily.bars}});
    const summary = ctx.market.ok ? regime({hourly: hourly.bars, daily: daily.bars, nowMs: ctx.market.exchangeNow, spot: ctx.market.spot, surface: ctx.surface}) : null;
    return json({
      asOf: ctx.market.exchangeNow, spot: ctx.market.spot, replay: Boolean(snapshot?.replay), regime: summary,
      klines: {hourly: packBars(hourly.bars.slice(-240)), daily: packBars(daily.bars.slice(-120))},
      sources: {hourly: {at: hourly.at, stale: hourly.stale, error: hourly.error ?? null, source: hourly.source},
        daily: {at: daily.at, stale: daily.stale, error: daily.error ?? null, source: daily.source},
        market: {status: snapshot?.status ?? null, stale: Boolean(snapshot?.stale), fetchedAt: snapshot?.fetched_at ?? null}},
    });
  }

  function parseScreenQuery(url) {
    if (url.search.length > 2048) throw new QueryError(400, "query_too_long");
    const params = {}, settings = {};
    let id = null, limit = 50;
    for (const [key, value] of url.searchParams) {
      if (!/^[A-Za-z]{1,24}$/.test(key) || !/^[A-Za-z0-9.~_-]{0,64}$/.test(value) || Object.hasOwn(params, key)) {
        throw new QueryError(400, "invalid_input");
      }
      if (key === "id") id = value;
      else if (key === "limit") limit = Math.min(200, Math.max(1, Number.parseInt(value, 10) || 50));
      else if (key === "budget") settings.riskBudget = Number(value);
      else if (key === "holdings") settings.holdingsUsd = Number(value);
      else if (key === "vol") settings.evVol = value;
      else if (key === "customVol") settings.evVolCustom = Number(value);
      else params[key] = value;
    }
    const strategy = getStrategy(id);
    if (!strategy) throw new QueryError(400, "unknown_strategy");
    const allowed = new Set(strategy.params.map(param => param.key));
    for (const key of Object.keys(params)) if (!allowed.has(key) && !SETTING_KEYS.has(key)) throw new QueryError(400, "unknown_param");
    return {strategy, params, settings, limit};
  }

  async function screenRoute(url) {
    const {strategy, params, settings, limit} = parseScreenQuery(url);
    const {snapshot, hourly, daily} = await marketAndKlines();
    const ctx = createContext({snapshot, localNow: now(), settings, klines: {hourlyBars: hourly.bars, dailyBars: daily.bars}});
    const result = screen(ctx, strategy.id, params, {limit});
    return json({asOf: ctx.market.exchangeNow, replay: Boolean(snapshot?.replay), klines: {hourlyStale: hourly.stale, dailyStale: daily.stale},
      ...serializeResult(result)});
  }

  async function exchangeTime() {
    if (now() - clock.at < 60_000) return now() + clock.offset;
    const began = now();
    const data = await binanceJson(fetcher, "/eapi/v1/time");
    const ended = now();
    if (!Number.isSafeInteger(data?.serverTime)) throw new QueryError(502, "invalid_response");
    clock = {offset: Math.round(data.serverTime - (began + ended) / 2), at: ended};
    return ended + clock.offset;
  }

  async function sign(payload) {
    signingKey ??= await crypto.subtle.importKey("raw", new TextEncoder().encode(credentials.apiSecret),
      {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", signingKey, new TextEncoder().encode(payload));
    return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  async function fetchAccount() {
    const timestamp = await exchangeTime();
    const call = async (path, windowMs) => {
      const query = `timestamp=${timestamp}&recvWindow=${windowMs}`;
      return binanceJson(fetcher, path, "?" + query + "&signature=" + await sign(query), credentials.apiKey);
    };
    const [account, positions] = await Promise.allSettled([call("/eapi/v1/marginAccount", 5000), call("/eapi/v1/position", 5000)]);
    if (account.status === "rejected") throw account.reason;
    if (positions.status === "rejected") throw positions.reason;
    return {...normalizeAccount(account.value), positions: normalizePositions(positions.value), receivedAt: now()};
  }

  async function accountRoute(request) {
    if (!credentials.configured) {
      return json({configured: false, reason: credentials.reason, mode: "server"}, 200, PRIVATE_HEADERS);
    }
    if (hosted) {
      if (!accessToken) return json({configured: true, authorized: false, reason: "hosted_requires_token"}, 403, PRIVATE_HEADERS);
      if (!await tokenMatches(request.headers.get("Authorization"), accessToken)) {
        return json({configured: true, authorized: false, reason: "token_required"}, 401, {...PRIVATE_HEADERS, "WWW-Authenticate": "Bearer"});
      }
    }
    // Single-flight with a 5-second in-memory memo: several open tabs share one
    // signed request. Nothing private is written to disk or shared caches.
    if (accountMemo && now() - accountMemo.at < 5000) return json({configured: true, authorized: true, mode: "server", ...accountMemo.data}, 200, PRIVATE_HEADERS);
    try {
      accountFlight ??= fetchAccount().finally(() => { accountFlight = null; });
      const data = await accountFlight;
      accountMemo = {at: now(), data};
      return json({configured: true, authorized: true, mode: "server", ...data}, 200, PRIVATE_HEADERS);
    } catch (error) {
      const code = error instanceof QueryError ? error.message : "unavailable";
      const status = error instanceof QueryError ? error.status : 503;
      return json({configured: true, authorized: true, error: code}, status, status === 429 ? {...PRIVATE_HEADERS, "Retry-After": "60"} : PRIVATE_HEADERS);
    }
  }

  return async function handleStrategy(request) {
    const url = new URL(request.url);
    if (!ROUTES.has(url.pathname)) return null;
    const isPrivate = url.pathname === "/api/strategy/account";
    const headers = isPrivate ? PRIVATE_HEADERS : PUBLIC_HEADERS;
    if (request.method !== "GET") return fail(405, "method", "仅支持 GET。", headers, {Allow: "GET"});
    try {
      if (url.pathname !== "/api/strategy/screen" && url.search) throw new QueryError(400, "invalid_input");
      if (url.pathname === "/api/strategy/catalog") {
        return new Response(catalogBody, {headers: {...PUBLIC_HEADERS, "Cache-Control": "public, max-age=300"}});
      }
      if (url.pathname === "/api/strategy/signals") return await signals();
      if (url.pathname === "/api/strategy/screen") return await screenRoute(url);
      return await accountRoute(request);
    } catch (error) {
      if (error instanceof QueryError) {
        const messages = {invalid_input: "请求参数无效。", query_too_long: "请求参数过长。", unknown_strategy: "未知策略。", unknown_param: "包含该策略不支持的参数。"};
        return fail(error.status, error.message, messages[error.message] ?? "请求无法完成。", headers);
      }
      return fail(503, "unavailable", "策略服务暂时不可用，请稍后重试。", headers);
    }
  };
}
