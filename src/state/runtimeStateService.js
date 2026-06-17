import {
  createEmptyRuntimeState,
  hydrateStateFromPayload,
} from "./stateHydrationService.js";

export function createRuntimeStateService({
  stateFileStore,
  appVersion,
  refStartFloor,
  hitDedupTtlMs,
  lossGuardRetentionMs,
  freeRefTtlMs,
  maps,
  getNextRef,
  getFreeCounter,
  getLastSummarySentDate,
  setHydratedState,
  ensureDailyStat,
}) {
  let savePromise = Promise.resolve();

  async function persistState() {
    savePromise = savePromise
      .then(async () => {
        const freeCounter = getFreeCounter();
        const payload = {
          updatedAt: new Date().toISOString(),
          version: appVersion,
          nextRef: getNextRef(),
          refStartFloor,
          activeTrades: Array.from(maps.activeTrades.entries()).map(([key, trade]) => [key, trade]),
          recentHitKeys: Array.from(maps.recentHitKeys.entries()).map(([key, ts]) => [key, ts]),
          recentAlertFingerprints: maps.recentAlertFingerprints
            ? Array.from(maps.recentAlertFingerprints.entries()).map(([key, info]) => [key, info])
            : [],
          recentLossStops: Array.from(maps.recentLossStops.entries()).map(([key, info]) => [key, info]),
          freePostDate: freeCounter.freePostDate,
          freePostsToday: freeCounter.freePostsToday,
          freeSharedRefs: Array.from(maps.freeSharedRefs.entries()).map(([refId, info]) => [refId, info]),
          lastPrices: Array.from(maps.lastPrices.entries()).map(([symbol, info]) => [symbol, info]),
          dailyStats: Array.from(maps.dailyStats.entries()).map(([dateKey, stat]) => [dateKey, stat]),
          lastSummarySentDate: getLastSummarySentDate(),
          paidMembers: Array.from(maps.paidMembers.entries()).map(([email, info]) => [email, info]),
          freeMembers: Array.from(maps.freeMembers.entries()).map(([email, info]) => [email, info]),
        };

        await stateFileStore.writeStatePayload(payload);
      })
      .catch((err) => {
        console.error("PERSIST SAVE ERROR:", err);
      });

    return savePromise;
  }

  async function loadState(now = Date.now()) {
    try {
      await stateFileStore.ensureDataDir();

      const parsed = await stateFileStore.readStatePayload();
      const hydrated = hydrateStateFromPayload({
        parsed,
        now,
        refStartFloor,
        hitDedupTtlMs,
        lossGuardRetentionMs,
        freeRefTtlMs,
        maps,
      });

      setHydratedState(hydrated);
      ensureDailyStat(now);

      console.log(`Loaded ${maps.activeTrades.size} active trades from disk`);
      console.log(`Loaded ${maps.recentHitKeys.size} recent hit keys from disk`);
      if (maps.recentAlertFingerprints) {
        console.log(`Loaded ${maps.recentAlertFingerprints.size} recent alert fingerprints from disk`);
      }
      console.log(`Loaded ${maps.recentLossStops.size} recent loss stops from disk`);
      console.log(`Loaded ${maps.freeSharedRefs.size} free shared refs from disk`);
      console.log(`Loaded ${maps.lastPrices.size} last prices from disk`);
      console.log(`Loaded ${maps.dailyStats.size} daily stat days from disk`);
      console.log(`Loaded ${maps.paidMembers.size} paid members from disk`);
      console.log(`Loaded ${maps.freeMembers.size} free members from disk`);
      console.log(`Loaded nextRef ${hydrated.nextRef}`);
    } catch (err) {
      if (err.code === "ENOENT") {
        console.log("No state.json found yet, starting clean");

        const emptyState = createEmptyRuntimeState({
          refStartFloor,
          now,
        });

        setHydratedState(emptyState);
        ensureDailyStat(now);
        return;
      }

      console.error("PERSIST LOAD ERROR:", err);
    }
  }

  return {
    persistState,
    loadState,
  };
}
