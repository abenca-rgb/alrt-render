import {
  evaluateShadowScore,
  evaluateShadowScoreV2,
} from "../../src/services/shadowScoringService.js";

const SUPABASE_ENABLED = String(process.env.SUPABASE_ENABLED || "false").toLowerCase() === "true";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const TP_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL"]);
const WIN_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL", "TIME_EXIT_PROFIT"]);
const LOSS_OUTCOMES = new Set(["SL", "TIME_EXIT_LOSS"]);
const RELIABLE_CLOSED_OUTCOMES = new Set([
  "TP",
  "TP1",
  "TP2",
  "TP_FULL",
  "SL",
  "TIME_EXIT_PROFIT",
  "TIME_EXIT_LOSS",
]);

const SINGLE_BUCKETS = [
  { key: "symbol", label: "Symbol", value: (row) => row.symbol },
  { key: "direction", label: "Direction", value: (row) => row.direction },
  { key: "setup", label: "Setup", value: (row) => row.setup_type },
  { key: "session", label: "Session", value: (row) => row.session_name },
  { key: "regime", label: "Regime", value: (row) => row.market_regime },
  { key: "rsi_bucket", label: "RSI bucket", value: (row) => bucketRsi(row.rsi) },
  { key: "trend_bucket", label: "Trend strength bucket", value: (row) => bucketTrend(row.trend_strength) },
  { key: "rr_bucket", label: "RR bucket", value: (row) => bucketRr(row.rr) },
  { key: "atr_bucket", label: "ATR/vol bucket", value: (row) => bucketVolatility(row.atr_pct ?? row.volatility_pct) },
  { key: "timeframe", label: "Timeframe", value: (row) => row.timeframe },
  { key: "hour_utc", label: "Hour UTC", value: (row) => hourUtc(row.signal_time_utc) },
  { key: "weekday_utc", label: "Day of week UTC", value: (row) => weekdayUtc(row.signal_time_utc) },
  { key: "compression_context", label: "Compression/Expansion", value: (row) => compressionContext(row.market_regime) },
  { key: "pine_strength", label: "Pine strength", value: (row) => row.pine_strength },
  { key: "current_grade", label: "Current grade", value: (row) => row.quality_grade },
  { key: "shadow_grade", label: "Shadow grade", value: (row) => row.shadow_v1_grade },
];

const COMBINATION_BUCKETS = [
  ["symbol", "setup"],
  ["symbol", "session"],
  ["setup", "session"],
  ["setup", "regime"],
  ["rsi_bucket", "setup"],
  ["regime", "session"],
  ["symbol", "setup", "session"],
  ["setup", "regime", "rsi_bucket"],
  ["direction", "session", "regime"],
];

const SL_TESTS = [
  { label: "HTF_CONTINUATION", match: (row) => row.setup_type === "HTF_CONTINUATION" },
  { label: "RSI 35-44", match: (row) => bucketRsi(row.rsi) === "35-44" },
  { label: "RSI 55-64", match: (row) => bucketRsi(row.rsi) === "55-64" },
  { label: "NEUTRAL session", match: (row) => row.session_name === "NEUTRAL" },
  { label: "TREND regime", match: (row) => row.market_regime === "TREND" },
  { label: "EXPANSION regime", match: (row) => row.market_regime === "EXPANSION" },
  { label: "SOLUSDT", match: (row) => row.symbol === "SOLUSDT" },
  { label: "BNBUSDT", match: (row) => row.symbol === "BNBUSDT" },
  { label: "Trend strength 22+", match: (row) => bucketTrend(row.trend_strength) === "22+" },
  { label: "TREND_PULLBACK without support", match: (row) => row.setup_type === "TREND_PULLBACK" && !hasSupportContext(row) },
  { label: "High RR without confirmation", match: (row) => (row.rr ?? 0) >= 2.5 && !hasSupportContext(row) },
];

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
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

function normalize(value, fallback = "UNKNOWN") {
  const text = String(value || "").trim().toUpperCase();
  return text || fallback;
}

function normalizeGrade(value) {
  const text = normalize(value);
  if (["A+", "A", "B+", "B", "C"].includes(text)) return text;
  return "UNKNOWN";
}

function dateMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function hourUtc(value) {
  const ms = dateMs(value);
  if (ms === null) return "UNKNOWN";
  return String(new Date(ms).getUTCHours()).padStart(2, "0");
}

function weekdayUtc(value) {
  const ms = dateMs(value);
  if (ms === null) return "UNKNOWN";
  return ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][new Date(ms).getUTCDay()];
}

function bucketRsi(value) {
  const rsi = numberOrNull(value);
  if (rsi === null) return "UNKNOWN";
  if (rsi < 35) return "<35";
  if (rsi < 45) return "35-44";
  if (rsi < 55) return "45-54";
  if (rsi < 65) return "55-64";
  return "65+";
}

function bucketTrend(value) {
  const trend = numberOrNull(value);
  if (trend === null) return "UNKNOWN";
  if (trend < 14) return "<14";
  if (trend < 22) return "14-21";
  return "22+";
}

function bucketRr(value) {
  const rr = numberOrNull(value);
  if (rr === null) return "UNKNOWN";
  if (rr < 1.5) return "<1.5";
  if (rr < 2) return "1.5-1.99";
  if (rr < 2.5) return "2.0-2.49";
  if (rr < 3) return "2.5-2.99";
  return "3+";
}

function bucketVolatility(value) {
  const vol = numberOrNull(value);
  if (vol === null) return "UNKNOWN";
  if (vol < 0.25) return "<0.25";
  if (vol < 0.5) return "0.25-0.49";
  if (vol < 1) return "0.50-0.99";
  return "1+";
}

function compressionContext(value) {
  const regime = normalize(value);
  if (regime.includes("COMPRESSION")) return "COMPRESSION";
  if (regime.includes("EXPANSION")) return "EXPANSION";
  if (regime.includes("TREND")) return "TREND";
  return regime;
}

function identityPrice(value) {
  const n = numberOrNull(value);
  if (n === null) return "NA";
  if (Math.abs(n) >= 10000) return (Math.round(n / 10) * 10).toFixed(0);
  if (Math.abs(n) >= 1000) return (Math.round(n / 5) * 5).toFixed(0);
  if (Math.abs(n) >= 100) return (Math.round(n * 2) / 2).toFixed(1);
  if (Math.abs(n) >= 1) return (Math.round(n * 10) / 10).toFixed(1);
  return (Math.round(n * 1000) / 1000).toFixed(3);
}

function alertIdentity(row) {
  const ms = dateMs(row.signal_time_utc);
  const bucket = ms === null ? "NA" : Math.floor(ms / (10 * 60 * 1000));
  return [
    row.symbol,
    row.direction,
    row.setup_type,
    row.timeframe,
    identityPrice(row.entry_price),
    identityPrice(row.tp_price),
    identityPrice(row.sl_price),
    bucket,
  ].join("|");
}

function estimatedR(row) {
  const actual = numberOrNull(row.r_multiple);
  if (actual !== null) return actual;
  if (WIN_OUTCOMES.has(row.outcome_type)) return numberOrNull(row.rr) ?? 1;
  if (LOSS_OUTCOMES.has(row.outcome_type)) return -1;
  return null;
}

function average(values) {
  const clean = values.map(numberOrNull).filter((value) => value !== null);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function pct(part, total) {
  return total ? round((part / total) * 100, 2) : null;
}

function confidence(sample) {
  if (sample >= 50) return "HIGH";
  if (sample >= 20) return "MEDIUM";
  return "LOW";
}

function summarize(rows, label = "sample") {
  const reliable = rows.filter((row) => row.reliable);
  const tp = reliable.filter((row) => TP_OUTCOMES.has(row.outcome_type));
  const sl = reliable.filter((row) => row.outcome_type === "SL");
  const wins = reliable.filter((row) => WIN_OUTCOMES.has(row.outcome_type));
  const losses = reliable.filter((row) => LOSS_OUTCOMES.has(row.outcome_type));
  const tpDurations = reliable.filter((row) => TP_OUTCOMES.has(row.outcome_type)).map((row) => row.duration_minutes);
  const slDurations = reliable.filter((row) => row.outcome_type === "SL").map((row) => row.duration_minutes);

  return {
    label,
    sample: reliable.length,
    alerts: rows.length,
    closed: reliable.length,
    tp: tp.length,
    sl: sl.length,
    wins: wins.length,
    losses: losses.length,
    tp_rate_pct: pct(tp.length, reliable.length),
    sl_rate_pct: pct(sl.length, reliable.length),
    winrate_pct: pct(wins.length, reliable.length),
    expectancy_r: round(average(reliable.map(estimatedR)), 3),
    average_market_move_pct: round(average(reliable.map((row) => row.market_move_pct)), 4),
    average_r: round(average(reliable.map(estimatedR)), 3),
    average_time_to_tp_min: round(average(tpDurations), 1),
    average_time_to_sl_min: round(average(slDurations), 1),
    confidence: confidence(reliable.length),
  };
}

function keyOf(row, columns) {
  return columns.map((column) => {
    const bucket = SINGLE_BUCKETS.find((item) => item.key === column);
    return `${column}:${bucket ? bucket.value(row) : row[column]}`;
  }).join(" + ");
}

function groupStats(rows, bucket, baseline, minSample = 1) {
  const groups = new Map();
  for (const row of rows) {
    const value = bucket.value(row);
    if (!value || value === "UNKNOWN") continue;
    const key = `${bucket.key}:${value}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups.entries()]
    .map(([key, items]) => {
      const summary = summarize(items, key);
      return {
        bucket: bucket.key,
        value: key.replace(`${bucket.key}:`, ""),
        ...summary,
        tp_rate_delta_pct: summary.tp_rate_pct === null || baseline.tp_rate_pct === null ? null : round(summary.tp_rate_pct - baseline.tp_rate_pct, 2),
        expectancy_delta_r: summary.expectancy_r === null || baseline.expectancy_r === null ? null : round(summary.expectancy_r - baseline.expectancy_r, 3),
      };
    })
    .filter((row) => row.sample >= minSample)
    .sort((a, b) => (b.expectancy_r ?? -Infinity) - (a.expectancy_r ?? -Infinity));
}

function combinationStats(rows, combo, baseline, minSample = 1) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row, combo);
    if (key.includes("UNKNOWN")) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups.entries()]
    .map(([key, items]) => {
      const summary = summarize(items, key);
      return {
        combination: combo.join(" + "),
        pattern: key,
        ...summary,
        tp_rate_delta_pct: summary.tp_rate_pct === null || baseline.tp_rate_pct === null ? null : round(summary.tp_rate_pct - baseline.tp_rate_pct, 2),
        expectancy_delta_r: summary.expectancy_r === null || baseline.expectancy_r === null ? null : round(summary.expectancy_r - baseline.expectancy_r, 3),
      };
    })
    .filter((row) => row.sample >= minSample)
    .sort((a, b) => {
      if ((b.expectancy_r ?? -Infinity) !== (a.expectancy_r ?? -Infinity)) return (b.expectancy_r ?? -Infinity) - (a.expectancy_r ?? -Infinity);
      return (b.tp_rate_pct ?? -Infinity) - (a.tp_rate_pct ?? -Infinity);
    });
}

function hasSupportContext(row) {
  return row.market_regime === "COMPRESSION" ||
    row.session_name === "LONDON" ||
    row.setup_type === "COMPRESSION_BREAKOUT" ||
    bucketRsi(row.rsi) === "45-54";
}

function buildContext(row) {
  return {
    symbol: row.symbol,
    side: row.direction,
    setupType: row.setup_type,
    session: row.session_name,
    marketRegime: row.market_regime,
    rr: row.rr,
    rsi: row.rsi,
    trendStrength: row.trend_strength,
    atrPct: row.atr_pct,
    volatilityPct: row.volatility_pct,
    strength: row.pine_strength,
    setupScore: row.setup_score,
  };
}

function shadowV21Grade(row) {
  const result = evaluateShadowScoreV2({
    context: buildContext(row),
    quality: { score: row.quality_score, grade: row.quality_grade },
  });
  let grade = result.proposedGrade;
  const c = result.scoreComponents || {};
  const strongSupport = c.regime === "COMPRESSION" ||
    c.session === "LONDON" ||
    c.rsi_bucket === "45-54" ||
    c.setup === "COMPRESSION_BREAKOUT";

  if (grade === "A+") {
    const hardBlock =
      c.rsi_bucket === "35-44" ||
      c.rsi_bucket === "55-64" ||
      (c.setup === "TREND_PULLBACK" && !strongSupport) ||
      ((c.session === "NEUTRAL" || c.regime === "TREND") && !strongSupport) ||
      (c.setup === "LIQUIDITY_RECLAIM" && !(c.session === "LONDON" || c.regime === "COMPRESSION"));
    if (hardBlock) grade = "A";
  }

  return {
    ...result,
    proposedGrade: grade,
  };
}

function rowWithShadow(row) {
  const v1 = evaluateShadowScore({
    context: buildContext(row),
    quality: { score: row.quality_score, grade: row.quality_grade },
  });
  const v2 = evaluateShadowScoreV2({
    context: buildContext(row),
    quality: { score: row.quality_score, grade: row.quality_grade },
  });
  const v21 = shadowV21Grade(row);
  return {
    ...row,
    shadow_v1_grade: row.shadow_v1_grade && row.shadow_v1_grade !== "UNKNOWN" ? row.shadow_v1_grade : v1.proposedGrade,
    shadow_v2_grade: row.shadow_v2_grade && row.shadow_v2_grade !== "UNKNOWN" ? row.shadow_v2_grade : v2.proposedGrade,
    shadow_v21_grade: v21.proposedGrade,
  };
}

function acceptedByGrade(row, gradeField) {
  return ["A+", "A"].includes(row[gradeField]);
}

function patternMatches(row, pattern) {
  if (pattern.kind === "single") {
    const bucket = SINGLE_BUCKETS.find((item) => item.key === pattern.bucket);
    return bucket?.value(row) === pattern.value;
  }
  if (pattern.kind === "combo") {
    return keyOf(row, pattern.columns) === pattern.pattern;
  }
  return false;
}

function buildTpFirstRules({ bucketRows, comboRows, slRows, baseline, minModelSample }) {
  const positiveSingles = bucketRows
    .filter((row) =>
      row.sample >= minModelSample &&
      row.tp_rate_pct !== null &&
      row.expectancy_r !== null &&
      row.tp_rate_pct >= (baseline.tp_rate_pct ?? 0) + 10 &&
      row.expectancy_r > 0 &&
      row.expectancy_r > (baseline.expectancy_r ?? -Infinity)
    )
    .map((row) => ({
      kind: "single",
      bucket: row.bucket,
      value: row.value,
      sample: row.sample,
      tp_rate_pct: row.tp_rate_pct,
      expectancy_r: row.expectancy_r,
      confidence: row.confidence,
    }));

  const positiveCombos = comboRows
    .filter((row) =>
      row.sample >= minModelSample &&
      row.tp_rate_pct !== null &&
      row.expectancy_r !== null &&
      row.tp_rate_pct >= (baseline.tp_rate_pct ?? 0) + 12 &&
      row.expectancy_r > 0 &&
      row.expectancy_r > (baseline.expectancy_r ?? -Infinity)
    )
    .map((row) => ({
      kind: "combo",
      columns: row.combination.split(" + "),
      pattern: row.pattern,
      sample: row.sample,
      tp_rate_pct: row.tp_rate_pct,
      expectancy_r: row.expectancy_r,
      confidence: row.confidence,
    }));

  const negativeRules = slRows
    .filter((row) =>
      row.sample >= minModelSample &&
      row.sl_rate_pct !== null &&
      row.sl_rate_pct >= (baseline.sl_rate_pct ?? 0) + 10 &&
      (row.expectancy_r ?? 0) < (baseline.expectancy_r ?? 0)
    )
    .map((row) => ({
      kind: "sl_test",
      label: row.pattern,
      sample: row.sample,
      sl_rate_pct: row.sl_rate_pct,
      expectancy_r: row.expectancy_r,
      confidence: row.confidence,
    }));

  return {
    version: "TP_FIRST_MODEL_V1",
    min_model_sample: minModelSample,
    positive_patterns: [...positiveCombos, ...positiveSingles]
      .sort((a, b) => (b.expectancy_r ?? -Infinity) - (a.expectancy_r ?? -Infinity))
      .slice(0, 50),
    negative_patterns: negativeRules.slice(0, 50),
    class_rules: [
      "AVOID when a major SL-heavy pattern matches.",
      "TP_FIRST_A+ when at least two TP-positive support patterns match and no SL-heavy pattern matches.",
      "TP_FIRST_A when at least one TP-positive support pattern matches and no SL-heavy pattern matches.",
      "REVIEW when no proven TP-positive support pattern exists.",
    ],
  };
}

function classifyTpFirst(row, rules) {
  const positiveMatches = rules.positive_patterns.filter((pattern) => patternMatches(row, pattern));
  const negativeMatches = rules.negative_patterns.filter((pattern) => SL_TESTS.find((test) => test.label === pattern.label)?.match(row));

  if (negativeMatches.length) {
    return {
      class: "AVOID",
      allow: false,
      positive_support: positiveMatches.map((item) => item.kind === "combo" ? item.pattern : `${item.bucket}:${item.value}`),
      negative_blocks: negativeMatches.map((item) => item.label),
    };
  }

  if (positiveMatches.length >= 2) {
    return {
      class: "TP_FIRST_A+",
      allow: true,
      positive_support: positiveMatches.map((item) => item.kind === "combo" ? item.pattern : `${item.bucket}:${item.value}`),
      negative_blocks: [],
    };
  }

  if (positiveMatches.length >= 1) {
    return {
      class: "TP_FIRST_A",
      allow: true,
      positive_support: positiveMatches.map((item) => item.kind === "combo" ? item.pattern : `${item.bucket}:${item.value}`),
      negative_blocks: [],
    };
  }

  return {
    class: "REVIEW",
    allow: false,
    positive_support: [],
    negative_blocks: [],
  };
}

function modelSummary(rows, label, filterFn) {
  const accepted = rows.filter(filterFn);
  const summary = summarize(accepted, label);
  return {
    model: label,
    ...summary,
    alert_volume_reduction_pct: rows.length ? round(((rows.length - accepted.length) / rows.length) * 100, 2) : null,
    false_a_plus_count: accepted.filter((row) => row.quality_grade === "A+" && LOSS_OUTCOMES.has(row.outcome_type)).length,
  };
}

function timeWindowRows(rows, window) {
  const sorted = [...rows].sort((a, b) => (dateMs(b.signal_time_utc) ?? 0) - (dateMs(a.signal_time_utc) ?? 0));
  const now = sorted[0] ? dateMs(sorted[0].signal_time_utc) : Date.now();
  if (window === "all") return sorted;
  if (window === "recent_100") return sorted.slice(0, 100);
  const days = window === "last_7_days" ? 7 : 30;
  const since = now - days * 24 * 60 * 60 * 1000;
  return sorted.filter((row) => (dateMs(row.signal_time_utc) ?? 0) >= since);
}

function compareModels(rows, rules, window = "all") {
  const scoped = timeWindowRows(rows, window);
  return [
    modelSummary(scoped, "Current model", () => true),
    modelSummary(scoped, "Shadow V1", (row) => acceptedByGrade(row, "shadow_v1_grade")),
    modelSummary(scoped, "Shadow V2.1", (row) => acceptedByGrade(row, "shadow_v21_grade")),
    modelSummary(scoped, "TP_FIRST_MODEL_V1", (row) => classifyTpFirst(row, rules).allow),
  ];
}

function slPatternStats(rows, baseline) {
  return SL_TESTS.map((test) => {
    const matched = rows.filter(test.match);
    const kept = rows.filter((row) => !test.match(row));
    const summary = summarize(matched, test.label);
    const keptSummary = summarize(kept, `without ${test.label}`);
    return {
      pattern: test.label,
      ...summary,
      tp_lost_if_blocked: summary.tp,
      sl_avoided_if_blocked: summary.sl,
      expectancy_improvement_if_blocked:
        keptSummary.expectancy_r === null || baseline.expectancy_r === null
          ? null
          : round(keptSummary.expectancy_r - baseline.expectancy_r, 3),
      winrate_improvement_if_blocked:
        keptSummary.winrate_pct === null || baseline.winrate_pct === null
          ? null
          : round(keptSummary.winrate_pct - baseline.winrate_pct, 2),
    };
  }).sort((a, b) => {
    if ((b.expectancy_improvement_if_blocked ?? -Infinity) !== (a.expectancy_improvement_if_blocked ?? -Infinity)) {
      return (b.expectancy_improvement_if_blocked ?? -Infinity) - (a.expectancy_improvement_if_blocked ?? -Infinity);
    }
    return (b.sl_avoided_if_blocked ?? 0) - (a.sl_avoided_if_blocked ?? 0);
  });
}

function indexBy(rows, field) {
  const map = new Map();
  for (const row of rows) {
    const key = String(row[field] || "");
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function firstFromMaps(row, maps) {
  const keys = [
    ["alert_id", row.alert_id],
    ["ref_id", row.ref_id],
    ["candidate_key", row.candidate_key],
  ];
  for (const [field, value] of keys) {
    if (!value) continue;
    const items = maps[field]?.get(String(value));
    if (items?.length) return items[0];
  }
  return null;
}

function makeRecord(source, alert, candidate, outcome, shadow, flags = []) {
  const raw = alert?.raw_payload || candidate?.raw_payload || outcome?.raw_payload || {};
  const signalTime = alert?.signal_time_utc || candidate?.event_time_utc || shadow?.event_time_utc || null;
  const outcomeTime = outcome?.closed_at_utc || outcome?.outcome_time_utc || shadow?.outcome_time_utc || null;
  const ref = String(alert?.ref_id || candidate?.ref_id || outcome?.ref_id || shadow?.ref_id || "");
  const alertId = String(alert?.alert_id || candidate?.alert_id || outcome?.alert_id || shadow?.alert_id || "");
  const outcomeType = normalize(outcome?.outcome_type || shadow?.outcome_type || "");
  const record = {
    source,
    alert_id: alertId,
    candidate_key: candidate?.candidate_key || outcome?.candidate_key || shadow?.candidate_key || null,
    ref_id: ref,
    symbol: normalize(alert?.symbol || candidate?.symbol || outcome?.symbol || shadow?.symbol),
    direction: normalize(alert?.direction || candidate?.direction || outcome?.direction || shadow?.direction),
    timeframe: normalize(alert?.timeframe || candidate?.timeframe || shadow?.timeframe),
    setup_type: normalize(alert?.setup_type || candidate?.setup_type || shadow?.setup_type),
    session_name: normalize(alert?.session_name || candidate?.session_name || raw.session || shadow?.score_components?.session),
    market_regime: normalize(alert?.market_regime || candidate?.market_regime || raw.regime || shadow?.score_components?.regime),
    quality_score: numberOrNull(alert?.quality_score ?? candidate?.quality_score ?? shadow?.current_score),
    quality_grade: normalizeGrade(alert?.quality_grade || candidate?.quality_grade || shadow?.current_grade),
    shadow_v1_grade: normalizeGrade(shadow?.proposed_grade),
    pine_strength: normalizeGrade(candidate?.strength || raw.strength || shadow?.score_components?.pine_strength),
    setup_score: numberOrNull(candidate?.setup_score || raw.setup_score),
    rr: numberOrNull(alert?.rr ?? candidate?.rr ?? raw.rr ?? shadow?.score_components?.rr),
    rsi: numberOrNull(candidate?.rsi ?? raw.rsi ?? shadow?.score_components?.rsi),
    trend_strength: numberOrNull(candidate?.trend_strength ?? raw.trend_strength ?? raw.adx ?? shadow?.score_components?.trend_strength),
    atr_pct: numberOrNull(candidate?.atr_pct ?? raw.atr_pct ?? shadow?.score_components?.atr_pct),
    volatility_pct: numberOrNull(candidate?.volatility_pct ?? raw.volatility_pct),
    entry_price: numberOrNull(alert?.entry_price ?? candidate?.entry_price ?? raw.entry),
    tp_price: numberOrNull(alert?.tp_price ?? candidate?.tp1_price ?? raw.tp),
    sl_price: numberOrNull(alert?.sl_price ?? candidate?.sl_price ?? raw.sl),
    signal_time_utc: signalTime,
    outcome_type: outcomeType || null,
    outcome_time_utc: outcomeTime,
    duration_minutes: numberOrNull(outcome?.duration_minutes) ?? durationMinutes(signalTime, outcomeTime),
    market_move_pct: numberOrNull(shadow?.market_move_pct ?? outcome?.move_pct ?? outcome?.pnl_percent),
    r_multiple: numberOrNull(shadow?.r_multiple ?? outcome?.r_multiple),
    flags,
  };
  record.identity = alertIdentity(record);
  record.reliable = RELIABLE_CLOSED_OUTCOMES.has(record.outcome_type) &&
    Boolean(record.symbol && record.direction && record.setup_type) &&
    !flags.some((flag) => ["DUPLICATE_OUTCOME", "ORPHAN_OUTCOME", "SHADOW_ONLY_MISMATCH", "MISSING_OUTCOME"].includes(flag));
  return rowWithShadow(record);
}

function durationMinutes(start, end) {
  const a = dateMs(start);
  const b = dateMs(end);
  if (a === null || b === null || b < a) return null;
  return round((b - a) / 60000, 1);
}

async function fetchAll() {
  const limit = Number(argValue("--limit", "10000"));
  const [alerts, outcomes, candidates, shadows] = await Promise.all([
    selectRows(
      "alerts",
      `?select=alert_id,ref_id,symbol,direction,timeframe,setup_type,entry_price,tp_price,sl_price,rr,quality_score,quality_grade,signal_time_utc,session_name,market_regime,raw_payload&order=signal_time_utc.asc&limit=${limit}`,
    ),
    selectRows(
      "outcomes",
      `?select=alert_id,ref_id,candidate_key,symbol,direction,outcome_type,outcome_time_utc,closed_at_utc,pnl_percent,move_pct,r_multiple,duration_minutes,exit_price,raw_payload&order=outcome_time_utc.asc&limit=${limit}`,
    ),
    selectRows(
      "alert_candidates",
      `?select=candidate_key,alert_id,ref_id,symbol,direction,timeframe,entry_price,tp1_price,sl_price,rr,rsi,trend_strength,atr_pct,volatility_pct,session_name,market_regime,setup_type,setup_score,strength,event_time_utc,decision,quality_score,quality_grade,raw_payload&order=event_time_utc.asc&limit=${limit}`,
    ),
    selectRows(
      "shadow_score_evaluations",
      `?select=shadow_version,candidate_key,alert_id,ref_id,symbol,direction,timeframe,setup_type,current_score,current_grade,proposed_score,proposed_grade,score_components,outcome_type,outcome_time_utc,market_move_pct,r_multiple,event_time_utc,evaluated_at_utc&order=event_time_utc.asc&limit=${limit}`,
    ).catch(() => []),
  ]);

  return { alerts, outcomes, candidates, shadows };
}

function buildRecords({ alerts, outcomes, candidates, shadows }) {
  const outcomeByAlert = indexBy(outcomes, "alert_id");
  const outcomeByRef = indexBy(outcomes, "ref_id");
  const outcomeByCandidate = indexBy(outcomes, "candidate_key");
  const candidateByAlert = indexBy(candidates, "alert_id");
  const candidateByRef = indexBy(candidates, "ref_id");
  const candidateByKey = indexBy(candidates, "candidate_key");
  const shadowByAlert = indexBy(shadows, "alert_id");
  const shadowByRef = indexBy(shadows, "ref_id");
  const shadowByCandidate = indexBy(shadows, "candidate_key");
  const alertByAlert = indexBy(alerts, "alert_id");
  const alertByRef = indexBy(alerts, "ref_id");

  const duplicateRefs = new Set([...alertByRef.entries()].filter(([, items]) => items.length > 1).map(([key]) => key));
  const duplicateOutcomes = new Set();
  for (const [key, items] of outcomeByRef.entries()) {
    if (key && items.length > 1) for (const item of items) duplicateOutcomes.add(item);
  }

  const records = [];
  const usedCandidates = new Set();
  const usedOutcomes = new Set();
  const usedShadows = new Set();

  for (const alert of alerts) {
    const candidate = firstFromMaps(alert, {
      alert_id: candidateByAlert,
      ref_id: candidateByRef,
    });
    const outcome = firstFromMaps(alert, {
      alert_id: outcomeByAlert,
      ref_id: outcomeByRef,
    });
    const shadow = firstFromMaps(alert, {
      alert_id: shadowByAlert,
      ref_id: shadowByRef,
    });
    if (candidate) usedCandidates.add(candidate);
    if (outcome) usedOutcomes.add(outcome);
    if (shadow) usedShadows.add(shadow);

    const flags = [];
    if (duplicateRefs.has(String(alert.ref_id || ""))) flags.push("DUPLICATE_REF");
    if (!outcome) flags.push("MISSING_OUTCOME");
    if (!shadow) flags.push("MISSING_SHADOW_ROW");
    if (outcome && duplicateOutcomes.has(outcome)) flags.push("DUPLICATE_OUTCOME");

    records.push(makeRecord("alerts", alert, candidate, outcome, shadow, flags));
  }

  for (const candidate of candidates) {
    if (usedCandidates.has(candidate)) continue;
    const alert = firstFromMaps(candidate, { alert_id: alertByAlert, ref_id: alertByRef });
    const outcome = firstFromMaps(candidate, {
      alert_id: outcomeByAlert,
      ref_id: outcomeByRef,
      candidate_key: outcomeByCandidate,
    });
    const shadow = firstFromMaps(candidate, {
      alert_id: shadowByAlert,
      ref_id: shadowByRef,
      candidate_key: shadowByCandidate,
    });
    if (outcome) usedOutcomes.add(outcome);
    if (shadow) usedShadows.add(shadow);
    if (alert) continue;
    const flags = ["CANDIDATE_ONLY"];
    if (!outcome) flags.push("MISSING_OUTCOME");
    if (!shadow) flags.push("MISSING_SHADOW_ROW");
    if (outcome && duplicateOutcomes.has(outcome)) flags.push("DUPLICATE_OUTCOME");
    records.push(makeRecord("alert_candidates", null, candidate, outcome, shadow, flags));
  }

  for (const outcome of outcomes) {
    if (usedOutcomes.has(outcome)) continue;
    const alert = firstFromMaps(outcome, { alert_id: alertByAlert, ref_id: alertByRef });
    const candidate = firstFromMaps(outcome, {
      alert_id: candidateByAlert,
      ref_id: candidateByRef,
      candidate_key: candidateByKey,
    });
    const shadow = firstFromMaps(outcome, {
      alert_id: shadowByAlert,
      ref_id: shadowByRef,
      candidate_key: shadowByCandidate,
    });
    if (alert || candidate) continue;
    records.push(makeRecord("outcomes", null, null, outcome, shadow, ["ORPHAN_OUTCOME"]));
  }

  for (const shadow of shadows) {
    if (usedShadows.has(shadow)) continue;
    const alert = firstFromMaps(shadow, { alert_id: alertByAlert, ref_id: alertByRef });
    const candidate = firstFromMaps(shadow, {
      alert_id: candidateByAlert,
      ref_id: candidateByRef,
      candidate_key: candidateByKey,
    });
    if (alert || candidate) continue;
    records.push(makeRecord("shadow_score_evaluations", null, null, null, shadow, ["SHADOW_ONLY_MISMATCH"]));
  }

  return records;
}

function dataAudit({ raw, records }) {
  const reliable = records.filter((row) => row.reliable);
  const closed = records.filter((row) => RELIABLE_CLOSED_OUTCOMES.has(row.outcome_type));
  const flags = {};
  for (const record of records) {
    for (const flag of record.flags) flags[flag] = (flags[flag] || 0) + 1;
  }
  const identities = new Map();
  for (const row of records) {
    if (!identities.has(row.identity)) identities.set(row.identity, []);
    identities.get(row.identity).push(row);
  }
  const duplicateIdentityCount = [...identities.values()].filter((items) => items.length > 1).reduce((sum, items) => sum + items.length - 1, 0);

  return {
    total_raw_alerts: raw.alerts.length,
    total_raw_candidates: raw.candidates.length,
    total_raw_outcomes: raw.outcomes.length,
    total_raw_shadow_rows: raw.shadows.length,
    total_joined_records: records.length,
    total_usable_alerts: reliable.length,
    total_closed_outcomes: closed.length,
    tp_count: reliable.filter((row) => TP_OUTCOMES.has(row.outcome_type)).length,
    sl_count: reliable.filter((row) => row.outcome_type === "SL").length,
    unreliable_excluded_count: records.length - reliable.length,
    duplicate_identity_count: duplicateIdentityCount,
    flags,
  };
}

function renderMarkdown(report) {
  const line = (text = "") => console.log(text);
  const table = (rows, columns) => {
    line(`| ${columns.map((column) => column.label).join(" | ")} |`);
    line(`| ${columns.map(() => "---").join(" | ")} |`);
    for (const row of rows) {
      line(`| ${columns.map((column) => row[column.key] ?? "").join(" | ")} |`);
    }
  };

  line("# D-ALRT TP-First Historical Rebuild");
  line(`Generated UTC: ${report.generated_at_utc}`);
  line("Simulation only. Live scoring, Telegram, Pine and auto-tuning were not changed.");
  line("");
  line("## Data Audit");
  table([report.data_audit], [
    { key: "total_raw_alerts", label: "Raw Alerts" },
    { key: "total_raw_candidates", label: "Candidates" },
    { key: "total_raw_outcomes", label: "Outcomes" },
    { key: "total_raw_shadow_rows", label: "Shadow Rows" },
    { key: "total_usable_alerts", label: "Usable" },
    { key: "total_closed_outcomes", label: "Closed" },
    { key: "tp_count", label: "TP" },
    { key: "sl_count", label: "SL" },
    { key: "unreliable_excluded_count", label: "Excluded" },
  ]);
  line("");
  line("## Best TP-Producing Single Buckets");
  table(report.tp_patterns.best_single_buckets.slice(0, 15), [
    { key: "bucket", label: "Bucket" },
    { key: "value", label: "Value" },
    { key: "sample", label: "Sample" },
    { key: "tp", label: "TP" },
    { key: "sl", label: "SL" },
    { key: "tp_rate_pct", label: "TP Rate" },
    { key: "expectancy_r", label: "Expectancy" },
    { key: "confidence", label: "Confidence" },
  ]);
  line("");
  line("## Best TP-Producing Combinations");
  table(report.tp_patterns.best_combinations.slice(0, 15), [
    { key: "combination", label: "Combination" },
    { key: "pattern", label: "Pattern" },
    { key: "sample", label: "Sample" },
    { key: "tp", label: "TP" },
    { key: "sl", label: "SL" },
    { key: "tp_rate_pct", label: "TP Rate" },
    { key: "expectancy_r", label: "Expectancy" },
    { key: "confidence", label: "Confidence" },
  ]);
  line("");
  line("## Worst SL Patterns");
  table(report.sl_blacklist.slice(0, 15), [
    { key: "pattern", label: "Pattern" },
    { key: "sample", label: "Sample" },
    { key: "tp_lost_if_blocked", label: "TP Lost" },
    { key: "sl_avoided_if_blocked", label: "SL Avoided" },
    { key: "sl_rate_pct", label: "SL Rate" },
    { key: "expectancy_r", label: "Expectancy" },
    { key: "expectancy_improvement_if_blocked", label: "Exp Improvement" },
    { key: "confidence", label: "Confidence" },
  ]);
  line("");
  line("## Model Comparison");
  for (const [window, rows] of Object.entries(report.backtest)) {
    line(`### ${window}`);
    table(rows, [
      { key: "model", label: "Model" },
      { key: "closed", label: "Closed" },
      { key: "tp", label: "TP" },
      { key: "sl", label: "SL" },
      { key: "winrate_pct", label: "Winrate" },
      { key: "expectancy_r", label: "Expectancy" },
      { key: "average_market_move_pct", label: "Avg Move" },
      { key: "false_a_plus_count", label: "False A+" },
      { key: "alert_volume_reduction_pct", label: "Volume Reduction" },
    ]);
    line("");
  }
  line("## TP_FIRST_MODEL_V1 Rules");
  line(`Positive patterns: ${report.tp_first_model.positive_patterns.length}`);
  line(`Negative patterns: ${report.tp_first_model.negative_patterns.length}`);
  line(`Gate default: ${report.launch_gate.default_enabled ? "enabled" : "disabled"}`);
  line(`Recommendation: ${report.recommendation}`);
}

async function main() {
  if (!ready()) {
    console.error("Missing Supabase env: SUPABASE_ENABLED=true, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
    process.exitCode = 1;
    return;
  }

  const minReportSample = Number(argValue("--min-report-sample", "3"));
  const minModelSample = Number(argValue("--min-model-sample", "20"));
  const raw = await fetchAll();
  const records = buildRecords(raw);
  const reliable = records.filter((row) => row.reliable);
  const baseline = summarize(reliable, "all reliable history");
  const bucketRows = SINGLE_BUCKETS.flatMap((bucket) => groupStats(reliable, bucket, baseline, minReportSample));
  const comboRows = COMBINATION_BUCKETS.flatMap((combo) => combinationStats(reliable, combo, baseline, minReportSample));
  const slRows = slPatternStats(reliable, baseline);
  const rules = buildTpFirstRules({
    bucketRows,
    comboRows,
    slRows,
    baseline,
    minModelSample,
  });
  const classified = reliable.map((row) => ({
    ...row,
    tp_first: classifyTpFirst(row, rules),
  }));

  const report = {
    ok: true,
    generated_at_utc: new Date().toISOString(),
    simulation_only: true,
    live_changes_made: false,
    source_tables: ["alerts", "alert_candidates", "outcomes", "shadow_score_evaluations"],
    data_audit: dataAudit({ raw, records }),
    baseline,
    tp_patterns: {
      best_single_buckets: bucketRows
        .filter((row) => row.sample >= minReportSample)
        .sort((a, b) => {
          if ((b.tp_rate_pct ?? -Infinity) !== (a.tp_rate_pct ?? -Infinity)) return (b.tp_rate_pct ?? -Infinity) - (a.tp_rate_pct ?? -Infinity);
          return (b.expectancy_r ?? -Infinity) - (a.expectancy_r ?? -Infinity);
        })
        .slice(0, 100),
      best_combinations: comboRows
        .filter((row) => row.sample >= minReportSample)
        .sort((a, b) => {
          if ((b.tp_rate_pct ?? -Infinity) !== (a.tp_rate_pct ?? -Infinity)) return (b.tp_rate_pct ?? -Infinity) - (a.tp_rate_pct ?? -Infinity);
          return (b.expectancy_r ?? -Infinity) - (a.expectancy_r ?? -Infinity);
        })
        .slice(0, 100),
    },
    sl_blacklist: slRows,
    tp_first_model: rules,
    backtest: {
      all_reliable_history: compareModels(classified, rules, "all"),
      last_30_days: compareModels(classified, rules, "last_30_days"),
      last_7_days: compareModels(classified, rules, "last_7_days"),
      most_recent_100_closed: compareModels(classified, rules, "recent_100"),
    },
    launch_gate: {
      env_name: "TP_FIRST_GATE_ENABLED",
      default_enabled: false,
      modes: ["staging_only", "free_only", "paid_later"],
      allow_classes: ["TP_FIRST_A", "TP_FIRST_A+"],
      block_classes: ["REVIEW", "AVOID"],
      note: "Gate is designed only; no runtime code or production behavior was changed.",
    },
    recommendation: "Run on Render with production Supabase env, review sample confidence, then consider staging_only only if TP_FIRST_MODEL_V1 beats Current, Shadow V1 and Shadow V2.1 with medium/high-confidence patterns.",
  };

  if (hasFlag("--markdown")) {
    renderMarkdown(report);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((err) => {
  console.error("TP-first historical rebuild failed:", err);
  process.exitCode = 1;
});
