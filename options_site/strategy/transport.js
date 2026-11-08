// Account transport for the Strategy Desk (interface thread). Market data is
// fetched, decoded and screened in the engine worker (engine-host.js); account
// reads stay here because the browser-held signing key never leaves this page.
// Routes: the site API (Cloudflare → Render) or the optional local connector.
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
