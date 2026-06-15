import { getUtcDateKey } from "../utils/date.js";

function arrayEntries(value) {
  return Array.isArray(value) ? value : [];
}

function resetFreeCounterIfNeeded({ freePostDate, freePostsToday, now }) {
  const today = getUtcDateKey(now);

  if (freePostDate !== today) {
    return {
      freePostDate: today,
      freePostsToday: 0,
    };
  }

  return {
    freePostDate,
    freePostsToday,
  };
}

export function createEmptyRuntimeState({ refStartFloor, now = Date.now() }) {
  return {
    nextRef: refStartFloor,
    freePostDate: getUtcDateKey(now),
    freePostsToday: 0,
    lastSummarySentDate: "",
  };
}

export function hydrateStateFromPayload({
  parsed,
  maps,
  now = Date.now(),
  refStartFloor,
  hitDedupTtlMs,
  lossGuardRetentionMs,
  freeRefTtlMs,
}) {
  const active = arrayEntries(parsed?.activeTrades);
  const hits = arrayEntries(parsed?.recentHitKeys);
  const lossStops = arrayEntries(parsed?.recentLossStops);
  const freeRefs = arrayEntries(parsed?.freeSharedRefs);
  const lastPrices = arrayEntries(parsed?.lastPrices);
  const stats = arrayEntries(parsed?.dailyStats);

  let nextRef = Number.isFinite(Number(parsed?.nextRef))
    ? Math.max(refStartFloor, Number(parsed.nextRef))
    : refStartFloor;

  let freePostDate = typeof parsed?.freePostDate === "string" ? parsed.freePostDate : getUtcDateKey(now);
  let freePostsToday = Number.isFinite(Number(parsed?.freePostsToday))
    ? Math.max(0, Number(parsed.freePostsToday))
    : 0;
  const lastSummarySentDate = typeof parsed?.lastSummarySentDate === "string" ? parsed.lastSummarySentDate : "";

  const freeCounter = resetFreeCounterIfNeeded({ freePostDate, freePostsToday, now });
  freePostDate = freeCounter.freePostDate;
  freePostsToday = freeCounter.freePostsToday;

  for (const item of active) {
    if (!Array.isArray(item) || item.length !== 2) continue;

    const [key, trade] = item;

    if (!trade || typeof trade !== "object") continue;
    if (!trade.createdAtMs) continue;
    if (trade.hit) continue;

    maps.activeTrades.set(key, trade);
  }

  for (const item of hits) {
    if (!Array.isArray(item) || item.length !== 2) continue;

    const [key, ts] = item;

    if (!ts || now - ts > hitDedupTtlMs) continue;

    maps.recentHitKeys.set(key, ts);
  }

  for (const item of lossStops) {
    if (!Array.isArray(item) || item.length !== 2) continue;

    const [key, info] = item;
    const atMs = Number(info?.atMs);

    if (!key || !Number.isFinite(atMs)) continue;
    if (now - atMs > lossGuardRetentionMs) continue;

    maps.recentLossStops.set(String(key), info);
  }

  for (const item of freeRefs) {
    if (!Array.isArray(item) || item.length !== 2) continue;

    const [refId, info] = item;

    if (!refId || !info?.sharedAtMs) continue;
    if (now - info.sharedAtMs > freeRefTtlMs) continue;

    maps.freeSharedRefs.set(String(refId), info);
  }

  for (const item of lastPrices) {
    if (!Array.isArray(item) || item.length !== 2) continue;

    const [symbol, info] = item;
    const receivedAtMs = Number(info?.received_at_ms || Date.parse(info?.received_at_utc || ""));

    if (!symbol || !info || !Number.isFinite(receivedAtMs)) continue;

    maps.lastPrices.set(String(symbol), {
      ...info,
      received_at_ms: receivedAtMs,
    });
  }

  if (Array.isArray(parsed?.paidMembers)) {
    for (const item of parsed.paidMembers) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [email, info] = item;
      maps.paidMembers.set(email, info);
    }
  }

  if (Array.isArray(parsed?.members)) {
    for (const item of parsed.members) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [email, info] = item;
      maps.paidMembers.set(email, info);
    }
  }

  if (Array.isArray(parsed?.freeMembers)) {
    for (const item of parsed.freeMembers) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [email, info] = item;
      maps.freeMembers.set(email, info);
    }
  }

  for (const item of stats) {
    if (!Array.isArray(item) || item.length !== 2) continue;

    const [dateKey, stat] = item;

    if (!dateKey || !stat || typeof stat !== "object") continue;

    maps.dailyStats.set(String(dateKey), stat);
  }

  return {
    nextRef,
    freePostDate,
    freePostsToday,
    lastSummarySentDate,
  };
}
