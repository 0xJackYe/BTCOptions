// Display vocabulary the serif face must always cover, even when a single
// replay never shows it: every strategy name, rule label, structure title,
// seal and toast title. Shared by serif_characters.mjs and tests/fonts.test.mjs.
import {readFile} from "node:fs/promises";
import {STRATEGIES, GROUPS, CITATIONS} from "../lib/strategies.mjs";
import {CHECK_LABELS} from "../lib/checks.mjs";

const FIXED = [
  "策略看板", "行情", "已触发", "未触发", "待数据", "入选", "差一条", "静待时机", "静观其变",
  "保护性 Put", "裸卖 Put", "垂直价差", "跨式", "宽跨式", "日历价差", "比率价差", "牛市看跌价差", "熊市看跌价差", "熊市看涨价差", "牛市看涨价差",
  "卖出 Put", "买入 Put", "卖出 Call", "买入 Call", "现货对冲", "备兑", "卖", "买",
  "规则检查", "压力测试", "资金", "合约", "币安 BTC 期权交易模型", "卖 Put 工作台 · 你的默认条件", "卖 Call 工作台 · 你的条件", "对话 #",
];

/** String literals in the second argument of every toast(kind, title, …) call. */
function toastTitles(source) {
  const titles = [];
  for (let at = source.indexOf("toast("); at >= 0; at = source.indexOf("toast(", at + 6)) {
    let i = at + 6, depth = 0, arg = 0, quote = null, literal = "";
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) { if (arg === 1) titles.push(literal); quote = null; literal = ""; } else literal += ch;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) { if (depth-- === 0) break; }
      else if (ch === "," && depth === 0 && ++arg > 1) break;
    }
  }
  return titles;
}

export async function serifVocabulary() {
  const parts = [...FIXED, ...STRATEGIES.map(s => s.name), ...GROUPS.map(g => g.label), ...Object.values(CHECK_LABELS),
    ...Object.values(CITATIONS).map(c => c.who ?? "")];
  for (const file of ["app.js", "panels.js", "ui.js", "views.js", "detail.js"]) {
    parts.push(...toastTitles(await readFile(new URL("../strategy/" + file, import.meta.url), "utf8")));
  }
  return new Set([...parts.join("")].filter(ch => ch.codePointAt(0) > 0x7e && !/\s/.test(ch)));
}
