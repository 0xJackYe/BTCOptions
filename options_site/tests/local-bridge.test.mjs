import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {request as httpRequest} from "node:http";
import {createServer} from "node:net";
import {once} from "node:events";
import test, {after, before} from "node:test";
import {fileURLToPath} from "node:url";

const HOSTED = "https://btcopt.pages.dev";
const bridgeFile = fileURLToPath(new URL("../local_bridge.mjs", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
let bridge;
let port;
let local;
let startupOutput = "";

async function availablePort() {
  const temporary = createServer();
  temporary.listen(0, "127.0.0.1");
  await once(temporary, "listening");
  const selected = temporary.address().port;
  await new Promise((resolve, reject) => temporary.close(error => error ? reject(error) : resolve()));
  return selected;
}

async function stopBridge() {
  if (!bridge || bridge.exitCode !== null || bridge.signalCode !== null) return;
  const exited = once(bridge, "exit");
  bridge.kill();
  await exited;
}

before(async () => {
  port = await availablePort();
  local = "http://127.0.0.1:" + port;
  bridge = spawn(process.execPath, [bridgeFile], {
    cwd: root,
    env: {...process.env, BTCOPT_HOSTED: "0", BTCOPT_BRIDGE_PORT: String(port)},
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Local bridge did not report readiness")), 8_000);
      const onData = chunk => {
        startupOutput = (startupOutput + chunk.toString()).slice(-4000);
        if (startupOutput.includes(local)) {
          clearTimeout(timeout);
          resolve();
        }
      };
      bridge.stdout.on("data", onData);
      bridge.stderr.on("data", chunk => {
        startupOutput = (startupOutput + chunk.toString()).slice(-4000);
      });
      bridge.once("error", error => {
        clearTimeout(timeout);
        reject(error);
      });
      bridge.once("exit", code => {
        clearTimeout(timeout);
        reject(new Error("Local bridge exited before readiness (" + code + ") " + startupOutput));
      });
    });
  } catch (error) {
    await stopBridge();
    throw error;
  }
});

after(stopBridge);

function call(path = "/api/health", {method = "GET", headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      agent: false,
      headers: {Host: "127.0.0.1:" + port, ...headers},
      timeout: 4000,
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", reject);
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error("Local request timed out")));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("health reports only local connector metadata with private cache headers", async () => {
  const response = await call();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), {status: "ok", service: "btcoptions", transport: "loopback"});
  assert.match(response.headers["cache-control"], /private, no-store/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("health permits only the two exact supported origins", async () => {
  for (const origin of [HOSTED, local]) {
    const response = await call("/api/health", {headers: {Origin: origin}});
    assert.equal(response.status, 200);
    assert.equal(response.headers["access-control-allow-origin"], origin);
    assert.match(response.headers.vary, /Origin/);
  }
  for (const origin of ["https://evil.test", HOSTED + ".evil.test", HOSTED + "/", "null"]) {
    const response = await call("/api/health", {headers: {Origin: origin}});
    assert.equal(response.status, 403);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  }
});

test("account POST without Origin rejects before inspecting credentials", async () => {
  const body = JSON.stringify({apiKey: "test-only-invalid"});
  const response = await call("/api/account", {
    method: "POST",
    body,
    headers: {"Content-Type": "application/json", "Content-Length": Buffer.byteLength(body)},
  });
  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(response.text), {error: "invalid_source"});
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("cross-site no-CORS health is rejected without Origin", async () => {
  const response = await call("/api/health", {headers: {"Sec-Fetch-Site": "cross-site"}});
  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(response.text), {error: "invalid_source"});
});

test("exact hosted preflight permits account content type and private network request", async () => {
  const response = await call("/api/account", {
    method: "OPTIONS",
    headers: {
      Origin: HOSTED,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
      "Access-Control-Request-Private-Network": "true",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.text, "");
  assert.equal(response.headers["access-control-allow-origin"], HOSTED);
  assert.equal(response.headers["access-control-allow-methods"], "POST");
  assert.equal(response.headers["access-control-allow-headers"], "Content-Type");
  assert.equal(response.headers["access-control-allow-private-network"], "true");
  assert.equal(response.headers["access-control-allow-credentials"], undefined);
});

test("preflights reject untrusted origins, extra headers and unexpected methods", async () => {
  const defaults = {
    Origin: HOSTED,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type",
  };
  for (const changes of [
    {Origin: "https://evil.test"},
    {Origin: "null"},
    {"Access-Control-Request-Method": "DELETE"},
    {"Access-Control-Request-Headers": "content-type,authorization"},
    {"Access-Control-Request-Headers": "x-mbx-apikey"},
    {"Access-Control-Request-Private-Network": "false"},
  ]) {
    const response = await call("/api/account", {method: "OPTIONS", headers: {...defaults, ...changes}});
    assert.equal(response.status, 403);
    assert.equal(response.headers["access-control-allow-private-network"], undefined);
  }
  const missing = await call("/api/account", {
    method: "OPTIONS", headers: {"Access-Control-Request-Method": "POST"},
  });
  assert.equal(missing.status, 403);
});

test("forbidden Host names are rejected even for health and static assets", async () => {
  for (const host of ["evil.test:" + port, "localhost:" + port, "127.0.0.1", "127.0.0.1:" + (port + 1)]) {
    const response = await call("/", {headers: {Host: host}});
    assert.equal(response.status, 403);
    assert.deepEqual(JSON.parse(response.text), {error: "invalid_source"});
  }
  const response = await call("/api/health", {headers: {Host: "evil.test:" + port}});
  assert.equal(response.status, 403);
});

test("only declared static files are served and traversal is rejected", async () => {
  for (const path of ["/_worker.js/index.js", "/worker-account.mjs", "/local_bridge.mjs",
    "/.git/config", "/.env", "/terminal/data/options-access.protected.json"]) {
    assert.equal((await call(path)).status, 404);
  }
  for (const path of ["/../account.html", "/%2e%2e/account.html", "//evil.test/", "/foo\\bar"]) {
    assert.equal((await call(path)).status, 400);
  }
});

test("standalone static pages and scripts have expected content and do not accept writes", async () => {
  for (const [path, contentType] of [
    ["/", "text/html"],
    ["/account.html", "text/html"],
    ["/account.js", "text/javascript"],
    ["/hosted.js", "text/javascript"],
    ["/browser-market.js", "text/javascript"],
    ["/version.json", "application/json"],
  ]) {
    const response = await call(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers["content-type"], new RegExp(contentType));
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.ok(response.text.length > 0);
  }
  assert.equal((await call("/account.html", {method: "POST"})).status, 405);
  const head = await call("/account.html", {method: "HEAD"});
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
  assert.ok(Number(head.headers["content-length"]) > 0);
});

test("account route rejects invalid input before any Binance request", async () => {
  const response = await call("/api/account", {
    method: "POST", body: "{}",
    headers: {Origin: HOSTED, "Content-Type": "application/json", "Content-Length": "2"},
  });
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.text), {error: "invalid_input"});
  assert.equal(response.headers["access-control-allow-origin"], HOSTED);
  const oversized = "x".repeat(1025);
  const rejected = await call("/api/account", {
    method: "POST", body: oversized,
    headers: {Origin: HOSTED, "Content-Type": "application/json", "Content-Length": String(oversized.length)},
  });
  assert.equal(rejected.status, 413);
  assert.equal((await call("/api/unknown", {headers: {Origin: HOSTED}})).status, 404);
  assert.equal((await call("/api/health?unexpected=1")).status, 400);
});
