export function createRecentHitService({ recentHitKeys, persistState }) {
  function wasSent(hitKey) {
    return recentHitKeys.has(hitKey);
  }

  async function markSent(hitKey, sentAtMs = Date.now()) {
    recentHitKeys.set(hitKey, sentAtMs);
    await persistState();
  }

  return {
    wasSent,
    markSent,
  };
}
