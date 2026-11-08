/**
 * Replay market for offline development and demos. Serves a recorded
 * /api/market snapshot with the exchange clock frozen at the capture moment
 * and receipt times shifted so quote ages stay exactly as recorded.
 *
 * Every payload carries replay: true and status "REPLAY"; the interfaces show
 * a prominent badge. local_bridge.mjs refuses to start replay on a public host.
 */
const RECEIPT_KEYS = ["quote_updated_at", "mark_updated_at", "ticker_updated_at", "quote_verified_at"];
const SYMBOL = /^BTC-\d{6}-\d{1,12}(?:\.\d{1,4})?-[CP]$/;

export function createReplayMarket(snapshot, {now = Date.now} = {}) {
  if (!snapshot || !Array.isArray(snapshot.options) || !snapshot.options.length) throw new Error("回放快照缺少期权数据。");
  const exchangeAt = Number(snapshot.server_now_ms);
  const offset = Number(snapshot.exchange_clock_offset_ms ?? 0);
  if (!Number.isSafeInteger(exchangeAt) || !Number.isFinite(offset) || !(Number(snapshot.btc_index_price) > 0)) {
    throw new Error("回放快照缺少 server_now_ms、时钟偏移或 BTC 指数。");
  }
  const capturedLocal = exchangeAt - offset;
  const headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"};

  function frame(current) {
    const shift = current - capturedLocal;
    const move = value => typeof value === "number" && Number.isFinite(value) ? value + shift : value;
    const options = snapshot.options.map(row => {
      const next = {...row, field_updated_at: Object.fromEntries(Object.entries(row.field_updated_at ?? {}).map(([key, value]) => [key, move(value)]))};
      for (const key of RECEIPT_KEYS) if (key in row) next[key] = move(row[key]);
      return next;
    });
    return {
      ...snapshot, options, replay: true, status: "REPLAY", stale: false, error: null,
      replay_captured_at: snapshot.fetched_at ?? snapshot.generated_at_beijing ?? null,
      server_now_ms: exchangeAt, snapshot_served_at_ms: current, exchange_clock_offset_ms: exchangeAt - current,
      index_updated_at: move(snapshot.index_updated_at),
      realtime: {transport: "replay", connected: false, last_message_at: null},
    };
  }

  async function handleReplay(request) {
    const url = new URL(request.url);
    if (!["/api/market", "/api/focused-market", "/api/mark-watch"].includes(url.pathname)) return null;
    if (request.method !== "GET") return new Response(null, {status: 405, headers: {Allow: "GET", "Cache-Control": "no-store"}});
    const body = frame(now());
    if (url.pathname === "/api/market") return new Response(JSON.stringify(body), {headers});
    const symbols = (url.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
    if (!symbols.length || symbols.length > 8 || symbols.some(symbol => !SYMBOL.test(symbol))) {
      return new Response(JSON.stringify({error: "请提供 1 至 8 个 BTC 期权合约。"}), {status: 400, headers});
    }
    if (url.pathname === "/api/mark-watch") return new Response(JSON.stringify({accepted: symbols.length}), {headers});
    const wanted = new Set(symbols);
    const options = body.options.filter(row => wanted.has(row.symbol));
    return new Response(JSON.stringify({...body, options, selected_contracts: options.length}), {headers});
  }

  // The replay server's clock is frozen at the capture moment: the Strategy
  // Desk receives a byte-stable frame (so revalidation answers 304) whose
  // quote ages and exchange clock stay exactly as recorded.
  const captured = frame(capturedLocal);
  handleReplay.latest = async () => ({snapshot: captured, builtAt: capturedLocal});
  handleReplay.clock = () => capturedLocal;
  return handleReplay;
}
