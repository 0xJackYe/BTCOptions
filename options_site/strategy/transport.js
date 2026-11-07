// Data transport for the Strategy Desk. Public market data never needs a key.
// Routes: site API (Cloudflare → Render), optional local connector, and a
// direct Binance WebSocket fallback (browser-market.js). Account reads use
// either server-held credentials or a non-extractable key held in memory.
import {parseKlines, unpackBars} from "../lib/signals.mjs";
import {load, save} from "./ui.js";

const KLINE_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];
const bridge = () => window.BTCOptionsBridge ?? null;

export class HttpError extends Error {
  constructor(status, body) { super(body?.error?.message ?? body?.error ?? "HTTP " + status); this.status = status; this.body = body; }
}

export async function fetchJson(path, {timeout = 10_000, local = false, headers = {}, method = "GET", body, signal} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  signal?.addEventListener("abort", () => controller.abort(), {once: true});
  try {
    const options = {method, headers, body, cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal};
    const response = await (local && bridge() ? bridge().fetch(path, options) : fetch(path, options));
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) throw new HttpError(response.status, data);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Translate server receipt times into this browser's clock (like the chain page). */
export function alignSnapshot(data, receivedAt) {
  const servedAt = Number(data?.snapshot_served_at_ms);
  if (!Number.isFinite(servedAt) || !Array.isArray(data?.options)) return data;
  const shift = receivedAt - servedAt;
  const move = value => typeof value === "number" && Number.isFinite(value) ? value + shift : value;
  return {
    ...data,
    index_updated_at: move(data.index_updated_at),
    exchange_clock_offset_ms: (Number(data.exchange_clock_offset_ms) || 0) - shift,
    options: data.options.map(row => ({...row, quote_updated_at: move(row.quote_updated_at), mark_updated_at: move(row.mark_updated_at),
      ticker_updated_at: move(row.ticker_updated_at),
      field_updated_at: Object.fromEntries(Object.entries(row.field_updated_at ?? {}).map(([key, value]) => [key, move(value)]))})),
  };
}

export class MarketFeed {
  constructor({onSnapshot, onStatus}) {
    this.onSnapshot = onSnapshot;
    this.onStatus = onStatus;
    this.local = Boolean(bridge()) && load("useLocal", false);
    this.direct = null;
    this.timer = 0;
    this.busy = false;
    this.lastOk = 0;
    this.retryDirectAt = 0;
  }

  get interval() { return this.local || location.hostname === "127.0.0.1" ? 4000 : 6000; }

  start() {
    this.tick();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.tick(); });
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), this.interval);
  }

  setLocal(value) {
    this.local = Boolean(value) && Boolean(bridge());
    save("useLocal", this.local);
    this.stopDirect();
    this.tick(true);
  }

  async tick(force = false) {
    if (this.busy || (document.hidden && !force)) { this.schedule(); return; }
    this.busy = true;
    const started = performance.now();
    try {
      const data = await fetchJson("/api/market", {local: this.local, timeout: 10_000});
      const latency = performance.now() - started;
      if (!data?.options?.length) {
        this.startDirect(data?.error?.message);
        if (this.direct) return;
        throw new Error(data?.error?.message ?? "行情暂不可用");
      }
      this.stopDirect();
      this.lastOk = Date.now();
      const route = data.replay ? "replay" : this.local ? "local" : "site";
      this.onSnapshot(alignSnapshot(data, Date.now()), {route, latency});
      this.onStatus({ok: true, route, latency, at: this.lastOk});
    } catch (error) {
      this.startDirect(error.message);
      if (!this.direct) this.onStatus({ok: false, route: this.local ? "local" : "site", error: this.local ? "无法连接本机连接器" : "行情服务暂不可用，正在重试", at: Date.now()});
    } finally {
      this.busy = false;
      this.schedule();
    }
  }

  startDirect(reason) {
    const market = window.BTCOptionsBrowserMarket;
    if (this.local || this.direct || !market || Date.now() < this.retryDirectAt) return;
    this.onStatus({ok: false, route: "direct", error: "网站线路不可用，改用币安直连行情" + (reason ? "（" + reason + "）" : ""), at: Date.now()});
    this.direct = market.connect(snapshot => {
      this.lastOk = Date.now();
      this.onSnapshot(snapshot, {route: "direct", latency: null});
      this.onStatus({ok: true, route: "direct", at: this.lastOk});
    }, () => {
      this.stopDirect();
      this.retryDirectAt = Date.now() + 5000;
    });
  }

  stopDirect() {
    this.direct?.close();
    this.direct = null;
  }
}

async function directKlines(interval, limit) {
  for (const host of KLINE_HOSTS) {
    try {
      const rows = await fetchJson(`${host}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`, {timeout: 8000});
      const bars = parseKlines(rows);
      if (bars.length >= 24) return bars;
    } catch { /* try next host */ }
  }
  return [];
}

export class SignalsFeed {
  constructor({onSignals, getLocal}) {
    this.onSignals = onSignals;
    this.getLocal = getLocal;
    this.timer = 0;
    this.lastOk = 0;
  }

  start() {
    this.tick();
    document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - this.lastOk > 60_000) this.tick(); });
  }

  async tick() {
    clearTimeout(this.timer);
    try {
      const data = await fetchJson("/api/strategy/signals", {local: this.getLocal(), timeout: 14_000});
      const hourly = unpackBars(data?.klines?.hourly), daily = unpackBars(data?.klines?.daily);
      if (!hourly.length && !daily.length) throw new Error("no klines");
      this.lastOk = Date.now();
      this.onSignals({hourly, daily, source: data.replay ? "replay" : "site", sources: data.sources ?? null, at: this.lastOk});
    } catch {
      const [hourly, daily] = await Promise.all([directKlines("1h", 240), directKlines("1d", 120)]);
      if (hourly.length || daily.length) this.lastOk = Date.now();
      this.onSignals({hourly, daily, source: hourly.length || daily.length ? "direct" : "unavailable", sources: null, at: Date.now()});
    } finally {
      this.timer = setTimeout(() => this.tick(), 60_000);
    }
  }
}

/* ----------------------------------------------------------------- account */

export async function readServerAccount({token = null, local = false} = {}) {
  try {
    return await fetchJson("/api/strategy/account", {local, timeout: 15_000, headers: token ? {Authorization: "Bearer " + token} : {}});
  } catch (error) {
    if (error instanceof HttpError && error.body && typeof error.body.configured === "boolean") return {...error.body, status: error.status};
    throw error;
  }
}

const encoder = new TextEncoder();

/** Imports the secret as a non-extractable HMAC key and wipes the raw bytes. */
export async function createBrowserSession(apiKey, secret) {
  if (!/^[A-Za-z0-9]{64}$/.test(apiKey) || !/^[A-Za-z0-9]{64}$/.test(secret)) throw new Error("请输入币安签发的 64 位 API Key 与 Secret。");
  if (!window.isSecureContext || !crypto?.subtle) throw new Error("需要 HTTPS 或本机安全环境才能在浏览器内签名。");
  const bytes = encoder.encode(secret);
  try {
    const key = await crypto.subtle.importKey("raw", bytes, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
    return {apiKey, key};
  } finally {
    bytes.fill(0);
  }
}

const ACCOUNT_ERRORS = {
  invalid_input: "API Key 或签名格式无效。", timestamp: "签名已超时，请检查电脑时间后重试。", throttled: "请求过于频繁，请稍后重试。",
  credentials: "币安拒绝读取：请核对 Key、Secret、读取权限与 IP 白名单。", region: "币安限制了服务器所在地区的 API 访问。",
  account_unavailable: "该账户未开通期权标准保证金账户。", unavailable: "账户服务暂时不可用，请稍后重试。",
  invalid_response: "币安响应缺少所需字段。", upstream_error: "币安账户接口暂时无法完成查询。",
};
export const accountErrorText = code => ACCOUNT_ERRORS[code] ?? ACCOUNT_ERRORS.unavailable;

/** Same signed protocol as account.html: the secret never leaves this page. */
export async function readBrowserAccount(session, {local = false} = {}) {
  const clock = await fetchJson("/api/account/time", {local, timeout: 8000});
  if (!Number.isSafeInteger(clock?.serverTime)) throw new Error("invalid_response");
  const sign = async windowMs => {
    const signature = await crypto.subtle.sign("HMAC", session.key, encoder.encode(`timestamp=${clock.serverTime}&recvWindow=${windowMs}`));
    return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
  };
  const [account, positions] = await Promise.all([sign(5000), sign(4900)]);
  try {
    return await fetchJson("/api/account", {local, method: "POST", timeout: 14_000, headers: {"Content-Type": "application/json"},
      body: JSON.stringify({apiKey: session.apiKey, timestamp: clock.serverTime, signatures: {account, positions}})});
  } catch (error) {
    throw new Error(accountErrorText(error instanceof HttpError ? error.body?.error : "unavailable"));
  }
}
