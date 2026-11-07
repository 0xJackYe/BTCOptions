// Number and time formatting for a financial interface: tabular, signed with a
// true minus sign, explicit about missing and unbounded values.
import {METRICS} from "../lib/strategies.mjs";

const MINUS = "−";
const cache = new Map();
const formatter = (min, max) => {
  const key = min + ":" + max;
  if (!cache.has(key)) cache.set(key, new Intl.NumberFormat("en-US", {minimumFractionDigits: min, maximumFractionDigits: max}));
  return cache.get(key);
};

export const isNum = value => typeof value === "number" && Number.isFinite(value);

export function num(value, digits = 2, {min = digits} = {}) {
  if (value === Infinity) return "无上限";
  if (value === -Infinity) return MINUS + "无上限";
  if (!isNum(value)) return "—";
  const text = formatter(Math.min(min, digits), digits).format(Math.abs(value) < 10 ** -digits / 2 ? 0 : value);
  return text.replace("-", MINUS);
}

export function signed(value, digits = 2) {
  if (!isNum(value)) return num(value, digits);
  const text = num(Math.abs(value), digits);
  return (value > 0 && text !== num(0, digits) ? "+" : value < 0 && text !== num(0, digits) ? MINUS : "") + text;
}

export const pct = (value, digits = 2) => isNum(value) ? num(value, digits) + "%" : num(value, digits);
export const signedPct = (value, digits = 2) => isNum(value) ? signed(value, digits) + "%" : "—";

/** BTC prices: whole USDT above 1,000, otherwise two decimals. */
export const price = value => !isNum(value) ? "—" : Math.abs(value) >= 1000 ? num(value, 0) : num(value, 2);

export function compact(value) {
  if (!isNum(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e6) return num(value / 1e6, 2) + "M";
  if (abs >= 1e4) { const k = value / 1e3; return num(k, Math.abs(k) >= 100 || Math.abs(k - Math.round(k)) < .05 ? 0 : 1) + "k"; }
  return num(value, abs >= 100 ? 0 : 2);
}

/** Formats a registered metric with its unit and precision. */
export function metric(key, value, {withUnit = false} = {}) {
  const spec = METRICS[key];
  if (!spec) return num(value);
  if (value === Infinity) return "无上限";
  if (value === -Infinity) return MINUS + "∞";
  if (!isNum(value)) return "—";
  let display;
  if (key === "pop" || key === "pItm") display = num(key === "pop" ? value * 100 : value, spec.digits) + "%";
  else if (spec.unit === "%") display = num(value, spec.digits) + "%";
  else if (spec.unit === "×") display = num(value, spec.digits) + "×";
  else if (spec.unit === "vol") display = signed(value, spec.digits);
  else if (["netCredit", "ev", "dailyPremium", "delta", "theta", "vega", "budgetPremium"].includes(key)) display = signed(value, spec.digits);
  else display = num(value, spec.digits);
  return withUnit && ["USDT", "BTC", "天"].includes(spec.unit) ? display + " " + spec.unit : display;
}

export const tone = value => !isNum(value) || value === 0 ? "" : value > 0 ? "pos" : "neg";

const BEIJING = 8 * 3_600_000;
const pad = n => String(n).padStart(2, "0");
export function beijing(ms, {date = false, seconds = true} = {}) {
  if (!isNum(ms)) return "—";
  const d = new Date(ms + BEIJING);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` + (seconds ? `:${pad(d.getUTCSeconds())}` : "");
  return date ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${time}` : time;
}

export function expiry(ms, {year = false} = {}) {
  if (!isNum(ms)) return "—";
  const d = new Date(ms + BEIJING);
  return (year ? d.getUTCFullYear() + "-" : "") + `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function dte(days) {
  if (!isNum(days)) return "—";
  if (days < 1) return num(days * 24, 1) + " 小时";
  return num(days, days < 10 ? 1 : 0) + " 天";
}

export function ago(ms, now = Date.now()) {
  if (!isNum(ms)) return "—";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}

export function hours(h) {
  if (!isNum(h)) return "—";
  if (h < 1) return Math.max(1, Math.round(h * 60)) + " 分钟";
  if (h < 48) return num(h, h < 10 ? 1 : 0) + " 小时";
  return num(h / 24, 1) + " 天";
}
