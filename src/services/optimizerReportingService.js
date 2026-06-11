const WIN_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL", "TIME_EXIT_PROFIT"]);
const LOSS_OUTCOMES = new Set(["SL", "TIME_EXIT_LOSS"]);
const EXPIRED_OUTCOMES = new Set(["EXPIRED"]);

function parseDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfUtcDay(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function getPeriod(periodType, now = new Date()) {
  const type = String(periodType || "all").toLowerCase();
  if (type === "daily") {
    const start = startOfUtcDay(now);
    return { periodType: "daily", start, end: now };
  }
  if (type === "weekly") {
    const start = startOfUtcDay(now);
    start.setUTCDate(start.getUTCDate() - 6);
    return { periodType: "weekly", start, end: now };
  }
  if (type === "monthly") {
    const start = startOfUtcDay(now);
    start.setUTCDate(start.getUTCDate() - 29);
    return { periodType: "monthly", start, end: now };
  }
  return { periodType: "all", start: null, end: now };
}

function periodQuery({ start, end }, selectColumns) {
  const params = [
    `select=${selectColumns.join(",")}`,
  ];
  if (start) params.push(`evaluated_at_utc=gte.${encodeURIComponent(start.toISOString())}`);
  if (end) params.push(`evaluated_at_utc=lte.${encodeURIComponent(end.toISOString())}`);
  params.push("limit=10000");
  return `?${params.join("&")}`;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function outcomeValue(row) {
  const r = numberOrNull(row.r_multiple);
  if (r !== null) return r;
  const move = numberOrNull(row.move_pct);
  if (move !== null) return move;
  return null;
}

function getConfidence(closedOutcomes, expectancyDelta = 0) {
  if (closedOutcomes < 20) {
    return {
      confidenceLevel: "INSUFFICIENT_SAMPLE",
      confidenceScore: 0,
      recommendationStatus: "insufficient_sample",
    };
  }

  let confidenceLevel = "LOW";
  let confidenceScore = 25;

  if (closedOutcomes >= 500) {
    confidenceLevel = "VERY_HIGH";
    confidenceScore = 90;
  } else if (closedOutcomes >= 250) {
    confidenceLevel = "HIGH";
    confidenceScore = 75;
  } else if (closedOutcomes >= 100) {
    confidenceLevel = "MEDIUM";
    confidenceScore = 55;
  } else if (closedOutcomes >= 50) {
    confidenceLevel = "MEDIUM_LOW";
    confidenceScore = 40;
  }

  const impactBoost = Math.min(10, Math.round(Math.abs(Number(expectancyDelta || 0)) * 10));
  confidenceScore = Math.min(100, confidenceScore + impactBoost);

  return {
    confidenceLevel,
    confidenceScore,
    recommendationStatus: "watch",
  };
}

function dayDiff(start, end) {
  const first = parseDate(start);
  const last = parseDate(end);
  if (!first || !last) return 0;
  const ms = Math.max(0, last.getTime() - first.getTime());
  return Math.floor(ms / (24 * 60 * 60 * 1000)) + 1;
}

function stabilityScore({ netValue, expectancyDelta, closedOutcomes }) {
  if (!closedOutcomes) return 0;
  let score = 50;
  if (netValue > 0) score += 15;
  if (netValue < 0) score -= 20;
  if (expectancyDelta !== null && expectancyDelta >= 0) score += 15;
  if (expectancyDelta !== null && expectancyDelta < 0) score -= 25;
  if (closedOutcomes >= 100) score += 10;
  if (closedOutcomes >= 250) score += 10;
  return Math.max(0, Math.min(100, score));
}

function recommendationStatus({
  closedOutcomes,
  observationDays,
  netValue,
  expectancyDelta,
  confidenceLevel,
  stability,
}) {
  if (closedOutcomes < 20) return "insufficient_sample";

  const expectancyOk = expectancyDelta === null || expectancyDelta >= 0;
  const confidenceRank = {
    INSUFFICIENT_SAMPLE: 0,
    LOW: 1,
    MEDIUM_LOW: 2,
    MEDIUM: 3,
    HIGH: 4,
    VERY_HIGH: 5,
  };
  const confidence = confidenceRank[confidenceLevel] || 0;

  if (closedOutcomes >= 20 && netValue < 0 && expectancyDelta !== null && expectancyDelta < 0) {
    return "harmful";
  }
  if (closedOutcomes >= 50 && netValue <= 0 && expectancyDelta !== null && expectancyDelta < 0) {
    return "discard";
  }
  if (
    closedOutcomes >= 250 &&
    observationDays >= 60 &&
    netValue > 0 &&
    expectancyOk &&
    confidence >= confidenceRank.HIGH &&
    stability >= 70
  ) {
    return "ready_for_ab_test";
  }
  if (
    closedOutcomes >= 100 &&
    observationDays >= 30 &&
    netValue > 0 &&
    expectancyOk &&
    confidence >= confidenceRank.MEDIUM
  ) {
    return "candidate_for_test";
  }
  if (closedOutcomes >= 50 && netValue > 0 && expectancyOk) {
    return "promising";
  }
  return "watch";
}

function summarizeRows(rows, groupKey, subjectType) {
  const groups = new Map();

  for (const row of rows) {
    const key = row[groupKey];
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups.entries()].map(([name, items]) => {
    const evaluatedAlerts = items.length;
    const flaggedAlerts = items.filter((row) => row.would_reject).length;
    const passedAlerts = evaluatedAlerts - flaggedAlerts;
    const closedItems = items.filter((row) => row.outcome_type);
    const closedOutcomes = closedItems.length;
    const openTrades = evaluatedAlerts - closedOutcomes;

    const wins = closedItems.filter((row) => WIN_OUTCOMES.has(row.outcome_type)).length;
    const losses = closedItems.filter((row) => LOSS_OUTCOMES.has(row.outcome_type)).length;
    const tpCount = closedItems.filter((row) => ["TP", "TP1", "TP2", "TP_FULL"].includes(row.outcome_type)).length;
    const slCount = closedItems.filter((row) => row.outcome_type === "SL").length;
    const timeExitProfitCount = closedItems.filter((row) => row.outcome_type === "TIME_EXIT_PROFIT").length;
    const timeExitLossCount = closedItems.filter((row) => row.outcome_type === "TIME_EXIT_LOSS").length;
    const expiredCount = closedItems.filter((row) => EXPIRED_OUTCOMES.has(row.outcome_type)).length;

    const flaggedClosed = closedItems.filter((row) => row.would_reject);
    const winsMissed = flaggedClosed.filter((row) => WIN_OUTCOMES.has(row.outcome_type)).length;
    const lossesAvoided = flaggedClosed.filter((row) => LOSS_OUTCOMES.has(row.outcome_type)).length;
    const netValue = lossesAvoided - winsMissed;

    const baselineValues = closedItems.map(outcomeValue).filter((value) => value !== null);
    const keptValues = closedItems.filter((row) => !row.would_reject).map(outcomeValue).filter((value) => value !== null);

    const baselineExpectancy = baselineValues.length
      ? baselineValues.reduce((sum, value) => sum + value, 0) / baselineValues.length
      : null;
    const simulatedExpectancy = keptValues.length
      ? keptValues.reduce((sum, value) => sum + value, 0) / keptValues.length
      : null;
    const expectancyDelta =
      baselineExpectancy !== null && simulatedExpectancy !== null
        ? simulatedExpectancy - baselineExpectancy
        : null;

    const baselineWinrate = closedOutcomes ? (wins / closedOutcomes) * 100 : null;
    const simulatedClosed = closedOutcomes - flaggedClosed.length;
    const simulatedWins = wins - winsMissed;
    const simulatedWinrate = simulatedClosed > 0 ? (simulatedWins / simulatedClosed) * 100 : null;
    const winrateDelta =
      baselineWinrate !== null && simulatedWinrate !== null
        ? simulatedWinrate - baselineWinrate
        : null;

    const rValues = closedItems.map((row) => numberOrNull(row.r_multiple)).filter((value) => value !== null);
    const avgRMultiple = rValues.length ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : null;
    const observedTimes = items.map((row) => row.evaluated_at_utc).filter(Boolean).sort();
    const observationDays = observedTimes.length ? dayDiff(observedTimes[0], observedTimes[observedTimes.length - 1]) : 0;

    const confidence = getConfidence(closedOutcomes, expectancyDelta || 0);
    const stability = stabilityScore({ netValue, expectancyDelta, closedOutcomes });
    const status = recommendationStatus({
      closedOutcomes,
      observationDays,
      netValue,
      expectancyDelta,
      confidenceLevel: confidence.confidenceLevel,
      stability,
    });

    return {
      subjectType,
      subjectName: name,
      shadowVersion: items[0]?.shadow_version || "unknown",
      ruleNames: items[0]?.rule_names || [],
      evaluatedAlerts,
      flaggedAlerts,
      passedAlerts,
      closedOutcomes,
      openTrades,
      tpCount,
      slCount,
      timeExitProfitCount,
      timeExitLossCount,
      expiredCount,
      lossesAvoided,
      winsMissed,
      netValue,
      baselineWinrate,
      simulatedWinrate,
      winrateDelta,
      baselineExpectancy,
      simulatedExpectancy,
      expectancyDelta,
      avgRMultiple,
      observationDays,
      stabilityScore: stability,
      confidenceLevel: confidence.confidenceLevel,
      confidenceScore: confidence.confidenceScore,
      recommendationStatus: status,
    };
  });
}

function rankItems(items) {
  return [...items]
    .sort((a, b) => {
      if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
      if ((b.netValue || 0) !== (a.netValue || 0)) return (b.netValue || 0) - (a.netValue || 0);
      return (b.expectancyDelta || 0) - (a.expectancyDelta || 0);
    })
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function snapshotKey(prefix, item, period) {
  const startKey = period.start ? period.start.toISOString() : "all";
  return `${prefix}:${period.periodType}:${startKey}:${item.shadowVersion}:${item.subjectName}`;
}

function recommendationText(item) {
  if (item.confidenceLevel === "INSUFFICIENT_SAMPLE") {
    return "Niet beoordelen: te weinig gesloten outcomes.";
  }
  if (item.recommendationStatus === "ready_for_ab_test") {
    return "Klaar voor toekomstige A/B test, alleen na menselijke goedkeuring.";
  }
  if (item.recommendationStatus === "candidate_for_test") {
    return "Kandidaat voor toekomstige test, alleen na menselijke review.";
  }
  if (item.recommendationStatus === "promising") {
    return "Veelbelovend, maar eerst meer live outcomes verzamelen.";
  }
  if (item.recommendationStatus === "harmful") {
    return "Niet activeren; huidige evidence is schadelijk.";
  }
  if (item.recommendationStatus === "discard") {
    return "Niet activeren; huidige evidence is structureel zwak.";
  }
  return "Blijven monitoren.";
}

function publicRecommendation(item) {
  return {
    rank: item.rank,
    subjectType: item.subject_type,
    subjectName: item.subject_name,
    sampleSize: item.sample_size,
    confidenceLevel: item.confidence_level,
    status: item.status,
    estimatedImpact: item.estimated_impact,
    recommendation: item.recommendation,
  };
}

function compactSnapshot(item) {
  return {
    subjectType: item.subjectType,
    subjectName: item.subjectName,
    sampleSize: item.closedOutcomes,
    evaluatedAlerts: item.evaluatedAlerts,
    flaggedAlerts: item.flaggedAlerts,
    lossesAvoided: item.lossesAvoided,
    winsMissed: item.winsMissed,
    netValue: item.netValue,
    expectancyDelta: item.expectancyDelta,
    confidenceLevel: item.confidenceLevel,
    confidenceScore: item.confidenceScore,
    status: item.recommendationStatus,
    observationDays: item.observationDays,
    stabilityScore: item.stabilityScore,
  };
}

export function createOptimizerReportingService({ supabase }) {
  async function runReport({ periodType = "all", now = new Date(), detail = "compact" } = {}) {
    const period = getPeriod(periodType, now);
    const ruleQuery = periodQuery(period, [
      "candidate_key",
      "alert_id",
      "ref_id",
      "rule_name",
      "shadow_version",
      "would_reject",
      "outcome_type",
      "move_pct",
      "r_multiple",
      "evaluated_at_utc",
    ]);
    const comboQuery = periodQuery(period, [
      "candidate_key",
      "alert_id",
      "ref_id",
      "combo_name",
      "rule_names",
      "shadow_version",
      "would_reject",
      "outcome_type",
      "move_pct",
      "r_multiple",
      "evaluated_at_utc",
    ]);

    const [ruleRows, comboRows] = await Promise.all([
      supabase.selectRows("shadow_rule_results", ruleQuery),
      supabase.selectRows("shadow_combo_results", comboQuery),
    ]);

    const generatedAtUtc = new Date().toISOString();
    const rankedRules = rankItems(summarizeRows(ruleRows, "rule_name", "rule"));
    const rankedCombos = rankItems(summarizeRows(comboRows, "combo_name", "combo"));
    const allRanked = rankItems([...rankedRules, ...rankedCombos]);

    const ruleSnapshots = rankedRules.map((item) => ({
      snapshot_key: snapshotKey("rule", item, period),
      period_type: period.periodType,
      period_start_utc: period.start ? period.start.toISOString() : null,
      period_end_utc: period.end ? period.end.toISOString() : null,
      shadow_version: item.shadowVersion,
      rule_name: item.subjectName,
      evaluated_alerts: item.evaluatedAlerts,
      flagged_alerts: item.flaggedAlerts,
      passed_alerts: item.passedAlerts,
      closed_outcomes: item.closedOutcomes,
      open_trades: item.openTrades,
      tp_count: item.tpCount,
      sl_count: item.slCount,
      time_exit_profit_count: item.timeExitProfitCount,
      time_exit_loss_count: item.timeExitLossCount,
      expired_count: item.expiredCount,
      losses_avoided: item.lossesAvoided,
      wins_missed: item.winsMissed,
      net_value: item.netValue,
      baseline_winrate: item.baselineWinrate,
      simulated_winrate: item.simulatedWinrate,
      winrate_delta: item.winrateDelta,
      baseline_expectancy: item.baselineExpectancy,
      simulated_expectancy: item.simulatedExpectancy,
      expectancy_delta: item.expectancyDelta,
      avg_r_multiple: item.avgRMultiple,
      observation_days: item.observationDays,
      stability_score: item.stabilityScore,
      confidence_level: item.confidenceLevel,
      confidence_score: item.confidenceScore,
      recommendation_status: item.recommendationStatus,
      generated_at_utc: generatedAtUtc,
    }));

    const comboSnapshots = rankedCombos.map((item) => ({
      snapshot_key: snapshotKey("combo", item, period),
      period_type: period.periodType,
      period_start_utc: period.start ? period.start.toISOString() : null,
      period_end_utc: period.end ? period.end.toISOString() : null,
      shadow_version: item.shadowVersion,
      combo_name: item.subjectName,
      rule_names: item.ruleNames,
      evaluated_alerts: item.evaluatedAlerts,
      flagged_alerts: item.flaggedAlerts,
      passed_alerts: item.passedAlerts,
      closed_outcomes: item.closedOutcomes,
      open_trades: item.openTrades,
      tp_count: item.tpCount,
      sl_count: item.slCount,
      time_exit_profit_count: item.timeExitProfitCount,
      time_exit_loss_count: item.timeExitLossCount,
      expired_count: item.expiredCount,
      losses_avoided: item.lossesAvoided,
      wins_missed: item.winsMissed,
      net_value: item.netValue,
      baseline_winrate: item.baselineWinrate,
      simulated_winrate: item.simulatedWinrate,
      winrate_delta: item.winrateDelta,
      baseline_expectancy: item.baselineExpectancy,
      simulated_expectancy: item.simulatedExpectancy,
      expectancy_delta: item.expectancyDelta,
      avg_r_multiple: item.avgRMultiple,
      observation_days: item.observationDays,
      stability_score: item.stabilityScore,
      confidence_level: item.confidenceLevel,
      confidence_score: item.confidenceScore,
      recommendation_status: item.recommendationStatus,
      generated_at_utc: generatedAtUtc,
    }));

    const recommendations = allRanked.slice(0, 20).map((item) => ({
      recommendation_key: `rec:${period.periodType}:${period.start ? period.start.toISOString() : "all"}:${item.shadowVersion}:${item.subjectType}:${item.subjectName}`,
      period_type: period.periodType,
      period_start_utc: period.start ? period.start.toISOString() : null,
      period_end_utc: period.end ? period.end.toISOString() : null,
      shadow_version: item.shadowVersion,
      subject_type: item.subjectType,
      subject_name: item.subjectName,
      rank: item.rank,
      sample_size: item.closedOutcomes,
      confidence_level: item.confidenceLevel,
      confidence_score: item.confidenceScore,
      status: item.recommendationStatus,
      estimated_impact: item.netValue,
      evidence: {
        evaluatedAlerts: item.evaluatedAlerts,
        flaggedAlerts: item.flaggedAlerts,
        closedOutcomes: item.closedOutcomes,
        openTrades: item.openTrades,
        lossesAvoided: item.lossesAvoided,
        winsMissed: item.winsMissed,
        winrateDelta: item.winrateDelta,
        expectancyDelta: item.expectancyDelta,
        observationDays: item.observationDays,
        stabilityScore: item.stabilityScore,
      },
      recommendation: recommendationText(item),
      generated_at_utc: generatedAtUtc,
    }));
    const compactRecommendations = recommendations.map(publicRecommendation);
    const monitoringReport = {
      report_key: `phase4b:${period.periodType}:${period.start ? period.start.toISOString() : "all"}`,
      report_type: `phase4b_${period.periodType}`,
      period_type: period.periodType,
      period_start_utc: period.start ? period.start.toISOString() : null,
      period_end_utc: period.end ? period.end.toISOString() : null,
      generated_at_utc: generatedAtUtc,
      summary: {
        periodType: period.periodType,
        rulesEvaluated: rankedRules.length,
        combosEvaluated: rankedCombos.length,
        recommendationCount: recommendations.length,
        topRule: rankedRules[0]?.subjectName || null,
        topCombo: rankedCombos[0]?.subjectName || null,
        minClosedOutcomesForJudgement: 20,
        candidateForTestGate: {
          closedOutcomes: 100,
          observationDays: 30,
          netGain: "positive",
          expectancyImpact: "non_negative",
          confidence: "MEDIUM",
        },
        readyForAbTestGate: {
          closedOutcomes: 250,
          observationDays: 60,
          performance: "stable_positive",
          confidence: "HIGH",
        },
      },
      top_rules: rankedRules.slice(0, 10).map(compactSnapshot),
      top_combos: rankedCombos.slice(0, 10).map(compactSnapshot),
      fastest_improving: [],
      fastest_declining: [],
      highest_confidence: allRanked
        .slice()
        .sort((a, b) => b.confidenceScore - a.confidenceScore || b.closedOutcomes - a.closedOutcomes)
        .slice(0, 10)
        .map(compactSnapshot),
      largest_sample: allRanked
        .slice()
        .sort((a, b) => b.closedOutcomes - a.closedOutcomes || b.confidenceScore - a.confidenceScore)
        .slice(0, 10)
        .map(compactSnapshot),
    };

    await supabase.persistOptimizerReport({
      period,
      generatedAtUtc,
      ruleSnapshots,
      comboSnapshots,
      recommendations,
      monitoringReport,
      summary: {
        periodType: period.periodType,
        ruleCount: rankedRules.length,
        comboCount: rankedCombos.length,
        recommendationCount: recommendations.length,
        bestRule: rankedRules[0]?.subjectName || null,
        bestCombo: rankedCombos[0]?.subjectName || null,
      },
    });

    return {
      ok: true,
      periodType: period.periodType,
      periodStartUtc: period.start ? period.start.toISOString() : null,
      periodEndUtc: period.end ? period.end.toISOString() : null,
      generatedAtUtc,
      summary: {
        rulesEvaluated: rankedRules.length,
        combosEvaluated: rankedCombos.length,
        recommendations: recommendations.length,
        topRule: rankedRules[0]?.subjectName || null,
        topCombo: rankedCombos[0]?.subjectName || null,
        highestConfidence: allRanked[0]?.confidenceLevel || "INSUFFICIENT_SAMPLE",
      },
      recommendations: compactRecommendations,
      ...(detail === "full"
        ? {
            rules: rankedRules.slice(0, 20),
            combos: rankedCombos.slice(0, 20),
          }
        : {}),
    };
  }

  return {
    runReport,
  };
}
