import fetch from "node-fetch";
import { parseNum } from "../utils/numbers.js";

const COINGECKO_IDS = {
  BTCUSDT: "bitcoin",
  ETHUSDT: "ethereum",
  SOLUSDT: "solana",
  XRPUSDT: "ripple",
  BNBUSDT: "binancecoin",
  DOGEUSDT: "dogecoin",
  LINKUSDT: "chainlink",
  ADAUSDT: "cardano",
  ATOMUSDT: "cosmos",
  AVAXUSDT: "avalanche-2",
  SHIBUSDT: "shiba-inu",
  LTCUSDT: "litecoin",
  OPUSDT: "optimism",
  ARBUSDT: "arbitrum",
};

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/^BINANCE:/, "");
}

function nowIso() {
  return new Date().toISOString();
}

function reliablePrice({
  provider,
  symbol,
  price,
  fetchedAtUtc = nowIso(),
  freshness = "live",
}) {
  return {
    ok: true,
    reliable: true,
    provider,
    source: provider,
    symbol,
    price,
    fetched_at_utc: fetchedAtUtc,
    freshness,
    error: null,
  };
}

function unreliablePrice({ provider, symbol, error, freshness = "unavailable" }) {
  return {
    ok: false,
    reliable: false,
    provider,
    source: provider,
    symbol,
    price: null,
    fetched_at_utc: null,
    freshness,
    error,
  };
}

async function fetchJson(url, { timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
      },
    });

    const text = await response.text().catch(() => "");
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        body: text,
        error: `http_${response.status}${text ? `:${text.slice(0, 160)}` : ""}`,
      };
    }

    return {
      ok: true,
      status: response.status,
      body: text ? JSON.parse(text) : {},
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      body: null,
      error: err?.name === "AbortError" ? "timeout" : err?.message || String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function createMarketPriceService({
  binanceBaseUrl = "https://api.binance.com",
  bybitBaseUrl = "https://api.bybit.com",
  coinGeckoBaseUrl = "https://api.coingecko.com/api/v3",
  timeoutMs = 8000,
} = {}) {
  function eventPrice({ symbol, eventPrice: rawEventPrice, eventSymbol = null } = {}) {
    const cleanSymbol = normalizeSymbol(symbol);
    const cleanEventSymbol = eventSymbol ? normalizeSymbol(eventSymbol) : cleanSymbol;
    const price = parseNum(rawEventPrice);

    if (!Number.isFinite(price) || price <= 0) {
      return unreliablePrice({
        provider: "event_price",
        symbol: cleanSymbol,
        error: "missing_or_invalid_event_price",
      });
    }

    if (cleanEventSymbol !== cleanSymbol) {
      return unreliablePrice({
        provider: "event_price",
        symbol: cleanSymbol,
        error: `symbol_mismatch:${cleanEventSymbol || "unknown"}`,
      });
    }

    return reliablePrice({
      provider: "event_price",
      symbol: cleanSymbol,
      price,
      freshness: "event",
    });
  }

  async function bybitPrice(symbol) {
    const cleanSymbol = normalizeSymbol(symbol);
    if (!cleanSymbol) {
      return unreliablePrice({
        provider: "bybit_ticker",
        symbol: cleanSymbol,
        error: "missing_symbol",
      });
    }

    const linear = await fetchJson(
      `${bybitBaseUrl}/v5/market/tickers?category=linear&symbol=${encodeURIComponent(cleanSymbol)}`,
      { timeoutMs },
    );
    const linearItem = linear.ok ? linear.body?.result?.list?.[0] : null;
    const linearPrice = parseNum(linearItem?.lastPrice || linearItem?.markPrice || linearItem?.indexPrice);
    if (Number.isFinite(linearPrice) && linearPrice > 0 && linearItem?.symbol === cleanSymbol) {
      return reliablePrice({
        provider: "bybit_linear_ticker",
        symbol: cleanSymbol,
        price: linearPrice,
        freshness: "live",
      });
    }

    const spot = await fetchJson(
      `${bybitBaseUrl}/v5/market/tickers?category=spot&symbol=${encodeURIComponent(cleanSymbol)}`,
      { timeoutMs },
    );
    const spotItem = spot.ok ? spot.body?.result?.list?.[0] : null;
    const spotPrice = parseNum(spotItem?.lastPrice);
    if (Number.isFinite(spotPrice) && spotPrice > 0 && spotItem?.symbol === cleanSymbol) {
      return reliablePrice({
        provider: "bybit_spot_ticker",
        symbol: cleanSymbol,
        price: spotPrice,
        freshness: "live",
      });
    }

    return unreliablePrice({
      provider: "bybit_ticker",
      symbol: cleanSymbol,
      error: linear.error || spot.error || "price_not_found",
    });
  }

  async function coinGeckoPrice(symbol) {
    const cleanSymbol = normalizeSymbol(symbol);
    const coinId = COINGECKO_IDS[cleanSymbol];
    if (!coinId) {
      return unreliablePrice({
        provider: "coingecko_simple_price",
        symbol: cleanSymbol,
        error: "unsupported_symbol",
      });
    }

    const result = await fetchJson(
      `${coinGeckoBaseUrl}/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd&include_last_updated_at=true`,
      { timeoutMs },
    );

    if (!result.ok) {
      return unreliablePrice({
        provider: "coingecko_simple_price",
        symbol: cleanSymbol,
        error: result.error,
      });
    }

    const row = result.body?.[coinId];
    const price = parseNum(row?.usd);
    if (!Number.isFinite(price) || price <= 0) {
      return unreliablePrice({
        provider: "coingecko_simple_price",
        symbol: cleanSymbol,
        error: "invalid_price",
      });
    }

    const lastUpdatedAt = Number(row?.last_updated_at);
    const fetchedAtUtc = Number.isFinite(lastUpdatedAt)
      ? new Date(lastUpdatedAt * 1000).toISOString()
      : nowIso();

    return reliablePrice({
      provider: "coingecko_simple_price",
      symbol: cleanSymbol,
      price,
      fetchedAtUtc,
      freshness: Number.isFinite(lastUpdatedAt) ? "reported_timestamp" : "live",
    });
  }

  async function binancePrice(symbol) {
    const cleanSymbol = normalizeSymbol(symbol);
    if (!cleanSymbol) {
      return unreliablePrice({
        provider: "binance_ticker_price",
        symbol: cleanSymbol,
        error: "missing_symbol",
      });
    }

    const result = await fetchJson(
      `${binanceBaseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(cleanSymbol)}`,
      { timeoutMs },
    );
    if (!result.ok) {
      return unreliablePrice({
        provider: "binance_ticker_price",
        symbol: cleanSymbol,
        error: result.error,
      });
    }

    const price = parseNum(result.body?.price);
    if (!Number.isFinite(price) || price <= 0 || result.body?.symbol !== cleanSymbol) {
      return unreliablePrice({
        provider: "binance_ticker_price",
        symbol: cleanSymbol,
        error: "invalid_price_or_symbol_mismatch",
      });
    }

    return reliablePrice({
      provider: "binance_ticker_price",
      symbol: cleanSymbol,
      price,
      freshness: "live",
    });
  }

  async function getLatestPrice(symbol, options = {}) {
    const cleanSymbol = normalizeSymbol(symbol);
    const attempts = [];

    if (options.eventPrice !== null && options.eventPrice !== undefined) {
      const eventResult = eventPrice({
        symbol: cleanSymbol,
        eventPrice: options.eventPrice,
        eventSymbol: options.eventSymbol,
      });
      attempts.push(eventResult);
      if (eventResult.reliable) return { ...eventResult, attempts };
    }

    for (const resolver of [bybitPrice, coinGeckoPrice, binancePrice]) {
      const result = await resolver(cleanSymbol);
      attempts.push(result);
      if (result.reliable) return { ...result, attempts };
    }

    return {
      ...unreliablePrice({
        provider: "price_resolver",
        symbol: cleanSymbol,
        error: "NO_RELIABLE_PRICE",
      }),
      attempts,
    };
  }

  return {
    getLatestPrice,
  };
}
