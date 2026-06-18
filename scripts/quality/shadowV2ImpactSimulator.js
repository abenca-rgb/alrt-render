import {
  SHADOW_SCORING_VERSION,
  SHADOW_SCORING_V2_VERSION,
  evaluateShadowScoreV2,
} from "../../src/services/shadowScoringService.js";

const SUPABASE_ENABLED = String(process.env.SUPABASE_ENABLED || "false").toLowerCase() === "true";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const WIN_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL", "TIME_EXIT_PROFIT"]);
const LOSS_OUTCOMES = new Set(["SL", "TIME_EXIT_LOSS"]);
const CLOSED_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL", "SL", "TIME_EXIT_PROFIT", "TIME_EXIT_LOSS", "EXPIRED", "MANUAL_CLOSE"]);

const PENALTY_TESTS = [
  { key: "HTF_CONTINUATION", field: "setup", label: "HTF_CONTINUATION penalty" },
  { key: "SOLUSDT", field: "symbol", label: "SOLUSDT penalty" },
  { key: "BTCUSDT", field: "symbol", label: "BTCUSDT penalty" },
  { key: "NEW_YORK", field: "session", label: "NEW_YORK penalty" },
  { key: "LONDON_NY_OVERLAP", field: "session", label: "LONDON_NY_OVERLAP penalty" },
  { key: "EXPANSION", field: "regime", label: "EXPANSION penalty" },
];

const BONUS_TESTS = [
  { key: "COMPRESSION", field: "regime", label: "COMPRESSION bonus" },
  { key: "LONDON", field: "session", label: "LONDON bonus" },
  { key: "COMPRESSION_BREAKOUT", field: "setup", label: "COMPRESSION_BREAKOUT bonus" },
  { key: "TREND_PULLBACK", field: "setup", label: "TREND_PULLBACK bonus" },
  { key: "45-54", field: "rsi_bucket", label: "RSI 45-54 bonus" },
];

const A_PLUS_THRESHOLDS = [92, 94, 96, 98];
const SHADOW_V21_VERSION = "shadow_v2_1_simulation";

const V21_VARIANTS = [
  {
    key: "A",
    label: "RSI A+ blockers",
    rules: {
      rsiBlocksAPlus: true,
    },
  },
  {
    key: "B",
    label: "RSI blockers + TREND_PULLBACK support requirement",
    rules: {
      rsiBlocksAPlus: true,
      trendPullbackRequiresAdditionalSupport: true,
    },
  },
  {
    key: "C",
    label: "Variant B + NEUTRAL/TREND A+ blockers",
    rules: {
      rsiBlocksAPlus: true,
      trendPullbackRequiresAdditionalSupport: true,
      neutralOrTrendRequiresStrongSupport: true,
    },
  },
  {
    key: "D",
    label: "Variant C + LIQUIDITY_RECLAIM support requirement",
    rules: {
      rsiBlocksAPlus: true,
      trendPullbackRequiresAdditionalSupport: true,
      neutralOrTrendRequiresStrongSupport: true,
      liquidityReclaimRequiresLondonOrCompression: true,
    },
  },
  {
    key: "E",
    label: "Variant D + BNBUSDT false A+ test",
    rules: {
      rsiBlocksAPlus: true,
      trendPullbackRequiresAdditionalSupport: true,
      neutralOrTrendRequiresStrongSupport: true,
      liquidityReclaimRequiresLondonOrCompression: true,
      bnbusdtBlocksAPlus: true,
    },
  },
];

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = numberOrNull(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function normalize(value, fallback = "UNKNOWN") {
  const text = String(value || "").trim().toUpperCase();
  return text || fallback;
}

function ready() {
  return Boolean(SUPABASE_ENABLED && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

async function selectRows(table, query) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Supabase ${table} SELECT failed ${response.status}: ${text}`);
  }

  return response.json();
}

function estimatedR(row) {
  const actual = numberOrNull(row.r_multiple);
  if (actual !== null) return actual;
  if (WIN_OUTCOMES.has(row.outcome_type)) return numberOrNull(row.score_components?.rr) ?? 1;
  if (LOSS_OUTCOMES.has(row.outcome_type)) return -1;
  return null;
}

function average(values) {
  const clean = values.map(numberOrNull).filter((value) => value !== null);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function summarize(rows) {
  const closed = rows.filter((row) => CLOSED_OUTCOMES.has(row.outcome_type));
  const wins = closed.filter((row) => WIN_OUTCOMES.has(row.outcome_type));
  const losses = closed.filter((row) => LOSS_OUTCOMES.has(row.outcome_type));
  const tp = closed.filter((row) => ["TP", "TP1", "TP2", "TP_FULL"].includes(row.outcome_type));
  const sl = closed.filter((row) => row.outcome_type === "SL");

  return {
    alerts: rows.length,
    closed: closed.length,
    tp: tp.length,
    sl: sl.length,
    wins: wins.length,
    losses: losses.length,
    winrate_pct: closed.length ? round((wins.length / closed.length) * 100, 2) : null,
    sl_rate_pct: closed.length ? round((losses.length / closed.length) * 100, 2) : null,
    expectancy_r: round(average(closed.map(estimatedR)), 3),
    average_market_move_pct: round(average(closed.map((row) => row.market_move_pct)), 4),
  };
}

function deltaSummary(candidate, baseline) {
  return {
    winrate_delta_pct:
      candidate.winrate_pct === null || baseline.winrate_pct === null
        ? null
        : round(candidate.winrate_pct - baseline.winrate_pct, 2),
    expectancy_delta_r:
      candidate.expectancy_r === null || baseline.expectancy_r === null
        ? null
        : round(candidate.expectancy_r - baseline.expectancy_r, 3),
    market_move_delta_pct:
      candidate.average_market_move_pct === null || baseline.average_market_move_pct === null
        ? null
        : round(candidate.average_market_move_pct - baseline.average_market_move_pct, 4),
    volume_delta: candidate.closed - baseline.closed,
    volume_delta_pct: baseline.closed ? round(((candidate.closed - baseline.closed) / baseline.closed) * 100, 2) : null,
  };
}

function componentValue(row, field) {
  const c = row.score_components || {};
  if (field === "setup") return normalize(row.setup_type || c.setup);
  if (field === "symbol") return normalize(row.symbol || c.symbol);
  if (field === "session") return normalize(c.session || row.session_name);
  if (field === "regime") return normalize(c.regime || row.market_regime);
  if (field === "rsi_bucket") return normalize(c.rsi_bucket);
  return normalize(c[field] || row[field]);
}

function matches(row, test) {
  return componentValue(row, test.field) === test.key;
}

function penaltyImpact(rows, baseline, test) {
  const removed = rows.filter((row) => matches(row, test));
  const kept = rows.filter((row) => !matches(row, test));
  const removedSummary = summarize(removed);
  const keptSummary = summarize(kept);

  return {
    key: test.key,
    label: test.label,
    sample: removedSummary.closed,
    alerts_removed: removedSummary.closed,
    tp_lost: removedSummary.tp,
    sl_avoided: removedSummary.sl,
    removed_winrate_pct: removedSummary.winrate_pct,
    removed_expectancy_r: removedSummary.expectancy_r,
    remaining: keptSummary,
    ...deltaSummary(keptSummary, baseline),
    impact_score: round(
      (removedSummary.sl * 1.0) -
      (removedSummary.tp * 0.85) +
      ((keptSummary.expectancy_r ?? 0) - (baseline.expectancy_r ?? 0)) * 20,
      3,
    ),
  };
}

function bonusImpact(rows, baseline, test) {
  const bucket = rows.filter((row) => matches(row, test));
  const summary = summarize(bucket);
  const expectedWins = summary.closed && baseline.winrate_pct !== null
    ? summary.closed * (baseline.winrate_pct / 100)
    : null;
  const expectedLosses = summary.closed && baseline.sl_rate_pct !== null
    ? summary.closed * (baseline.sl_rate_pct / 100)
    : null;

  return {
    key: test.key,
    label: test.label,
    sample: summary.closed,
    bucket: summary,
    tp_gained_vs_baseline: expectedWins === null ? null : round(summary.wins - expectedWins, 2),
    sl_reduced_vs_baseline: expectedLosses === null ? null : round(expectedLosses - summary.losses, 2),
    expectancy_change_vs_baseline:
      summary.expectancy_r === null || baseline.expectancy_r === null
        ? null
        : round(summary.expectancy_r - baseline.expectancy_r, 3),
    winrate_delta_pct:
      summary.winrate_pct === null || baseline.winrate_pct === null
        ? null
        : round(summary.winrate_pct - baseline.winrate_pct, 2),
    impact_score: round(
      ((summary.expectancy_r ?? 0) - (baseline.expectancy_r ?? 0)) * 20 +
      ((summary.winrate_pct ?? 0) - (baseline.winrate_pct ?? 0)) / 5,
      3,
    ),
  };
}

function aPlusThresholdImpact(rows, baseline, threshold) {
  const kept = rows.filter((row) => {
    const score = numberOrNull(row.proposed_score ?? row.current_score);
    return score !== null && score >= threshold;
  });
  const summary = summarize(kept);
  return {
    threshold,
    ...summary,
    ...deltaSummary(summary, baseline),
  };
}

function contextFromShadowRow(row) {
  const c = row.score_components || {};
  return {
    candidateKey: row.candidate_key || row.alert_id || row.ref_id,
    symbol: row.symbol || c.symbol,
    side: row.direction || c.direction,
    timeframe: row.timeframe || c.timeframe,
    setupType: row.setup_type || c.setup,
    rr: c.rr,
    strength: c.pine_strength,
    setupScore: c.setup_score,
    trendStrength: c.trend_strength,
    marketRegime: c.regime,
    session: c.session,
    rsi: c.rsi,
    atrPct: c.atr_pct,
    eventTimeMs: row.event_time_utc ? new Date(row.event_time_utc).getTime() : Date.now(),
  };
}

function withShadowV2(rows) {
  return rows.map((row) => {
    const v2 = evaluateShadowScoreV2({
      context: contextFromShadowRow(row),
      quality: {
        score: row.current_score,
        grade: row.current_grade,
      },
    });

    return {
      ...row,
      v2_shadow_version: v2.shadowVersion,
      v2_proposed_score: v2.proposedScore,
      v2_proposed_grade: v2.proposedGrade,
      v2_score_delta: v2.scoreDelta,
      v2_penalty_reasons: v2.penaltyReasons,
      v2_bonus_reasons: v2.bonusReasons,
      v2_major_penalty_active: v2.majorPenaltyActive,
      v2_positive_support_active: v2.positiveSupportActive,
      v2_recommended_action: v2.recommendedAction,
    };
  });
}

function strongSupportBuckets(row) {
  const setup = componentValue(row, "setup");
  const session = componentValue(row, "session");
  const regime = componentValue(row, "regime");
  const rsiBucket = componentValue(row, "rsi_bucket");

  return {
    compression: regime === "COMPRESSION",
    london: session === "LONDON",
    rsi45To54: rsiBucket === "45-54",
    compressionBreakout: setup === "COMPRESSION_BREAKOUT",
  };
}

function hasAnyStrongSupport(row) {
  return Object.values(strongSupportBuckets(row)).some(Boolean);
}

function hasLondonOrCompression(row) {
  const support = strongSupportBuckets(row);
  return support.london || support.compression;
}

function applyV21Variant(row, variant) {
  const next = {
    ...row,
    v21_variant: variant.key,
    v21_variant_label: variant.label,
    v21_proposed_score: row.v2_proposed_score,
    v21_proposed_grade: row.v2_proposed_grade,
    v21_a_plus_block_reasons: [],
  };

  if (row.v2_proposed_grade !== "A+") return next;

  const setup = componentValue(row, "setup");
  const symbol = componentValue(row, "symbol");
  const session = componentValue(row, "session");
  const regime = componentValue(row, "regime");
  const rsiBucket = componentValue(row, "rsi_bucket");
  const support = strongSupportBuckets(row);
  const strongSupportCount = Object.values(support).filter(Boolean).length;
  const reasons = [];

  if (variant.rules.rsiBlocksAPlus && ["35-44", "55-64"].includes(rsiBucket)) {
    reasons.push(`rsi_${rsiBucket}_blocks_a_plus`);
  }

  if (
    variant.rules.trendPullbackRequiresAdditionalSupport &&
    setup === "TREND_PULLBACK" &&
    strongSupportCount < 1
  ) {
    reasons.push("trend_pullback_requires_additional_strong_support");
  }

  if (
    variant.rules.neutralOrTrendRequiresStrongSupport &&
    session === "NEUTRAL" &&
    strongSupportCount < 1
  ) {
    reasons.push("neutral_session_requires_strong_support");
  }

  if (
    variant.rules.neutralOrTrendRequiresStrongSupport &&
    regime === "TREND" &&
    strongSupportCount < 1
  ) {
    reasons.push("trend_regime_requires_strong_support");
  }

  if (
    variant.rules.liquidityReclaimRequiresLondonOrCompression &&
    setup === "LIQUIDITY_RECLAIM" &&
    !hasLondonOrCompression(row)
  ) {
    reasons.push("liquidity_reclaim_requires_london_or_compression");
  }

  if (variant.rules.bnbusdtBlocksAPlus && symbol === "BNBUSDT") {
    reasons.push("bnbusdt_false_a_plus_test");
  }

  if (reasons.length) {
    next.v21_proposed_grade = "A";
    next.v21_a_plus_block_reasons = reasons;
  }

  return next;
}

function withV21Variant(rows, variant) {
  return rows.map((row) => applyV21Variant(row, variant));
}

function aPlusStats(rows, gradeField = "proposed_grade") {
  const aPlus = rows.filter((row) => row[gradeField] === "A+");
  const wins = aPlus.filter((row) => WIN_OUTCOMES.has(row.outcome_type));
  const losses = aPlus.filter((row) => LOSS_OUTCOMES.has(row.outcome_type));

  return {
    a_plus_count: aPlus.length,
    a_plus_tp: wins.length,
    false_a_plus_losses: losses.length,
    a_plus_winrate_pct: aPlus.length ? round((wins.length / aPlus.length) * 100, 2) : null,
    a_plus_expectancy_r: round(average(aPlus.map(estimatedR)), 3),
  };
}

function v21VariantSummary(rows, variant, baseline, v1APlus, v2APlus) {
  const variantRows = withV21Variant(rows, variant);
  const kept = variantRows.filter((row) => ["A+", "A"].includes(row.v21_proposed_grade));
  const model = summarize(kept);
  const aPlus = aPlusStats(variantRows, "v21_proposed_grade");
  const demoted = variantRows.filter((row) => row.v2_proposed_grade === "A+" && row.v21_proposed_grade !== "A+");
  const demotedWins = demoted.filter((row) => WIN_OUTCOMES.has(row.outcome_type)).length;
  const demotedLosses = demoted.filter((row) => LOSS_OUTCOMES.has(row.outcome_type)).length;
  const reasons = new Map();

  for (const row of demoted) {
    for (const reason of row.v21_a_plus_block_reasons || []) {
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
  }

  return {
    variant: variant.key,
    label: variant.label,
    closed: model.closed,
    tp: model.tp,
    sl: model.sl,
    winrate_pct: model.winrate_pct,
    expectancy_r: model.expectancy_r,
    average_market_move_pct: model.average_market_move_pct,
    alert_volume: model.alerts,
    volume_delta_pct: deltaSummary(model, baseline).volume_delta_pct,
    a_plus_count: aPlus.a_plus_count,
    false_a_plus_losses: aPlus.false_a_plus_losses,
    false_a_plus_delta_vs_v1: aPlus.false_a_plus_losses - v1APlus.false_a_plus_losses,
    false_a_plus_delta_vs_v2: aPlus.false_a_plus_losses - v2APlus.false_a_plus_losses,
    tp_lost_by_demotion: demotedWins,
    sl_avoided_by_demotion: demotedLosses,
    demoted_a_plus_count: demoted.length,
    demotion_reasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  };
}

function selectBestV21Variant({ variants, current, v1, v2 }) {
  const candidates = variants.filter((variant) => (
    (variant.winrate_pct ?? 0) > (current.winrate_pct ?? 0) &&
    (variant.expectancy_r ?? -Infinity) > (current.expectancy_r ?? -Infinity) &&
    (
      (variant.winrate_pct ?? 0) > (v1.winrate_pct ?? 0) ||
      (
        (variant.winrate_pct ?? 0) === (v1.winrate_pct ?? 0) &&
        variant.false_a_plus_delta_vs_v1 < 0
      )
    ) &&
    variant.false_a_plus_delta_vs_v2 < 0 &&
    (variant.expectancy_r ?? 0) > 0 &&
    (variant.volume_delta_pct ?? -100) >= -60
  ));

  return candidates
    .sort((a, b) => (
      (a.false_a_plus_losses - b.false_a_plus_losses) ||
      ((b.expectancy_r ?? -Infinity) - (a.expectancy_r ?? -Infinity)) ||
      ((b.winrate_pct ?? -Infinity) - (a.winrate_pct ?? -Infinity))
    ))[0] || null;
}

function bucketSummary(rows, field, gradeField = "v21_proposed_grade") {
  const kept = rows.filter((row) => ["A+", "A"].includes(row[gradeField]));
  const groups = new Map();

  for (const row of kept) {
    const key = `${field}:${componentValue(row, field)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups.entries()]
    .map(([bucket, items]) => ({
      bucket,
      ...summarize(items),
    }))
    .filter((row) => row.closed >= 3)
    .sort((a, b) => (b.expectancy_r ?? -999) - (a.expectancy_r ?? -999));
}

function buildV21BucketReport(rows, bestVariant) {
  if (!bestVariant) {
    return {
      variant: null,
      top_buckets: [],
      worst_buckets: [],
    };
  }

  const variant = V21_VARIANTS.find((item) => item.key === bestVariant.variant);
  const variantRows = withV21Variant(rows, variant);
  const buckets = [
    ...bucketSummary(variantRows, "setup"),
    ...bucketSummary(variantRows, "symbol"),
    ...bucketSummary(variantRows, "session"),
    ...bucketSummary(variantRows, "regime"),
    ...bucketSummary(variantRows, "rsi_bucket"),
  ];

  return {
    variant: bestVariant.variant,
    top_buckets: buckets.slice(0, 10),
    worst_buckets: buckets.slice().sort((a, b) => (a.expectancy_r ?? 999) - (b.expectancy_r ?? 999)).slice(0, 10),
  };
}

function bucketsNotPenalizedYet(variants) {
  const bnb = variants.find((variant) => variant.variant === "E");

  return [
    {
      bucket: "BTCUSDT",
      reason: "Measured separately only; not recommended as automatic V2/V2.1 penalty by instruction and sample impact remains weak.",
    },
    {
      bucket: "BNBUSDT",
      reason: bnb && bnb.false_a_plus_delta_vs_v2 < 0
        ? "BNBUSDT A+ block can reduce false A+ in Variant E, but this is still a simulation-only test and needs more data before becoming a penalty."
        : "No automatic BNBUSDT penalty yet; keep measuring as a false A+ bucket.",
    },
    {
      bucket: "TREND_PULLBACK",
      reason: "Useful bucket overall; V2.1 only tests extra A+ support requirements, not a broad setup penalty.",
    },
  ];
}

function v21GoLiveStatus(bestVariant, rows) {
  if (!bestVariant) return "KEEP V2 SHADOW ONLY";
  if (rows.length < 100) return "V2.1 SHADOW CANDIDATE";
  return "V2.1 SHADOW CANDIDATE";
}

function modelComparison(rows) {
  const current = summarize(rows);
  const shadowV1Rows = rows.filter((row) => ["A+", "A"].includes(row.proposed_grade));
  const shadowV2Rows = rows.filter((row) => ["A+", "A"].includes(row.v2_proposed_grade));
  const shadowV1 = summarize(shadowV1Rows);
  const shadowV2 = summarize(shadowV2Rows);

  return {
    current_model: {
      ...current,
      model: "current_model_all_alerts",
      volume_pct: 100,
    },
    shadow_v1: {
      ...shadowV1,
      model: SHADOW_SCORING_VERSION,
      kept_rule: "proposed_grade in A+,A",
      ...deltaSummary(shadowV1, current),
    },
    shadow_v2: {
      ...shadowV2,
      model: SHADOW_SCORING_V2_VERSION,
      kept_rule: "v2_proposed_grade in A+,A",
      ...deltaSummary(shadowV2, current),
    },
    v2_vs_v1: {
      winrate_delta_pct:
        shadowV2.winrate_pct === null || shadowV1.winrate_pct === null
          ? null
          : round(shadowV2.winrate_pct - shadowV1.winrate_pct, 2),
      expectancy_delta_r:
        shadowV2.expectancy_r === null || shadowV1.expectancy_r === null
          ? null
          : round(shadowV2.expectancy_r - shadowV1.expectancy_r, 3),
      market_move_delta_pct:
        shadowV2.average_market_move_pct === null || shadowV1.average_market_move_pct === null
          ? null
          : round(shadowV2.average_market_move_pct - shadowV1.average_market_move_pct, 4),
      volume_delta: shadowV2.closed - shadowV1.closed,
      volume_delta_pct: shadowV1.closed ? round(((shadowV2.closed - shadowV1.closed) / shadowV1.closed) * 100, 2) : null,
    },
  };
}

function falseAPlusReduction(rows) {
  const v1False = rows.filter((row) => row.proposed_grade === "A+" && LOSS_OUTCOMES.has(row.outcome_type));
  const v2False = rows.filter((row) => row.v2_proposed_grade === "A+" && LOSS_OUTCOMES.has(row.outcome_type));
  const reasons = new Map();
  const add = (reason) => reasons.set(reason, (reasons.get(reason) || 0) + 1);

  for (const row of v2False) {
    for (const reason of row.v2_penalty_reasons || []) add(reason.reason);
    for (const reason of row.v2_bonus_reasons || []) add(reason.reason);
    add(`setup:${componentValue(row, "setup")}`);
    add(`symbol:${componentValue(row, "symbol")}`);
    add(`session:${componentValue(row, "session")}`);
    add(`regime:${componentValue(row, "regime")}`);
    add(`rsi_bucket:${componentValue(row, "rsi_bucket")}`);
  }

  return {
    v1_false_a_plus_losses: v1False.length,
    v2_false_a_plus_losses: v2False.length,
    reduction_count: v1False.length - v2False.length,
    reduction_pct: v1False.length ? round(((v1False.length - v2False.length) / v1False.length) * 100, 2) : null,
    remaining_problem_buckets: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
    remaining_false_a_plus_rows: v2False.slice(0, 50).map((row) => ({
      ref_id: row.ref_id,
      symbol: row.symbol,
      direction: row.direction,
      setup_type: row.setup_type,
      current_score: row.current_score,
      v1_score: row.proposed_score,
      v1_grade: row.proposed_grade,
      v2_score: row.v2_proposed_score,
      v2_grade: row.v2_proposed_grade,
      outcome_type: row.outcome_type,
      v2_penalty_reasons: row.v2_penalty_reasons,
      v2_bonus_reasons: row.v2_bonus_reasons,
    })),
  };
}

function falseAPlusAnalysis(rows) {
  const falseAPlus = rows.filter((row) => row.current_grade === "A+" && LOSS_OUTCOMES.has(row.outcome_type));
  const reasons = new Map();
  const add = (kind, value) => {
    const key = `${kind}:${normalize(value)}`;
    reasons.set(key, (reasons.get(key) || 0) + 1);
  };

  for (const row of falseAPlus) {
    const c = row.score_components || {};
    add("setup", row.setup_type || c.setup);
    add("symbol", row.symbol || c.symbol);
    add("session", c.session || row.session_name);
    add("regime", c.regime || row.market_regime);
    add("rsi_bucket", c.rsi_bucket);
    add("trend_strength_bucket", c.trend_strength_bucket);
    add("pine_strength", c.pine_strength);
    for (const reason of row.penalty_reasons || []) add("v1_penalty", reason.reason);
    for (const reason of row.bonus_reasons || []) add("v1_bonus", reason.reason);
  }

  return {
    total_false_a_plus_sl: falseAPlus.length,
    top_reasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    rows: falseAPlus.slice(0, 50).map((row) => ({
      ref_id: row.ref_id,
      symbol: row.symbol,
      direction: row.direction,
      setup_type: row.setup_type,
      session: row.score_components?.session || null,
      regime: row.score_components?.regime || null,
      current_score: row.current_score,
      current_grade: row.current_grade,
      proposed_score: row.proposed_score,
      proposed_grade: row.proposed_grade,
      outcome_type: row.outcome_type,
      market_move_pct: row.market_move_pct,
      penalty_reasons: row.penalty_reasons || [],
      bonus_reasons: row.bonus_reasons || [],
    })),
  };
}

function confidence(sample) {
  if (sample >= 100) return "medium";
  if (sample >= 50) return "low_medium";
  if (sample >= 20) return "low";
  return "insufficient_sample";
}

function recommendedChanges({ penaltyRanking, bonusRanking, bestThreshold, falseAPlus }) {
  const changes = [];
  for (const row of penaltyRanking.filter((item) => (
    item.key !== "BTCUSDT" &&
    item.sample >= 5 &&
    (item.expectancy_delta_r ?? 0) > 0
  )).slice(0, 6)) {
    changes.push({
      type: "penalty",
      change: `Increase or enforce ${row.key} penalty`,
      reason: `${row.sl_avoided} SL avoided vs ${row.tp_lost} TP lost in simulation.`,
      sample: row.sample,
      expected_winrate_delta_pct: row.winrate_delta_pct,
      expected_expectancy_delta_r: row.expectancy_delta_r,
      risk: confidence(row.sample),
    });
  }
  for (const row of bonusRanking.filter((item) => item.sample >= 5 && (item.expectancy_change_vs_baseline ?? 0) > 0).slice(0, 4)) {
    changes.push({
      type: "bonus",
      change: `Preserve or modestly increase ${row.key} bonus`,
      reason: `Bucket outperforms baseline by ${row.expectancy_change_vs_baseline}R expectancy.`,
      sample: row.sample,
      expected_winrate_delta_pct: row.winrate_delta_pct,
      expected_expectancy_delta_r: row.expectancy_change_vs_baseline,
      risk: confidence(row.sample),
    });
  }
  if (bestThreshold && bestThreshold.threshold > 92) {
    changes.push({
      type: "a_plus_threshold",
      change: `Raise A+ threshold candidate to ${bestThreshold.threshold}`,
      reason: `Best threshold score by expectancy/winrate tradeoff in this sample.`,
      sample: bestThreshold.closed,
      expected_winrate_delta_pct: bestThreshold.winrate_delta_pct,
      expected_expectancy_delta_r: bestThreshold.expectancy_delta_r,
      risk: confidence(bestThreshold.closed),
    });
  } else {
    changes.push({
      type: "a_plus_hardening",
      change: "Keep A+ threshold at 92 but require no major negative bucket and at least one support bucket",
      reason: "Threshold-only hardening did not improve the sample; component gates are the safer V2 path.",
      sample: bestThreshold?.closed ?? null,
      expected_winrate_delta_pct: null,
      expected_expectancy_delta_r: null,
      risk: "rule_based_from_simulation",
    });
  }
  for (const reason of falseAPlus.top_reasons.slice(0, 3)) {
    changes.push({
      type: "false_a_plus_pattern",
      change: `Review false A+ pattern ${reason.reason}`,
      reason: `Appears in ${reason.count} false A+ losses.`,
      sample: reason.count,
      expected_winrate_delta_pct: null,
      expected_expectancy_delta_r: null,
      risk: confidence(reason.count),
    });
  }

  return changes
    .sort((a, b) => {
      const aImpact = Math.abs(a.expected_expectancy_delta_r ?? 0) * 100 + Math.abs(a.expected_winrate_delta_pct ?? 0);
      const bImpact = Math.abs(b.expected_expectancy_delta_r ?? 0) * 100 + Math.abs(b.expected_winrate_delta_pct ?? 0);
      return bImpact - aImpact;
    })
    .slice(0, 10);
}

async function fetchRows() {
  const limit = Number(argValue("--limit", "10000"));
  const rows = await selectRows(
    "shadow_score_evaluations",
    [
      "?select=shadow_version,candidate_key,alert_id,ref_id,symbol,direction,timeframe,setup_type,current_score,current_grade,proposed_score,proposed_grade,score_delta,score_components,penalty_reasons,bonus_reasons,major_penalty_active,outcome_type,outcome_time_utc,market_move_pct,r_multiple,return_2x,return_3x,return_4x,return_5x,return_6x,evaluated_at_utc,event_time_utc",
      `shadow_version=eq.${encodeURIComponent(SHADOW_SCORING_VERSION)}`,
      "order=event_time_utc.desc",
      `limit=${limit}`,
    ].join("&"),
  );
  return rows.filter((row) => CLOSED_OUTCOMES.has(row.outcome_type));
}

function renderMarkdown(report) {
  const line = (text = "") => console.log(text);
  const table = (rows, columns) => {
    line(`| ${columns.map((col) => col.label).join(" | ")} |`);
    line(`| ${columns.map(() => "---").join(" | ")} |`);
    for (const row of rows) {
      line(`| ${columns.map((col) => row[col.key] ?? "").join(" | ")} |`);
    }
  };

  line("# D-ALRT Shadow V2 Impact Simulator");
  line(`Generated UTC: ${report.generated_at_utc}`);
  line(`Closed sample: ${report.baseline.closed}`);
  line("");
  line("## Baseline");
  line(`Current closed alerts: ${report.baseline.closed}, winrate ${report.baseline.winrate_pct}%, expectancy ${report.baseline.expectancy_r}R, avg move ${report.baseline.average_market_move_pct}%.`);
  line("");
  line("## Penalty Ranking");
  table(report.penalty_ranking, [
    { key: "key", label: "Penalty" },
    { key: "sample", label: "Sample" },
    { key: "alerts_removed", label: "Removed" },
    { key: "tp_lost", label: "TP Lost" },
    { key: "sl_avoided", label: "SL Avoided" },
    { key: "winrate_delta_pct", label: "Winrate Delta" },
    { key: "expectancy_delta_r", label: "Expectancy Delta" },
  ]);
  line("");
  line("## Bonus Ranking");
  table(report.bonus_ranking, [
    { key: "key", label: "Bonus" },
    { key: "sample", label: "Sample" },
    { key: "tp_gained_vs_baseline", label: "TP Gain vs Baseline" },
    { key: "sl_reduced_vs_baseline", label: "SL Reduced vs Baseline" },
    { key: "winrate_delta_pct", label: "Winrate Delta" },
    { key: "expectancy_change_vs_baseline", label: "Expectancy Delta" },
  ]);
  line("");
  line("## A+ Thresholds");
  table(report.a_plus_thresholds, [
    { key: "threshold", label: "Threshold" },
    { key: "closed", label: "Closed" },
    { key: "tp", label: "TP" },
    { key: "sl", label: "SL" },
    { key: "winrate_pct", label: "Winrate" },
    { key: "expectancy_r", label: "Expectancy" },
    { key: "volume_delta_pct", label: "Volume Delta" },
  ]);
  line("");
  line(`Best A+ threshold: ${report.best_a_plus_threshold?.threshold ?? "insufficient data"}`);
  line("");
  line("## False A+ Top Reasons");
  table(report.false_a_plus_analysis.top_reasons.slice(0, 12), [
    { key: "reason", label: "Reason" },
    { key: "count", label: "Count" },
  ]);
  line("");
  line("## Current vs Shadow V1 vs Shadow V2");
  table([
    report.model_comparison.current_model,
    report.model_comparison.shadow_v1,
    report.model_comparison.shadow_v2,
  ], [
    { key: "model", label: "Model" },
    { key: "closed", label: "Closed" },
    { key: "tp", label: "TP" },
    { key: "sl", label: "SL" },
    { key: "winrate_pct", label: "Winrate" },
    { key: "expectancy_r", label: "Expectancy" },
    { key: "average_market_move_pct", label: "Avg Move" },
    { key: "volume_delta_pct", label: "Volume Delta" },
  ]);
  line("");
  line("## False A+ Reduction");
  line(`V1 false A+ losses: ${report.false_a_plus_reduction.v1_false_a_plus_losses}`);
  line(`V2 false A+ losses: ${report.false_a_plus_reduction.v2_false_a_plus_losses}`);
  line(`Reduction: ${report.false_a_plus_reduction.reduction_count} (${report.false_a_plus_reduction.reduction_pct}%)`);
  line("");
  line("## Recommended Shadow V2 Changes");
  table(report.recommended_shadow_v2_model, [
    { key: "type", label: "Type" },
    { key: "change", label: "Change" },
    { key: "sample", label: "Sample" },
    { key: "expected_winrate_delta_pct", label: "Winrate Delta" },
    { key: "expected_expectancy_delta_r", label: "Expectancy Delta" },
    { key: "risk", label: "Confidence" },
  ]);
  line("");
  line("## Shadow V2.1 Variant Comparison");
  table(report.shadow_v2_1.variant_comparison, [
    { key: "variant", label: "Variant" },
    { key: "closed", label: "Closed" },
    { key: "tp", label: "TP" },
    { key: "sl", label: "SL" },
    { key: "winrate_pct", label: "Winrate" },
    { key: "expectancy_r", label: "Expectancy" },
    { key: "average_market_move_pct", label: "Avg Move" },
    { key: "a_plus_count", label: "A+ Count" },
    { key: "false_a_plus_losses", label: "False A+ SL" },
    { key: "tp_lost_by_demotion", label: "TP Demoted" },
    { key: "sl_avoided_by_demotion", label: "SL Demoted" },
  ]);
  line("");
  line("## Shadow V2.1 Best Variant");
  line(report.shadow_v2_1.best_variant
    ? `${report.shadow_v2_1.best_variant.variant}: ${report.shadow_v2_1.best_variant.label}`
    : "No V2.1 variant met all selection criteria.");
  line(`Go-live status: ${report.shadow_v2_1.go_live_status}`);
}

async function main() {
  if (!ready()) {
    console.error("Missing Supabase env: SUPABASE_ENABLED=true, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
    process.exitCode = 1;
    return;
  }

  const rows = withShadowV2(await fetchRows());
  const baseline = summarize(rows);
  const penaltyRanking = PENALTY_TESTS
    .map((test) => penaltyImpact(rows, baseline, test))
    .sort((a, b) => (b.impact_score ?? -Infinity) - (a.impact_score ?? -Infinity));
  const bonusRanking = BONUS_TESTS
    .map((test) => bonusImpact(rows, baseline, test))
    .sort((a, b) => (b.impact_score ?? -Infinity) - (a.impact_score ?? -Infinity));
  const aPlusThresholds = A_PLUS_THRESHOLDS
    .map((threshold) => aPlusThresholdImpact(rows, baseline, threshold));
  const bestThreshold = aPlusThresholds
    .filter((row) => row.closed >= 5)
    .sort((a, b) => {
      if ((b.expectancy_r ?? -Infinity) !== (a.expectancy_r ?? -Infinity)) return (b.expectancy_r ?? -Infinity) - (a.expectancy_r ?? -Infinity);
      return (b.winrate_pct ?? -Infinity) - (a.winrate_pct ?? -Infinity);
    })[0] || null;
  const falseAPlus = falseAPlusAnalysis(rows);
  const comparison = modelComparison(rows);
  const falseAPlusV2 = falseAPlusReduction(rows);
  const v1APlus = aPlusStats(rows, "proposed_grade");
  const v2APlus = aPlusStats(rows, "v2_proposed_grade");
  const v21Variants = V21_VARIANTS.map((variant) => v21VariantSummary(
    rows,
    variant,
    baseline,
    v1APlus,
    v2APlus,
  ));
  const bestV21 = selectBestV21Variant({
    variants: v21Variants,
    current: comparison.current_model,
    v1: comparison.shadow_v1,
    v2: comparison.shadow_v2,
  });
  const v21Buckets = buildV21BucketReport(rows, bestV21);
  const recommended = recommendedChanges({
    penaltyRanking,
    bonusRanking,
    bestThreshold,
    falseAPlus,
  });

  const report = {
    ok: true,
    generated_at_utc: new Date().toISOString(),
    source: "shadow_score_evaluations",
    simulation_only: true,
    live_changes_made: false,
    baseline,
    penalty_ranking: penaltyRanking,
    bonus_ranking: bonusRanking,
    a_plus_thresholds: aPlusThresholds,
    best_a_plus_threshold: bestThreshold,
    false_a_plus_analysis: falseAPlus,
    model_comparison: comparison,
    false_a_plus_reduction: falseAPlusV2,
    shadow_v2_ruleset: {
      version: SHADOW_SCORING_V2_VERSION,
      a_plus_rule: "score >= 92, no major negative bucket, at least one positive support bucket",
      major_negative_buckets: ["HTF_CONTINUATION", "EXPANSION", "NEW_YORK", "LONDON_NY_OVERLAP", "SOLUSDT"],
      no_automatic_penalty: ["BTCUSDT"],
      positive_support_buckets: ["COMPRESSION", "LONDON", "RSI 45-54", "COMPRESSION_BREAKOUT", "TREND_PULLBACK"],
      penalty_strengths: {
        HTF_CONTINUATION: "strong",
        EXPANSION: "medium",
        NEW_YORK: "medium",
        LONDON_NY_OVERLAP: "medium",
        SOLUSDT: "modest",
        "RSI 55-64": "medium",
        "RSI 35-44": "medium",
      },
    },
    recommended_shadow_v2_model: recommended,
    estimated_quality_improvement: comparison.shadow_v2,
    expected_alert_volume_reduction: comparison.shadow_v2.volume_delta_pct ?? null,
    shadow_v2_1: {
      version: SHADOW_V21_VERSION,
      simulation_only: true,
      variants_tested: V21_VARIANTS.map((variant) => ({
        variant: variant.key,
        label: variant.label,
        rules: variant.rules,
      })),
      baseline_a_plus: {
        v1: v1APlus,
        v2: v2APlus,
      },
      variant_comparison: v21Variants,
      best_variant: bestV21,
      bucket_report: v21Buckets,
      buckets_not_penalized_yet: bucketsNotPenalizedYet(v21Variants),
      expected_volume_reduction: bestV21?.volume_delta_pct ?? null,
      go_live_status: v21GoLiveStatus(bestV21, rows),
    },
    go_live_readiness: {
      status: v21GoLiveStatus(bestV21, rows),
      reasons: [
        "Requires 100+ closed outcomes before any promotion.",
        "Requires V2 to beat both current model and Shadow V1.",
        "Requires positive expectancy and lower false A+ count.",
        "Requires manual approval.",
      ],
    },
  };

  if (hasFlag("--markdown")) {
    renderMarkdown(report);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((err) => {
  console.error("Shadow V2 impact simulation failed:", err);
  process.exitCode = 1;
});
