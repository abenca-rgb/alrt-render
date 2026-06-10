import {
  findOpenTradeByCandidateIds,
  findTradeByRefId,
  getOpenTradesForSymbol,
} from "./tradeLookupService.js";
import { getTimeExitResult, shouldInferHit } from "../utils/outcomes.js";

export function createTradingViewCloseService({
  activeTrades,
  maxTradeAgeMs,
  closeTrade,
  recordRejectStat,
  wasRecentHitSent,
}) {
  async function closeExpiredTradesForSymbol({
    symbol,
    currentPrice,
    eventTime,
    receivedAtMs,
  }) {
    if (!symbol) return;

    for (const [key, trade] of Array.from(activeTrades.entries())) {
      if (trade.symbol !== symbol) continue;
      if (trade.hit) continue;

      const ageMs = receivedAtMs - (trade.createdAtMs || receivedAtMs);

      if (ageMs >= maxTradeAgeMs) {
        const finalPrice = Number.isFinite(currentPrice) ? currentPrice : trade.entry;
        const result = getTimeExitResult(trade, finalPrice);

        await closeTrade({
          matched: {
            key,
            trade,
            matchType: "server_time_exit",
          },
          closeType: result,
          eventTime,
          currentPrice: finalPrice,
          source: "server_time_exit",
        });
      }
    }
  }

  async function handleExplicitClose({
    symbol,
    side,
    setupType,
    explicitCloseType,
    incomingRef,
    candidateIdsBase,
    eventTime,
    currentPrice,
    receivedAtMs,
  }) {
    if (!explicitCloseType || !symbol) return false;

    const matched =
      findOpenTradeByCandidateIds(activeTrades, candidateIdsBase) ||
      findTradeByRefId(activeTrades, incomingRef);

    if (matched) {
      await closeTrade({
        matched,
        closeType: explicitCloseType,
        eventTime,
        currentPrice,
        source: "explicit_pine_close",
      });

      return true;
    }

    console.log("EXPLICIT CLOSE RECEIVED BUT NO MATCHED TRADE FOUND - IGNORING OLD/UNMATCHED CLOSE:", {
      symbol,
      explicitCloseType,
      incomingRef,
      candidateIdsBase,
      openTradesForSymbol: getOpenTradesForSymbol(activeTrades, symbol),
    });

    await recordRejectStat({
      symbol,
      side,
      setupType,
      reason: `unmatched_${String(explicitCloseType).toLowerCase()}`,
      ts: receivedAtMs,
    });

    return true;
  }

  async function inferPriceHits({
    symbol,
    currentPrice,
    receivedAtMs,
  }) {
    if (!symbol || !Number.isFinite(currentPrice)) return;

    for (const [key, trade] of activeTrades.entries()) {
      if (trade.symbol !== symbol) continue;
      if (trade.hit) continue;

      const inferredHit = shouldInferHit(trade, currentPrice);
      if (!inferredHit) continue;

      const inferredHitKey = `${symbol}|${trade.refId}|${inferredHit}|${Math.floor(receivedAtMs / 60000)}`;
      if (wasRecentHitSent(inferredHitKey)) continue;

      await closeTrade({
        matched: {
          key,
          trade,
          matchType: "price_inference",
        },
        closeType: inferredHit,
        eventTime: receivedAtMs,
        currentPrice,
        source: "price_inference",
      });
    }
  }

  async function handleCloseLifecycle(context) {
    await closeExpiredTradesForSymbol(context);

    const explicitCloseHandled = await handleExplicitClose(context);
    if (explicitCloseHandled) return true;

    await inferPriceHits(context);
    return false;
  }

  return {
    closeExpiredTradesForSymbol,
    handleExplicitClose,
    inferPriceHits,
    handleCloseLifecycle,
  };
}
