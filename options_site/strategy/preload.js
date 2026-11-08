"use strict";
// Starts the engine worker while the page is still parsing, so it downloads
// its modules and requests market data in parallel with the interface code.
// Anything it says before the interface is listening is kept in an inbox.
(() => {
  // If the interface already started its own engine (this script arrived
  // late), do nothing.
  if (typeof Worker !== "function" || window.BTCOptionsEngineClaimed) return;
  try {
    const worker = new Worker("./strategy/engine.worker.js", {type: "module", name: "strategy-engine"});
    const inbox = [], state = {worker, inbox, failed: false, ready: false};
    const keep = event => {
      inbox.push(event.data);
      if (event.data?.type === "ready") state.ready = true;
    };
    const fail = event => { state.failed = true; event.preventDefault?.(); };
    worker.addEventListener("message", keep);
    worker.addEventListener("error", fail);
    state.release = () => { worker.removeEventListener("message", keep); worker.removeEventListener("error", fail); };
    window.BTCOptionsEngineWorker = state;
  } catch { /* the interface starts its own engine */ }
})();
