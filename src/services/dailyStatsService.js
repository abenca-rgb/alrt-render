import { formatUtc, getUtcDateKey } from "../utils/date.js";

function createEmptyClosureStats() {
  return {
    tp: 0,
    sl: 0,
    timeExitProfit: 0,
    timeExitLoss: 0,
    expired: 0,
  };
}

function createEmptyDailyStat(dateKey) {
  return {
    date: dateKey,
    alerts: 0,
    tp: 0,
    sl: 0,
    timeExitProfit: 0,
    timeExitLoss: 0,
    expired: 0,
    freeAlerts: 0,
    rejectedSignals: 0,
    rejectsByReason: {},
    oldClosures: createEmptyClosureStats(),
    orphanClosures: createEmptyClosureStats(),
    bySymbol: {},
    bySetup: {},
    byRef: {},
  };
}

function normalizeDailyStat(stat) {
  if (stat.timeExitProfit === undefined) stat.timeExitProfit = 0;
  if (stat.timeExitLoss === undefined) stat.timeExitLoss = 0;
  if (stat.expired === undefined) stat.expired = 0;
  if (stat.rejectedSignals === undefined) stat.rejectedSignals = 0;
  if (!stat.rejectsByReason) stat.rejectsByReason = {};
  if (!stat.oldClosures) stat.oldClosures = createEmptyClosureStats();
  if (!stat.orphanClosures) stat.orphanClosures = createEmptyClosureStats();
  if (!stat.bySymbol) stat.bySymbol = {};
  if (!stat.bySetup) stat.bySetup = {};
  if (!stat.byRef) stat.byRef = {};

  return stat;
}

function ensureSymbolStats(stat, symbol) {
  const key = symbol || "UNKNOWN";

  if (!stat.bySymbol[key]) {
    stat.bySymbol[key] = {
      alerts: 0,
      tp: 0,
      sl: 0,
      timeExitProfit: 0,
      timeExitLoss: 0,
      expired: 0,
    };
  }

  const s = stat.bySymbol[key];

  if (s.timeExitProfit === undefined) s.timeExitProfit = 0;
  if (s.timeExitLoss === undefined) s.timeExitLoss = 0;
  if (s.expired === undefined) s.expired = 0;

  return s;
}

function ensureSetupStats(stat, setupType) {
  const key = setupType || "UNKNOWN";

  if (!stat.bySetup[key]) {
    stat.bySetup[key] = {
      alerts: 0,
      tp: 0,
      sl: 0,
      timeExitProfit: 0,
      timeExitLoss: 0,
      expired: 0,
    };
  }

  const s = stat.bySetup[key];

  if (s.timeExitProfit === undefined) s.timeExitProfit = 0;
  if (s.timeExitLoss === undefined) s.timeExitLoss = 0;
  if (s.expired === undefined) s.expired = 0;

  return s;
}

export function createDailyStatsService({ dailyStats, persistState, persistRejectionToSupabase }) {
  function getDailyStat(dateKey = getUtcDateKey(Date.now())) {
    if (!dailyStats.has(dateKey)) {
      dailyStats.set(dateKey, createEmptyDailyStat(dateKey));
    }

    return normalizeDailyStat(dailyStats.get(dateKey));
  }

  async function recordSignalStat({
    refId,
    alertId,
    symbol,
    side,
    strength,
    setupType,
    setupScore,
    qualityScore,
    qualityGrade,
    trendStrength,
    volatilityState,
    marketRegime,
    session,
    confidenceLevel,
    estimatedHoldDuration,
    entry,
    tp,
    sl,
    rr,
    sharedToFree,
    ts = Date.now(),
  }) {
    const dateKey = getUtcDateKey(ts);
    const stat = getDailyStat(dateKey);

    const symbolStat = ensureSymbolStats(stat, symbol);
    const setupStat = ensureSetupStats(stat, setupType);

    stat.alerts += 1;
    symbolStat.alerts += 1;
    setupStat.alerts += 1;

    if (sharedToFree) {
      stat.freeAlerts += 1;
    }

    stat.byRef[String(refId)] = {
      refId: String(refId),
      alertId: alertId ? String(alertId) : String(refId),
      primaryAlertId: alertId ? String(alertId) : String(refId),
      symbol,
      side,
      strength,
      setupType,
      setupScore,
      qualityScore,
      qualityGrade,
      trendStrength,
      volatilityState,
      marketRegime,
      session,
      confidenceLevel,
      estimatedHoldDuration,
      entry,
      tp,
      sl,
      rr,
      sharedToFree: Boolean(sharedToFree),
      openedDateKey: dateKey,
      openedAtMs: ts,
      openedAtUtc: formatUtc(ts),
      result: "OPEN",
      closedAtMs: null,
      closedAtUtc: null,
      exitPrice: null,
      movePct: null,
    };

    await persistState();
  }

  async function recordCloseStat({
    refId,
    symbol,
    setupType = "UNKNOWN",
    result,
    exitPrice = null,
    movePct = null,
    ts = Date.now(),
  }) {
    const closeDateKey = getUtcDateKey(ts);
    const stat = getDailyStat(closeDateKey);
    let item = stat.byRef[String(refId)];
    let openedStat = stat;

    if (!item) {
      for (const [, dayStat] of dailyStats.entries()) {
        const found = dayStat?.byRef?.[String(refId)];

        if (found) {
          item = found;
          openedStat = dayStat;
          break;
        }
      }
    }

    const openedDateKey = item?.openedDateKey || item?.openedAtUtc?.slice(0, 10) || null;
    const belongsToToday = openedDateKey === closeDateKey;
    const targetStat = belongsToToday ? openedStat : stat;
    const finalSetupType = item?.setupType || setupType || "UNKNOWN";

    if (item?.result && item.result !== "OPEN") {
      console.log("CLOSE STAT IGNORED - REF ALREADY CLOSED:", {
        refId,
        oldResult: item.result,
        newResult: result,
      });
      return false;
    }

    if (!item) {
      const orphan = stat.orphanClosures || createEmptyClosureStats();

      if (result === "TP") orphan.tp += 1;
      if (result === "SL") orphan.sl += 1;
      if (result === "TIME_EXIT_PROFIT") orphan.timeExitProfit += 1;
      if (result === "TIME_EXIT_LOSS") orphan.timeExitLoss += 1;
      if (result === "EXPIRED") orphan.expired += 1;

      stat.orphanClosures = orphan;
    } else if (belongsToToday) {
      const symbolStat = ensureSymbolStats(targetStat, symbol);
      const setupStat = ensureSetupStats(targetStat, finalSetupType);

      if (result === "TP") {
        targetStat.tp += 1;
        symbolStat.tp += 1;
        setupStat.tp += 1;
      }

      if (result === "SL") {
        targetStat.sl += 1;
        symbolStat.sl += 1;
        setupStat.sl += 1;
      }

      if (result === "TIME_EXIT_PROFIT") {
        targetStat.timeExitProfit += 1;
        symbolStat.timeExitProfit += 1;
        setupStat.timeExitProfit += 1;
      }

      if (result === "TIME_EXIT_LOSS") {
        targetStat.timeExitLoss += 1;
        symbolStat.timeExitLoss += 1;
        setupStat.timeExitLoss += 1;
      }

      if (result === "EXPIRED") {
        targetStat.expired += 1;
        symbolStat.expired += 1;
        setupStat.expired += 1;
      }
    } else {
      const old = stat.oldClosures || createEmptyClosureStats();

      if (result === "TP") old.tp += 1;
      if (result === "SL") old.sl += 1;
      if (result === "TIME_EXIT_PROFIT") old.timeExitProfit += 1;
      if (result === "TIME_EXIT_LOSS") old.timeExitLoss += 1;
      if (result === "EXPIRED") old.expired += 1;

      stat.oldClosures = old;
    }

    if (item) {
      item.result = result;
      item.closedAtMs = ts;
      item.closedAtUtc = formatUtc(ts);
      item.exitPrice = exitPrice;
      item.movePct = movePct;
      item.closedDateKey = closeDateKey;
    } else {
      stat.byRef[String(refId)] = {
        refId: String(refId),
        symbol,
        setupType: finalSetupType,
        result,
        openedDateKey: null,
        openedAtMs: null,
        openedAtUtc: null,
        closedDateKey: closeDateKey,
        closedAtMs: ts,
        closedAtUtc: formatUtc(ts),
        exitPrice,
        movePct,
        orphanClose: true,
      };
    }

    await persistState();
    return true;
  }

  async function recordRejectStat({
    symbol,
    side,
    setupType = "UNKNOWN",
    reason,
    qualityScore = null,
    qualityGrade = null,
    rawPayload = null,
    ts = Date.now(),
  }) {
    const stat = getDailyStat(getUtcDateKey(ts));
    const reasonKey = String(reason || "unknown").toLowerCase();

    stat.rejectedSignals += 1;
    stat.rejectsByReason[reasonKey] = (stat.rejectsByReason[reasonKey] || 0) + 1;

    const symbolStat = ensureSymbolStats(stat, symbol || "UNKNOWN");
    symbolStat.rejected = (symbolStat.rejected || 0) + 1;

    const setupStat = ensureSetupStats(stat, setupType || "UNKNOWN");
    setupStat.rejected = (setupStat.rejected || 0) + 1;

    await persistState();

    persistRejectionToSupabase({
      symbol,
      side,
      setupType,
      reason,
      qualityScore,
      qualityGrade,
      rawPayload,
    });
  }

  return {
    getDailyStat,
    recordSignalStat,
    recordCloseStat,
    recordRejectStat,
  };
}
