import { isoFromMs } from "../utils/date.js";
import { parseNum } from "../utils/numbers.js";
import { sanitizePayloadForStorage } from "../utils/payload.js";

export function createCandidateLoggingService({
  enabled,
  persistCandidateToSupabase,
  updateCandidateDecisionInSupabase,
}) {
  function buildCandidateRecord({
    body,
    context,
    receivedAtMs,
    renderVersion,
  }) {
    if (!context?.candidateKey) return null;

    return {
      candidateKey: context.candidateKey,
      alertId: context.candidateIdsBase?.[0] || context.incomingRef || context.candidateKey,
      refId: context.incomingRef || null,
      symbol: context.symbol || null,
      side: context.side || null,
      timeframe: context.timeframe || null,
      entry: context.entryParsed,
      tp1: context.tpParsed,
      tp2: context.tp2Parsed,
      tp3: context.tp3Parsed,
      sl: context.slParsed,
      rr: context.rr,
      rsi: parseNum(context.rsi),
      trendStrength: parseNum(context.trendStrength),
      atrPct: parseNum(context.atrPct),
      volatilityPct: parseNum(context.volatilityPct),
      session: context.session || null,
      marketRegime: context.marketRegime || context.volatilityState || null,
      setupType: context.setupType || null,
      setupScore: parseNum(context.setupScore),
      strength: context.strength || null,
      pineVersion: context.pineVersion || null,
      renderVersion,
      eventType: context.eventType || null,
      eventTimeMs: context.eventTimeMs || receivedAtMs,
      rawPayload: sanitizePayloadForStorage(body),
    };
  }

  function logCandidate(input) {
    if (!enabled) return null;

    const record = buildCandidateRecord(input);
    if (!record) return null;

    try {
      persistCandidateToSupabase(record);
      console.log("CANDIDATE LOG REQUESTED:", {
        candidateKey: record.candidateKey,
        symbol: record.symbol,
        side: record.side,
        eventType: record.eventType,
        eventTimeUtc: isoFromMs(record.eventTimeMs),
      });
    } catch (err) {
      console.warn("CANDIDATE LOG WARNING:", err?.message || String(err));
    }

    return record;
  }

  function updateDecision({
    candidateKey,
    decision,
    reason = null,
    quality = null,
    refId = null,
    alertId = null,
    postedToPaid = false,
    postedToFree = false,
  }) {
    if (!enabled || !candidateKey) return;

    try {
      updateCandidateDecisionInSupabase({
        candidateKey,
        decision,
        reason,
        qualityScore: quality?.score ?? null,
        qualityGrade: quality?.grade ?? null,
        refId,
        alertId,
        postedToPaid,
        postedToFree,
      });
      console.log("CANDIDATE DECISION UPDATE REQUESTED:", {
        candidateKey,
        decision,
        reason,
        refId,
        alertId,
        postedToPaid,
        postedToFree,
      });
    } catch (err) {
      console.warn("CANDIDATE DECISION WARNING:", err?.message || String(err));
    }
  }

  return {
    buildCandidateRecord,
    logCandidate,
    updateDecision,
  };
}
