const BINANCE = "https://eapi.binance.com";
const CLOCK_ROUTE = "/eapi/v1/time";
const REQUEST_LIMIT = 1024;
const UPSTREAM_LIMIT = 512 * 1024;
const IP_LIMIT = 6;
const RATE_WINDOW = 60_000;
const MAX_PEERS = 512;
const MAX_ACTIVE = 16;
const peers = new Map();
let active = 0;

const routes = Object.freeze({
  account: { path: "/eapi/v1/marginAccount", window: 5000 },
  positions: { path: "/eapi/v1/position", window: 4900 },
});
const accountFields = ["marginBalance", "equity", "available", "initialMargin", "maintMargin", "unrealizedPNL", "adjustedEquity"];
const positionFields = ["quantity", "entryPrice", "markPrice", "markValue", "unrealizedPNL", "strikePrice"];

class QueryError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function reply(data, status = 200, extra = {}) {
  return Response.json(data, { status, headers: {
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, noarchive",
    ...extra,
  } });
}

function requireSameOrigin(request, origin, isClock) {
  const source = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if ((!isClock && source !== origin) || (source !== null && source !== origin) ||
      (site !== null && site !== "same-origin")) {
    throw new QueryError(403, "invalid_source");
  }
}

function acquire(request, now, scope) {
  const peer = request.headers.get("CF-Connecting-IP");
  const key = scope + ":" + (peer && /^[0-9a-f:.]{2,45}$/i.test(peer) ? peer : "unknown");
  for (const [address, state] of peers) {
    if (state.expires <= now) peers.delete(address);
  }
  const current = peers.get(key);
  if (active >= MAX_ACTIVE || (current && current.count >= IP_LIMIT) ||
      (!current && peers.size >= MAX_PEERS)) {
    throw new QueryError(429, "throttled");
  }
  if (current) current.count += 1;
  else peers.set(key, { count: 1, expires: now + RATE_WINDOW });
  active += 1;
}

async function boundedJson(message, limit, errorStatus, errorCode) {
  const length = message.headers.get("Content-Length");
  const reader = message.body?.getReader();
  if (!reader) throw new QueryError(errorStatus, errorCode);
  try {
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
      throw new QueryError(errorStatus, errorCode);
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new QueryError(errorStatus, errorCode);
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    void reader.cancel().catch(() => {});
    throw new QueryError(errorStatus, errorCode);
  } finally {
    reader.releaseLock();
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 1_500_000_000_000 && value <= 8_640_000_000_000_000;
}

function validateRequest(body, now) {
  if (!isObject(body) || Object.keys(body).length !== 3 ||
      typeof body.apiKey !== "string" || !/^[A-Za-z0-9]{64}$/.test(body.apiKey) ||
      !timestamp(body.timestamp) || !isObject(body.signatures) ||
      Object.keys(body.signatures).length !== 2 ||
      !Object.keys(routes).every(name => typeof body.signatures[name] === "string" &&
        /^[a-f0-9]{64}$/.test(body.signatures[name]))) {
    throw new QueryError(400, "invalid_input");
  }
  if (now - body.timestamp >= routes.positions.window || body.timestamp - now >= 1000) {
    throw new QueryError(400, "timestamp");
  }
  return body;
}

async function binanceJson(fetcher, path, query = "", apiKey = null) {
  let response;
  try {
    const headers = { Accept: "application/json", "Cache-Control": "no-cache, no-store" };
    if (apiKey) headers["X-MBX-APIKEY"] = apiKey;
    response = await fetcher(BINANCE + path + query, {
      method: "GET",
      redirect: "manual",
      headers,
      cf: { cacheTtl: 0, cacheEverything: false },
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    throw new QueryError(503, "unavailable");
  }
  if (response.status === 451 || response.status === 418 || response.status === 429 ||
      response.status >= 500 || response.redirected ||
      (response.status >= 300 && response.status < 400)) {
    if (response.body) void response.body.cancel().catch(() => {});
    if (response.status === 451) throw new QueryError(503, "region");
    if (response.status === 418 || response.status === 429) throw new QueryError(429, "throttled");
    throw new QueryError(503, "unavailable");
  }
  const data = await boundedJson(response, UPSTREAM_LIMIT, 502, "invalid_response");
  const code = isObject(data) && Number.isInteger(data.code) ? data.code : null;
  if (code === -1021) throw new QueryError(400, "timestamp");
  if (code === -21001 || code === -4080) throw new QueryError(403, "account_unavailable");
  if (response.status === 401 || response.status === 403 ||
      [-1002, -1022, -2014, -2015, -5002, -5005, -5008, -5009].includes(code)) {
    throw new QueryError(403, "credentials");
  }
  if (code === -1003) throw new QueryError(429, "throttled");
  if (!response.ok || (code !== null && code < 0)) throw new QueryError(502, "upstream_error");
  return data;
}

function fields(row, names, required) {
  const result = {};
  for (const name of names) {
    const value = row[name];
    if (value == null && !required.includes(name)) {
      result[name] = null;
    } else {
      if (typeof value !== "string" || value.length > 80 ||
          !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
        throw new QueryError(502, "invalid_response");
      }
      result[name] = value;
    }
  }
  return result;
}

function normalizeAccount(data) {
  if (!isObject(data) || !Array.isArray(data.asset) || data.asset.length > 100) {
    throw new QueryError(502, "invalid_response");
  }
  const seen = new Set();
  const assets = data.asset.map(row => {
    if (!isObject(row) || typeof row.asset !== "string" ||
        !/^[A-Z0-9]{1,20}$/.test(row.asset) || seen.has(row.asset)) {
      throw new QueryError(502, "invalid_response");
    }
    seen.add(row.asset);
    const values = fields(row, accountFields, ["marginBalance", "equity", "available", "initialMargin", "maintMargin"]);
    if (Number(values.initialMargin) < 0 || Number(values.maintMargin) < 0) {
      throw new QueryError(502, "invalid_response");
    }
    return { asset: row.asset, ...values };
  });
  return { assets, time: timestamp(data.time) ? data.time : null };
}

function normalizePositions(data) {
  if (!Array.isArray(data) || data.length > 2000) throw new QueryError(502, "invalid_response");
  return data.flatMap(row => {
    if (!isObject(row) || typeof row.symbol !== "string" ||
        !/^[A-Z0-9._]{1,32}-\d{6}-\d{1,16}(?:\.\d{1,12})?-[CP]$/.test(row.symbol) ||
        !["LONG", "SHORT"].includes(row.side)) {
      throw new QueryError(502, "invalid_response");
    }
    const values = fields(row, positionFields, ["quantity"]);
    const quantity = Number(values.quantity);
    if (quantity === 0) return [];
    if ((quantity < 0) !== (row.side === "SHORT")) throw new QueryError(502, "invalid_response");
    return [{
      symbol: row.symbol,
      side: row.side,
      ...values,
      expiryDate: timestamp(row.expiryDate) ? row.expiryDate : null,
      time: timestamp(row.time) ? row.time : null,
      quoteAsset: typeof row.quoteAsset === "string" && /^[A-Z0-9]{1,20}$/.test(row.quoteAsset)
        ? row.quoteAsset : null,
    }];
  });
}

export async function handleAccount(request, { fetcher = (...args) => fetch(...args), now = Date.now } = {}) {
  const { pathname, search, origin } = new URL(request.url);
  const isClock = pathname === "/api/account/time";
  if (!isClock && pathname !== "/api/account") return reply({ error: "not_found" }, 404);
  if (search) return reply({ error: "invalid_input" }, 400);
  const method = isClock ? "GET" : "POST";
  if (request.method !== method) return reply({ error: "method" }, 405, { Allow: method });
  let acquired = false;
  try {
    requireSameOrigin(request, origin, isClock);
    if (isClock) {
      acquire(request, now(), "clock");
      acquired = true;
      const data = await binanceJson(fetcher, CLOCK_ROUTE);
      if (!isObject(data) || !timestamp(data.serverTime)) throw new QueryError(502, "invalid_response");
      return reply({ serverTime: data.serverTime });
    }
    const contentType = request.headers.get("Content-Type") || "";
    if (contentType.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new QueryError(415, "invalid_input");
    }
    const body = await boundedJson(request, REQUEST_LIMIT, 400, "invalid_input");
    const credentials = validateRequest(body, now());
    acquire(request, now(), "account");
    acquired = true;
    const call = name => {
      const { path, window } = routes[name];
      const query = "?timestamp=" + credentials.timestamp + "&recvWindow=" + window +
        "&signature=" + credentials.signatures[name];
      return binanceJson(fetcher, path, query, credentials.apiKey);
    };
    // Wait for both requests to finish before releasing the concurrency slot.
    const [account, positions] = await Promise.allSettled([call("account"), call("positions")]);
    if (account.status === "rejected") throw account.reason;
    if (positions.status === "rejected") throw positions.reason;
    return reply({
      ...normalizeAccount(account.value),
      positions: normalizePositions(positions.value),
      receivedAt: now(),
    });
  } catch (error) {
    if (!(error instanceof QueryError)) return reply({ error: "unavailable" }, 503);
    const headers = error.status === 429 ? { "Retry-After": "60" } : {};
    return reply({ error: error.message }, error.status, headers);
  } finally {
    if (acquired) active -= 1;
  }
}
