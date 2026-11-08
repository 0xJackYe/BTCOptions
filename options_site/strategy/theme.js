"use strict";
// Applies the saved theme before first paint (a classic, render-blocking
// script, because CSP forbids inline scripts). The preference is shared with
// the option chain page, which stores it as a "light" boolean.
(() => {
  let theme = null;
  try {
    const shared = JSON.parse(localStorage.getItem("btc-options-anthropic-light-theme"));
    if (typeof shared === "boolean") theme = shared ? "light" : "dark";
    else {
      const own = JSON.parse(localStorage.getItem("btcdesk:theme"));
      if (own === "light" || own === "dark") theme = own;
    }
  } catch { /* storage unavailable */ }
  if (!theme) theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
})();
