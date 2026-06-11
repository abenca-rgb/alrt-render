import { getSymbolConfig, isAllowedTradingSymbol } from "../config/symbols.js";
import { scoreAlertQuality } from "./alertScoring.js";
import { getLossGuardBlock } from "./lossGuardService.js";
import {
  countOpenTradesForSide,
  countOpenTradesForSymbol,
  hasOpenTradeForSymbol,
} from "./tradeLookupService.js";
import { getUtcDateKey } from "../utils/date.js";
import { validateTradeSanity } from "../utils/tradeMath.js";

const HISTORICAL_DUPLICATE_COOLDOWN_MS = 90 * 60 * 1000;
const HISTORICAL_DUPLICATE_ENTRY_TOLERANCE_PCT = 0.25;

function findRecentSimilarSignal(stat, {
  symbol,
  side,
  entry,
  receivedAtMs,
}) {
  if (!stat?.byRef || !symbol || !side || !Number.isFinite(entry)) return null;

  for (const item of Object.values(stat.byRef)) {
    if (!item || item.symbol !== symbol || item.side !== side) continue;
    if (!Number.isFinite(item.entry) || !Number.isFinite(item.openedAtMs)) continue;

    const ageMs = receivedAtMs - item.openedAtMs;
    if (ageMs < 0 || ageMs > HISTORICAL_DUPLICATE_COOLDOWN_MS) continue;

    const entryDistancePct = Math.abs((entry - item.entry) / entry) * 100;
    if (entryDistancePct <= HISTORICAL_DUPLICATE_ENTRY_TOLERANCE_PCT) {
      return {
        refId: item.refId,
        openedAtUtc: item.openedAtUtc,
        entry: item.entry,
        entryDistancePct,
        cooldownMinutes: Math.round(HISTORICAL_DUPLICATE_COOLDOWN_MS / 60000),
      };
    }
  }

  return null;
}

export function evaluateSignalAcceptance({
  activeTrades,
  recentLossStops,
  getDailyStat,
  allowedSymbols,
  maxOpenTradesPerSymbol,
  maxOpenTradesPerSide,
  dailySlCircuitBreaker,
  minRrToSend,
  alertQualityFilterEnabled,
  candidateQualityFilterEnabled,
  historicalQualityAdjustmentsEnabled,
  duplicateSuppressionEnabled,
  lossGuardRetentionMs,
  lossGuardSymbolCooldownMs,
  lossGuardMarketWindowMs,
  lossGuardMarketCooldownMs,
  lossGuardMarketLimit,
  context,
  receivedAtMs,
}) {
  const {
    symbol,
    side,
    setupType,
    entryParsed,
    tpParsed,
    slParsed,
    rr,
    tpPct,
    strength,
    setupScore,
    trendStrength,
    volatilityState,
    marketRegime,
    session,
    rsi,
    atrPct,
    isCandidateEvent,
    eventTimeMs,
  } = context;

  if (!isAllowedTradingSymbol(symbol, allowedSymbols)) {
    return {
      accepted: false,
      reason: "symbol_filter",
      details: {
        symbol,
        allowedSymbols,
      },
    };
  }

  const symbolConfig = getSymbolConfig(symbol);

  const sanity = validateTradeSanity({
    symbol,
    side,
    entry: entryParsed,
    tp: tpParsed,
    sl: slParsed,
    rr,
  });

  if (!sanity.ok) {
    return {
      accepted: false,
      reason: sanity.reason || "sanity_filter",
      symbolConfig,
      sanity,
      details: {
        reason: sanity.reason,
        symbol,
        side,
        entry: entryParsed,
        tp: tpParsed,
        sl: slParsed,
        rr,
        tpPct: sanity.tpPct,
        slPct: sanity.slPct,
        minTpPct: sanity.minTpPct,
        minSlPct: sanity.minSlPct,
        maxTpPct: sanity.maxTpPct,
        maxSlPct: sanity.maxSlPct,
      },
    };
  }

  const openTradesForSymbol = countOpenTradesForSymbol(activeTrades, symbol);

  if (hasOpenTradeForSymbol(activeTrades, symbol, maxOpenTradesPerSymbol)) {
    return {
      accepted: false,
      reason: "open_trade_filter",
      symbolConfig,
      sanity,
      details: {
        symbol,
        openTradesForSymbol,
        maxOpenTradesPerSymbol,
      },
    };
  }

  const todayStat = getDailyStat(getUtcDateKey(receivedAtMs));
  const duplicateSignal = duplicateSuppressionEnabled
    ? findRecentSimilarSignal(todayStat, {
        symbol,
        side,
        entry: entryParsed,
        receivedAtMs,
      })
    : null;

  if (duplicateSignal) {
    return {
      accepted: false,
      reason: "duplicate_cooldown_filter",
      symbolConfig,
      sanity,
      details: {
        symbol,
        side,
        setupType,
        entry: entryParsed,
        previousRef: duplicateSignal.refId,
        previousOpenedAtUtc: duplicateSignal.openedAtUtc,
        previousEntry: duplicateSignal.entry,
        entryDistancePct: duplicateSignal.entryDistancePct,
        cooldownMinutes: duplicateSignal.cooldownMinutes,
      },
    };
  }

  const slToday = todayStat.sl || 0;

  if (dailySlCircuitBreaker > 0 && slToday >= dailySlCircuitBreaker) {
    return {
      accepted: false,
      reason: "daily_sl_circuit_breaker",
      symbolConfig,
      sanity,
      details: {
        symbol,
        side,
        setupType,
        slToday,
        dailySlCircuitBreaker,
      },
    };
  }

  const openTradesForSide = countOpenTradesForSide(activeTrades, side);

  if (openTradesForSide >= maxOpenTradesPerSide) {
    return {
      accepted: false,
      reason: "side_exposure_filter",
      symbolConfig,
      sanity,
      details: {
        symbol,
        side,
        openTradesForSide,
        maxOpenTradesPerSide,
      },
    };
  }

  const lossGuard = getLossGuardBlock(recentLossStops, {
    symbol,
    side,
    now: receivedAtMs,
    retentionMs: lossGuardRetentionMs,
    symbolCooldownMs: lossGuardSymbolCooldownMs,
    marketWindowMs: lossGuardMarketWindowMs,
    marketCooldownMs: lossGuardMarketCooldownMs,
    marketLimit: lossGuardMarketLimit,
  });

  if (lossGuard.blocked) {
    return {
      accepted: false,
      reason: lossGuard.reason,
      symbolConfig,
      sanity,
      lossGuard,
      details: {
        reason: lossGuard.reason,
        symbol,
        side,
        setupType,
        latestRef: lossGuard.latestRef,
        latestAtUtc: lossGuard.latestAtUtc,
        stopCount: lossGuard.stopCount,
        cooldownMinutes: lossGuard.cooldownMinutes,
      },
    };
  }

  const effectiveMinRr =
    Number.isFinite(minRrToSend) && minRrToSend > 0
      ? minRrToSend
      : symbolConfig.minRr;

  if (Number.isFinite(effectiveMinRr) && effectiveMinRr > 0 && (!Number.isFinite(rr) || rr < effectiveMinRr)) {
    return {
      accepted: false,
      reason: "min_rr_filter",
      symbolConfig,
      sanity,
      effectiveMinRr,
      details: {
        minRequired: effectiveMinRr,
        symbol,
        rr,
      },
    };
  }

  const quality = scoreAlertQuality({
    symbolConfig,
    symbol,
    side,
    setupType,
    rr,
    tpPct,
    slPct: sanity.slPct,
    strength,
    setupScore,
    trendStrength,
    volatilityState,
    marketRegime,
    session,
    rsi,
    atrPct,
    eventTimeMs,
    historicalQualityAdjustmentsEnabled,
  });

  const enforceQualityFilter =
    alertQualityFilterEnabled ||
    (candidateQualityFilterEnabled && isCandidateEvent);

  if (enforceQualityFilter && !quality.passed) {
    return {
      accepted: false,
      reason: "quality_filter",
      symbolConfig,
      sanity,
      quality,
      details: {
        symbol,
        side,
        isCandidateEvent,
        qualityScore: quality.score,
        qualityGrade: quality.grade,
        minScore: quality.minScore,
        minGrade: quality.minGrade,
        reasons: quality.reasons,
        penalties: quality.penalties,
      },
    };
  }

  return {
    accepted: true,
    symbolConfig,
    sanity,
    quality,
    effectiveMinRr,
  };
}
