export function registerLossStop(recentLossStops, trade, closeType, ts) {
  if (!trade || closeType !== "SL") return;

  const atMs = Number.isFinite(Number(ts)) ? Number(ts) : Date.now();
  const key = `${trade.symbol}|${trade.side}|${trade.refId}|${atMs}`;

  recentLossStops.set(key, {
    symbol: trade.symbol,
    side: trade.side,
    setupType: trade.setupType || "UNKNOWN",
    refId: trade.refId,
    atMs,
    atUtc: new Date(atMs).toISOString(),
  });
}

export function getFreshLossStops(recentLossStops, retentionMs, now = Date.now()) {
  return Array.from(recentLossStops.values()).filter((item) => {
    if (!item?.atMs) return false;
    return now - Number(item.atMs) <= retentionMs;
  });
}

export function getLossGuardBlock(
  recentLossStops,
  {
    symbol,
    side,
    now = Date.now(),
    retentionMs,
    symbolCooldownMs,
    marketWindowMs,
    marketCooldownMs,
    marketLimit,
  },
) {
  const recentStops = getFreshLossStops(recentLossStops, retentionMs, now);
  const sameSymbolSide = recentStops
    .filter((item) => item.symbol === symbol && item.side === side)
    .sort((a, b) => Number(b.atMs) - Number(a.atMs));

  const latestSymbolStop = sameSymbolSide[0];

  if (latestSymbolStop && now - Number(latestSymbolStop.atMs) <= symbolCooldownMs) {
    return {
      blocked: true,
      reason: "loss_guard_symbol",
      latestRef: latestSymbolStop.refId,
      latestAtUtc: latestSymbolStop.atUtc,
      cooldownMinutes: Math.round(symbolCooldownMs / 60000),
    };
  }

  const marketSideStops = recentStops
    .filter((item) => item.side === side && now - Number(item.atMs) <= marketWindowMs)
    .sort((a, b) => Number(b.atMs) - Number(a.atMs));

  if (marketSideStops.length >= marketLimit) {
    const latestMarketStop = marketSideStops[0];

    if (now - Number(latestMarketStop.atMs) <= marketCooldownMs) {
      return {
        blocked: true,
        reason: "loss_guard_market",
        stopCount: marketSideStops.length,
        latestRef: latestMarketStop.refId,
        latestAtUtc: latestMarketStop.atUtc,
        cooldownMinutes: Math.round(marketCooldownMs / 60000),
      };
    }
  }

  return { blocked: false };
}
