import { parseNum } from "../utils/numbers.js";

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/^BINANCE:/, "");
}

function round(value, decimals = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** decimals;
  return Math.round(number * factor) / factor;
}

export function createLastPriceCacheService({
  lastPrices,
  persistState,
  maxAgeMs = 5 * 60 * 1000,
} = {}) {
  function recordTradingViewPrice({
    symbol,
    price,
    eventType = null,
    alertId = null,
    refId = null,
    receivedAtMs = Date.now(),
  }) {
    const cleanSymbol = normalizeSymbol(symbol);
    const parsedPrice = parseNum(price);

    if (!cleanSymbol || !Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      return { ok: false, reason: "missing_or_invalid_price" };
    }

    const record = {
      symbol: cleanSymbol,
      price: parsedPrice,
      source: "tradingview_webhook",
      event_type: eventType || null,
      alert_id: alertId || null,
      ref_id: refId || null,
      received_at_utc: new Date(receivedAtMs).toISOString(),
      received_at_ms: receivedAtMs,
    };

    lastPrices.set(cleanSymbol, record);
    void persistState?.();

    return { ok: true, record };
  }

  function getCachedPrice(symbol, nowMs = Date.now()) {
    const cleanSymbol = normalizeSymbol(symbol);
    const record = lastPrices.get(cleanSymbol);

    if (!record) {
      return {
        ok: false,
        reliable: false,
        provider: "tradingview_cache",
        source: "tradingview_cache",
        symbol: cleanSymbol,
        price: null,
        fetched_at_utc: null,
        freshness: "missing",
        freshness_seconds: null,
        error: "cache_miss",
      };
    }

    const receivedAtMs = Number(record.received_at_ms || new Date(record.received_at_utc || 0).getTime());
    const ageMs = Number.isFinite(receivedAtMs) ? Math.max(0, nowMs - receivedAtMs) : null;
    const price = parseNum(record.price);
    const fresh = ageMs !== null && ageMs <= maxAgeMs;

    return {
      ok: fresh && Number.isFinite(price) && price > 0,
      reliable: fresh && Number.isFinite(price) && price > 0,
      provider: "tradingview_cache",
      source: "tradingview_cache",
      symbol: cleanSymbol,
      price: Number.isFinite(price) && price > 0 ? price : null,
      fetched_at_utc: record.received_at_utc || null,
      freshness: fresh ? "fresh_cache" : "stale_cache",
      freshness_seconds: ageMs === null ? null : round(ageMs / 1000, 1),
      event_type: record.event_type || null,
      alert_id: record.alert_id || null,
      ref_id: record.ref_id || null,
      error: fresh ? null : "stale_or_invalid_cache_price",
    };
  }

  function listCachedPrices(nowMs = Date.now()) {
    return Array.from(lastPrices.values())
      .map((record) => getCachedPrice(record.symbol, nowMs))
      .sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
  }

  return {
    recordTradingViewPrice,
    getCachedPrice,
    listCachedPrices,
  };
}
