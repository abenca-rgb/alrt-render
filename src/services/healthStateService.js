export function createHealthStateService({
  supabaseReady,
  activeTrades,
  recentHitKeys,
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
