"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BTCOptionsScreener = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  const day = 86400000;
  const profiles = {LOW: [0, .15], MEDIUM: [.15, .30], HIGH: [.30, .60]};
  const selectors = {
    risk: (a, b) => a.delta - b.delta || b.daily - a.daily,
    balance: (a, b) => b.efficiency - a.efficiency || a.delta - b.delta,
    premium: (a, b) => b.daily - a.daily || a.delta - b.delta
  };
  const numeric = value => value == null || value === "" ? NaN : Number(value);
  const fmt = new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 4});
  const dates = new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"});
  const expiryDate = row => dates.format(new Date(Number(row.expiry_ms)));

  function screen(snapshot, settings, now, quoteIssue) {
    const {side, expiry, quantity, mode, risk} = settings;
    if (!Number.isFinite(quantity) || quantity < .01 || quantity > 100 ||
        !["PUT", "CALL"].includes(side) || !selectors[mode] || !profiles[risk]) {
      throw new RangeError("请选择有效的筛选条件，数量为 0.01 至 100。");
    }
    if (snapshot?.stale || !(numeric(snapshot?.btc_index_price) > 0)) return [];
    const index = Number(snapshot.btc_index_price);
    const [minDelta, maxDelta] = profiles[risk];
    const rows = [];
    for (const row of snapshot.options ?? []) {
      const expiryMs = numeric(row.expiry_ms);
      const days = (expiryMs - now - (Number(snapshot.exchange_clock_offset_ms) || 0)) / day;
      if (row.side !== side || !(days >= 2 && days <= 60) ||
          expiry !== "ALL" && expiryDate(row) !== expiry ||
          quoteIssue(snapshot, row, {direction: "SELL", quantity}, now)) continue;
      const strike = numeric(row.strike_price), delta = Math.abs(numeric(row.delta));
      const bid = numeric(row.bid_price), ask = numeric(row.ask_price), spread = (ask - bid) / ((ask + bid) / 2);
      const markAt = row.field_updated_at?.delta ?? row.mark_updated_at;
      const markMs = typeof markAt === "number" ? markAt : Date.parse(markAt);
      const markAge = now - markMs;
      if (!(side === "PUT" ? strike < index : strike > index) ||
          !(delta > minDelta && delta <= maxDelta) || !(bid > 0 && ask >= bid && spread <= .2) ||
          !(markAge >= -2000 && markAge <= 30000)) continue;
      const credit = quantity * (bid - Math.min(index * .00024, bid * .1));
      const daily = credit / days;
      rows.push({row, delta, days, spread, credit, daily, efficiency: daily / delta});
    }
    return rows.sort((a, b) => selectors[mode](a, b) || a.row.symbol.localeCompare(b.row.symbol));
  }

  function initialize({getSnapshot, getExpiry, openContract}) {
    const $ = id => document.getElementById(id);
    const dialog = $("siteScreenDialog");
    const body = $("siteScreenRows");
    const status = $("siteScreenStatus");
    const config = () => ({
      side: $("siteScreenSide").value, expiry: $("siteScreenExpiry").value,
      quantity: $("siteScreenQty").valueAsNumber, risk: $("siteScreenRisk").value,
      mode: $("siteScreenMode").value
    });
    let renderedKey = "";
    let opener = null;
    function render() {
      const snapshot = getSnapshot();
      const settings = config();
      const key = JSON.stringify([snapshot?.fetched_at, snapshot?.stale, settings, Math.floor(Date.now() / 5000)]);
      if (key === renderedKey) return;
      renderedKey = key;
      try {
        const entries = screen(snapshot, settings, Date.now(), window.OptionRiskUI.quoteIssue);
        status.textContent = entries.length ? "符合条件 " + entries.length + " 个，展示前 20 个" :
          "当前没有符合条件且报价、深度和 Delta 仍有效的合约。";
        const fragment = document.createDocumentFragment();
        for (const entry of entries.slice(0, 20)) {
          const tr = document.createElement("tr");
          const title = tr.insertCell();
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = entry.row.symbol;
          button.addEventListener("click", () => {
            const current = screen(getSnapshot(), config(), Date.now(), window.OptionRiskUI.quoteIssue);
            const match = current.find(candidate => candidate.row.symbol === entry.row.symbol);
            if (!match) {
              renderedKey = "";
              render();
              status.textContent = "该合约报价或筛选条件已变化，已刷新列表。";
              return;
            }
            dialog.close("contract");
            openContract(match.row);
          });
          title.append(button);
          for (const val of [entry.days, entry.delta, entry.spread * 100, entry.credit, entry.daily]) {
            tr.insertCell().textContent = fmt.format(val);
          }
          fragment.append(tr);
        }
        body.replaceChildren(fragment);
      } catch (error) {
        body.replaceChildren();
        status.textContent = error instanceof RangeError ? error.message : "暂时无法计算筛选结果。";
      }
    }

    function open(event) {
      opener = event.currentTarget;
      renderedKey = "";
      const select = $("siteScreenExpiry");
      const listed = [...new Set((getSnapshot()?.options ?? [])
        .filter(row => Number.isFinite(numeric(row.expiry_ms)) && Number(row.expiry_ms) > Date.now())
        .map(expiryDate))].sort();
      select.replaceChildren(new Option("全部到期日", "ALL"), ...listed.map(date => new Option(date, date)));
      select.value = listed.includes(getExpiry()) ? getExpiry() : "ALL";
      dialog.showModal();
      render();
    }

    for (const id of ["aiButton", "focusAIButton"]) $(id).addEventListener("click", open);
    $("siteScreenClose").addEventListener("click", () => dialog.close());
    $("siteScreenForm").addEventListener("input", render);
    $("siteScreenForm").addEventListener("submit", event => event.preventDefault());
    dialog.addEventListener("close", () => {if (dialog.returnValue !== "contract") opener?.focus(); dialog.returnValue = "";});
    window.setInterval(() => {if (dialog.open && !document.hidden) render();}, 5000);
  }

  return {initialize, screen};
});
