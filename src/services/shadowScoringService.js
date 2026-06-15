export const SHADOW_SCORING_VERSION = "shadow-score-v1";

const NEGATIVE_SETUPS = new Set(["HTF_CONTINUATION"]);
const NEGATIVE_SESSIONS = new Set(["NEW_YORK", "LONDON_NY_OVERLAP"]);
const NEGATIVE_REGIMES = new Set(["EXPANSION"]);
const NEGATIVE_SYMBOLS = new Set(["BTCUSDT", "SOLUSDT"]);
const NEGATIVE_RSI_BUCKETS = new Set(["55-64", "35-44"]);

const POSITIVE_SETUPS = new Set(["COMPRESSION_BREAKOUT", "TREND_PULLBACK"]);
const POSITIVE_SESSIONS = new Set(["LONDON"]);
const POSITIVE_REGIMES = new Set(["COMPRESSION"]);
const POSITIVE_RSI_BUCKETS = new Set(["45-54"]);
const POSITIVE_TREND_BUCKETS = new Set(["14-21"]);

const WIN_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL", "TIME_EXIT_PROFIT"]);
const LOSS_OUTCOMES = new Set(["SL", "TIME_EXIT_LOSS"]);
const CLOSED_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL", "SL", "TIME_EXIT_PROFIT", "TIME_EXIT_LOSS", "EXPIRED", "MANUAL_CLOSE"]);

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, decimals = 2) {
  const number = numberOrNull(value);
  if (number === null) return null;
  const factor = 10 ** decimals;
  return Math.round(number * factor) / factor;
}

function clampScore(value) {
  const number = numberOrNull(value);
  if (number === null) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeText(value, fallback = "UNKNOWN") {
  const text = String(value || "").trim().toUpperCase();
  return text || fallback;
}

function normalizeGrade(value) {
  const text = String(value || "").trim().toUpperCase();
  if (text === "A+" || text === "A" || text === "B+" || text === "B" || text === "C") return text;
  return "UNKNOWN";
}

function bucketRsi(value) {
  const rsi = numberOrNull(value);
  if (rsi === null) return "unknown";
  if (rsi < 35) return "<35";
  if (rsi < 45) return "35-44";
  if (rsi < 55) return "45-54";
  if (rsi < 65) return "55-64";
  return "65+";
}

function bucketTrend(value) {
  const trend = numberOrNull(value);
  if (trend === null) return "unknown";
  if (trend < 14) return "<14";
  if (trend < 22) return "14-21";
  return "22+";
}

function proposedGradeFromScore(score, {
  setupNegative,
  sessionNegative,
  symbolNegative,
  majorPenaltyActive,
} = {}) {
  const numericScore = numberOrNull(score);
  if (numericScore === null) return "UNKNOWN";

  if (
    numericScore >= 92 &&
    !setupNegative &&
    !sessionNegative &&
    !symbolNegative &&
    !majorPenaltyActive
  ) {
    return "A+";
  }
  if (numericScore >= 84) return "A";
  if (numericScore >= 75) return "B+";
  return "B";
}

function addPenalty({ amount, reason, penalties }) {
  penalties.push({ amount: -Math.abs(amount), reason });
  return -Math.abs(amount);
}

function addBonus({ amount, reason, bonuses }) {
  bonuses.push({ amount: Math.abs(amount), reason });
  return Math.abs(amount);
}

function estimatedR({ outcomeType, rMultiple, rr }) {
  const actual = numberOrNull(rMultiple);
  if (actual !== null) return actual;
  if (WIN_OUTCOMES.has(outcomeType)) return numberOrNull(rr) ?? 1;
  if (LOSS_OUTCOMES.has(outcomeType)) return -1;
  return null;
}

function pct(part, total) {
  return total ? round((part / total) * 100, 2) : null;
}

function average(values) {
  const clean = values.map(numberOrNull).filter((value) => value !== null);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function leverageReturns(movePct) {
  const move = numberOrNull(movePct);
  return {
    marketMovePct: move === null ? null : round(move, 4),
    return2x: move === null ? null : round(move * 2, 4),
    return3x: move === null ? null : round(move * 3, 4),
    return4x: move === null ? null : round(move * 4, 4),
    return5x: move === null ? null : round(move * 5, 4),
    return6x: move === null ? null : round(move * 6, 4),
  };
}

export function buildScoreComponents({ context = {}, quality = null } = {}) {
  const setup = normalizeText(context.setupType);
  const session = normalizeText(context.session);
  const symbol = normalizeText(context.symbol);
  const regime = normalizeText(context.marketRegime || context.volatilityState);
  const rsiBucket = bucketRsi(context.rsi);
  const trendStrengthBucket = bucketTrend(context.trendStrength);

  return {
    setup,
    session,
    symbol,
    regime,
    rr: numberOrNull(context.rr),
    trend_strength: numberOrNull(context.trendStrength),
    trend_strength_bucket: trendStrengthBucket,
    rsi: numberOrNull(context.rsi),
    rsi_bucket: rsiBucket,
    atr_pct: numberOrNull(context.atrPct),
    direction: normalizeText(context.side),
    pine_strength: normalizeGrade(context.strength),
    setup_score: numberOrNull(context.setupScore),
    current_score: quality?.score ?? null,
    current_grade: normalizeGrade(quality?.grade),
  };
}

export function evaluateShadowScore({ context = {}, quality = null } = {}) {
  const components = buildScoreComponents({ context, quality });
  const currentScore = clampScore(quality?.score);
  const currentGrade = normalizeGrade(quality?.grade);
  const penalties = [];
  const bonuses = [];
  let proposedScore = currentScore;

  if (proposedScore === null) {
    return {
      shadowVersion: SHADOW_SCORING_VERSION,
      currentScore,
      currentGrade,
      proposedScore: null,
      proposedGrade: "UNKNOWN",
      scoreDelta: null,
      scoreComponents: components,
      penaltyReasons: penalties,
      bonusReasons: bonuses,
      majorPenaltyActive: false,
      recommendedAction: "insufficient_current_score",
    };
  }

  const setupNegative = NEGATIVE_SETUPS.has(components.setup);
  const sessionNegative = NEGATIVE_SESSIONS.has(components.session);
  const symbolNegative = NEGATIVE_SYMBOLS.has(components.symbol);
  const majorPenaltyActive =
    setupNegative ||
    sessionNegative ||
    symbolNegative ||
    NEGATIVE_REGIMES.has(components.regime);

  if (setupNegative) proposedScore += addPenalty({ amount: 14, reason: "historically_weak_setup:HTF_CONTINUATION", penalties });
  if (sessionNegative) proposedScore += addPenalty({ amount: 12, reason: `historically_weak_session:${components.session}`, penalties });
  if (NEGATIVE_REGIMES.has(components.regime)) proposedScore += addPenalty({ amount: 10, reason: "historically_weak_regime:EXPANSION", penalties });
  if (symbolNegative) proposedScore += addPenalty({ amount: 10, reason: `historically_weak_symbol:${components.symbol}`, penalties });
  if (NEGATIVE_RSI_BUCKETS.has(components.rsi_bucket)) proposedScore += addPenalty({ amount: 6, reason: `historically_weak_rsi_bucket:${components.rsi_bucket}`, penalties });

  if (POSITIVE_REGIMES.has(components.regime)) proposedScore += addBonus({ amount: 7, reason: "historically_strong_regime:COMPRESSION", bonuses });
  if (POSITIVE_SESSIONS.has(components.session)) proposedScore += addBonus({ amount: 6, reason: "historically_strong_session:LONDON", bonuses });
  if (POSITIVE_SETUPS.has(components.setup)) proposedScore += addBonus({ amount: 5, reason: `historically_supported_setup:${components.setup}`, bonuses });
  if (POSITIVE_RSI_BUCKETS.has(components.rsi_bucket)) proposedScore += addBonus({ amount: 5, reason: "historically_supported_rsi_bucket:45-54", bonuses });
  if (POSITIVE_TREND_BUCKETS.has(components.trend_strength_bucket)) proposedScore += addBonus({ amount: 4, reason: "historically_supported_trend_strength:14-21", bonuses });

  if ((components.rr ?? 0) >= 2.5 && majorPenaltyActive) {
    proposedScore += addPenalty({
      amount: 4,
      reason: "rr_weight_reduced_when_major_penalty_active",
      penalties,
    });
  }

  if ((components.trend_strength ?? 0) >= 22 && majorPenaltyActive) {
    proposedScore += addPenalty({
      amount: 4,
      reason: "trend_strength_weight_reduced_when_major_penalty_active",
      penalties,
    });
  }

  proposedScore = clampScore(proposedScore);
  const proposedGrade = proposedGradeFromScore(proposedScore, {
    setupNegative,
    sessionNegative,
    symbolNegative,
    majorPenaltyActive,
  });

  let recommendedAction = "keep_watch";
  if (currentGrade === "A+" && proposedGrade !== "A+") recommendedAction = "demote_false_a_plus_risk";
  if (proposedScore !== null && currentScore !== null && proposedScore <= currentScore - 15) recommendedAction = "shadow_penalty_review";
  if (proposedGrade === "A+" && currentGrade !== "A+") recommendedAction = "shadow_upgrade_candidate";

  return {
    shadowVersion: SHADOW_SCORING_VERSION,
    currentScore,
    currentGrade,
    proposedScore,
    proposedGrade,
    scoreDelta: proposedScore === null || currentScore === null ? null : proposedScore - currentScore,
    scoreComponents: components,
    penaltyReasons: penalties,
    bonusReasons: bonuses,
    majorPenaltyActive,
    recommendedAction,
  };
}

function summarize(rows, name, predicate = () => true) {
  const items = rows.filter(predicate);
  const closed = items.filter((row) => CLOSED_OUTCOMES.has(row.outcome_type));
  const wins = closed.filter((row) => WIN_OUTCOMES.has(row.outcome_type));
  const losses = closed.filter((row) => LOSS_OUTCOMES.has(row.outcome_type));

  return {
    name,
    alerts: items.length,
    closed: closed.length,
    tp: closed.filter((row) => ["TP", "TP1", "TP2", "TP_FULL"].includes(row.outcome_type)).length,
    sl: closed.filter((row) => row.outcome_type === "SL").length,
    winrate_pct: pct(wins.length, closed.length),
    expectancy_r: round(average(closed.map((row) => estimatedR({
      outcomeType: row.outcome_type,
      rMultiple: row.r_multiple,
      rr: row.score_components?.rr,
    }))), 3),
    average_move_pct: round(average(closed.map((row) => row.market_move_pct)), 3),
    average_r: round(average(closed.map((row) => row.r_multiple)), 3),
    losses: losses.length,
  };
}

function recommendedLeverageForGrade(grade, winrate, expectancy) {
  if (grade === "A+" && winrate >= 45 && expectancy >= 0.4) return "6x_shadow_only";
  if (grade === "A+" && winrate >= 40 && expectancy >= 0.25) return "5x_shadow_only";
  if (grade === "A" && winrate >= 38 && expectancy >= 0.15) return "4x_shadow_only";
  if (grade === "B+" && winrate >= 35 && expectancy >= 0) return "3x_shadow_only";
  return "2x_or_avoid_shadow_only";
}

export function buildShadowWeeklyReport({ rows = [], now = new Date() } = {}) {
  const current = summarize(rows, "current_model");
  const shadowKept = summarize(rows, "shadow_model_kept_A_or_better", (row) => ["A+", "A"].includes(row.proposed_grade));
  const shadowAPlus = summarize(rows, "shadow_A_plus_only", (row) => row.proposed_grade === "A+");
  const falseAPlus = rows
    .filter((row) => row.current_grade === "A+" && row.outcome_type === "SL")
    .slice(0, 50);

  const gradeGroups = ["A+", "A", "B+", "B"].map((grade) => {
    const summary = summarize(rows, `shadow_${grade}`, (row) => row.proposed_grade === grade);
    return {
      grade,
      ...summary,
      recommended_leverage: recommendedLeverageForGrade(grade, summary.winrate_pct || 0, summary.expectancy_r || 0),
    };
  });

  return {
    generated_at_utc: now.toISOString(),
    shadow_version: SHADOW_SCORING_VERSION,
    current_model: current,
    shadow_model: shadowKept,
    shadow_a_plus: shadowAPlus,
    improvement: {
      winrate_delta_pct:
        current.winrate_pct === null || shadowKept.winrate_pct === null
          ? null
          : round(shadowKept.winrate_pct - current.winrate_pct, 2),
      expectancy_delta_r:
        current.expectancy_r === null || shadowKept.expectancy_r === null
          ? null
          : round(shadowKept.expectancy_r - current.expectancy_r, 3),
      volume_delta_pct: pct(shadowKept.alerts - current.alerts, current.alerts),
      target_winrate_pct: 40,
      target_expectancy_r: 0.4,
      go_live_allowed:
        current.closed >= 100 &&
        (shadowKept.winrate_pct || 0) > (current.winrate_pct || 0) &&
        (shadowKept.expectancy_r || 0) > (current.expectancy_r || 0),
      manual_approval_required: true,
    },
    leverage_shadow_analysis: gradeGroups,
    false_a_plus_alerts: falseAPlus.map((row) => ({
      ref_id: row.ref_id,
      symbol: row.symbol,
      direction: row.direction,
      setup_type: row.setup_type,
      current_score: row.current_score,
      current_grade: row.current_grade,
      proposed_score: row.proposed_score,
      proposed_grade: row.proposed_grade,
      score_delta: row.score_delta,
      penalty_reasons: row.penalty_reasons,
      outcome_type: row.outcome_type,
      market_move_pct: row.market_move_pct,
    })),
    best_performing_buckets: gradeGroups
      .slice()
      .sort((a, b) => (b.expectancy_r || -999) - (a.expectancy_r || -999)),
    worst_performing_buckets: gradeGroups
      .slice()
      .sort((a, b) => (a.expectancy_r || 999) - (b.expectancy_r || 999)),
    recommended_actions: [
      "Keep shadow-only until 100+ closed outcomes.",
      "Review every A+ that shadow model demotes.",
      "Do not publish leverage recommendations; use internal analysis only.",
      "Promote only if winrate and expectancy improve with positive sample growth.",
    ],
  };
}

export function createShadowScoringService({
  enabled = true,
  persistShadowScoreEvaluation,
  updateShadowScoreOutcome,
}) {
  function evaluateCandidate({ context, quality }) {
    if (!enabled || !context?.candidateKey) return null;

    return {
      candidateKey: context.candidateKey,
      alertId: context.candidateIdsBase?.[0] || context.incomingRef || context.candidateKey,
      refId: context.incomingRef || null,
      symbol: context.symbol || null,
      side: context.side || null,
      timeframe: context.timeframe || null,
      setupType: context.setupType || null,
      eventTimeMs: context.eventTimeMs || Date.now(),
      ...evaluateShadowScore({ context, quality }),
    };
  }

  function recordCandidate({ context, quality, liveDecision, decisionReason, delivery = null }) {
    const evaluation = evaluateCandidate({ context, quality });
    if (!evaluation) return null;

    persistShadowScoreEvaluation?.({
      ...evaluation,
      alertId: delivery?.primaryAlertId || evaluation.alertId,
      refId: delivery?.refId || evaluation.refId,
      liveDecision,
      decisionReason,
      postedToPaid: Boolean(delivery?.primaryAlertId),
      postedToFree: Boolean(delivery?.sharedToFree),
    });

    return evaluation;
  }

  function updateOutcome({ trade, outcomeType, outcomeTimeMs, movePct, rMultiple }) {
    if (!enabled || !trade?.candidateKey) return;

    const returns = leverageReturns(movePct);
    updateShadowScoreOutcome?.({
      candidateKey: trade.candidateKey,
      alertId: trade.primaryAlertId || trade.alertIds?.[0] || null,
      refId: trade.refId || null,
      outcomeType,
      outcomeTimeMs,
      marketMovePct: returns.marketMovePct,
      return2x: returns.return2x,
      return3x: returns.return3x,
      return4x: returns.return4x,
      return5x: returns.return5x,
      return6x: returns.return6x,
      rMultiple,
    });
  }

  return {
    evaluateCandidate,
    recordCandidate,
    updateOutcome,
  };
}
