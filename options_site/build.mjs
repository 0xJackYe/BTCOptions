import {copyFile, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";

const repo = new URL("../", import.meta.url);
const out = new URL("./dist/", import.meta.url);
const worker = new URL("_worker.js/", out);
const original = new URL("dashboard/dist/", repo);
const assets = [
  "styles.css", "anthropic.css", "payoff.css", "portfolio.css", "combo.css", "risk.css", "option-ai.css",
  "payoff.js", "portfolio.js", "payoff-ui.js", "portfolio-ui.js", "risk-metrics.js", "risk-ui.js", "app.js"
];
const standalone = ["hosted.css", "hosted.js", "browser-market.js", "screener.js", "account.html", "account.js", "account.css", "_headers", "_routes.json"];
await rm(out, {recursive: true, force: true});
await mkdir(worker, {recursive: true});
await Promise.all([
  ...assets.map(name => copyFile(new URL(name, original), new URL(name, out))),
  ...standalone.map(name => copyFile(new URL(name, import.meta.url), new URL(name, out))),
  ...["worker-market.mjs", "worker-account.mjs", "worker-relay.mjs"].map(name => copyFile(new URL(name, import.meta.url), new URL(name, worker))),
  copyFile(new URL("worker-entry.mjs", import.meta.url), new URL("index.js", worker))
]);

function replace(source, pattern, value) {
  if (!pattern.test(source)) throw new Error("Dashboard source changed: " + pattern);
  return source.replace(pattern, value);
}

const screen = await readFile(new URL("screener.html", import.meta.url), "utf8");
let html = await readFile(new URL("index.html", original), "utf8");
html = replace(html, /<script src="\/option-ai-ui\.js" defer><\/script>/, [
  '<link rel="stylesheet" href="/hosted.css">',
  '<script src="/hosted.js" defer></script>',
  '<script src="/browser-market.js" defer></script>',
  '<script src="/screener.js" defer></script>'
].join("\n  "));
html = replace(html, /<dialog id="aiDialog"[\s\S]*?<\/dialog>/, screen.trim());
html = replace(html, /<div class="topbar-right">/, '<div class="topbar-right"><a class="help-button site-account-link" href="./account.html">币安账户</a>');
html = replace(html, /<div class="notice-bar" id="noticeBar" hidden role="status"><\/div>/, [
  '<aside id="siteBridgeBanner" class="notice-bar site-bridge-banner" hidden>',
  '  <span id="siteBridgeStatus" role="status"></span>',
  '  <button type="button" id="siteBridgeToggle" class="filter-button">连接本机行情</button>',
  '  <a href="http://127.0.0.1:8767/" target="_blank" rel="noopener noreferrer">打开本机看板</a>',
  '</aside>',
  '<div class="notice-bar" id="noticeBar" hidden role="status"></div>'
].join("\n"));
html = html.replaceAll("AI 选期权", "卖方筛选");
html = html.replace(/\b(href|src)="\/([^"/][^"]*)?"/g, (_, attr, path = "") => attr + '="./' + path + '"');
await writeFile(new URL("index.html", out), html);
const commit = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA ||
  execFileSync("git", ["rev-parse", "HEAD"], {cwd: repo, encoding: "utf8"}).trim();
if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("Invalid deployment commit");
await writeFile(new URL("version.json", out), JSON.stringify({commit}) + "\n");

for (const entry of await readdir(out)) {
  if (entry.startsWith(".") || /terminal-embed|option-ai-ui/.test(entry)) throw new Error("Unexpected standalone asset " + entry);
}
console.log("Standalone options site built from " + commit);
