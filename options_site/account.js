"use strict";

const byId = id => document.getElementById(id);
const form = byId("accountForm");
const keyInput = byId("apiKey");
const secretInput = byId("apiSecret");
const query = byId("query");
const statusText = byId("accountStatus");
const result = byId("result");
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium",
});
const encoder = new TextEncoder();
const errors = {
  invalid_input: "请输入币安签发的 64 位 HMAC API Key 和 Secret。",
  timestamp: "签名已超时，请重新输入凭据并查询。",
  throttled: "请求过于频繁，请稍后重试。",
  credentials: "币安拒绝读取。请核对 Key、Secret、读取权限及 IP 白名单。",
  region: "币安限制了本站服务器所在地的 API 访问。",
  account_unavailable: "币安未开放此期权账户的标准保证金查询。",
  unavailable: "暂时无法连接币安期权账户接口，请稍后重试。",
  invalid_response: "币安响应缺少查询所需的数据。",
  upstream_error: "币安账户接口暂时无法完成查询。",
  insecure: "账户查询需要安全的 HTTPS 浏览器环境。",
};
let request = null;

function clearResult() {
  result.hidden = true;
  byId("assetRows").replaceChildren();
  byId("positionRows").replaceChildren();
  byId("asOf").textContent = "";
}

function clear() {
  request?.abort();
  request = null;
  form.reset();
  clearResult();
  statusText.textContent = "";
  statusText.classList.remove("error");
  query.disabled = false;
  form.removeAttribute("aria-busy");
}

function renderRows(prefix, rows, toValues) {
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement("tr");
    toValues(row).forEach((value, index) => {
      const cell = document.createElement(index === 0 ? "th" : "td");
      if (index === 0) cell.scope = "row";
      cell.textContent = value ?? "—";
      tr.append(cell);
    });
    fragment.append(tr);
  }
  byId(prefix + "Rows").replaceChildren(fragment);
  byId(prefix + "Empty").hidden = rows.length !== 0;
  byId(prefix + "Table").hidden = rows.length === 0;
}

function render(data) {
  renderRows("asset", data.assets, row => [
    row.asset, row.marginBalance, row.equity, row.available, row.initialMargin, row.maintMargin,
    row.adjustedEquity, row.unrealizedPNL,
  ]);
  renderRows("position", data.positions, row => [
    row.symbol, row.side === "LONG" ? "多头" : "空头", row.quantity,
    row.entryPrice, row.markPrice, row.unrealizedPNL,
    row.expiryDate === null ? null : dateFormat.format(row.expiryDate),
  ]);
  byId("asOf").textContent = "读取于 " + dateFormat.format(data.receivedAt) + "（北京）";
  result.hidden = false;
}

async function fetchJson(path, settings = {}) {
  let response;
  let data;
  try {
    response = await fetch(path, {
      cache: "no-store", credentials: "same-origin", redirect: "error", ...settings,
    });
    data = await response.json();
  } catch {
    throw new Error("unavailable");
  }
  if (!response.ok) throw new Error(data?.error ?? "unavailable");
  return data;
}

async function signedQuery(apiKey, secretBytes, signal) {
  if (!window.isSecureContext || !globalThis.crypto?.subtle) throw new Error("insecure");
  const key = await crypto.subtle.importKey("raw", secretBytes,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  secretBytes.fill(0);
  const clock = await fetchJson("./api/account/time", { signal });
  if (!Number.isSafeInteger(clock.serverTime)) throw new Error("invalid_response");
  // Start from the exchange clock. Avoid projecting browser round-trip delay into Binance's
  // tighter future-time check. If transport exceeds the window, the query fails safely.
  const timestamp = clock.serverTime;
  const sign = async windowMs => {
    const bytes = encoder.encode("timestamp=" + timestamp + "&recvWindow=" + windowMs);
    const signature = await crypto.subtle.sign("HMAC", key, bytes);
    return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
  };
  const [account, positions] = await Promise.all([sign(5000), sign(4900)]);
  return fetchJson("./api/account", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ apiKey, timestamp, signatures: { account, positions } }),
  });
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (request) return;
  const apiKey = keyInput.value.trim();
  const secret = encoder.encode(secretInput.value.trim());
  form.reset();
  clearResult();
  const controller = new AbortController();
  request = controller;
  const timeout = setTimeout(() => controller.abort(), 14_000);
  query.disabled = true;
  form.setAttribute("aria-busy", "true");
  statusText.classList.remove("error");
  statusText.textContent = "正在向币安读取账户快照…";
  try {
    if (!/^[A-Za-z0-9]{64}$/.test(apiKey) || !/^[A-Za-z0-9]{64}$/.test(new TextDecoder().decode(secret))) {
      throw new Error("invalid_input");
    }
    const data = await signedQuery(apiKey, secret, controller.signal);
    if (request !== controller) return;
    if (!Array.isArray(data.assets) || !Array.isArray(data.positions) ||
        !Number.isSafeInteger(data.receivedAt)) throw new Error("invalid_response");
    render(data);
    statusText.textContent = "账户快照已读取。";
  } catch (error) {
    if (request !== controller) return;
    statusText.textContent = Object.hasOwn(errors, error.message) ? errors[error.message] : errors.unavailable;
    statusText.classList.add("error");
  } finally {
    secret.fill(0);
    clearTimeout(timeout);
    if (request === controller) {
      request = null;
      query.disabled = false;
      form.removeAttribute("aria-busy");
    }
  }
});

byId("clear").addEventListener("click", clear);
window.addEventListener("pagehide", clear);
