const PUBLIC_LIMIT = 8 * 1024 * 1024;
const PRIVATE_LIMIT = 1024 * 1024;
const REQUEST_LIMIT = 1024;
const SYMBOL = /^BTC-\d{6}-\d{1,12}(?:\.\d{1,4})?-[CP]$/;
const METHODS = new Map([
  ["/api/market", "GET"], ["/api/focused-market", "GET"], ["/api/mark-watch", "GET"],
  ["/api/account/time", "GET"], ["/api/account", "POST"],
]);
const ACCOUNT_ERRORS = new Set(["invalid_input", "timestamp", "throttled", "credentials", "region",
  "account_unavailable", "unavailable", "invalid_response", "upstream_error", "invalid_source", "method"]);
const HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const PUBLIC_ERRORS = {
  invalid_input: "行情请求参数无效。",
  unavailable: "行情服务正在启动或暂时不可用，请稍后重试。",
  invalid_response: "行情服务返回的数据不完整，请稍后重试。",
  method: "不支持此请求方式。",
  invalid_source: "请通过当前网站读取账户。",
  throttled: "行情服务正在限流，请稍后重试。",
};

class RelayError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failure(status, code, isPrivate, extra = {}) {
  const error = isPrivate ? code : {message: PUBLIC_ERRORS[code] ?? PUBLIC_ERRORS.unavailable};
  return Response.json({error}, {status, headers: {...HEADERS, ...extra}});
}

function relayOrigin(value) {
  if (typeof value !== "string" || !value) throw new RelayError(503, "unavailable");
  let url;
  try {url = new URL(value);} catch {throw new RelayError(503, "unavailable");}
  if (url.protocol !== "https:" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.onrender\.com$/.test(url.hostname) ||
      url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash ||
      (value !== url.origin && value !== url.origin + "/")) {
    throw new RelayError(503, "unavailable");
  }
  return url.origin;
}

async function boundedJson(message, limit, status, code) {
  const length = message.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await message.body?.cancel().catch(() => {});
    throw new RelayError(status, code);
  }
  const reader = message.body?.getReader();
  if (!reader) throw new RelayError(status, code);
  const decoder = new TextDecoder("utf-8", {fatal: true});
  let total = 0;
  const chunks = [];
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new RelayError(status, code);
      chunks.push(decoder.decode(value, {stream: true}));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(""));
  } catch {
    await reader.cancel().catch(() => {});
    throw new RelayError(status, code);
  } finally {reader.releaseLock();}
}

function validateQuery(url) {
  if (url.pathname === "/api/market") {
    if (url.search && url.search !== "?refresh=1") throw new RelayError(400, "invalid_input");
  } else if (url.pathname === "/api/account" || url.pathname === "/api/account/time") {
    if (url.search) throw new RelayError(400, "invalid_input");
  } else {
    const params = [...url.searchParams];
    const symbols = params.length === 1 && params[0][0] === "symbols" ? params[0][1].split(",") : [];
    if (!symbols.length || symbols.length > 8 || symbols.some(symbol => !SYMBOL.test(symbol))) {
      throw new RelayError(400, "invalid_input");
    }
  }
}

function accountBody(body) {
  if (!object(body) || Object.keys(body).length !== 3 ||
      typeof body.apiKey !== "string" || !/^[a-z0-9]{64}$/i.test(body.apiKey) ||
      !Number.isSafeInteger(body.timestamp) || body.timestamp < 1_500_000_000_000 ||
      !object(body.signatures) || Object.keys(body.signatures).length !== 2 ||
      !["account", "positions"].every(key => typeof body.signatures[key] === "string" &&
        /^[a-f0-9]{64}$/.test(body.signatures[key]))) {
    throw new RelayError(400, "invalid_input");
  }
  return JSON.stringify({apiKey: body.apiKey, timestamp: body.timestamp,
    signatures: {account: body.signatures.account, positions: body.signatures.positions}});
}

function validResponse(data, path) {
  if (!object(data)) return false;
  if (path === "/api/account/time") return Number.isSafeInteger(data.serverTime) && data.serverTime > 0;
  if (path === "/api/account") return Array.isArray(data.assets) && Array.isArray(data.positions);
  if (path === "/api/mark-watch") return Number.isInteger(data.accepted) && data.accepted >= 0 && data.accepted <= 8;
  return Array.isArray(data.options) && data.options.length <= 4000;
}

/**
 * Forward only the fixed read-only API surface to a configured Render origin.
 * An unset backend leaves the caller's existing Worker handlers in control.
 */
export async function relay(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  const method = METHODS.get(url.pathname);
  if (!method || !env?.BINANCE_RELAY_URL) return null;
  const isPrivate = url.pathname.startsWith("/api/account");
  if (request.method !== method) return failure(405, "method", isPrivate, {Allow: method});
  try {
    const target = relayOrigin(env.BINANCE_RELAY_URL);
    validateQuery(url);
    const source = request.headers.get("Origin");
    const site = request.headers.get("Sec-Fetch-Site");
    if (isPrivate && ((url.pathname === "/api/account" && source !== url.origin) ||
        (source !== null && source !== url.origin) || (site !== null && site !== "same-origin"))) {
      throw new RelayError(403, "invalid_source");
    }
    if (request.headers.has("Transfer-Encoding")) throw new RelayError(400, "invalid_input");
    const headers = new Headers();
    if (source === url.origin) headers.set("Origin", source);
    let body;
    if (method === "POST") {
      if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        throw new RelayError(415, "invalid_input");
      }
      body = accountBody(await boundedJson(request, REQUEST_LIMIT, 400, "invalid_input"));
      headers.set("Content-Type", "application/json");
    } else if (request.body || Number(request.headers.get("Content-Length") ?? 0) !== 0) {
      throw new RelayError(400, "invalid_input");
    }
    const upstream = await fetcher(target + url.pathname + url.search, {
      method, headers, body, redirect: "manual", signal: AbortSignal.timeout(11_000),
    });
    if (upstream.redirected || upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => {});
      throw new RelayError(503, "unavailable");
    }
    if (!upstream.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
      await upstream.body?.cancel().catch(() => {});
      throw new RelayError(503, "unavailable");
    }
    const data = await boundedJson(upstream, isPrivate ? PRIVATE_LIMIT : PUBLIC_LIMIT, 502, "invalid_response");
    if (!upstream.ok) {
      const code = isPrivate && ACCOUNT_ERRORS.has(data?.error) ? data.error
        : upstream.status === 429 ? "throttled" : "unavailable";
      const status = [400, 401, 403, 404, 405, 413, 415, 429, 502, 503].includes(upstream.status)
        ? upstream.status : 503;
      return failure(status, code, isPrivate, upstream.status === 429 ? {"Retry-After": "60"} : {});
    }
    if (!validResponse(data, url.pathname)) throw new RelayError(502, "invalid_response");
    return Response.json(data, {headers: HEADERS});
  } catch (error) {
    return error instanceof RelayError ? failure(error.status, error.code, isPrivate)
      : failure(503, "unavailable", isPrivate);
  }
}
