// Display vocabulary the serif face must always cover, even when a single
// replay never shows it. Only display text is set in serif — the brand,
// strategy and structure names, seals and stamps, dialog titles, empty-state
// headings and figures; everything else uses the Gothic sans.
// Shared by serif_characters.mjs and tests/fonts.test.mjs.
import {STRATEGIES} from "../lib/strategies.mjs";

const FIXED = [
  "策略看板", "策", "已触发", "未触发", "待数据", "入选", "差一条", "静待时机", "个候选",
  "保护性 Put", "裸卖 Put", "垂直价差", "跨式", "宽跨式", "日历价差", "比率价差", "牛市看跌价差", "熊市看跌价差", "熊市看涨价差", "牛市看涨价差",
  "卖出 Put", "买入 Put", "卖出 Call", "买入 Call", "现货对冲", "备兑",
  "我的资金与模型", "币安期权账户", "快捷键与说明", "急跌未触发 · 严格模式", "此刻没有合约同时满足全部条件",
  "0123456789+−-.,%×无上限",
];

export async function serifVocabulary() {
  const parts = [...FIXED, ...STRATEGIES.map(s => s.name)];
  return new Set([...parts.join("")].filter(ch => ch.codePointAt(0) > 0x7e && !/\s/.test(ch)));
}
