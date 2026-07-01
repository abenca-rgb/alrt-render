import { getSymbolConfig } from "../../src/config/symbols.js";
import { scoreAlertQuality } from "../../src/services/alertScoring.js";
import {
  SHADOW_SCORING_V21_VERSION,
  evaluateShadowScoreV21,
} from "../../src/services/shadowScoringService.js";

const SUPABASE_ENABLED = String(process.env.SUPABASE_ENABLED || "false").toLowerCase() === "true";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const HISTORICAL_QUALITY_ADJUSTMENTS_ENABLED =
  String(process.env.HISTORICAL_QUALITY_ADJUSTMENTS_ENABLED || "false").toLowerCase() === "true";
const WIN_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL", "TIME_EXIT_PROFIT"]);
const LOSS_OUTCOMES = new Set(["SL", "TIME_EXIT_LOSS"]);
const CLOSED_OUTCOMES = new Set([
  "TP",
  "TP1",
  "TP2",
  "TP_FULL",
  "SL",
  "TIME_EXIT_PROFIT",
  "TIME_EXIT_LOSS",
  "EXPIRED",
  "MANUAL_CLOSE",
]);

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

function normalize(value, fallback = "UNKNOWN") {
  const text = String(value || "").trim().toUpperCase();
  return text || fallback;
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

function pct(part, total) {
  return total ? round((part / total) * 100, 2) : 0;
}

function average(values) {
  const clean = values.map(numberOrNull).filter((value) => value !== null);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function inFilter(values) {
  return `in.(${values.map((value) => `"${String(value).replace(/"/g, '\\"')}"`).join(",")})`;
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function tpPctFromContext(context) {
  const entry = numberOrNull(context.entry);
  const tp = numberOrNull(context.tp);
  if (!entry || tp === null) return null;
  return Math.abs((tp - entry) / entry) * 100;
}

function slPctFromContext(context) {
  const entry = numberOrNull(context.entry);
  const sl = numberOrNull(context.sl);
  if (!entry || sl === null) return null;
  return Math.abs((entry - sl) / entry) * 100;
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
    entry: c.entry,
    tp: c.tp,
    sl: c.sl,
  };
}

function contextFromCandidateRow(row) {
  const raw = row.raw_payload || {};
  return {
    candidateKey: row.candidate_key || row.alert_id || row.ref_id,
    symbol: row.symbol || raw.symbol,
    side: row.direction || raw.direction || raw.side,
    timeframe: row.timeframe || raw.timeframe,
    setupType: row.setup_type || raw.setup_type || raw.setup,
    rr: row.rr ?? raw.rr,
    strength: row.strength || raw.strength,
    setupScore: row.setup_score ?? raw.setup_score,
    trendStrength: row.trend_strength ?? raw.trend_strength ?? raw.adx,
    marketRegime: row.market_regime || raw.market_regime || raw.volatility_state || raw.regime,
    volatilityState: raw.volatility_state,
    session: row.session_name || raw.session_name || raw.session,
    rsi: row.rsi ?? raw.rsi,
    atrPct: row.atr_pct ?? raw.atr_pct ?? raw.atrPercent ?? raw.atr_percent,
    entry: row.entry_price ?? raw.entry ?? raw.entry_price ?? raw.entryPrice ?? raw.price,
    tp: row.tp1_price ?? raw.tp1 ?? raw.tp ?? raw.take_profit ?? raw.takeProfit,
    sl: row.sl_price ?? raw.sl ?? raw.stop_loss ?? raw.stopLoss,
    eventTimeUtc: row.event_time_utc || null,
  };
}

async function fetchRows() {
  const limit = Number(argValue("--limit", "50"));
  const candidates = await fetchCandidateRows(limit);

  if (!candidates.length) return [];

  const candidateKeys = unique(candidates.map((row) => row.candidate_key));
  const alertIds = unique(candidates.map((row) => row.alert_id));
  const refIds = unique(candidates.map((row) => row.ref_id));

  const [shadowRows, outcomeRows] = await Promise.all([
    fetchShadowRows(candidateKeys),
    fetchOutcomeRows({ candidateKeys, alertIds, refIds }),
  ]);

  const shadowByCandidate = new Map(shadowRows.map((row) => [String(row.candidate_key), row]));
  const outcomesByCandidate = new Map(outcomeRows.map((row) => [String(row.candidate_key || ""), row]));
  const outcomesByAlert = new Map(outcomeRows.map((row) => [String(row.alert_id || ""), row]));
  const outcomesByRef = new Map(outcomeRows.map((row) => [String(row.ref_id || ""), row]));

  return candidates.map((row) => {
    const shadow = shadowByCandidate.get(String(row.candidate_key || "")) || null;
    const outcome =
      outcomesByCandidate.get(String(row.candidate_key || "")) ||
      outcomesByAlert.get(String(row.alert_id || "")) ||
      outcomesByRef.get(String(row.ref_id || "")) ||
      null;

    return {
      source: "alert_candidates",
      raw: row,
      shadow,
      outcome,
      context: contextFromCandidateRow(row),
      current_score: firstValue(row.quality_score, row.current_score),
      current_grade: firstValue(row.quality_grade, row.current_grade),
      decision: row.decision || "",
      decision_reason: row.decision_reason || "",
      event_time_utc: row.event_time_utc || "",
    };
  });
}

async function fetchCandidateRows(limit) {
  const baseSelect = "candidate_key,alert_id,ref_id,symbol,direction,timeframe,entry_price,tp1_price,sl_price,rr,rsi,trend_strength,atr_pct,session_name,market_regime,setup_type,setup_score,strength,event_time_utc,decision,decision_reason,quality_score,quality_grade,posted_to_paid,posted_to_free,raw_payload";
  const v21Select = `${baseSelect},current_score,current_grade,proposed_score,proposed_grade,shadow_v21_score,shadow_v21_grade,shadow_v21_decision,shadow_v21_block_reason`;
  const suffix = ["order=event_time_utc.desc", `limit=${limit}`].join("&");

  try {
    return await selectRows("alert_candidates", `?select=${v21Select}&${suffix}`);
  } catch (err) {
    const message = String(err?.message || err);
    if (!message.includes("shadow_v21_") && !message.includes("current_score") && !message.includes("proposed_score")) {
      throw err;
    }
    return selectRows("alert_candidates", `?select=${baseSelect}&${suffix}`);
  }
}

async function fetchShadowRows(candidateKeys) {
  if (!candidateKeys.length) return [];

  return selectRows(
    "shadow_score_evaluations",
    [
      "?select=shadow_version,candidate_key,alert_id,ref_id,symbol,direction,timeframe,setup_type,current_score,current_grade,proposed_score,proposed_grade,score_components,penalty_reasons,bonus_reasons,live_decision,decision_reason,event_time_utc,posted_to_paid,posted_to_free,outcome_type,market_move_pct,r_multiple",
      `shadow_version=eq.${encodeURIComponent(SHADOW_SCORING_V21_VERSION)}`,
      `candidate_key=${encodeURIComponent(inFilter(candidateKeys))}`,
      "order=event_time_utc.desc",
      "limit=10000",
    ].join("&"),
  );
}

async function fetchOutcomeRows({ candidateKeys, alertIds, refIds }) {
  const queries = [];
  const select = "candidate_key,alert_id,ref_id,outcome_type,move_pct,pnl_percent,r_multiple,outcome_time_utc,closed_at_utc";

  if (candidateKeys.length) {
    queries.push(selectRows(
      "outcomes",
      `?select=${select}&candidate_key=${encodeURIComponent(inFilter(candidateKeys))}&limit=10000`,
    ));
  }
  if (alertIds.length) {
    queries.push(selectRows(
      "outcomes",
      `?select=${select}&alert_id=${encodeURIComponent(inFilter(alertIds))}&limit=10000`,
    ));
  }
  if (refIds.length) {
    queries.push(selectRows(
      "outcomes",
      `?select=${select}&ref_id=${encodeURIComponent(inFilter(refIds))}&limit=10000`,
    ));
  }

  const results = await Promise.all(queries);
  const byKey = new Map();
  for (const row of results.flat()) {
    const key = `${row.candidate_key || ""}:${row.alert_id || ""}:${row.ref_id || ""}`;
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

function missingContextFields(context) {
  const required = {
    symbol: context.symbol,
    direction: context.side,
    setup: context.setupType,
    session: context.session,
    regime: context.marketRegime || context.volatilityState,
    rr: context.rr,
    entry: context.entry,
    tp: context.tp,
    sl: context.sl,
  };
  return Object.entries(required)
    .filter(([, value]) => value === null || value === undefined || value === "")
    .map(([key]) => key);
}

function qualityFromCandidate(row) {
  if (row.current_score !== null && row.current_score !== undefined && row.current_score !== "") {
    return {
      score: row.current_score,
      grade: row.current_grade,
      source: "alert_candidates",
      missingFields: [],
    };
  }

  if (row.shadow?.current_score !== null && row.shadow?.current_score !== undefined && row.shadow?.current_score !== "") {
    return {
      score: row.shadow.current_score,
      grade: row.shadow.current_grade,
      source: "shadow_score_evaluations",
      missingFields: [],
    };
  }

  const context = row.context || {};
  const missing = missingContextFields(context);
  const symbol = normalize(context.symbol, "");
  const side = normalize(context.side, "");
  const symbolConfig = symbol ? getSymbolConfig(symbol) : null;
  const tpPct = tpPctFromContext(context);
  const slPct = slPctFromContext(context);

  if (!symbolConfig || !symbol || !side || !context.setupType || !context.session || !context.rr) {
    return {
      score: null,
      grade: null,
      source: "unscorable",
      missingFields: missing,
    };
  }

  const quality = scoreAlertQuality({
    symbolConfig,
    symbol,
    side,
    setupType: context.setupType,
    rr: context.rr,
    tpPct,
    slPct,
    strength: context.strength,
    setupScore: context.setupScore,
    trendStrength: context.trendStrength,
    volatilityState: context.volatilityState,
    marketRegime: context.marketRegime,
    session: context.session,
    rsi: context.rsi,
    atrPct: context.atrPct,
    eventTimeMs: context.eventTimeUtc ? Date.parse(context.eventTimeUtc) : Date.now(),
    historicalQualityAdjustmentsEnabled: HISTORICAL_QUALITY_ADJUSTMENTS_ENABLED,
  });

  return {
    score: quality.score,
    grade: quality.grade,
    source: "recalculated_from_candidate_context",
    missingFields: missing,
    qualityReasons: quality.reasons || [],
    qualityPenalties: quality.penalties || [],
  };
}

function outcomeFor(row) {
  const outcome = row.outcome || {};
  const type = outcome.outcome_type || row.shadow?.outcome_type || null;
  return {
    outcome_type: type || "OPEN_OR_UNKNOWN",
    closed: CLOSED_OUTCOMES.has(type),
    win: WIN_OUTCOMES.has(type),
    loss: LOSS_OUTCOMES.has(type),
    r_multiple: firstValue(outcome.r_multiple, row.shadow?.r_multiple),
    move_pct: firstValue(outcome.move_pct, outcome.pnl_percent, row.shadow?.market_move_pct),
    outcome_time_utc: firstValue(outcome.closed_at_utc, outcome.outcome_time_utc),
  };
}

function buildBlockReason(evaluation, quality) {
  if (evaluation.proposedGrade && evaluation.proposedGrade !== "UNKNOWN") {
    return `shadow_v21_live_gate_blocked:${evaluation.proposedGrade}`;
  }
  const missing = quality.missingFields || [];
  return missing.length
    ? `shadow_v21_live_gate_blocked:UNKNOWN:missing_${missing.join(",")}`
    : "shadow_v21_live_gate_blocked:UNKNOWN";
}

function evaluateRows(rows) {
  return rows.map((row) => {
    const quality = qualityFromCandidate(row);
    const evaluation = evaluateShadowScoreV21({
      context: row.context,
      quality: {
        score: quality.score,
        grade: quality.grade,
      },
    });
    const wouldSend = ["A+", "A"].includes(evaluation.proposedGrade);
    const raw = row.raw || {};
    const outcome = outcomeFor(row);
    const blockReason = wouldSend ? null : buildBlockReason(evaluation, quality);
    const shadowDecision = wouldSend ? "SENT" : "BLOCKED";

    return {
      source: row.source,
      ref_id: raw.ref_id || "",
      alert_id: raw.alert_id || "",
      candidate_key: raw.candidate_key || "",
      symbol: normalize(row.context.symbol),
      direction: normalize(row.context.side),
      setup: normalize(row.context.setupType),
      session: normalize(row.context.session),
      regime: normalize(row.context.marketRegime),
      current_grade: quality.grade || "",
      current_score: quality.score ?? "",
      current_quality_source: quality.source,
      shadow_v21_grade: evaluation.proposedGrade || "",
      shadow_v21_score: evaluation.proposedScore ?? "",
      shadow_v21_decision: shadowDecision,
      shadow_v21_block_reason: blockReason || "",
      decision: shadowDecision,
      reason: wouldSend ? "shadow_v21_live_gate_passed" : blockReason,
      would_receive_telegram: wouldSend ? "yes" : "no",
      live_candidate_decision: row.decision || "",
      live_candidate_reason: row.decision_reason || "",
      stored_shadow_v21_grade: row.shadow?.proposed_grade || "",
      stored_shadow_v21_score: firstValue(raw.shadow_v21_score, row.shadow?.proposed_score, raw.proposed_score) ?? "",
      stored_shadow_v21_decision: raw.shadow_v21_decision || row.shadow?.live_decision || "",
      stored_shadow_v21_block_reason: raw.shadow_v21_block_reason || row.shadow?.decision_reason || "",
      outcome: outcome.outcome_type,
      r_multiple: outcome.r_multiple ?? "",
      move_pct: outcome.move_pct ?? "",
      outcome_time_utc: outcome.outcome_time_utc || "",
      missing_fields: (quality.missingFields || []).join(","),
      penalty_reasons: (evaluation.penaltyReasons || []).map((item) => item.reason).join(","),
      bonus_reasons: (evaluation.bonusReasons || []).map((item) => item.reason).join(","),
    };
  });
}

function summarizeOutcomes(rows) {
  const closed = rows.filter((row) => CLOSED_OUTCOMES.has(row.outcome));
  const tp = closed.filter((row) => WIN_OUTCOMES.has(row.outcome));
  const sl = closed.filter((row) => LOSS_OUTCOMES.has(row.outcome));
  return {
    total: rows.length,
    closed: closed.length,
    tp: tp.length,
    sl: sl.length,
    open_or_unknown: rows.length - closed.length,
    winrate_pct: closed.length ? pct(tp.length, closed.length) : null,
    expectancy_r: round(average(closed.map((row) => row.r_multiple)), 3),
    avg_move_pct: round(average(closed.map((row) => row.move_pct)), 4),
  };
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row[key] || "UNKNOWN";
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function buildSummary(rows) {
  const sent = rows.filter((row) => row.shadow_v21_decision === "SENT");
  const blocked = rows.filter((row) => row.shadow_v21_decision === "BLOCKED");
  const unknown = rows.filter((row) => row.shadow_v21_grade === "UNKNOWN");
  const blockedClosed = blocked.filter((row) => CLOSED_OUTCOMES.has(row.outcome));
  const sentClosed = sent.filter((row) => CLOSED_OUTCOMES.has(row.outcome));

  return {
    total_candidates: rows.length,
    shadow_v21_unknown: unknown.length,
    sent: sent.length,
    blocked: blocked.length,
    blocked_pct: pct(blocked.length, rows.length),
    sent_closed: summarizeOutcomes(sent),
    blocked_closed: summarizeOutcomes(blocked),
    blocked_closed_tp: blockedClosed.filter((row) => WIN_OUTCOMES.has(row.outcome)).length,
    blocked_closed_sl: blockedClosed.filter((row) => LOSS_OUTCOMES.has(row.outcome)).length,
    sent_closed_tp: sentClosed.filter((row) => WIN_OUTCOMES.has(row.outcome)).length,
    sent_closed_sl: sentClosed.filter((row) => LOSS_OUTCOMES.has(row.outcome)).length,
    unknown_missing_fields: countBy(unknown, "missing_fields"),
    block_reasons: countBy(blocked, "shadow_v21_block_reason"),
  };
}

function renderMarkdown(rows) {
  const sent = rows.filter((row) => row.decision === "SENT");
  const blocked = rows.filter((row) => row.decision === "BLOCKED");
  const unknown = rows.filter((row) => row.shadow_v21_grade === "UNKNOWN");
  const summary = buildSummary(rows);
  const reduction = rows.length ? Math.round((blocked.length / rows.length) * 10000) / 100 : null;
  const line = (text = "") => console.log(text);
  const table = (items, columns) => {
    line(`| ${columns.map((column) => column.label).join(" | ")} |`);
    line(`| ${columns.map(() => "---").join(" | ")} |`);
    for (const item of items) {
      line(`| ${columns.map((column) => item[column.key] ?? "").join(" | ")} |`);
    }
  };

  line("# D-ALRT Shadow V2.1 Live Gate Dry Run");
  line(`Generated UTC: ${new Date().toISOString()}`);
  line("Read-only. No Telegram messages were sent and no production behavior was changed.");
  line("");
  line("## Summary");
  table([{
    total: rows.length,
    sent: sent.length,
    blocked: blocked.length,
    expected_volume_reduction_pct: reduction,
  }], [
    { key: "total", label: "Signals" },
    { key: "sent", label: "Would Send" },
    { key: "blocked", label: "Would Block" },
    { key: "expected_volume_reduction_pct", label: "Volume Reduction %" },
  ]);
  line("");
  line("## UNKNOWN Coverage");
  table([{
    unknown: unknown.length,
    unknown_pct: pct(unknown.length, rows.length),
  }], [
    { key: "unknown", label: "UNKNOWN Candidates" },
    { key: "unknown_pct", label: "UNKNOWN %" },
  ]);
  line("");
  line("## Outcome Summary");
  table([
    { bucket: "Sent", ...summary.sent_closed },
    { bucket: "Blocked", ...summary.blocked_closed },
  ], [
    { key: "bucket", label: "Bucket" },
    { key: "total", label: "Candidates" },
    { key: "closed", label: "Closed" },
    { key: "tp", label: "TP" },
    { key: "sl", label: "SL" },
    { key: "open_or_unknown", label: "Open/Unknown" },
    { key: "winrate_pct", label: "Winrate %" },
    { key: "expectancy_r", label: "Expectancy R" },
    { key: "avg_move_pct", label: "Avg Move %" },
  ]);
  line("");
  line("## Last Signals");
  table(rows, [
    { key: "source", label: "Source" },
    { key: "ref_id", label: "Ref" },
    { key: "symbol", label: "Symbol" },
    { key: "direction", label: "Direction" },
    { key: "setup", label: "Setup" },
    { key: "session", label: "Session" },
    { key: "regime", label: "Regime" },
    { key: "current_grade", label: "Current Grade" },
    { key: "current_score", label: "Current Score" },
    { key: "current_quality_source", label: "Quality Source" },
    { key: "shadow_v21_grade", label: "V2.1 Grade" },
    { key: "shadow_v21_score", label: "V2.1 Score" },
    { key: "decision", label: "Gate Decision" },
    { key: "would_receive_telegram", label: "Telegram" },
    { key: "outcome", label: "Outcome" },
    { key: "r_multiple", label: "R" },
    { key: "move_pct", label: "Move %" },
    { key: "missing_fields", label: "Missing Fields" },
    { key: "reason", label: "Reason" },
  ]);
}

async function main() {
  if (!ready()) {
    console.error("Missing Supabase env: SUPABASE_ENABLED=true, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
    process.exitCode = 1;
    return;
  }

  const rows = evaluateRows(await fetchRows());
  if (hasFlag("--markdown")) renderMarkdown(rows);
  else console.log(JSON.stringify({ ok: true, summary: buildSummary(rows), rows }, null, 2));
}

main().catch((err) => {
  console.error("Shadow V2.1 gate dry-run failed:", err);
  process.exitCode = 1;
});
