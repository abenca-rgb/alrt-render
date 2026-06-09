export function cleanupRuntimeState({
  maps,
  now = Date.now(),
  hitDedupTtlMs,
  lossGuardRetentionMs,
  freeRefTtlMs,
  dailyStatsRetentionDays = 10,
}) {
  let changed = false;

  for (const [key, ts] of maps.recentHitKeys.entries()) {
    if (!ts || now - ts > hitDedupTtlMs) {
      maps.recentHitKeys.delete(key);
      changed = true;
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
