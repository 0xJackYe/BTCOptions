// Dedicated worker: all network, decoding and quantitative work happens here
// so the interface thread only renders and animates.
// The flat import list lets the module loader fetch the whole graph in one
// parallel wave instead of discovering it level by level.
import "../lib/quant.mjs";
import "../lib/strategies.mjs";
import "../lib/checks.mjs";
import "../lib/market.mjs";
import "../lib/signals.mjs";
import "../lib/screener.mjs";
import "./engine.js";
import {startHost} from "./engine-host.js";

const host = startHost(message => self.postMessage(message), self);
self.addEventListener("message", event => host.handle(event.data));
self.postMessage({type: "ready", mode: "worker"});
// Begin on the site route at once; the interface re-routes if it must.
host.handle({type: "start"});
