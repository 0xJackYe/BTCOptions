// Collects the characters the Strategy Desk renders in its serif display face,
// so the Noto Serif SC subset carries only those glyphs (~140 KB → ~40 KB).
//
//   node options_site/tools/serif_characters.mjs      (needs Playwright)
//   python options_site/tools/subset_fonts.py --packages <dir> --serif-characters options_site/strategy/fonts/serif-characters.txt
//
// It drives the real interface in replay mode (every strategy, every detail
// tab, dialogs, palette, toasts) and records text whose computed font is the
// serif face, then adds the static vocabularies that may not appear in one
// replay (all strategy names, check labels, toast titles).
import {spawn, spawnSync} from "node:child_process";
import {once} from "node:events";
import {writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {createServer} from "node:net";
import {fileURLToPath} from "node:url";
import {serifVocabulary} from "./serif_vocabulary.mjs";

const require = createRequire(import.meta.url);
const playwright = require("playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
if (spawnSync(process.execPath, ["options_site/build.mjs"], {cwd: root, stdio: "inherit"}).status !== 0) process.exit(1);

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

const seen = new Set();
const collect = async page => {
  const text = await page.evaluate(() => {
    let out = "";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && getComputedStyle(parent).fontFamily.includes("Desk Serif")) out += node.textContent;
    }
    return out;
  });
  for (const ch of text) seen.add(ch);
};

const {STRATEGIES} = await import("../lib/strategies.mjs");
const browser = await playwright.chromium.launch();
try {
  for (const viewport of [{width: 1600, height: 1000}, {width: 390, height: 844}]) {
    const page = await browser.newPage({viewport});
    await page.goto(base + "/strategy");
    await page.waitForSelector("#gridBody tr, .cand-card", {state: "attached"});
    for (const strategy of STRATEGIES) {
      await page.evaluate(id => { location.hash = "#/" + id; }, strategy.id);
      await page.waitForFunction(name => document.querySelector("#strategyHead h1")?.firstChild?.textContent === name, strategy.name);
      await page.waitForTimeout(250);
      await collect(page);
      if (viewport.width < 900) continue;
      for (const tab of ["rules", "stress", "funds", "legs"]) {
        if (!(await page.$("#tab-" + tab))) break;
        await page.click("#tab-" + tab);
        await page.waitForTimeout(80);
        await collect(page);
      }
    }
    for (const key of ["s", "a", "?"]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(300);
      await collect(page);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(200);
    await collect(page);
    await page.keyboard.press("Escape");
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}

for (const ch of await serifVocabulary()) seen.add(ch);
const characters = [...seen].filter(ch => ch.codePointAt(0) > 0x7e && !/\s/.test(ch)).sort().join("");
await writeFile(new URL("../strategy/fonts/serif-characters.txt", import.meta.url), characters + "\n");
console.log(`${characters.length} non-ASCII serif characters → options_site/strategy/fonts/serif-characters.txt`);
