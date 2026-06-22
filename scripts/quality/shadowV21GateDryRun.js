import { evaluateShadowScoreV21 } from "../../src/services/shadowScoringService.js";

const SUPABASE_ENABLED = String(process.env.SUPABASE_ENABLED || "false").toLowerCase() === "true";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SHADOW_V1_VERSION = "shadow-score-v1";

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
  };
}

function contextFromCandidateRow(row) {
  const raw = row.raw_payload || {};
  return {
    candidateKey: row.candidate_key || row.alert_id || row.ref_id,
    symbol: row.symbol || raw.symbol,
    side: row.direction || raw.direction || raw.side,
    timeframe: row.timeframe || raw.timeframe,
    setupType: row.setup_type || raw.setup,
    rr: row.rr ?? raw.rr,
    strength: row.strength || raw.strength,
    setupScore: row.setup_score ?? raw.setup_score,
    trendStrength: row.trend_strength ?? raw.trend_strength ?? raw.adx,
    marketRegime: row.market_regime || raw.regime,
    session: row.session_name || raw.session,
    rsi: row.rsi ?? raw.rsi,
    atrPct: row.atr_pct ?? raw.atr_pct,
  };
}

async function fetchRows() {
  const limit = Number(argValue("--limit", "50"));
  const candidates = await selectRows(
    "alert_candidates",
    [
      "?select=candidate_key,alert_id,ref_id,symbol,direction,timeframe,entry_price,tp1_price,sl_price,rr,rsi,trend_strength,atr_pct,session_name,market_regime,setup_type,setup_score,strength,event_time_utc,decision,decision_reason,quality_score,quality_grade,raw_payload",
      "order=event_time_utc.desc",
      `limit=${limit}`,
    ].join("&"),
  );

  if (candidates.length) {
    return candidates.map((row) => ({
      source: "alert_candidates",
      raw: row,
      context: contextFromCandidateRow(row),
      current_score: row.quality_score,
      current_grade: row.quality_grade,
      decision: row.decision || "",
      decision_reason: row.decision_reason || "",
      event_time_utc: row.event_time_utc || "",
    }));
  }

  const shadows = await selectRows(
    "shadow_score_evaluations",
    [
      "?select=shadow_version,candidate_key,alert_id,ref_id,symbol,direction,timeframe,setup_type,current_score,current_grade,proposed_score,proposed_grade,score_components,penalty_reasons,bonus_reasons,live_decision,decision_reason,event_time_utc",
      `shadow_version=eq.${encodeURIComponent(SHADOW_V1_VERSION)}`,
      "order=event_time_utc.desc",
      `limit=${limit}`,
    ].join("&"),
  );

  return shadows.map((row) => ({
    source: "shadow_score_evaluations",
    raw: row,
    context: contextFromShadowRow(row),
    current_score: row.current_score,
    current_grade: row.current_grade,
    decision: row.live_decision || "",
    decision_reason: row.decision_reason || "",
    event_time_utc: row.event_time_utc || "",
  }));
}

function evaluateRows(rows) {
  return rows.map((row) => {
    const evaluation = evaluateShadowScoreV21({
      context: row.context,
      quality: {
        score: row.current_score,
        grade: row.current_grade,
      },
    });
    const wouldSend = ["A+", "A"].includes(evaluation.proposedGrade);
    const raw = row.raw || {};
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
      current_grade: row.current_grade || "",
      current_score: row.current_score ?? "",
      shadow_v21_grade: evaluation.proposedGrade || "",
      shadow_v21_score: evaluation.proposedScore ?? "",
      decision: wouldSend ? "SENT" : "BLOCKED",
      reason: wouldSend ? "shadow_v21_live_gate_passed" : `shadow_v21_live_gate_blocked:${evaluation.proposedGrade || "UNKNOWN"}`,
      would_receive_telegram: wouldSend ? "yes" : "no",
    };
  });
}

function renderMarkdown(rows) {
  const sent = rows.filter((row) => row.decision === "SENT");
  const blocked = rows.filter((row) => row.decision === "BLOCKED");
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
    { key: "shadow_v21_grade", label: "V2.1 Grade" },
    { key: "shadow_v21_score", label: "V2.1 Score" },
    { key: "decision", label: "Gate Decision" },
    { key: "would_receive_telegram", label: "Telegram" },
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
  else console.log(JSON.stringify({ ok: true, rows }, null, 2));
}

main().catch((err) => {
  console.error("Shadow V2.1 gate dry-run failed:", err);
  process.exitCode = 1;
});
