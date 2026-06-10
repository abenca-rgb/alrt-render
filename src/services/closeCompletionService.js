import { registerLossStop } from "./lossGuardService.js";

export function createCloseCompletionService({
  recentLossStops,
  recordCloseStat,
  persistOutcomeToSupabase,
  markRecentHit,
  removeTrade,
}) {
  async function completeClosedTrade({
    matched,
    trade,
    finalCloseType,
    closedAtMs,
    sent,
    hitKey,
    source,
  }) {
    await recordCloseStat({
      refId: trade.refId,
      symbol: trade.symbol,
      setupType: trade.setupType || "UNKNOWN",
      result: finalCloseType,
      exitPrice: sent.exitPrice,
      movePct: sent.movePct,
      ts: closedAtMs,
    });

    persistOutcomeToSupabase({
      trade,
      outcomeType: finalCloseType,
      outcomeTimeMs: closedAtMs,
      pnlPercent: sent.movePct,
      durationMinutes:
        Number.isFinite(closedAtMs) && Number.isFinite(trade.createdAtMs)
          ? Math.max(0, Math.round((closedAtMs - trade.createdAtMs) / 60000))
          : null,
      exitPrice: sent.exitPrice,
      rawPayload: {
        source,
        matchType: matched.matchType,
      },
    });

    registerLossStop(recentLossStops, trade, finalCloseType, closedAtMs);
    await markRecentHit(hitKey);
    await removeTrade(matched.key);
  }

  return {
    completeClosedTrade,
  };
}
