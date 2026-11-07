import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:net";
import test, {after, before} from "node:test";
import {fileURLToPath} from "node:url";

const bridgeFile = fileURLToPath(new URL("../local_bridge.mjs", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const HOSTED = "https://btcopt.pages.dev";
const quietEnv = extra => {
  const env = {...process.env, BTCOPT_NO_DOTENV: "1", ...extra};
  for (const key of ["BINANCE_API_KEY", "BINANCE_API_SECRET", "BTCOPT_ACCESS_TOKEN"]) if (!(key in extra)) delete env[key];
  return env;
};
let bridge, local;

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const {port} = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

before(async () => {
  const port = await freePort();
  local = "http://127.0.0.1:" + port;
  bridge = spawn(process.execPath, [bridgeFile], {cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: quietEnv({BTCOPT_HOSTED: "0", BTCOPT_BRIDGE_PORT: String(port), BTCOPT_REPLAY: "analysis/put-20261030/snapshot.json",
      BTCOPT_REPLAY_KLINES: "analysis/put-20261030/spot_daily.json"})});
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge did not start: " + output)), 10_000);
    const read = chunk => { output += chunk; if (output.includes(local)) { clearTimeout(timer); resolve(); } };
    bridge.stdout.on("data", read);
    bridge.stderr.on("data", chunk => { output += chunk; });
    bridge.once("exit", code => { clearTimeout(timer); reject(new Error("bridge exited " + code + ": " + output)); });
  });
});

after(async () => {
  if (bridge && bridge.exitCode === null) { const exited = once(bridge, "exit"); bridge.kill(); await exited; }
});

test("strategy page, shared library and fonts are served with strict headers", async () => {
  for (const [path, type] of [["/strategy.html", "text/html"], ["/strategy", "text/html"], ["/lib/screener.mjs", "text/javascript"],
    ["/strategy/app.js", "text/javascript"], ["/strategy/desk.css", "text/css"], ["/strategy/fonts/inter-latin-wght.woff2", "font/woff2"]]) {
    const response = await fetch(local + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), new RegExp(type), path);
    await response.arrayBuffer();
  }
  const page = await fetch(local + "/strategy.html");
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'.*font-src 'self'/);
  for (const path of ["/_worker.js/index.js", "/lib/../local_bridge.mjs", "/strategy/%2e%2e/x", "/.env"]) {
    const response = await fetch(local + path);
    assert.ok([400, 404].includes(response.status), path + " → " + response.status);
    await response.arrayBuffer();
  }
});

test("replay health and strategy API answer from the recorded snapshot", async () => {
  assert.deepEqual(await (await fetch(local + "/api/health")).json(), {status: "ok", service: "btcoptions", transport: "loopback", replay: true});
  const screen = await (await fetch(local + "/api/strategy/screen?id=budget-put&limit=3")).json();
  assert.equal(screen.quality.replay, true);
  assert.ok(screen.candidates.length >= 1 && screen.candidates.every(c => Number(c.metrics.maxLoss) <= 1000));
  const signals = await (await fetch(local + "/api/strategy/signals")).json();
  assert.equal(signals.replay, true);
  assert.ok(signals.klines.daily.c.length > 0);
  const account = await fetch(local + "/api/strategy/account");
  assert.deepEqual(await account.json(), {configured: false, reason: "missing", mode: "server"});
  assert.match(account.headers.get("cache-control"), /no-store/);
});

test("CORS: the hosted site may send a bearer only to the account route", async () => {
  const preflight = (path, headers) => fetch(local + path, {method: "OPTIONS", headers: {Origin: HOSTED, "Access-Control-Request-Method": "GET", ...headers}});
  const allowed = await preflight("/api/strategy/account", {"Access-Control-Request-Headers": "authorization"});
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-headers"), "Authorization");
  assert.equal((await preflight("/api/strategy/screen", {"Access-Control-Request-Headers": "authorization"})).status, 403);
  assert.equal((await preflight("/api/strategy/account", {"Access-Control-Request-Headers": "x-api-key"})).status, 403);
  const malformed = await fetch(local + "/api/strategy/account", {headers: {Authorization: "Bearer a b"}});
  assert.equal(malformed.status, 400);
  const evil = await fetch(local + "/api/strategy/catalog", {headers: {Origin: "https://evil.example"}});
  assert.equal(evil.status, 403);
});

test("replay mode refuses to start on a public host", async () => {
  const child = spawn(process.execPath, [bridgeFile], {cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: quietEnv({BTCOPT_HOSTED: "1", PORT: String(await freePort()), RENDER_EXTERNAL_HOSTNAME: "btcoptions.onrender.com",
      BTCOPT_REPLAY: "analysis/put-20261030/snapshot.json"})});
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
  assert.match(stderr, /Replay mode is local-only/);
});
