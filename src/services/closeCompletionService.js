import { registerLossStop } from "./lossGuardService.js";

function estimateRMultiple({ trade, finalCloseType, movePct }) {
  if (finalCloseType === "SL") return -1;
  if (finalCloseType === "TP") return Number.isFinite(Number(trade?.rr)) ? Number(trade.rr) : null;

  const entry = Number(trade?.entry);
  const sl = Number(trade?.sl);
  const move = Number(movePct);

  if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(move) || entry === 0) {
    return null;
  }

  const riskPct = Math.abs((entry - sl) / entry) * 100;
  if (!riskPct) return null;

  return move / riskPct;
}

export function createCloseCompletionService({
  recentLossStops,
  recordCloseStat,
  persistOutcomeToSupabase,
  updateShadowOutcome,
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

    const rMultiple = estimateRMultiple({
      trade,
      finalCloseType,
      movePct: sent.movePct,
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
        candidateKey: trade.candidateKey || null,
        rMultiple,
      },
    });

    updateShadowOutcome?.({
      trade,
      outcomeType: finalCloseType,
      outcomeTimeMs: closedAtMs,
      movePct: sent.movePct,
      rMultiple,
    });

    registerLossStop(recentLossStops, trade, finalCloseType, closedAtMs);
    await markRecentHit(hitKey);
    await removeTrade(matched.key);
  }

  return {
    completeClosedTrade,
  };
}
