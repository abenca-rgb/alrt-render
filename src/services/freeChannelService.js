import { formatUtc, getUtcDateKey } from "../utils/date.js";

export function createFreeChannelService({
  freeSharedRefs,
  freeChatId,
  freeDailyLimit,
  getFreePostDate,
  getFreePostsToday,
  setFreeCounter,
  persistState,
}) {
  function resetCounterIfNeeded(nowMs = Date.now()) {
    const today = getUtcDateKey(nowMs);

    if (getFreePostDate() !== today) {
      setFreeCounter({
        freePostDate: today,
        freePostsToday: 0,
      });
    }
  }

  function canSendSignal(nowMs = Date.now()) {
    resetCounterIfNeeded(nowMs);
    return Boolean(freeChatId) && getFreePostsToday() < freeDailyLimit;
  }

  async function markSignalShared({ refId, symbol, side, sharedAtMs = Date.now() }) {
    if (!refId) return;

    resetCounterIfNeeded(sharedAtMs);

    setFreeCounter({
      freePostDate: getFreePostDate(),
      freePostsToday: getFreePostsToday() + 1,
    });

    freeSharedRefs.set(String(refId), {
      refId: String(refId),
      symbol,
      side,
      sharedAtMs,
      sharedAtUtc: formatUtc(sharedAtMs),
    });

    await persistState();
  }

  function wasShared(refId) {
    if (!refId) return false;
    return freeSharedRefs.has(String(refId));
  }

  return {
    resetCounterIfNeeded,
    canSendSignal,
    markSignalShared,
    wasShared,
  };
}
