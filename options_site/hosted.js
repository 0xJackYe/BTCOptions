"use strict";

window.BTCOptionsHosted = true;
if (location.origin === "https://btcopt.pages.dev") {
  const origin = "http://127.0.0.1:8767";
  window.BTCOptionsBridge = Object.freeze({
    origin,
    fetch: (path, options) => fetch(origin + path, {
      ...options, credentials: "omit", redirect: "error", targetAddressSpace: "loopback"
    })
  });
}
