import {spawnSync} from "node:child_process";
import {readdir} from "node:fs/promises";
const root = new URL("../", import.meta.url);
const newTests = (await readdir(new URL("tests/", import.meta.url))).filter(name => name.endsWith(".test.mjs")).map(name => "options_site/tests/" + name);
const originals = [
  "test_frontend_data.js", "test_option_payoff.js", "test_option_portfolio.js", "test_option_preview_ui.js",
  "test_option_risk.js", "test_risk_comparison_ui.js", "test_seller_screen_engine.js", "test_sell_call_engine.js", "test_sell_put_engine.js"
];
for (const args of [["options_site/build.mjs"], ["--test", ...newTests, ...originals]]) {
  const proc = spawnSync(process.execPath, args, {cwd: root, stdio: "inherit"});
  if (proc.error) throw proc.error;
  if (proc.status !== 0) process.exit(proc.status ?? 1);
}
