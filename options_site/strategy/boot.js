// Starts the engine before the interface modules finish loading, so the
// worker is already fetching market data while app.js and its imports are in
// flight. Messages that arrive before the interface listens are buffered.
import {createEngineClient} from "./engine-client.js";

const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem("btcdesk:" + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
};

const bridge = window.BTCOptionsBridge ?? null;
// The optional local connector (127.0.0.1) is reached from this page itself,
// where the browser can ask for local-network permission.
export const local = Boolean(bridge) && read("useLocal", false) === true;

const buffer = [];
let listener = null;
export const engine = createEngineClient(message => { if (listener) listener(message); else buffer.push(message); }, {preferMain: local});
export function listen(handler) {
  listener = handler;
  buffer.splice(0).forEach(handler);
}

const paramsById = {};
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith("btcdesk:params:")) paramsById[key.slice(15)] = read(key.slice(8), {});
  }
} catch { /* storage unavailable */ }

engine.post({type: "init", settings: read("settings", {}), paramsById, strategyId: "crash-put", hash: location.hash,
  selectedKey: null, autoSelect: !matchMedia("(max-width: 900px)").matches, account: null});
engine.post({type: "route", local, origin: local ? bridge.origin : null});
engine.post({type: "visibility", hidden: document.hidden});
engine.post({type: "start"});
document.addEventListener("visibilitychange", () => engine.post({type: "visibility", hidden: document.hidden}));
