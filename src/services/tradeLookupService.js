import { formatUtc } from "../utils/date.js";
import { uniqueStrings } from "../utils/payload.js";

export function findTradeByRefId(activeTrades, refId) {
  if (!refId) return null;

  for (const [key, trade] of activeTrades.entries()) {
    if (trade.hit) continue;

    if (String(trade.refId) === String(refId)) {
      return {
        key,
        trade,
        matchType: "ref_id",
        score: 2000,
      };
    }
  }

  return null;
}

export function findOpenTradeByCandidateIds(activeTrades, ids) {
  const wanted = uniqueStrings(ids);

  if (wanted.length === 0) return null;

  for (const [key, trade] of activeTrades.entries()) {
    if (trade.hit) continue;

    const tradeIds = uniqueStrings([
      trade.primaryAlertId,
      ...(Array.isArray(trade.alertIds) ? trade.alertIds : []),
    ]);

    const matched = tradeIds.some((id) => wanted.includes(id));

    if (matched) {
      return {
        key,
        trade,
        matchType: "candidate_id",
        score: 1000,
      };
    }
  }

  return null;
}

export function countOpenTradesForSymbol(activeTrades, symbol) {
  let count = 0;

  for (const [, trade] of activeTrades.entries()) {
    if (!trade) continue;
    if (trade.hit) continue;
    if (trade.symbol === symbol) count += 1;
  }

  return count;
}

export function countOpenTradesForSide(activeTrades, side) {
  let count = 0;

  for (const [, trade] of activeTrades.entries()) {
    if (!trade) continue;
    if (trade.hit) continue;
    if (trade.side === side) count += 1;
  }

  return count;
}

export function hasOpenTradeForSymbol(activeTrades, symbol, maxOpenTradesPerSymbol) {
  return countOpenTradesForSymbol(activeTrades, symbol) >= maxOpenTradesPerSymbol;
}

export function getOpenTradesForSymbol(activeTrades, symbol) {
  const items = [];

  for (const [, trade] of activeTrades.entries()) {
    if (trade.symbol !== symbol) continue;
    if (trade.hit) continue;

    items.push({
      refId: trade.refId,
      symbol: trade.symbol,
      side: trade.side,
      entry: trade.entry,
      tp: trade.tp,
      sl: trade.sl,
      createdAtMs: trade.createdAtMs,
      createdAtUtc: formatUtc(trade.createdAtMs),
      primaryAlertId: trade.primaryAlertId || null,
      alertIds: uniqueStrings(trade.alertIds || []),
    });
  }

  items.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  return items;
}
