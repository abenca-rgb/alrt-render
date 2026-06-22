import { evaluateShadowScoreV2 } from "../../src/services/shadowScoringService.js";

const SUPABASE_ENABLED = String(process.env.SUPABASE_ENABLED || "false").toLowerCase() === "true";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const WIN_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL", "TIME_EXIT_PROFIT"]);
const LOSS_OUTCOMES = new Set(["SL", "TIME_EXIT_LOSS"]);
const CLOSED_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL", "SL", "TIME_EXIT_PROFIT", "TIME_EXIT_LOSS"]);
const SHADOW_V1_VERSION = "shadow-score-v1";

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
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

function clampScore(value) {
  const n = numberOrNull(value);
  if (n === null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function componentValue(row, field) {
  const c = row.score_components || {};
  if (field === "setup") return normalize(row.setup_type || c.setup);
  if (field === "symbol") return normalize(row.symbol || c.symbol);
  if (field === "session") return normalize(c.session || row.session_name);
  if (field === "regime") return normalize(c.regime || row.market_regime);
  if (field === "rsi_bucket") return normalize(c.rsi_bucket);
  if (field === "trend_strength") return numberOrNull(c.trend_strength);
  if (field === "trend_strength_bucket") return normalize(c.trend_strength_bucket || bucketTrend(c.trend_strength));
  return normalize(c[field] || row[field]);
}

function bucketTrend(value) {
  const trend = numberOrNull(value);
  if (trend === null) return "UNKNOWN";
  if (trend < 14) return "<14";
  if (trend < 22) return "14-21";
  return "22+";
}

function average(values) {
  const clean = values.map(numberOrNull).filter((value) => value !== null);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function estimatedR(row) {
  const actual = numberOrNull(row.r_multiple);
  if (actual !== null) return actual;
  if (WIN_OUTCOMES.has(row.outcome_type)) return numberOrNull(row.score_components?.rr) ?? 1;
  if (LOSS_OUTCOMES.has(row.outcome_type)) return -1;
  return null;
}

function summarize(rows, label, baselineCount = null, gradeField = null) {
  const closed = rows.filter((row) => CLOSED_OUTCOMES.has(row.outcome_type));
  const wins = closed.filter((row) => WIN_OUTCOMES.has(row.outcome_type));
  const losses = closed.filter((row) => LOSS_OUTCOMES.has(row.outcome_type));
  const tp = closed.filter((row) => ["TP", "TP1", "TP2", "TP_FULL"].includes(row.outcome_type));
  const sl = closed.filter((row) => row.outcome_type === "SL");
  const falseAPlus = gradeField
    ? closed.filter((row) => row[gradeField] === "A+" && LOSS_OUTCOMES.has(row.outcome_type)).length
    : closed.filter((row) => row.current_grade === "A+" && LOSS_OUTCOMES.has(row.outcome_type)).length;

  return {
    model: label,
    closed: closed.length,
    tp: tp.length,
    sl: sl.length,
    winrate_pct: closed.length ? round((wins.length / closed.length) * 100, 2) : null,
    expectancy_r: round(average(closed.map(estimatedR)), 3),
    average_market_move_pct: round(average(closed.map((row) => row.market_move_pct)), 4),
    false_a_plus: falseAPlus,
    volume_reduction_pct: baselineCount ? round(((baselineCount - closed.length) / baselineCount) * 100, 2) : 0,
  };
}

function contextFromRow(row) {
  const c = row.score_components || {};
  return {
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
  };
}

function strongSupport(row) {
  return {
    compression: componentValue(row, "regime") === "COMPRESSION",
    london: componentValue(row, "session") === "LONDON",
    rsi45To54: componentValue(row, "rsi_bucket") === "45-54",
    compressionBreakout: componentValue(row, "setup") === "COMPRESSION_BREAKOUT",
  };
}

function strongSupportCount(row) {
  return Object.values(strongSupport(row)).filter(Boolean).length;
}

function gradeFromScore(score, { majorPenaltyActive = false, positiveSupportActive = false } = {}) {
  const numeric = numberOrNull(score);
  if (numeric === null) return "UNKNOWN";
  if (numeric >= 92 && !majorPenaltyActive && positiveSupportActive) return "A+";
  if (numeric >= 84) return "A";
  if (numeric >= 75) return "B+";
  return "B";
}

function applyV21(row) {
  const next = {
    ...row,
    v21_score: row.v2_score,
    v21_grade: row.v2_grade,
    v21_reasons: [],
  };

  if (next.v21_grade !== "A+") return next;

  const setup = componentValue(row, "setup");
  const session = componentValue(row, "session");
  const regime = componentValue(row, "regime");
  const rsiBucket = componentValue(row, "rsi_bucket");
  const support = strongSupport(row);
  const supportCount = strongSupportCount(row);
  const reasons = [];

  if (["35-44", "55-64"].includes(rsiBucket)) reasons.push(`rsi_${rsiBucket}_blocks_a_plus`);
  if (setup === "TREND_PULLBACK" && supportCount < 1) reasons.push("trend_pullback_requires_additional_strong_support");
  if (session === "NEUTRAL" && supportCount < 1) reasons.push("neutral_session_requires_strong_support");
  if (regime === "TREND" && supportCount < 1) reasons.push("trend_regime_requires_strong_support");
  if (setup === "LIQUIDITY_RECLAIM" && !(support.london || support.compression)) {
    reasons.push("liquidity_reclaim_requires_london_or_compression");
  }

  if (reasons.length) {
    next.v21_grade = "A";
    next.v21_reasons = reasons;
  }

  return next;
}

function applyV22(row) {
  const next = {
    ...row,
    v22_score: row.v21_score,
    v22_grade: row.v21_grade,
    v22_penalty_reasons: [...(row.v21_reasons || [])],
    v22_major_penalty_active: false,
  };

  const setup = componentValue(row, "setup");
  const session = componentValue(row, "session");
  const symbol = componentValue(row, "symbol");
  const trendBucket = componentValue(row, "trend_strength_bucket");
  const supportCount = strongSupportCount(row);

  function penalty(amount, reason, major = false) {
    next.v22_score = clampScore((next.v22_score ?? row.current_score ?? 0) - amount);
    next.v22_penalty_reasons.push(reason);
    if (major) next.v22_major_penalty_active = true;
  }

  if (trendBucket === "22+") penalty(18, "v22_high_confidence_sl_pattern:trend_strength_22_plus", true);
  if (setup === "HTF_CONTINUATION") penalty(10, "v22_stronger_penalty:HTF_CONTINUATION", true);
  if (session === "NEUTRAL") penalty(14, "v22_stronger_penalty:NEUTRAL_session", true);
  if (symbol === "SOLUSDT") penalty(8, "v22_stronger_penalty:SOLUSDT", true);

  const positiveSupportActive = supportCount > 0;
  next.v22_grade = gradeFromScore(next.v22_score, {
    majorPenaltyActive: next.v22_major_penalty_active,
    positiveSupportActive,
  });

  if (next.v22_major_penalty_active && supportCount === 0 && next.v22_grade === "A") {
    next.v22_grade = "B+";
    next.v22_penalty_reasons.push("v22_block:no_positive_support_with_major_sl_pattern");
  }

  return next;
}

function enrichRows(rows) {
  return rows.map((row) => {
    const v2 = evaluateShadowScoreV2({
      context: contextFromRow(row),
      quality: {
        score: row.current_score,
        grade: row.current_grade,
      },
    });
    return {
      ...row,
      v2_score: v2.proposedScore,
      v2_grade: v2.proposedGrade,
      v2_penalty_reasons: v2.penaltyReasons,
      v2_bonus_reasons: v2.bonusReasons,
      v2_major_penalty_active: v2.majorPenaltyActive,
    };
  }).map(applyV21).map(applyV22);
}

async function fetchRows() {
  const limit = Number(argValue("--limit", "10000"));
  const rows = await selectRows(
    "shadow_score_evaluations",
    [
      "?select=shadow_version,candidate_key,alert_id,ref_id,symbol,direction,timeframe,setup_type,current_score,current_grade,proposed_score,proposed_grade,score_delta,score_components,penalty_reasons,bonus_reasons,outcome_type,outcome_time_utc,market_move_pct,r_multiple,event_time_utc",
      `shadow_version=eq.${encodeURIComponent(SHADOW_V1_VERSION)}`,
      "order=event_time_utc.asc",
      `limit=${limit}`,
    ].join("&"),
  );
  return rows.filter((row) => CLOSED_OUTCOMES.has(row.outcome_type));
}

function accepted(rows, gradeField) {
  return rows.filter((row) => ["A+", "A"].includes(row[gradeField]));
}

function blockedComparedToV21(rows) {
  return rows
    .filter((row) => ["A+", "A"].includes(row.v21_grade) && !["A+", "A"].includes(row.v22_grade))
    .map((row) => ({
      ref_id: row.ref_id || "",
      symbol: componentValue(row, "symbol"),
      direction: normalize(row.direction || row.score_components?.direction),
      setup: componentValue(row, "setup"),
      session: componentValue(row, "session"),
      regime: componentValue(row, "regime"),
      trend_bucket: componentValue(row, "trend_strength_bucket"),
      outcome: row.outcome_type,
      v21_grade: row.v21_grade,
      v22_grade: row.v22_grade,
      v22_score: row.v22_score,
      reasons: row.v22_penalty_reasons.join("; "),
    }));
}

function reasonSummary(blocked) {
  const counts = new Map();
  for (const row of blocked) {
    for (const reason of row.reasons.split("; ").filter(Boolean)) {
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

function buildReport(rows) {
  const enriched = enrichRows(rows);
  const baselineCount = enriched.length;
  const current = summarize(enriched, "Current model", baselineCount, null);
  const v1 = summarize(accepted(enriched, "proposed_grade"), "Shadow V1", baselineCount, "proposed_grade");
  const v21 = summarize(accepted(enriched, "v21_grade"), "Shadow V2.1", baselineCount, "v21_grade");
  const v22 = summarize(accepted(enriched, "v22_grade"), "Shadow V2.2", baselineCount, "v22_grade");
  const blocked = blockedComparedToV21(enriched);

  return {
    ok: true,
    generated_at_utc: new Date().toISOString(),
    simulation_only: true,
    live_changes_made: false,
    tp_first_gate_enabled: false,
    v22_rules: [
      "Strengthen/block trend_strength >= 22 as high-confidence SL pattern.",
      "Add stronger extra penalty for HTF_CONTINUATION.",
      "Add stronger penalty for NEUTRAL session.",
      "Add stronger penalty for SOLUSDT.",
      "Keep A+/A acceptance simulation only; no live scoring changes.",
    ],
    comparison: [current, v1, v21, v22],
    blocked_compared_to_v21: blocked,
    blocked_reason_summary: reasonSummary(blocked),
    v22_vs_v21: {
      winrate_delta_pct: v22.winrate_pct === null || v21.winrate_pct === null ? null : round(v22.winrate_pct - v21.winrate_pct, 2),
      expectancy_delta_r: v22.expectancy_r === null || v21.expectancy_r === null ? null : round(v22.expectancy_r - v21.expectancy_r, 3),
      avg_move_delta_pct: v22.average_market_move_pct === null || v21.average_market_move_pct === null ? null : round(v22.average_market_move_pct - v21.average_market_move_pct, 4),
      closed_delta: v22.closed - v21.closed,
      additional_volume_reduction_pct: v21.closed ? round(((v21.closed - v22.closed) / v21.closed) * 100, 2) : null,
      false_a_plus_delta: v22.false_a_plus - v21.false_a_plus,
    },
    recommendation: (
      (v22.expectancy_r ?? -Infinity) > (v21.expectancy_r ?? -Infinity) &&
      (v22.winrate_pct ?? -Infinity) >= (v21.winrate_pct ?? -Infinity) &&
      (v22.closed / Math.max(v21.closed, 1)) >= 0.55
    )
      ? "V2.2 improves V2.1 without killing too much volume; keep simulation-only and collect more outcomes before staging."
      : "Do not promote V2.2 yet; keep as simulation-only because it does not clearly improve V2.1 on winrate/expectancy/volume tradeoff.",
  };
}

function renderMarkdown(report) {
  const line = (text = "") => console.log(text);
  const table = (rows, columns) => {
    line(`| ${columns.map((column) => column.label).join(" | ")} |`);
    line(`| ${columns.map(() => "---").join(" | ")} |`);
    for (const row of rows) line(`| ${columns.map((column) => row[column.key] ?? "").join(" | ")} |`);
  };

  line("# D-ALRT Shadow V2.2 Simulation");
  line(`Generated UTC: ${report.generated_at_utc}`);
  line("Simulation only. Live scoring, Pine, Telegram, routes, website/payment/portal logic were not changed.");
  line(`TP_FIRST_GATE_ENABLED: ${report.tp_first_gate_enabled}`);
  line("");
  line("## V2.2 Rules Tested");
  for (const rule of report.v22_rules) line(`- ${rule}`);
  line("");
  line("## Current vs Shadow V1 vs Shadow V2.1 vs Shadow V2.2");
  table(report.comparison, [
    { key: "model", label: "Model" },
    { key: "closed", label: "Closed" },
    { key: "tp", label: "TP" },
    { key: "sl", label: "SL" },
    { key: "winrate_pct", label: "Winrate" },
    { key: "expectancy_r", label: "Expectancy" },
    { key: "average_market_move_pct", label: "Avg Move" },
    { key: "false_a_plus", label: "False A+" },
    { key: "volume_reduction_pct", label: "Volume Reduction" },
  ]);
  line("");
  line("## V2.2 vs V2.1 Delta");
  table([report.v22_vs_v21], [
    { key: "winrate_delta_pct", label: "Winrate Delta" },
    { key: "expectancy_delta_r", label: "Expectancy Delta" },
    { key: "avg_move_delta_pct", label: "Avg Move Delta" },
    { key: "closed_delta", label: "Closed Delta" },
    { key: "additional_volume_reduction_pct", label: "Additional Volume Reduction" },
    { key: "false_a_plus_delta", label: "False A+ Delta" },
  ]);
  line("");
  line("## V2.2 Blocks Compared To V2.1");
  table(report.blocked_compared_to_v21, [
    { key: "ref_id", label: "Ref" },
    { key: "symbol", label: "Symbol" },
    { key: "direction", label: "Direction" },
    { key: "setup", label: "Setup" },
    { key: "session", label: "Session" },
    { key: "regime", label: "Regime" },
    { key: "trend_bucket", label: "Trend" },
    { key: "outcome", label: "Outcome" },
    { key: "v21_grade", label: "V2.1" },
    { key: "v22_grade", label: "V2.2" },
    { key: "v22_score", label: "V2.2 Score" },
    { key: "reasons", label: "Reasons" },
  ]);
  line("");
  line("## Block Reason Summary");
  table(report.blocked_reason_summary, [
    { key: "reason", label: "Reason" },
    { key: "count", label: "Count" },
  ]);
  line("");
  line(`## Recommendation`);
  line(report.recommendation);
}

async function main() {
  if (!ready()) {
    console.error("Missing Supabase env: SUPABASE_ENABLED=true, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
    process.exitCode = 1;
    return;
  }

  const report = buildReport(await fetchRows());
  if (hasFlag("--markdown")) renderMarkdown(report);
  else console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("Shadow V2.2 simulation failed:", err);
  process.exitCode = 1;
});
