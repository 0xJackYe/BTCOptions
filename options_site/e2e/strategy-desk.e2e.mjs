// End-to-end check of the Strategy Desk in a real browser, against the
// recorded Binance snapshot (replay mode). Optional: requires Playwright.
//
//   node options_site/e2e/strategy-desk.e2e.mjs
//
// Skips cleanly when Playwright is not installed, so CI stays dependency-free.
import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {once} from "node:events";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {createServer} from "node:net";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch {
  console.log("Playwright 未安装，跳过浏览器端到端检查。");
  process.exit(0);
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const build = spawnSync(process.execPath, ["options_site/build.mjs"], {cwd: root, stdio: "inherit"});
if (build.status !== 0) process.exit(build.status ?? 1);

const free = createServer();
free.listen(0, "127.0.0.1");
await once(free, "listening");
const port = free.address().port;
await new Promise(resolve => free.close(resolve));
const base = `http://127.0.0.1:${port}`;
const env = {...process.env, BTCOPT_NO_DOTENV: "1", BTCOPT_HOSTED: "0", BTCOPT_BRIDGE_PORT: String(port),
  BTCOPT_REPLAY: "analysis/put-20261030/snapshot.json", BTCOPT_REPLAY_KLINES: "analysis/put-20261030/spot_daily.json"};
for (const key of ["BINANCE_API_KEY", "BINANCE_API_SECRET", "BTCOPT_ACCESS_TOKEN"]) delete env[key];
const server = spawn(process.execPath, ["options_site/local_bridge.mjs"], {cwd: root, env, stdio: ["ignore", "pipe", "inherit"]});
await new Promise((resolve, reject) => {
  let out = "";
  const timer = setTimeout(() => reject(new Error("server did not start")), 10_000);
  server.stdout.on("data", chunk => { out += chunk; if (out.includes(base)) { clearTimeout(timer); resolve(); } });
});

const {STRATEGIES} = await import("../lib/strategies.mjs");
const browser = await playwright.chromium.launch();
const errors = [];
const watch = page => {
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
};
const step = async (name, fn) => { await fn(); console.log("✓ " + name); };

try {
  const context = await browser.newContext({viewport: {width: 1600, height: 1000}, colorScheme: "dark", acceptDownloads: true});
  const page = await context.newPage();
  watch(page);
  await page.goto(base + "/strategy.html");
  await page.waitForSelector("#gridBody tr");

  await step("每个策略都能筛选并给出结果或诊断", async () => {
    for (const strategy of STRATEGIES) {
      await page.click(`.strategy-item[data-id="${strategy.id}"]`);
      await page.waitForFunction(name => document.querySelector("#strategyHead h1")?.firstChild?.textContent === name, strategy.name);
      const rows = await page.locator("#gridBody tr").count();
      const empty = await page.locator("#emptyState:not([hidden])").count();
      assert.ok(rows > 0 || empty > 0, strategy.id);
    }
  });

  await step("快捷键切换策略、移动选择与冻结", async () => {
    await page.keyboard.press("1");
    await page.waitForFunction(() => document.querySelector("#strategyHead h1")?.firstChild?.textContent === "急跌卖 Put");
    const first = await page.getAttribute('#gridBody tr[aria-selected="true"]', "data-key");
    await page.keyboard.press("ArrowDown");
    const second = await page.getAttribute('#gridBody tr[aria-selected="true"]', "data-key");
    assert.notEqual(first, second);
    await page.keyboard.press("f");
    await page.waitForFunction(() => document.querySelector("#livePill")?.textContent.includes("已冻结"));
    await page.keyboard.press("f");
  });

  await step("参数编辑器即时重新筛选并可重置", async () => {
    const before = await page.locator("#gridBody tr").count();
    assert.equal(await page.locator('.chip[data-key="otm"]').count(), 0, "parameters start collapsed");
    await page.click(".chip.toggle");
    await page.click('.chip[data-key="otm"]');
    const low = page.locator('.popover input.num-input').first();
    await low.fill("25");
    await low.dispatchEvent("change");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector('.chip[data-key="otm"]')?.classList.contains("modified"));
    assert.ok(await page.locator("#gridBody tr").count() <= before);
    assert.match(page.url(), /otm=25~32/);
    await page.click(".chip-reset");
    await page.waitForFunction(() => !document.querySelector('.chip[data-key="otm"]')?.classList.contains("modified"));
  });

  await step("导出 CSV（带 BOM 与表头）", async () => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("e")]);
    assert.match(download.suggestedFilename(), /^btc-crash-put-\d{12}\.csv$/);
    const text = await readFile(await download.path(), "utf8");
    assert.ok(text.startsWith("﻿\"排名\""));
    assert.ok(text.split("\r\n").length >= 2);
  });

  await step("命令面板跳转策略", async () => {
    await page.keyboard.press("Control+k");
    await page.keyboard.type("保护");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#strategyHead h1")?.firstChild?.textContent === "保护性 Put");
    await page.click('.seg button:has-text("含现货")');
    await page.waitForSelector("svg.payoff path.combined");
  });

  await step("详情页签：压力测试与三账户资金规划", async () => {
    await page.keyboard.press("1");
    await page.click('.tabs button:has-text("压力测试")');
    await page.waitForSelector("table.mini.stress td.cell");
    await page.click('.tabs button:has-text("资金")');
    await page.waitForSelector(".stack i");
  });

  await step("资金设置影响预算定量", async () => {
    await page.keyboard.press("4");
    await page.waitForSelector("#gridBody tr");
    const qty = async () => Number(await page.locator('#gridBody tr[aria-selected="true"]').getAttribute("data-key").then(() =>
      page.evaluate(() => document.querySelector(".stepper input")?.value)));
    const before = await qty();
    await page.keyboard.press("s");
    const budget = page.locator('#settingsDialog input[aria-label="期权风险预算"]');
    await budget.fill("3000");
    await page.click('#settingsDialog button:has-text("保存")');
    await page.click('.tabs button:has-text("资金")');
    await page.waitForFunction(previous => Number(document.querySelector(".stepper input")?.value) > previous, before);
    await page.keyboard.press("s");
    await page.click('#settingsDialog button:has-text("恢复默认")');
  });

  await step("账户：未配置提示与浏览器密钥格式校验", async () => {
    await page.keyboard.press("a");
    await page.waitForSelector('#accountDialog:has-text("服务器尚未配置 API Key")');
    await page.click('#accountDialog .mode-card:has-text("浏览器临时连接")');
    await page.fill('#accountDialog input[aria-label="API Key"]', "short");
    await page.fill('#accountDialog input[aria-label="Secret"]', "short");
    await page.click('#accountDialog button:has-text("在浏览器内连接")');
    await page.waitForSelector("#accountDialog .callout.danger");
    await page.keyboard.press("Escape");
  });

  await step("主题切换（墨滴过渡）并与期权链共享偏好", async () => {
    await page.keyboard.press("t");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    assert.equal(await page.evaluate(() => localStorage.getItem("btc-options-anthropic-light-theme")), "true");
    await page.waitForTimeout(800);
    await page.keyboard.press("t");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  });

  await step("行情在后台线程计算，界面只负责渲染", async () => {
    await page.waitForFunction(() => document.querySelector("#statusbar [data-tip]")?.getAttribute("data-tip").includes("后台线程"));
    const workers = page.workers().map(worker => worker.url());
    assert.ok(workers.some(url => /\/strategy\/engine\.worker\.js\?v=[0-9a-f]{10}$/.test(url)), "engine worker: " + workers.join(", "));
  });

  await step("性能预算：关键交互不掉帧，操作到画面 ≤ 50 ms", async () => {
    await page.evaluate(() => {
      window.__budget = {frames: [], events: [], rec: false};
      let last = 0;
      const loop = t => { if (window.__budget.rec && last) window.__budget.frames.push(t - last); last = t; requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      new PerformanceObserver(list => { for (const e of list.getEntries()) if (window.__budget.rec && e.interactionId) window.__budget.events.push(e.duration); })
        .observe({type: "event", durationThreshold: 16});
    });
    const measure = async (name, action, settle = 900) => {
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.evaluate(() => { window.__budget.frames = []; window.__budget.events = []; window.__budget.rec = true; });
        await action();
        await page.waitForTimeout(settle);
        result = await page.evaluate(() => { window.__budget.rec = false; const f = window.__budget.frames.filter(d => d < 1000);
          return {dropped: f.filter(d => d > 25).length, worst: Math.max(0, ...f), input: Math.max(0, ...window.__budget.events)}; });
        if (!result.dropped && result.input <= 50) break;
      }
      console.log(`  ${name}: 掉帧 ${result.dropped} · 最长帧 ${result.worst.toFixed(1)} ms · 操作到画面 ${result.input ? result.input.toFixed(0) + " ms" : "< 16 ms"}`);
      assert.equal(result.dropped, 0, name + " dropped frames");
      assert.ok(result.input <= 50, name + " input to paint " + result.input);
    };
    await page.keyboard.press("1");
    await page.waitForTimeout(600);
    await measure("切换策略", () => page.keyboard.press("2"));
    await measure("切回策略", () => page.keyboard.press("1"));
    await measure("选择候选", () => page.click("#gridBody tr:nth-child(2)"), 1200);
    await measure("切换详情页签", () => page.click("#tab-stress"));
    await measure("命令面板", () => page.keyboard.press("Control+k"), 600);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await measure("主题墨滴", () => page.keyboard.press("t"), 1100);
    await page.keyboard.press("t");
    await page.waitForTimeout(1100);
  });

  await step("手机布局：卡片列表与详情抽屉", async () => {
    const mobile = await browser.newContext({...playwright.devices["iPhone 13"], colorScheme: "dark"});
    const phone = await mobile.newPage();
    watch(phone);
    await phone.goto(base + "/strategy.html");
    await phone.waitForSelector(".cand-card");
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, "no horizontal page overflow: " + overflow);
    await phone.click(".cand-card");
    await phone.waitForFunction(() => document.querySelector("#desk").classList.contains("detail-open"));
    await phone.click(".detail-close");
    await phone.waitForFunction(() => !document.querySelector("#desk").classList.contains("detail-open"));
    await mobile.close();
  });

  assert.deepEqual(errors, [], "browser console errors");
  console.log("策略看板端到端检查全部通过。");
} finally {
  await browser.close();
  server.kill();
}
