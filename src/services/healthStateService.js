export function createHealthStateService({
  supabaseReady,
  activeTrades,
  recentHitKeys,
  recentAlertFingerprints,
  recentLossStops,
  getNextRef,
  getFreePostDate,
  getFreePostsToday,
  freeSharedRefs,
  dailyStats,
  getLastSummarySentDate,
  paidMembers,
  freeMembers,
  resetFreeCounterIfNeeded,
}) {
  function getHealthState() {
    resetFreeCounterIfNeeded(Date.now());

    return {
      supabaseReady: supabaseReady(),
      activeTrades: activeTrades.size,
      recentHitKeys: recentHitKeys.size,
      recentAlertFingerprints: recentAlertFingerprints?.size || 0,
      recentLossStops: recentLossStops.size,
      nextRef: getNextRef(),
      freePostDate: getFreePostDate(),
      freePostsToday: getFreePostsToday(),
      freeSharedRefs: freeSharedRefs.size,
      dailyStatsDays: dailyStats.size,
      lastSummarySentDate: getLastSummarySentDate(),
      paidMembers: paidMembers.size,
      freeMembers: freeMembers.size,
    };
  }

  return {
    getHealthState,
  };
}
