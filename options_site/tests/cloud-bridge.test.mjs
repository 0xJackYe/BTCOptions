import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {request} from "node:http";
import {createServer} from "node:net";
import test from "node:test";
import {fileURLToPath} from "node:url";

test("cloud mode uses the platform port and accepts only its configured application host", async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const hostname = "btcoptions-test.onrender.com";
  const child = spawn(process.execPath, [fileURLToPath(new URL("../local_bridge.mjs", import.meta.url))], {
    env: {...process.env, BTCOPT_HOSTED: "1", PORT: String(port), RENDER_EXTERNAL_HOSTNAME: hostname},
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Cloud server did not start")), 5000);
      child.once("error", error => {clearTimeout(timer); reject(error);});
      child.once("exit", code => {clearTimeout(timer); reject(new Error("Cloud server exited " + code));});
      child.stdout.on("data", () => {clearTimeout(timer); resolve();});
    });
    const get = (path, host) => new Promise((resolve, reject) => {
      const req = request({hostname: "127.0.0.1", port, path, headers: {Host: host}, agent: false}, res => {
        const parts = [];
        res.on("data", part => parts.push(part));
        res.on("end", () => resolve({status: res.statusCode, body: Buffer.concat(parts).toString()}));
      });
      req.on("error", reject);
      req.end();
    });
    const health = await get("/api/health", "internal-health-check");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), {status: "ok", service: "btcoptions", transport: "cloud"});
    assert.equal((await get("/", hostname)).status, 200);
    assert.equal((await get("/api/market", "unexpected.example")).status, 403);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});
