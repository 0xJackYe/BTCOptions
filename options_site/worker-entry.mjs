import {handleAccount} from "./worker-account.mjs";
import {handleMarket} from "./worker-market.mjs";
import {relay} from "./worker-relay.mjs";
import {createStrategyHandler} from "./worker-strategy.mjs";

const headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"};
const backend = {BINANCE_RELAY_URL: "https://btcoptions.onrender.com"};
// Fallback only: the Render backend normally answers strategy routes. The edge
// handler has no credentials, so its account route reports "not configured".
let strategyHandler = null;
const strategy = request => {
  strategyHandler ??= createStrategyHandler({
    getMarket: async () => (await handleMarket(new Request(new URL("/api/market", request.url)))).json(),
  });
  return strategyHandler(request);
};
export default {
  async fetch(request, env) {
    const {pathname} = new URL(request.url);
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (pathname === "/api/health" && request.method === "GET") {
        return Response.json({status: "ok", service: "btcoptions"}, {headers});
      }
      const remote = await relay(request, backend);
      if (remote) return remote;
      if (pathname === "/api/account" || pathname === "/api/account/time") return await handleAccount(request);
      if (pathname.startsWith("/api/strategy/")) {
        const reply = await strategy(request);
        if (reply) return reply;
      }
      const market = await handleMarket(request);
      if (market) return market;
      return Response.json({error: {message: "接口不存在。"}}, {status: 404, headers});
    } catch {
      return Response.json({error: {message: "服务暂时不可用，请稍后重试。"}}, {status: 503, headers});
    }
  }
};
