export function cleanupRuntimeState({
  maps,
  now = Date.now(),
  hitDedupTtlMs,
  lossGuardRetentionMs,
  freeRefTtlMs,
  lastPriceTtlMs = 6 * 60 * 60 * 1000,
  dailyStatsRetentionDays = 10,
}) {
  let changed = false;

  for (const [key, ts] of maps.recentHitKeys.entries()) {
    if (!ts || now - ts > hitDedupTtlMs) {
      maps.recentHitKeys.delete(key);
      changed = true;
    }
  }

  if (maps.recentAlertFingerprints) {
    for (const [key, info] of maps.recentAlertFingerprints.entries()) {
      const atMs = Number(info?.atMs || info);
      if (!Number.isFinite(atMs) || now - atMs > hitDedupTtlMs) {
        maps.recentAlertFingerprints.delete(key);
        changed = true;
      }
    }
  }

  for (const [key, info] of maps.recentLossStops.entries()) {
    if (!info?.atMs || now - Number(info.atMs) > lossGuardRetentionMs) {
      maps.recentLossStops.delete(key);
      changed = true;
    }
  }

  for (const [refId, info] of maps.freeSharedRefs.entries()) {
    if (!info?.sharedAtMs || now - info.sharedAtMs > freeRefTtlMs) {
      maps.freeSharedRefs.delete(refId);
      changed = true;
    }
  }

  if (maps.lastPrices) {
    for (const [symbol, info] of maps.lastPrices.entries()) {
      const receivedAtMs = Number(info?.received_at_ms || Date.parse(info?.received_at_utc || ""));
      if (!Number.isFinite(receivedAtMs) || now - receivedAtMs > lastPriceTtlMs) {
        maps.lastPrices.delete(symbol);
        changed = true;
      }
    }
  }

  const keepAfterMs = now - dailyStatsRetentionDays * 24 * 60 * 60 * 1000;

  for (const [dateKey] of maps.dailyStats.entries()) {
    const statDateMs = Date.parse(`${dateKey}T00:00:00Z`);

    if (Number.isFinite(statDateMs) && statDateMs < keepAfterMs) {
      maps.dailyStats.delete(dateKey);
      changed = true;
    }
  }

  return { changed };
}
