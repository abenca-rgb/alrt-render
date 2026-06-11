import { isoFromMs } from "../utils/date.js";
import { sanitizePayloadForStorage } from "../utils/payload.js";

const SHADOW_VERSION = "shadow-v1-phase3";
const WIN_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL", "TIME_EXIT_PROFIT"]);
const LOSS_OUTCOMES = new Set(["SL", "TIME_EXIT_LOSS"]);

const WEAK_UTC_HOURS = new Set([14, 15, 18, 20, 21, 22, 3]);
const NY_UTC_HOURS = new Set([13, 14, 15, 16, 17, 18, 19, 20]);
const ENTRY_TOLERANCE_PCT = 0.25;

const COMBOS = [
  ["cluster_60m", "xrp_cooldown_60m"],
  ["cluster_60m", "xrp_cooldown_120m"],
  ["cluster_60m", "weak_hour_penalty"],
  ["cluster_60m", "new_york_session_penalty"],
  ["cluster_60m", "short_side_stricter_scoring"],
  ["cluster_60m", "btc_stricter_scoring"],
  ["cluster_60m", "new_york_session_penalty", "short_side_stricter_scoring"],
  ["cluster_60m", "weak_hour_penalty", "xrp_cooldown_60m"],
];

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function normalizeSide(side) {
  return String(side || "").trim().toUpperCase();
}

function eventHour(eventTimeMs, fallbackMs) {
  const ts = Number.isFinite(Number(eventTimeMs)) ? Number(eventTimeMs) : fallbackMs;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.getUTCHours();
}

function entryDistancePct(a, b) {
  const current = Number(a);
  const previous = Number(b);
  if (!Number.isFinite(current) || !Number.isFinite(previous) || current === 0) return null;
  return Math.abs((current - previous) / current) * 100;
}

function findRecentSimilarTrade(activeTrades, {
  symbol,
  side,
  entry,
  receivedAtMs,
  windowMinutes,
  excludeCandidateKey,
  excludeRefId,
  excludeAlertId,
}) {
  const windowMs = windowMinutes * 60 * 1000;

  for (const trade of activeTrades.values()) {
    if (!trade) continue;
    if (excludeCandidateKey && trade.candidateKey && String(trade.candidateKey) === String(excludeCandidateKey)) continue;
    if (excludeRefId && trade.refId && String(trade.refId) === String(excludeRefId)) continue;
    if (excludeAlertId && trade.primaryAlertId && String(trade.primaryAlertId) === String(excludeAlertId)) continue;
    if (normalizeSymbol(trade.symbol) !== symbol || normalizeSide(trade.side) !== side) continue;

    const openedAtMs = Number(trade.createdAtMs);
    if (!Number.isFinite(openedAtMs)) continue;

    const ageMs = receivedAtMs - openedAtMs;
    if (ageMs < 0 || ageMs > windowMs) continue;

    const distancePct = entryDistancePct(entry, trade.entry);
    if (distancePct === null || distancePct <= ENTRY_TOLERANCE_PCT) {
      return {
        refId: trade.refId || null,
        alertId: trade.primaryAlertId || null,
        candidateKey: trade.candidateKey || null,
        openedAtUtc: trade.createdAtUtc || isoFromMs(openedAtMs),
        entry: Number.isFinite(Number(trade.entry)) ? Number(trade.entry) : null,
        distancePct,
        ageMinutes: Math.round(ageMs / 60000),
      };
    }
  }

  return null;
}

function result(ruleName, status, scoreAdjustment, wouldReject, reason, details = {}) {
  return {
    ruleName,
    status,
    scoreAdjustment,
    wouldReject,
    reason,
    details,
  };
}

function evaluateRules({ activeTrades, context, delivery, receivedAtMs }) {
  const symbol = normalizeSymbol(context.symbol);
  const side = normalizeSide(context.side);
  const hour = eventHour(context.eventTimeMs, receivedAtMs);
  const similar60 = findRecentSimilarTrade(activeTrades, {
    symbol,
    side,
    entry: context.entryParsed,
    receivedAtMs,
    windowMinutes: 60,
    excludeCandidateKey: context.candidateKey,
    excludeRefId: delivery?.refId,
    excludeAlertId: delivery?.primaryAlertId,
  });
  const similar120 = findRecentSimilarTrade(activeTrades, {
    symbol,
    side,
    entry: context.entryParsed,
    receivedAtMs,
    windowMinutes: 120,
    excludeCandidateKey: context.candidateKey,
    excludeRefId: delivery?.refId,
    excludeAlertId: delivery?.primaryAlertId,
  });

  const rules = [
    similar60
      ? result("cluster_60m", "FAIL", -25, true, "similar_symbol_direction_entry_within_60m", similar60)
      : result("cluster_60m", "PASS", 0, false, null),
    symbol === "XRPUSDT" && similar60
      ? result("xrp_cooldown_60m", "FAIL", -20, true, "xrp_duplicate_within_60m", similar60)
      : result("xrp_cooldown_60m", symbol === "XRPUSDT" ? "PASS" : "NA", 0, false, null),
    symbol === "XRPUSDT" && similar120
      ? result("xrp_cooldown_120m", "FAIL", -25, true, "xrp_duplicate_within_120m", similar120)
      : result("xrp_cooldown_120m", symbol === "XRPUSDT" ? "PASS" : "NA", 0, false, null),
    WEAK_UTC_HOURS.has(hour)
      ? result("weak_hour_penalty", "WARNING", -10, false, "historically_weak_utc_hour", { utcHour: hour })
      : result("weak_hour_penalty", "PASS", 0, false, null, { utcHour: hour }),
    NY_UTC_HOURS.has(hour)
      ? result("new_york_session_penalty", "WARNING", -8, false, "historically_weak_new_york_window", { utcHour: hour })
      : result("new_york_session_penalty", "PASS", 0, false, null, { utcHour: hour }),
    symbol === "BTCUSDT"
      ? result("btc_stricter_scoring", "WARNING", -10, false, "btc_requires_stricter_confirmation", { symbol })
      : result("btc_stricter_scoring", "NA", 0, false, null, { symbol }),
    side === "SHORT"
      ? result("short_side_stricter_scoring", "WARNING", -8, false, "shorts_historically_underperformed", { side })
      : result("short_side_stricter_scoring", "PASS", 0, false, null, { side }),
  ];

  return rules;
}

function evaluateCombos(ruleResults) {
  const byName = new Map(ruleResults.map((rule) => [rule.ruleName, rule]));

  return COMBOS.map((ruleNames) => {
    const rules = ruleNames.map((name) => byName.get(name)).filter(Boolean);
    const wouldReject = rules.some((rule) => rule.wouldReject);
    const totalScoreAdjustment = rules.reduce((sum, rule) => sum + Number(rule.scoreAdjustment || 0), 0);
    const reasons = rules.map((rule) => rule.reason).filter(Boolean);
    const anyFail = rules.some((rule) => rule.status === "FAIL");
    const anyWarning = rules.some((rule) => rule.status === "WARNING");

    return {
      comboName: ruleNames.join("__"),
      ruleNames,
      status: anyFail ? "FAIL" : anyWarning ? "WARNING" : "PASS",
      totalScoreAdjustment,
      wouldReject,
      reasons,
      details: Object.fromEntries(rules.map((rule) => [rule.ruleName, rule.details || {}])),
    };
  });
}

function outcomeEffect(outcomeType, wouldReject) {
  if (!wouldReject || !outcomeType) {
    return {
      rejectionWouldHelp: null,
      rejectionWouldHurt: null,
    };
  }

  return {
    rejectionWouldHelp: LOSS_OUTCOMES.has(outcomeType),
    rejectionWouldHurt: WIN_OUTCOMES.has(outcomeType),
  };
}

export function createShadowValidationService({
  enabled,
  activeTrades,
  persistShadowEvaluationToSupabase,
  updateShadowOutcomeInSupabase,
}) {
  function evaluateAcceptedSignal({
    body,
    context,
    delivery,
    receivedAtMs,
    liveDecision = "ACCEPTED",
  }) {
    if (!enabled || !context?.candidateKey || !delivery?.primaryAlertId) return null;

    try {
      const ruleResults = evaluateRules({ activeTrades, context, delivery, receivedAtMs });
      const comboResults = evaluateCombos(ruleResults);
      const evaluation = {
        candidateKey: context.candidateKey,
        alertId: delivery.primaryAlertId,
        refId: delivery.refId,
        symbol: context.symbol,
        side: context.side,
        timeframe: context.timeframe,
        setupType: context.setupType,
        liveDecision,
        shadowVersion: SHADOW_VERSION,
        eventTimeMs: context.eventTimeMs || receivedAtMs,
        rawContext: sanitizePayloadForStorage({
          eventType: context.eventType,
          entry: context.entryParsed,
          tp: context.tpParsed,
          sl: context.slParsed,
          rr: context.rr,
          setupScore: context.setupScore,
          session: context.session,
          marketRegime: context.marketRegime,
          pineVersion: context.pineVersion,
          payload: body,
        }),
        ruleResults,
        comboResults,
      };

      persistShadowEvaluationToSupabase(evaluation);
      console.log("SHADOW EVALUATION REQUESTED:", {
        candidateKey: evaluation.candidateKey,
        refId: evaluation.refId,
        symbol: evaluation.symbol,
        side: evaluation.side,
        fails: ruleResults.filter((rule) => rule.status === "FAIL").map((rule) => rule.ruleName),
        warnings: ruleResults.filter((rule) => rule.status === "WARNING").map((rule) => rule.ruleName),
      });

      return evaluation;
    } catch (err) {
      console.warn("SHADOW EVALUATION WARNING:", err?.message || String(err));
      return null;
    }
  }

  function updateOutcome({ trade, outcomeType, outcomeTimeMs, movePct, rMultiple }) {
    if (!enabled || !trade?.candidateKey) return;

    try {
      updateShadowOutcomeInSupabase({
        candidateKey: trade.candidateKey,
        alertId: trade.primaryAlertId || trade.alertIds?.[0] || null,
        refId: trade.refId || null,
        outcomeType,
        outcomeTimeMs,
        movePct,
        rMultiple,
        outcomeEffect,
      });
      console.log("SHADOW OUTCOME UPDATE REQUESTED:", {
        candidateKey: trade.candidateKey,
        refId: trade.refId,
        outcomeType,
      });
    } catch (err) {
      console.warn("SHADOW OUTCOME WARNING:", err?.message || String(err));
    }
  }

  return {
    evaluateAcceptedSignal,
    updateOutcome,
  };
}
