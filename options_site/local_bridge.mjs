// Run after node options_site/build.mjs. No dependencies beyond Node.js 22.
import {createServer} from "node:http";
import {existsSync} from "node:fs";
import {readFile, readdir} from "node:fs/promises";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";
import {brotliCompressSync, constants as zlibConstants, createBrotliCompress, createGzip, gzipSync} from "node:zlib";
import {handleAccount} from "./dist/_worker.js/worker-account.mjs";
import {handleMarket as liveMarket} from "./dist/_worker.js/worker-market.mjs";
import {CONDITIONAL_ROUTES, createStrategyHandler, readCredentials} from "./dist/_worker.js/worker-strategy.mjs";
import {createReplayMarket} from "./replay.mjs";

const CLOUD = process.env.BTCOPT_HOSTED === "1";
// Local runs read optional secrets from a git-ignored .env file. On Render the
// operator sets the same names as secret environment variables instead.
if (!CLOUD && process.env.BTCOPT_NO_DOTENV !== "1") {
  for (const candidate of [new URL("./.env", import.meta.url), new URL("../.env", import.meta.url)]) {
    if (existsSync(candidate)) { process.loadEnvFile(candidate); break; }
  }
}
const HOST = CLOUD ? "0.0.0.0" : "127.0.0.1";
const PORT = Number(CLOUD ? process.env.PORT ?? "10000" : process.env.BTCOPT_BRIDGE_PORT ?? "8767");
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("无效的本地看板端口。");
const CLOUD_HOST = process.env.RENDER_EXTERNAL_HOSTNAME;
if (CLOUD && (typeof CLOUD_HOST !== "string" || !/^[a-z0-9-]+\.onrender\.com$/.test(CLOUD_HOST))) {
  throw new Error("Hosted mode requires the Render service hostname.");
}
const HOST_HEADER = CLOUD ? CLOUD_HOST : HOST + ":" + PORT;
const LOCAL = (CLOUD ? "https://" : "http://") + HOST_HEADER;
const HOSTED = "https://btcopt.pages.dev";
const DIST = new URL("./dist/", import.meta.url);
const LIMIT = 1024;
const API = new Map([
  ["/api/health", "GET"], ["/api/market", "GET"], ["/api/focused-market", "GET"],
  ["/api/mark-watch", "GET"], ["/api/account/time", "GET"], ["/api/account", "POST"],
  ["/api/strategy/market", "GET"], ["/api/strategy/klines", "GET"],
  ["/api/strategy/catalog", "GET"], ["/api/strategy/signals", "GET"], ["/api/strategy/screen", "GET"],
  ["/api/strategy/account", "GET"],
]);
const TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  woff2: "font/woff2",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
};
// Every regular file the build emitted, except the Worker bundle and dotfiles.
async function collectAssets(directory, prefix = "") {
  const found = new Set();
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const path = prefix + entry.name;
    if (entry.isDirectory()) for (const nested of await collectAssets(new URL(entry.name + "/", directory), path + "/")) found.add(nested);
    else if (entry.isFile() && Object.hasOwn(TYPES, entry.name.split(".").at(-1))) found.add(path);
  }
  return found;
}
const ASSETS = await collectAssets(DIST);

// Replay serves a recorded snapshot with a frozen clock. Never on a public host.
const REPLAY = process.env.BTCOPT_REPLAY;
if (REPLAY && CLOUD) throw new Error("Replay mode is local-only.");
const replaySnapshot = REPLAY ? JSON.parse(await readFile(REPLAY, "utf8")) : null;
const replayKlinesFile = process.env.BTCOPT_REPLAY_KLINES;
const replayDaily = replayKlinesFile ? JSON.parse(await readFile(replayKlinesFile, "utf8")) : null;
const handleMarket = replaySnapshot ? createReplayMarket(replaySnapshot) : liveMarket;
const handleStrategy = createStrategyHandler({
  // In-process snapshot object: no second JSON encode/parse per request.
  latest: typeof handleMarket.latest === "function" ? () => handleMarket.latest(LOCAL) : null,
  getMarket: async () => (await handleMarket(new Request(LOCAL + "/api/market"))).json(),
  serverClock: replaySnapshot ? handleMarket.clock : null,
  credentials: readCredentials(process.env),
  accessToken: typeof process.env.BTCOPT_ACCESS_TOKEN === "string" && process.env.BTCOPT_ACCESS_TOKEN.trim().length >= 24
    ? process.env.BTCOPT_ACCESS_TOKEN.trim() : null,
  hosted: CLOUD,
  replayKlines: replaySnapshot ? {hourly: [], daily: Array.isArray(replayDaily?.klines) ? replayDaily.klines : Array.isArray(replayDaily) ? replayDaily : []} : null,
});
const SECURITY = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const CSP = "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const CORS_VARY = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network";
let exchangeOffset = 0;
let clockReadAt = 0;

function fail(res, status, error, headers = {}) {
  const body = JSON.stringify({error});
  res.writeHead(status, {...SECURITY, "Content-Type": TYPES.json, "Content-Length": Buffer.byteLength(body),
    Connection: "close", ...headers});
  res.end(body);
}

function allowOrigin(origin) {
  return origin === HOSTED || origin === LOCAL;
}

function apiHeaders(origin) {
  return allowOrigin(origin) ? {Vary: CORS_VARY, "Access-Control-Allow-Origin": origin, "Access-Control-Expose-Headers": "ETag, X-Served-At"}
    : {Vary: CORS_VARY};
}

/* Compression: brotli or gzip by Accept-Encoding. Bodies that carry a strong
 * validator are compressed once per ETag and replayed from memory. */
const COMPRESSIBLE = /^(application\/json|text\/|image\/svg\+xml)/i;
const compressed = new Map(), compressedAssets = new Map();
function negotiate(req) {
  const offers = String(req.headers["accept-encoding"] ?? "").toLowerCase().split(",").map(part => part.trim().split(";"));
  const accepts = name => offers.some(([token, ...params]) => token.trim() === name && !params.some(param => /^\s*q=0(?:\.0*)?\s*$/.test(param)));
  return accepts("br") ? "br" : accepts("gzip") ? "gzip" : null;
}
function compressOnce(key, raw, encoding, cache = compressed) {
  let body = cache.get(key);
  if (!body) {
    body = encoding === "br" ? brotliCompressSync(raw, {params: {[zlibConstants.BROTLI_PARAM_QUALITY]: 6, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length}})
      : gzipSync(raw, {level: 6});
    cache.set(key, body);
    if (cache === compressed && cache.size > 48) cache.delete(cache.keys().next().value);
  }
  return body;
}
const withVary = (headers, value) => ({...headers, Vary: headers.Vary ? headers.Vary + ", " + value : value});

function noBody(req) {
  return !req.headers["transfer-encoding"] && (!req.headers["content-length"] || req.headers["content-length"] === "0");
}

function preflight(req, res, origin, method, headers, path) {
  const requested = req.headers["access-control-request-headers"];
  const fields = requested ? requested.toLowerCase().split(",").map(field => field.trim()) : [];
  const privateNetwork = req.headers["access-control-request-private-network"];
  const allowedField = field => field === "content-type" ? method === "POST"
    : field === "authorization" ? path === "/api/strategy/account" : field === "if-none-match" && CONDITIONAL_ROUTES.has(path);
  if (!allowOrigin(origin) || !noBody(req) || req.headers["access-control-request-method"] !== method ||
      fields.some(field => !allowedField(field)) ||
      (privateNetwork !== undefined && privateNetwork !== "true")) {
    fail(res, 403, "invalid_source");
    return;
  }
  res.writeHead(204, {...SECURITY, ...headers, "Access-Control-Allow-Methods": method,
    ...(fields.length ? {"Access-Control-Allow-Headers": method === "POST" ? "Content-Type" : CONDITIONAL_ROUTES.has(path) ? "If-None-Match" : "Authorization"} : {}),
    // Older clients may still send a PNA preflight.
    ...(privateNetwork === "true" ? {"Access-Control-Allow-Private-Network": "true"} : {}),
    "Access-Control-Max-Age": "300"});
  res.end();
}

async function sendResponse(res, reply, headers, req) {
  const outgoing = Object.fromEntries(reply.headers);
  // Use Node's normal response framing and enforce no-store even for public
  // data. Never pass a provider-supplied header or a credential to the browser.
  delete outgoing["content-length"];
  const compressible = reply.body && reply.status === 200 && COMPRESSIBLE.test(outgoing["content-type"] ?? "");
  const encoding = compressible ? negotiate(req) : null;
  const finalHeaders = compressible ? withVary({...outgoing, ...SECURITY, ...headers}, "Accept-Encoding") : {...outgoing, ...SECURITY, ...headers};
  if (!encoding) {
    res.writeHead(reply.status, finalHeaders);
    if (reply.body) await pipeline(Readable.fromWeb(reply.body), res);
    else res.end();
    return;
  }
  if (outgoing.etag) {
    const key = outgoing.etag + "|" + encoding;
    let body = compressed.get(key);
    if (body) await reply.body.cancel().catch(() => {});
    else body = compressOnce(key, Buffer.from(await reply.arrayBuffer()), encoding);
    res.writeHead(reply.status, {...finalHeaders, "Content-Encoding": encoding, "Content-Length": body.length});
    res.end(body);
    return;
  }
  res.writeHead(reply.status, {...finalHeaders, "Content-Encoding": encoding});
  const stream = encoding === "br" ? createBrotliCompress({params: {[zlibConstants.BROTLI_PARAM_QUALITY]: 4}}) : createGzip({level: 5});
  await pipeline(Readable.fromWeb(reply.body), stream, res);
}

async function serveApi(req, res, url, origin) {
  const method = API.get(url.pathname);
  const headers = apiHeaders(origin);
  if (!method) return fail(res, 404, "not_found", headers);
  if (req.method === "OPTIONS") return preflight(req, res, origin, method, headers, url.pathname);
  if (req.method !== method) return fail(res, 405, "method", {...headers, Allow: method});
  // A browser cross-origin no-CORS fetch must not reach any local API.
  if (!origin && (req.headers["sec-fetch-site"] === "cross-site" || method === "POST")) {
    return fail(res, 403, "invalid_source", headers);
  }
  const requestHeaders = new Headers();
  if (origin) requestHeaders.set("Origin", LOCAL);
  requestHeaders.set("Sec-Fetch-Site", "same-origin");
  if (CONDITIONAL_ROUTES.has(url.pathname)) {
    const validator = req.headers["if-none-match"];
    if (typeof validator === "string") {
      if (validator.length > 200 || !/^[\x21-\x7e ,]+$/.test(validator)) return fail(res, 400, "invalid_input", headers);
      requestHeaders.set("If-None-Match", validator);
    }
  }
  if (url.pathname === "/api/strategy/account") {
    const authorization = req.headers.authorization;
    if (typeof authorization === "string") {
      if (authorization.length > 300 || !/^Bearer [\x21-\x7e]{1,280}$/.test(authorization)) return fail(res, 400, "invalid_input", headers);
      requestHeaders.set("Authorization", authorization);
    }
  }
  let body;
  if (method === "POST") {
    const type = req.headers["content-type"];
    const length = req.headers["content-length"];
    if (typeof type !== "string" || type.split(";")[0].trim().toLowerCase() !== "application/json") {
      return fail(res, 415, "invalid_input", headers);
    }
    if (req.headers["transfer-encoding"] || typeof length !== "string" || !/^[1-9]\d*$/.test(length)) {
      return fail(res, 400, "invalid_input", headers);
    }
    if (Number(length) > LIMIT) return fail(res, 413, "invalid_input", headers);
    const chunks = [];
    let received = 0;
    for await (const chunk of req) {
      received += chunk.length;
      if (received > LIMIT || received > Number(length)) return fail(res, 413, "invalid_input", headers);
      chunks.push(chunk);
    }
    if (received !== Number(length)) return fail(res, 400, "invalid_input", headers);
    body = Buffer.concat(chunks, received);
    requestHeaders.set("Content-Type", "application/json");
    requestHeaders.set("Content-Length", length);
  } else if (!noBody(req)) return fail(res, 400, "invalid_input", headers);
  if (res.destroyed) return;

  // The API client validates its same-origin inputs. External origins were
  // checked above, and only this fixed loopback URL and explicit headers enter
  // the existing Workers handlers.
  const request = new Request(LOCAL + url.pathname + url.search, {method, headers: requestHeaders, body});
  let reply;
  if (url.pathname === "/api/health") {
    if (url.search) return fail(res, 400, "invalid_input", headers);
    reply = Response.json({status: "ok", service: "btcoptions", transport: "loopback", ...(replaySnapshot ? {replay: true} : {})});
  } else if (url.pathname === "/api/account/time") {
    const began = Date.now();
    reply = await handleAccount(request);
    if (reply.ok) {
      const {serverTime} = await reply.clone().json();
      const ended = Date.now();
      const offset = Math.round(serverTime - (began + ended) / 2);
      if (Number.isSafeInteger(offset) && Math.abs(offset) <= 120_000 && ended - began <= 5000) {
        exchangeOffset = offset;
        clockReadAt = ended;
      }
    }
  } else if (url.pathname === "/api/account") {
    // The browser signs using Binance time. A recently calibrated offset is
    // needed when the Windows clock differs from Binance by several seconds.
    const accountNow = () => {
      const local = Date.now();
      return local - clockReadAt <= 60_000 ? local + exchangeOffset : local;
    };
    try {reply = await handleAccount(request, {now: accountNow});}
    finally {body.fill(0);}
  } else if (url.pathname.startsWith("/api/strategy/")) reply = await handleStrategy(request);
  else reply = await handleMarket(request);
  if (reply) await sendResponse(res, reply, headers, req);
  else fail(res, 404, "not_found", headers);
}

async function serve(req, res) {
  if (CLOUD && req.method === "GET" && req.url === "/api/health" && noBody(req)) {
    res.writeHead(200, {...SECURITY, "Content-Type": TYPES.json});
    res.end(JSON.stringify({status: "ok", service: "btcoptions", transport: "cloud"}));
    return;
  }
  const h = req.headersDistinct;
  const origin = req.headers.origin;
  if (h.host?.length !== 1 || h.host[0] !== HOST_HEADER ||
      ["origin", "content-type", "content-length", "transfer-encoding", "access-control-request-method",
        "access-control-request-headers", "access-control-request-private-network", "sec-fetch-site"]
        .some(name => h[name]?.length > 1) || (origin !== undefined && !allowOrigin(origin))) {
    return fail(res, 403, "invalid_source");
  }
  const path = req.url?.split("?", 1)[0];
  if (!path?.startsWith("/") || path.startsWith("//") || /[%\\]/.test(path) ||
      path.split("/").some(segment => segment === "." || segment === "..")) {
    return fail(res, 400, "invalid_input");
  }
  const url = new URL(req.url, LOCAL);
  if (url.pathname.startsWith("/api/")) return serveApi(req, res, url, origin);
  if (!["GET", "HEAD"].includes(req.method) || !noBody(req)) return fail(res, 405, "method", {Allow: "GET, HEAD"});
  const asset = url.pathname === "/" ? "index.html" : url.pathname === "/strategy" ? "strategy.html" : url.pathname.slice(1);
  if (!ASSETS.has(asset)) return fail(res, 404, "not_found");
  const data = await readFile(new URL(asset, DIST));
  const type = TYPES[asset.split(".").at(-1)];
  const encoding = COMPRESSIBLE.test(type) ? negotiate(req) : null;
  // Strategy Desk URLs carry a content version (?v=…) from build.mjs, so
  // they never change: cache them for a year. Everything else revalidates.
  const caching = {"Cache-Control": /^\?v=[0-9a-f]{10}$/.test(url.search) && /^(strategy|lib)\//.test(asset)
    ? "public, max-age=31536000, immutable" : "no-cache"};
  if (encoding) {
    const body = compressOnce(asset + "|" + data.length + "|" + encoding, data, encoding, compressedAssets);
    res.writeHead(200, {...SECURITY, "Content-Security-Policy": CSP, "Content-Type": type, "Content-Encoding": encoding,
      "Content-Length": body.length, Vary: "Accept-Encoding", ...caching});
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  res.writeHead(200, {...SECURITY, "Content-Security-Policy": CSP, "Content-Type": type,
    "Content-Length": data.length, ...caching});
  res.end(req.method === "HEAD" ? undefined : data);
}

const server = createServer({maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 12_000,
  connectionsCheckingInterval: 1000, keepAliveTimeout: 3000}, (req, res) => {
  serve(req, res).catch(() => {
    if (!res.headersSent && !res.destroyed) {
      const origin = req.headers.origin;
      fail(res, 503, "unavailable", req.url?.startsWith("/api/") ? apiHeaders(origin) : {});
    } else if (!res.destroyed) res.destroy();
  });
});
server.on("clientError", (_error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});
server.on("error", () => {
  process.stderr.write("无法启动本地期权看板，请检查端口 " + PORT + "。\n");
  process.exitCode = 1;
});
// Render sends SIGTERM before replacing an instance: finish in-flight
// responses, drop idle keep-alive sockets, then exit.
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 2500).unref();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
server.listen(PORT, HOST, () => process.stdout.write("BTC 期权看板 " + LOCAL + (replaySnapshot ? "（回放模式）" : "") + "\n策略看板 " + LOCAL + "/strategy.html\n"));
