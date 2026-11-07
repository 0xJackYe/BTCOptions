import {handleAccount} from "./worker-account.mjs";
import {handleMarket} from "./worker-market.mjs";
import {relay} from "./worker-relay.mjs";

const headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"};
const backend = {BINANCE_RELAY_URL: "https://btcoptions.onrender.com"};
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
      const market = await handleMarket(request);
      if (market) return market;
      return Response.json({error: {message: "接口不存在。"}}, {status: 404, headers});
    } catch {
      return Response.json({error: {message: "服务暂时不可用，请稍后重试。"}}, {status: 503, headers});
    }
  }
};
