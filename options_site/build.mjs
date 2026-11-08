import {copyFile, cp, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";

const repo = new URL("../", import.meta.url);
const out = new URL("./dist/", import.meta.url);
const worker = new URL("_worker.js/", out);
const original = new URL("dashboard/dist/", repo);
const assets = [
  "styles.css", "anthropic.css", "payoff.css", "portfolio.css", "combo.css", "risk.css", "option-ai.css",
  "payoff.js", "portfolio.js", "payoff-ui.js", "portfolio-ui.js", "risk-metrics.js", "risk-ui.js", "app.js"
];
const standalone = ["hosted.css", "hosted.js", "browser-market.js", "screener.js", "account.html", "account.js", "account.css",
  "strategy.html", "_headers", "_routes.json"];
const workerModules = ["worker-market.mjs", "worker-account.mjs", "worker-relay.mjs", "worker-strategy.mjs"];
await rm(out, {recursive: true, force: true});
await mkdir(worker, {recursive: true});
await Promise.all([
  ...assets.map(name => copyFile(new URL(name, original), new URL(name, out))),
  ...standalone.map(name => copyFile(new URL(name, import.meta.url), new URL(name, out))),
  ...workerModules.map(name => copyFile(new URL(name, import.meta.url), new URL(name, worker))),
  copyFile(new URL("worker-entry.mjs", import.meta.url), new URL("index.js", worker)),
  // Strategy Desk: browser modules, the shared isomorphic library (served to
  // browsers and bundled into the Worker) and self-hosted OFL fonts.
  cp(new URL("strategy/", import.meta.url), new URL("strategy/", out), {recursive: true}),
  cp(new URL("lib/", import.meta.url), new URL("lib/", out), {recursive: true}),
  cp(new URL("lib/", import.meta.url), new URL("lib/", worker), {recursive: true}),
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
html = replace(html, /<div class="topbar-right">/, '<div class="topbar-right"><a class="help-button site-account-link site-strategy-link" href="./strategy">策略看板</a><a class="help-button site-account-link" href="./account.html">币安账户</a>');
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
await versionStrategyAssets();

const commit = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA ||
  execFileSync("git", ["rev-parse", "HEAD"], {cwd: repo, encoding: "utf8"}).trim();
if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("Invalid deployment commit");
await writeFile(new URL("version.json", out), JSON.stringify({commit}) + "\n");

for (const entry of await readdir(out)) {
  if (entry.startsWith(".") || /terminal-embed|option-ai-ui/.test(entry)) throw new Error("Unexpected standalone asset " + entry);
}
console.log("Standalone options site built from " + commit);

/**
 * Strategy Desk assets get a content-derived version (?v=…) on every URL —
 * module imports, the worker, fonts, stylesheet — so _headers can mark
 * /strategy/* and /lib/* immutable for a year: repeat visits load the desk
 * without a single revalidation round trip, and any change ships a new URL.
 * strategy.html also receives <link rel="modulepreload"> for the interface
 * module graph, so the browser fetches it in one parallel wave.
 */
async function versionStrategyAssets() {
  const list = async (dir, pattern) => (await readdir(new URL(dir, out))).filter(name => pattern.test(name)).sort().map(name => dir + name);
  const scripts = [...await list("strategy/", /\.m?js$/), ...await list("lib/", /\.mjs$/)];
  const styles = await list("strategy/", /\.css$/);
  const fonts = await list("strategy/fonts/", /\.woff2$/);
  const hash = createHash("sha256");
  for (const path of [...scripts, ...styles, ...fonts]) hash.update(path).update("\0").update(await readFile(new URL(path, out)));
  const version = "?v=" + hash.digest("hex").slice(0, 10);
  const relative = /(\b(?:from|import)\s*)(["'])(\.{1,2}\/[^"'?]+?\.m?js)\2/g;
  const graph = new Map();
  for (const path of scripts) {
    let source = await readFile(new URL(path, out), "utf8");
    const deps = [];
    source = source.replace(relative, (_, keyword, quote, spec) => {
      deps.push(new URL(spec, new URL(path, out)).href.slice(out.href.length));
      return keyword + quote + spec + version + quote;
    });
    if (path === "strategy/preload.js") source = replaceOnce(source, '"./strategy/engine.worker.js"', `"./strategy/engine.worker.js${version}"`);
    graph.set(path, deps);
    await writeFile(new URL(path, out), source);
  }
  for (const path of styles) {
    const source = await readFile(new URL(path, out), "utf8");
    await writeFile(new URL(path, out), source.replace(/url\("(\.\/fonts\/[^"?]+\.woff2)"\)/g, (_, font) => `url("${font}${version}")`));
  }
  // Interface graph (everything app.js and boot.js reach), in dependency order.
  const ordered = [], seen = new Set();
  const visit = path => {
    if (seen.has(path)) return;
    seen.add(path);
    if (!graph.has(path)) throw new Error("Missing module " + path);
    for (const dep of graph.get(path)) visit(dep);
    ordered.push(path);
  };
  visit("strategy/boot.js");
  visit("strategy/app.js");
  if (ordered.some(path => /screener|engine\.js|engine-host/.test(path))) throw new Error("The interface graph must not load the screening engine");
  let html = await readFile(new URL("strategy.html", out), "utf8");
  html = html.replace(/((?:href|src)=")(\.\/strategy\/[^"?]+\.(?:m?js|css|woff2))"/g, (_, attr, path) => `${attr}${path}${version}"`);
  html = replaceOnce(html, "<!-- modulepreload -->", ordered.filter(path => !["strategy/boot.js", "strategy/app.js"].includes(path))
    .map(path => `<link rel="modulepreload" href="./${path}${version}">`).join("\n  "));
  await writeFile(new URL("strategy.html", out), html);
}

function replaceOnce(source, needle, value) {
  if (source.split(needle).length !== 2) throw new Error("Expected exactly one " + needle);
  return source.replace(needle, () => value);
}
