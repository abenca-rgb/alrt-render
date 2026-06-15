import {
  SHADOW_SCORING_VERSION,
  buildShadowWeeklyReport,
  evaluateShadowScore,
} from "./shadowScoringService.js";

const WIN_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL", "TIME_EXIT_PROFIT"]);
const LOSS_OUTCOMES = new Set(["SL", "TIME_EXIT_LOSS"]);
const TIME_EXIT_OUTCOMES = new Set(["TIME_EXIT_PROFIT", "TIME_EXIT_LOSS"]);
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

function pct(part, total) {
  return total ? round((part / total) * 100, 2) : null;
}

function avg(values) {
  const clean = values.map(numberOrNull).filter((value) => value !== null);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function normalizeText(value, fallback = "UNKNOWN") {
  const text = String(value || "").trim();
  return text || fallback;
}

function normalizeGrade(value) {
  const text = String(value || "").trim().toUpperCase();
  if (text === "A+" || text === "A" || text === "B+" || text === "B" || text === "C") return text;
  return "UNKNOWN";
}

function gradeFromScore(score) {
  const n = numberOrNull(score);
  if (n === null) return "UNKNOWN";
  if (n >= 92) return "A+";
  if (n >= 84) return "A";
  if (n >= 78) return "B+";
  if (n >= 72) return "B";
  return "C";
}

function scoreBand(score) {
  const n = numberOrNull(score);
  if (n === null) return "unknown";
  if (n >= 90) return "90-100";
  if (n >= 80) return "80-89";
  if (n >= 70) return "70-79";
  if (n >= 60) return "60-69";
  return "below 60";
}

function bucketNumber(value, buckets, fallback = "unknown") {
  const n = numberOrNull(value);
  if (n === null) return fallback;
  for (const bucket of buckets) {
    if (n >= bucket.min && n < bucket.max) return bucket.label;
  }
  return fallback;
}

function dateDiffMinutes(start, end) {
  const a = start ? new Date(start).getTime() : NaN;
  const b = end ? new Date(end).getTime() : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 60000);
}

function outcomeKind(outcomeType) {
  if (WIN_OUTCOMES.has(outcomeType)) return "win";
  if (LOSS_OUTCOMES.has(outcomeType)) return "loss";
  if (CLOSED_OUTCOMES.has(outcomeType)) return "closed";
  return "open";
}

function estimatedR(row) {
  const actual = numberOrNull(row.r_multiple);
  if (actual !== null) return actual;

  if (WIN_OUTCOMES.has(row.outcome_type)) {
    const rr = numberOrNull(row.rr);
    return rr !== null ? rr : 1;
  }
  if (LOSS_OUTCOMES.has(row.outcome_type)) return -1;

  return null;
}

function makeRecord(alert, outcome, candidate) {
  const qualityScore = numberOrNull(alert.quality_score ?? candidate?.quality_score);
  const qualityGrade = normalizeGrade(alert.quality_grade || candidate?.quality_grade || gradeFromScore(qualityScore));
  const signalTime = alert.signal_time_utc || candidate?.event_time_utc || null;
  const outcomeTime = outcome?.closed_at_utc || outcome?.outcome_time_utc || null;

  return {
    alert_id: String(alert.alert_id || ""),
    candidate_key: candidate?.candidate_key || outcome?.candidate_key || null,
    ref_id: String(alert.ref_id || outcome?.ref_id || candidate?.ref_id || ""),
    symbol: normalizeText(alert.symbol || candidate?.symbol || outcome?.symbol),
    direction: normalizeText(alert.direction || candidate?.direction || outcome?.direction),
    timeframe: alert.timeframe || candidate?.timeframe || null,
    setup_type: normalizeText(alert.setup_type || candidate?.setup_type),
    session_name: normalizeText(alert.session_name || candidate?.session_name),
    market_regime: normalizeText(alert.market_regime || candidate?.market_regime),
    quality_score: qualityScore,
    quality_grade: qualityGrade,
    pine_strength: normalizeGrade(candidate?.strength || alert.raw_payload?.strength),
    setup_score: numberOrNull(candidate?.setup_score || alert.raw_payload?.setup_score),
    rr: numberOrNull(alert.rr ?? candidate?.rr),
    rsi: numberOrNull(candidate?.rsi || alert.raw_payload?.rsi),
    trend_strength: numberOrNull(candidate?.trend_strength || alert.raw_payload?.trend_strength || alert.raw_payload?.adx),
    atr_pct: numberOrNull(candidate?.atr_pct || alert.raw_payload?.atr_pct),
    volatility_pct: numberOrNull(candidate?.volatility_pct || alert.raw_payload?.volatility_pct),
    entry_price: numberOrNull(alert.entry_price ?? candidate?.entry_price),
    tp_price: numberOrNull(alert.tp_price ?? candidate?.tp1_price),
    sl_price: numberOrNull(alert.sl_price ?? candidate?.sl_price),
    signal_time_utc: signalTime,
    outcome_type: outcome?.outcome_type || null,
    outcome_time_utc: outcomeTime,
    duration_minutes: numberOrNull(outcome?.duration_minutes) ?? dateDiffMinutes(signalTime, outcomeTime),
    move_pct: numberOrNull(outcome?.move_pct ?? outcome?.pnl_percent),
    r_multiple: numberOrNull(outcome?.r_multiple),
    estimated_r: null,
    why_text: alert.why_text || alert.raw_payload?.reason || null,
    raw_payload: alert.raw_payload || candidate?.raw_payload || null,
  };
}

function summarize(items, name) {
  const totalAlerts = items.length;
  const closed = items.filter((row) => CLOSED_OUTCOMES.has(row.outcome_type));
  const tp = items.filter((row) => ["TP", "TP1", "TP2", "TP_FULL"].includes(row.outcome_type)).length;
  const sl = items.filter((row) => row.outcome_type === "SL").length;
  const timeExitProfit = items.filter((row) => row.outcome_type === "TIME_EXIT_PROFIT").length;
  const timeExitLoss = items.filter((row) => row.outcome_type === "TIME_EXIT_LOSS").length;
  const timeExits = items.filter((row) => TIME_EXIT_OUTCOMES.has(row.outcome_type)).length;
  const openTrades = totalAlerts - closed.length;
  const wins = closed.filter((row) => WIN_OUTCOMES.has(row.outcome_type)).length;
  const losses = closed.filter((row) => LOSS_OUTCOMES.has(row.outcome_type)).length;
  const rActual = avg(closed.map((row) => row.r_multiple));
  const rEstimated = avg(closed.map((row) => estimatedR(row)));
  const move = avg(closed.map((row) => row.move_pct));
  const tpDurations = closed.filter((row) => WIN_OUTCOMES.has(row.outcome_type)).map((row) => row.duration_minutes);
  const slDurations = closed.filter((row) => LOSS_OUTCOMES.has(row.outcome_type)).map((row) => row.duration_minutes);

  return {
    name,
    total_alerts: totalAlerts,
    closed_trades: closed.length,
    tp_hits: tp,
    sl_hits: sl,
    time_exit_profit: timeExitProfit,
    time_exit_loss: timeExitLoss,
    time_exits: timeExits,
    open_trades: openTrades,
    winrate_pct: pct(wins, closed.length),
    tp_pct: pct(tp, closed.length),
    sl_pct: pct(sl, closed.length),
    expectancy_r_actual: round(rActual, 3),
    expectancy_r_estimated: round(rEstimated, 3),
    average_move_pct: round(move, 3),
    average_r_multiple: round(rActual, 3),
    average_time_to_tp_minutes: round(avg(tpDurations), 1),
    average_time_to_sl_minutes: round(avg(slDurations), 1),
    wins,
    losses,
  };
}

function groupBy(records, getKey, order = null) {
  const groups = new Map();
  for (const record of records) {
    const key = getKey(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const rows = [...groups.entries()].map(([key, items]) => summarize(items, key));
  if (order) {
    const rank = new Map(order.map((item, index) => [item, index]));
    rows.sort((a, b) => (rank.get(a.name) ?? 999) - (rank.get(b.name) ?? 999));
  } else {
    rows.sort((a, b) => b.closed_trades - a.closed_trades || b.total_alerts - a.total_alerts);
  }
  return rows;
}

function impactLabel(deltaExpectancy, deltaWinrate, sample) {
  if (sample < 5) return "insufficient_sample";
  if ((deltaExpectancy ?? 0) > 0.08 || (deltaWinrate ?? 0) > 8) return "positive";
  if ((deltaExpectancy ?? 0) < -0.08 || (deltaWinrate ?? 0) < -8) return "negative";
  return "neutral";
}

function componentRows(records, baseline) {
  const specs = [
    ["pine_strength", (r) => r.pine_strength],
    ["setup_score_band", (r) => bucketNumber(r.setup_score, [
      { min: -Infinity, max: 8, label: "<8" },
      { min: 8, max: 10, label: "8-9" },
      { min: 10, max: 13, label: "10-12" },
      { min: 13, max: Infinity, label: "13+" },
    ])],
    ["rr_band", (r) => bucketNumber(r.rr, [
      { min: -Infinity, max: 1.2, label: "<1.2R" },
      { min: 1.2, max: 1.6, label: "1.2-1.59R" },
      { min: 1.6, max: 2, label: "1.6-1.99R" },
      { min: 2, max: Infinity, label: "2R+" },
    ])],
    ["trend_strength_band", (r) => bucketNumber(r.trend_strength, [
      { min: -Infinity, max: 14, label: "<14" },
      { min: 14, max: 22, label: "14-21" },
      { min: 22, max: Infinity, label: "22+" },
    ])],
    ["rsi_band", (r) => bucketNumber(r.rsi, [
      { min: -Infinity, max: 35, label: "<35" },
      { min: 35, max: 45, label: "35-44" },
      { min: 45, max: 55, label: "45-54" },
      { min: 55, max: 65, label: "55-64" },
      { min: 65, max: Infinity, label: "65+" },
    ])],
    ["atr_pct_band", (r) => bucketNumber(r.atr_pct, [
      { min: -Infinity, max: 0.25, label: "<0.25" },
      { min: 0.25, max: 0.5, label: "0.25-0.49" },
      { min: 0.5, max: 0.8, label: "0.50-0.79" },
      { min: 0.8, max: Infinity, label: "0.80+" },
    ])],
    ["market_regime", (r) => r.market_regime],
    ["session", (r) => r.session_name],
    ["setup_type", (r) => r.setup_type],
    ["symbol", (r) => r.symbol],
    ["direction", (r) => r.direction],
  ];

  const output = [];
  for (const [component, getter] of specs) {
    const grouped = groupBy(records, getter);
    for (const row of grouped) {
      const deltaExpectancy = row.expectancy_r_estimated === null || baseline.expectancy_r_estimated === null
        ? null
        : row.expectancy_r_estimated - baseline.expectancy_r_estimated;
      const deltaWinrate = row.winrate_pct === null || baseline.winrate_pct === null
        ? null
        : row.winrate_pct - baseline.winrate_pct;
      output.push({
        component,
        value: row.name,
        sample_size: row.closed_trades,
        total_alerts: row.total_alerts,
        winrate_pct: row.winrate_pct,
        expectancy_r_estimated: row.expectancy_r_estimated,
        average_move_pct: row.average_move_pct,
        delta_winrate_pct: round(deltaWinrate, 2),
        delta_expectancy_r: round(deltaExpectancy, 3),
        impact: impactLabel(deltaExpectancy, deltaWinrate, row.closed_trades),
      });
    }
  }

  return output.sort((a, b) => {
    const impactRank = { negative: 0, positive: 1, neutral: 2, insufficient_sample: 3 };
    return (impactRank[a.impact] ?? 9) - (impactRank[b.impact] ?? 9)
      || Math.abs(b.delta_expectancy_r || 0) - Math.abs(a.delta_expectancy_r || 0)
      || b.sample_size - a.sample_size;
  });
}

function correlation(records, getX, getY) {
  const pairs = records
    .map((row) => [numberOrNull(getX(row)), numberOrNull(getY(row))])
    .filter(([x, y]) => x !== null && y !== null);
  if (pairs.length < 3) return null;
  const avgX = avg(pairs.map(([x]) => x));
  const avgY = avg(pairs.map(([, y]) => y));
  let numerator = 0;
  let x2 = 0;
  let y2 = 0;
  for (const [x, y] of pairs) {
    const dx = x - avgX;
    const dy = y - avgY;
    numerator += dx * dy;
    x2 += dx * dx;
    y2 += dy * dy;
  }
  return x2 && y2 ? numerator / Math.sqrt(x2 * y2) : null;
}

function inferAPlusDrivers(row) {
  const drivers = [];
  if (row.quality_score !== null) drivers.push(`backend score ${row.quality_score}`);
  if (row.pine_strength === "A+") drivers.push("Pine strength A+");
  if ((row.setup_score ?? -Infinity) >= 13) drivers.push(`high Pine setup_score ${row.setup_score}`);
  if ((row.rr ?? -Infinity) >= 2) drivers.push(`high RR ${round(row.rr, 2)}R`);
  if ((row.trend_strength ?? -Infinity) >= 22) drivers.push(`strong trend/adx ${round(row.trend_strength, 2)}`);
  if (/overlap|london|new_york|ny/i.test(row.session_name)) drivers.push(`session ${row.session_name}`);
  if (/trend|continuation|clean|expansion/i.test(row.market_regime)) drivers.push(`regime ${row.market_regime}`);
  return drivers;
}

function proposedScore(row, negativeComponents, positiveComponents) {
  let score = numberOrNull(row.quality_score);
  if (score === null) return null;

  const keys = [
    `setup_type:${row.setup_type}`,
    `symbol:${row.symbol}`,
    `session:${row.session_name}`,
    `market_regime:${row.market_regime}`,
    `pine_strength:${row.pine_strength}`,
  ];

  for (const key of keys) {
    if (negativeComponents.has(key)) score -= 8;
    if (positiveComponents.has(key)) score += 4;
  }
  if (/continuation/i.test(row.setup_type) && row.pine_strength === "A+") score -= 6;
  if (row.outcome_type === null && row.quality_grade === "A+" && row.setup_type === "HTF_CONTINUATION") score -= 4;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function simulateModel(records, componentAnalysis) {
  const negativeComponents = new Set(
    componentAnalysis
      .filter((row) => row.impact === "negative" && row.sample_size >= 5)
      .slice(0, 12)
      .map((row) => `${row.component === "session" ? "session" : row.component}:${row.value}`),
  );
  const positiveComponents = new Set(
    componentAnalysis
      .filter((row) => row.impact === "positive" && row.sample_size >= 5)
      .slice(0, 8)
      .map((row) => `${row.component === "session" ? "session" : row.component}:${row.value}`),
  );

  const currentAccepted = records.filter((row) => numberOrNull(row.quality_score) !== null);
  const proposedAccepted = currentAccepted.filter((row) => proposedScore(row, negativeComponents, positiveComponents) >= 84);
  const proposedRecords = proposedAccepted.map((row) => ({
    ...row,
    proposed_quality_score: proposedScore(row, negativeComponents, positiveComponents),
    proposed_quality_grade: gradeFromScore(proposedScore(row, negativeComponents, positiveComponents)),
  }));

  return {
    negative_factors_penalized: [...negativeComponents],
    positive_factors_rewarded: [...positiveComponents],
    current_model: summarize(currentAccepted, "current_model"),
    proposed_model_kept_score_84_plus: summarize(proposedRecords, "proposed_model_score_84_plus"),
    alert_volume_change_pct: pct(proposedRecords.length - currentAccepted.length, currentAccepted.length),
  };
}

function gradeValidation(gradeRows) {
  const byGrade = Object.fromEntries(gradeRows.map((row) => [row.name, row]));
  const order = ["A+", "A", "B+", "B", "C"];
  const findings = [];

  for (let i = 0; i < order.length - 1; i += 1) {
    const high = byGrade[order[i]];
    const low = byGrade[order[i + 1]];
    if (!high || !low || high.closed_trades < 5 || low.closed_trades < 5) continue;
    if ((high.winrate_pct ?? -Infinity) < (low.winrate_pct ?? -Infinity)) {
      findings.push(`${order[i]} underperformed ${order[i + 1]} on winrate (${high.winrate_pct}% vs ${low.winrate_pct}%).`);
    }
    if ((high.expectancy_r_estimated ?? -Infinity) < (low.expectancy_r_estimated ?? -Infinity)) {
      findings.push(`${order[i]} underperformed ${order[i + 1]} on estimated expectancy (${high.expectancy_r_estimated}R vs ${low.expectancy_r_estimated}R).`);
    }
  }

  if (!findings.length) {
    findings.push("No grade inversion detected at the current sample threshold, but small samples may still be unreliable.");
  }

  return {
    expected_order: order,
    actual_by_grade: gradeRows,
    findings,
  };
}

function confidenceLevel(sample) {
  if (sample >= 250) return "HIGH";
  if (sample >= 100) return "MEDIUM";
  if (sample >= 50) return "MEDIUM_LOW";
  if (sample >= 20) return "LOW";
  return "INSUFFICIENT_SAMPLE";
}

export function createScoreAuditService({ supabase } = {}) {
  async function selectRows(table, query) {
    return supabase.selectRows(table, query);
  }

  function ready() {
    return Boolean(supabase?.ready?.());
  }

  async function runScoreAudit() {
    if (!ready()) {
      return {
        ok: false,
        error: "supabase unavailable",
        generated_at_utc: new Date().toISOString(),
      };
    }

    const [alerts, outcomes, candidates, shadowRules] = await Promise.all([
      selectRows(
        "alerts",
        "?select=alert_id,ref_id,symbol,direction,timeframe,setup_type,entry_price,tp_price,sl_price,rr,risk_score,quality_score,quality_grade,why_text,signal_time_utc,session_name,market_regime,pine_version,backend_version,raw_payload&order=signal_time_utc.asc&limit=10000",
      ),
      selectRows(
        "outcomes",
        "?select=alert_id,ref_id,candidate_key,symbol,direction,outcome_type,outcome_time_utc,closed_at_utc,pnl_percent,move_pct,r_multiple,duration_minutes,exit_price,raw_payload&order=outcome_time_utc.asc&limit=10000",
      ),
      selectRows(
        "alert_candidates",
        "?select=candidate_key,alert_id,ref_id,symbol,direction,timeframe,entry_price,tp1_price,sl_price,rr,rsi,trend_strength,atr_pct,volatility_pct,session_name,market_regime,setup_type,setup_score,strength,event_time_utc,decision,quality_score,quality_grade,raw_payload&order=event_time_utc.asc&limit=10000",
      ),
      selectRows(
        "shadow_rule_results",
        "?select=rule_name,rule_status,score_adjustment,would_reject,outcome_type,move_pct,r_multiple,shadow_version,evaluated_at_utc&limit=10000",
      ).catch(() => []),
    ]);

    const outcomeByAlert = new Map(outcomes.map((row) => [String(row.alert_id), row]));
    const candidatesByAlert = new Map();
    const candidatesByRef = new Map();
    for (const candidate of candidates) {
      if (candidate.alert_id) candidatesByAlert.set(String(candidate.alert_id), candidate);
      if (candidate.ref_id) candidatesByRef.set(String(candidate.ref_id), candidate);
    }

    const records = alerts.map((alert) => {
      const outcome = outcomeByAlert.get(String(alert.alert_id)) || null;
      const candidate = candidatesByAlert.get(String(alert.alert_id)) || candidatesByRef.get(String(alert.ref_id)) || null;
      const record = makeRecord(alert, outcome, candidate);
      record.estimated_r = estimatedR(record);
      return record;
    });

    const closedRecords = records.filter((row) => CLOSED_OUTCOMES.has(row.outcome_type));
    const baseline = summarize(records, "all_alerts");
    const scoreBands = groupBy(records, (row) => scoreBand(row.quality_score), ["90-100", "80-89", "70-79", "60-69", "below 60", "unknown"]);
    const grades = groupBy(records, (row) => row.quality_grade, ["A+", "A", "B+", "B", "C", "UNKNOWN"]);
    const setupRankings = groupBy(records, (row) => row.setup_type);
    const symbolRankings = groupBy(records, (row) => row.symbol);
    const sessionRankings = groupBy(records, (row) => row.session_name);
    const components = componentRows(records, baseline);

    const falseAPlus = records
      .filter((row) => row.quality_grade === "A+" && LOSS_OUTCOMES.has(row.outcome_type))
      .map((row) => ({
        ref_id: row.ref_id,
        symbol: row.symbol,
        direction: row.direction,
        setup_type: row.setup_type,
        session_name: row.session_name,
        market_regime: row.market_regime,
        quality_score: row.quality_score,
        quality_grade: row.quality_grade,
        pine_strength: row.pine_strength,
        setup_score: row.setup_score,
        rr: row.rr,
        rsi: row.rsi,
        trend_strength: row.trend_strength,
        atr_pct: row.atr_pct,
        outcome_type: row.outcome_type,
        move_pct: row.move_pct,
        estimated_r: row.estimated_r,
        duration_minutes: row.duration_minutes,
        signal_time_utc: row.signal_time_utc,
        outcome_time_utc: row.outcome_time_utc,
        why_did_it_score_a_plus: inferAPlusDrivers(row),
        audit_opinion: "A+ is questionable because the final outcome was SL; compare recurring drivers in false_a_plus_patterns.",
      }));

    const falseAPlusPatterns = {
      by_setup: groupBy(falseAPlus, (row) => row.setup_type),
      by_symbol: groupBy(falseAPlus, (row) => row.symbol),
      by_session: groupBy(falseAPlus, (row) => row.session_name),
      by_market_regime: groupBy(falseAPlus, (row) => row.market_regime),
    };

    const scoreToTp = correlation(closedRecords, (row) => row.quality_score, (row) => WIN_OUTCOMES.has(row.outcome_type) ? 1 : 0);
    const scoreToExpectancy = correlation(closedRecords, (row) => row.quality_score, (row) => estimatedR(row));
    const scoreToMove = correlation(closedRecords, (row) => row.quality_score, (row) => row.move_pct);
    const shadowTest = simulateModel(records, components);

    return {
      ok: true,
      generated_at_utc: new Date().toISOString(),
      source: "supabase",
      sample: {
        alerts: records.length,
        closed_trades: closedRecords.length,
        outcomes: outcomes.length,
        candidates: candidates.length,
        shadow_rule_rows: shadowRules.length,
        confidence_level: confidenceLevel(closedRecords.length),
      },
      primary_answers: {
        does_a_plus_outperform_a: (() => {
          const aPlus = grades.find((row) => row.name === "A+");
          const a = grades.find((row) => row.name === "A");
          if (!aPlus || !a) return "insufficient data";
          return (aPlus.expectancy_r_estimated ?? -Infinity) > (a.expectancy_r_estimated ?? -Infinity)
            && (aPlus.winrate_pct ?? -Infinity) >= (a.winrate_pct ?? -Infinity);
        })(),
        does_a_outperform_b: (() => {
          const a = grades.find((row) => row.name === "A");
          const b = grades.find((row) => row.name === "B");
          if (!a || !b) return "insufficient data";
          return (a.expectancy_r_estimated ?? -Infinity) > (b.expectancy_r_estimated ?? -Infinity)
            && (a.winrate_pct ?? -Infinity) >= (b.winrate_pct ?? -Infinity);
        })(),
        score_tp_correlation: round(scoreToTp, 4),
        score_expectancy_correlation: round(scoreToExpectancy, 4),
        score_market_move_correlation: round(scoreToMove, 4),
        useful_components: components.filter((row) => row.impact === "positive").slice(0, 12),
        harmful_components: components.filter((row) => row.impact === "negative").slice(0, 12),
      },
      score_audit_report: {
        baseline,
        by_score_band: scoreBands,
      },
      grade_accuracy_report: gradeValidation(grades),
      setup_rankings: setupRankings,
      symbol_rankings: symbolRankings,
      session_rankings: sessionRankings,
      component_analysis: components,
      false_a_plus_analysis: {
        total_false_a_plus_sl: falseAPlus.length,
        rows: falseAPlus,
        patterns: falseAPlusPatterns,
      },
      recommended_new_scoring_model: {
        principle: "Do not let A+ survive unless historical grade, setup, symbol and session buckets outperform baseline.",
        suggested_changes: [
          "Demote A+ to A when setup_type/session/symbol bucket has negative expectancy versus baseline.",
          "Apply an extra penalty to HTF_CONTINUATION A+ until its closed-sample expectancy is positive.",
          "Reward only components that show positive expectancy and at least 5 closed samples.",
          "Use estimated expectancy as a gate, not only score totals.",
          "Keep all changes in shadow mode first; do not modify Telegram/Pine output until validated.",
        ],
      },
      estimated_quality_improvement: {
        current_winrate_pct: shadowTest.current_model.winrate_pct,
        proposed_winrate_pct: shadowTest.proposed_model_kept_score_84_plus.winrate_pct,
        current_expectancy_r_estimated: shadowTest.current_model.expectancy_r_estimated,
        proposed_expectancy_r_estimated: shadowTest.proposed_model_kept_score_84_plus.expectancy_r_estimated,
        alert_volume_change_pct: shadowTest.alert_volume_change_pct,
        sample_size: closedRecords.length,
        confidence_level: confidenceLevel(closedRecords.length),
      },
      shadow_test: shadowTest,
      exact_future_implementation_plan: [
        "Freeze current scoring as baseline and keep collecting outcomes.",
        "Add score_component fields to candidate logging so future audits do not infer components from raw payload.",
        "Deploy proposed model as shadow score only; do not affect live alerts.",
        "Compare current_score vs proposed_score weekly with TP%, SL%, expectancy and volume.",
        "Promote penalties/bonuses only after at least 100 closed outcomes or manual owner approval.",
        "Then update Pine/backend scoring thresholds and Telegram grade labels together.",
      ],
    };
  }

  async function getShadowScoreReport() {
    if (!ready()) {
      return {
        ok: false,
        error: "supabase unavailable",
        generated_at_utc: new Date().toISOString(),
      };
    }

    try {
      const rows = await selectRows(
        "shadow_score_evaluations",
        "?select=candidate_key,alert_id,ref_id,symbol,direction,timeframe,setup_type,live_decision,decision_reason,shadow_version,event_time_utc,evaluated_at_utc,posted_to_paid,posted_to_free,current_score,current_grade,proposed_score,proposed_grade,score_delta,score_components,penalty_reasons,bonus_reasons,major_penalty_active,recommended_action,outcome_type,outcome_time_utc,market_move_pct,r_multiple,return_2x,return_3x,return_4x,return_5x,return_6x&order=event_time_utc.desc&limit=10000",
      );

      return {
        ok: true,
        source: "supabase",
        row_count: rows.length,
        ...buildShadowWeeklyReport({ rows }),
      };
    } catch (err) {
      return {
        ok: false,
        error: "shadow scoring schema not available or report failed",
        detail: err?.message || String(err),
        generated_at_utc: new Date().toISOString(),
      };
    }
  }

  async function backfillShadowScoreHistory() {
    if (!ready()) {
      return {
        ok: false,
        error: "supabase unavailable",
        generated_at_utc: new Date().toISOString(),
      };
    }

    const [alerts, outcomes, candidates] = await Promise.all([
      selectRows(
        "alerts",
        "?select=alert_id,ref_id,symbol,direction,timeframe,setup_type,entry_price,tp_price,sl_price,rr,risk_score,quality_score,quality_grade,why_text,signal_time_utc,session_name,market_regime,pine_version,backend_version,raw_payload&order=signal_time_utc.asc&limit=10000",
      ),
      selectRows(
        "outcomes",
        "?select=alert_id,ref_id,candidate_key,symbol,direction,outcome_type,outcome_time_utc,closed_at_utc,pnl_percent,move_pct,r_multiple,duration_minutes,exit_price,raw_payload&order=outcome_time_utc.asc&limit=10000",
      ),
      selectRows(
        "alert_candidates",
        "?select=candidate_key,alert_id,ref_id,symbol,direction,timeframe,entry_price,tp1_price,sl_price,rr,rsi,trend_strength,atr_pct,volatility_pct,session_name,market_regime,setup_type,setup_score,strength,event_time_utc,decision,quality_score,quality_grade,raw_payload&order=event_time_utc.asc&limit=10000",
      ),
    ]);

    const outcomeByAlert = new Map(outcomes.map((row) => [String(row.alert_id), row]));
    const candidatesByAlert = new Map();
    const candidatesByRef = new Map();
    for (const candidate of candidates) {
      if (candidate.alert_id) candidatesByAlert.set(String(candidate.alert_id), candidate);
      if (candidate.ref_id) candidatesByRef.set(String(candidate.ref_id), candidate);
    }

    const rows = alerts.map((alert) => {
      const outcome = outcomeByAlert.get(String(alert.alert_id)) || null;
      const candidate = candidatesByAlert.get(String(alert.alert_id)) || candidatesByRef.get(String(alert.ref_id)) || null;
      const record = makeRecord(alert, outcome, candidate);
      const context = {
        candidateKey: record.candidate_key || record.alert_id,
        symbol: record.symbol,
        side: record.direction,
        timeframe: record.timeframe,
        setupType: record.setup_type,
        rr: record.rr,
        strength: record.pine_strength,
        setupScore: record.setup_score,
        trendStrength: record.trend_strength,
        marketRegime: record.market_regime,
        session: record.session_name,
        rsi: record.rsi,
        atrPct: record.atr_pct,
        eventTimeMs: record.signal_time_utc ? new Date(record.signal_time_utc).getTime() : Date.now(),
      };
      const quality = {
        score: record.quality_score,
        grade: record.quality_grade,
      };
      const shadow = evaluateShadowScore({ context, quality });
      const move = numberOrNull(record.move_pct);

      return {
        candidate_key: String(context.candidateKey),
        alert_id: record.alert_id || null,
        ref_id: record.ref_id || null,
        symbol: record.symbol || null,
        direction: record.direction || null,
        timeframe: record.timeframe || null,
        setup_type: record.setup_type || null,
        live_decision: "ACCEPTED",
        decision_reason: "historical_backfill",
        shadow_version: SHADOW_SCORING_VERSION,
        event_time_utc: record.signal_time_utc || null,
        evaluated_at_utc: new Date().toISOString(),
        posted_to_paid: true,
        posted_to_free: false,
        current_score: shadow.currentScore,
        current_grade: shadow.currentGrade,
        proposed_score: shadow.proposedScore,
        proposed_grade: shadow.proposedGrade,
        score_delta: shadow.scoreDelta,
        score_components: shadow.scoreComponents,
        penalty_reasons: shadow.penaltyReasons,
        bonus_reasons: shadow.bonusReasons,
        major_penalty_active: shadow.majorPenaltyActive,
        recommended_action: shadow.recommendedAction,
        outcome_type: record.outcome_type || null,
        outcome_time_utc: record.outcome_time_utc || null,
        market_move_pct: move,
        r_multiple: numberOrNull(record.r_multiple) ?? estimatedR(record),
        return_2x: move === null ? null : round(move * 2, 4),
        return_3x: move === null ? null : round(move * 3, 4),
        return_4x: move === null ? null : round(move * 4, 4),
        return_5x: move === null ? null : round(move * 5, 4),
        return_6x: move === null ? null : round(move * 6, 4),
        updated_at: new Date().toISOString(),
      };
    });

    if (rows.length) {
      await supabase.request("shadow_score_evaluations", {
        query: "?on_conflict=candidate_key,shadow_version",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: rows,
      });
    }

    return {
      ok: true,
      generated_at_utc: new Date().toISOString(),
      shadow_version: SHADOW_SCORING_VERSION,
      backfilled_rows: rows.length,
    };
  }

  return {
    runScoreAudit,
    getShadowScoreReport,
    backfillShadowScoreHistory,
    ready,
  };
}
