import fetch from "node-fetch";
import { parseNum } from "../utils/numbers.js";

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/^BINANCE:/, "");
}

export function createMarketPriceService({
  baseUrl = "https://api.binance.com",
  timeoutMs = 8000,
} = {}) {
  async function getLatestPrice(symbol) {
    const cleanSymbol = normalizeSymbol(symbol);
    if (!cleanSymbol) {
      return {
        ok: false,
        symbol: cleanSymbol,
        price: null,
        source: "binance_ticker_price",
        error: "missing_symbol",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(
        `${baseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(cleanSymbol)}`,
        {
          method: "GET",
          signal: controller.signal,
          headers: {
            accept: "application/json",
          },
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          ok: false,
          symbol: cleanSymbol,
          price: null,
          source: "binance_ticker_price",
          error: `http_${response.status}${text ? `:${text.slice(0, 120)}` : ""}`,
        };
      }

      const body = await response.json();
      const price = parseNum(body?.price);

      if (!Number.isFinite(price) || price <= 0) {
        return {
          ok: false,
          symbol: cleanSymbol,
          price: null,
          source: "binance_ticker_price",
          error: "invalid_price",
        };
      }

      return {
        ok: true,
        symbol: cleanSymbol,
        price,
        source: "binance_ticker_price",
        fetched_at_utc: new Date().toISOString(),
      };
    } catch (err) {
      return {
        ok: false,
        symbol: cleanSymbol,
        price: null,
        source: "binance_ticker_price",
        error: err?.name === "AbortError" ? "timeout" : err?.message || String(err),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    getLatestPrice,
  };
}
