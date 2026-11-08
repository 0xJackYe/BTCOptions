// Main-thread client for the engine. Prefers a module Web Worker; if the
// worker cannot start (old browser, blocked scripts), the identical engine
// runs on the main thread behind the same message interface.
export function createEngineClient(onMessage, {preferMain = false} = {}) {
  const version = new URL(import.meta.url).search;
  let target = null, ready = false, fallen = false;
  const queue = [];

  async function fallback(reason) {
    if (fallen) return;
    fallen = true;
    target?.terminate?.();
    const {startHost} = await import("./engine-host.js" + version);
    const host = startHost(message => queueMicrotask(() => onMessage(message)), globalThis);
    target = {postMessage: message => host.handle(message), mode: "main"};
    ready = true;
    onMessage({type: "ready", mode: "main", reason});
    queue.splice(0).forEach(message => host.handle(message));
  }

  const adopt = (worker, inbox = []) => {
    worker.addEventListener("message", event => {
      if (event.data?.type === "ready") {
        ready = true;
        queue.splice(0).forEach(message => worker.postMessage(message));
      }
      onMessage(event.data);
    });
    worker.addEventListener("error", event => {
      if (!ready) { event.preventDefault?.(); fallback("worker-start-failed"); }
      else onMessage({type: "error", where: "worker", message: event.message ?? "engine error"});
    });
    target = worker;
    for (const message of inbox) {
      if (message?.type === "ready") ready = true;
      onMessage(message);
    }
    if (!ready) setTimeout(() => { if (!ready) fallback("worker-timeout"); }, 4000);
  };

  // preload.js may have started the worker during parsing; adopt it.
  const early = globalThis.BTCOptionsEngineWorker ?? null;
  globalThis.BTCOptionsEngineClaimed = true;
  if (early) {
    globalThis.BTCOptionsEngineWorker = null;
    early.release();
  }
  try {
    if (preferMain) { early?.worker.terminate(); throw new Error("main-thread mode"); }
    if (early?.failed) throw new Error("worker-start-failed");
    if (early) adopt(early.worker, early.inbox);
    else {
      if (typeof Worker !== "function") throw new Error("no Worker");
      adopt(new Worker(new URL("./engine.worker.js" + version, import.meta.url), {type: "module", name: "strategy-engine"}));
    }
  } catch (error) {
    fallback(String(error?.message ?? error));
  }

  return {
    post(message) {
      if (ready && target) target.postMessage(message);
      else queue.push(message);
    },
    get mode() { return fallen ? "main" : "worker"; },
  };
}
