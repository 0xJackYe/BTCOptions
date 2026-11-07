// Run after node options_site/build.mjs. No dependencies beyond Node.js 22.
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";
import {handleAccount} from "./dist/_worker.js/worker-account.mjs";
import {handleMarket} from "./dist/_worker.js/worker-market.mjs";

const CLOUD = process.env.BTCOPT_HOSTED === "1";
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
]);
const ASSETS = new Set([
  "index.html", "account.html", "version.json", "account.css", "browser-market.js", "anthropic.css",
  "combo.css", "hosted.css", "option-ai.css", "payoff.css", "portfolio.css",
  "risk.css", "styles.css", "account.js", "app.js", "hosted.js", "payoff-ui.js",
  "payoff.js", "portfolio-ui.js", "portfolio.js", "risk-metrics.js", "risk-ui.js", "screener.js",
]);
const TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
};
const SECURITY = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const CSP = "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
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
  return allowOrigin(origin) ? {Vary: CORS_VARY, "Access-Control-Allow-Origin": origin} : {Vary: CORS_VARY};
}

function noBody(req) {
  return !req.headers["transfer-encoding"] && (!req.headers["content-length"] || req.headers["content-length"] === "0");
}

function preflight(req, res, origin, method, headers) {
  const requested = req.headers["access-control-request-headers"];
  const fields = requested ? requested.toLowerCase().split(",").map(field => field.trim()) : [];
  const privateNetwork = req.headers["access-control-request-private-network"];
  if (!allowOrigin(origin) || !noBody(req) || req.headers["access-control-request-method"] !== method ||
      fields.some(field => field !== "content-type" || method !== "POST") ||
      (privateNetwork !== undefined && privateNetwork !== "true")) {
    fail(res, 403, "invalid_source");
    return;
  }
  res.writeHead(204, {...SECURITY, ...headers, "Access-Control-Allow-Methods": method,
    ...(fields.length ? {"Access-Control-Allow-Headers": "Content-Type"} : {}),
    // Older clients may still send a PNA preflight.
    ...(privateNetwork === "true" ? {"Access-Control-Allow-Private-Network": "true"} : {}),
    "Access-Control-Max-Age": "300"});
  res.end();
}

async function sendResponse(res, reply, headers) {
  const outgoing = Object.fromEntries(reply.headers);
  // Use Node's normal response framing and enforce no-store even for public
  // data. Never pass a provider-supplied header or a credential to the browser.
  delete outgoing["content-length"];
  res.writeHead(reply.status, {...outgoing, ...SECURITY, ...headers});
  if (reply.body) await pipeline(Readable.fromWeb(reply.body), res);
  else res.end();
}

async function serveApi(req, res, url, origin) {
  const method = API.get(url.pathname);
  const headers = apiHeaders(origin);
  if (!method) return fail(res, 404, "not_found", headers);
  if (req.method === "OPTIONS") return preflight(req, res, origin, method, headers);
  if (req.method !== method) return fail(res, 405, "method", {...headers, Allow: method});
  // A browser cross-origin no-CORS fetch must not reach any local API.
  if (!origin && (req.headers["sec-fetch-site"] === "cross-site" || method === "POST")) {
    return fail(res, 403, "invalid_source", headers);
  }
  const requestHeaders = new Headers();
  if (origin) requestHeaders.set("Origin", LOCAL);
  requestHeaders.set("Sec-Fetch-Site", "same-origin");
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
    reply = Response.json({status: "ok", service: "btcoptions", transport: "loopback"});
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
  } else reply = await handleMarket(request);
  if (reply) await sendResponse(res, reply, headers);
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
  const asset = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (!ASSETS.has(asset)) return fail(res, 404, "not_found");
  const data = await readFile(new URL(asset, DIST));
  res.writeHead(200, {...SECURITY, "Content-Security-Policy": CSP, "Content-Type": TYPES[asset.split(".").at(-1)],
    "Content-Length": data.length});
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
server.listen(PORT, HOST, () => process.stdout.write("BTC 期权看板 " + LOCAL + "\n"));
