const WIN_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL", "TIME_EXIT_PROFIT"]);
const LOSS_OUTCOMES = new Set(["SL", "TIME_EXIT_LOSS"]);
const CLOSED_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL", "SL", "TIME_EXIT_PROFIT", "TIME_EXIT_LOSS", "EXPIRED", "MANUAL_CLOSE"]);

function numberOrNull(value) {
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

function scoreBand(score) {
  const n = numberOrNull(score);
  if (n === null) return "unknown";
  if (n >= 90) return "90-100";
  if (n >= 80) return "80-89";
  if (n >= 70) return "70-79";
  if (n >= 60) return "60-69";
  return "below_60";
}

function parseDateMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function getOutcomeTime(row) {
  return row?.outcome_time_utc || row?.closed_at_utc || null;
}

function outcomeR(alert, outcome) {
  const explicit = numberOrNull(outcome?.r_multiple);
  if (explicit !== null) return explicit;
  if (WIN_OUTCOMES.has(outcome?.outcome_type)) return numberOrNull(alert?.rr) ?? 1;
  if (LOSS_OUTCOMES.has(outcome?.outcome_type)) return -1;
  return null;
}

function outcomeMove(outcome) {
  return numberOrNull(outcome?.move_pct) ?? numberOrNull(outcome?.pnl_percent);
}

function avg(values) {
  const clean = values.map(numberOrNull).filter((value) => value !== null);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function confidence(sampleSize, delta = 0) {
  if (sampleSize < 20) return { level: "INSUFFICIENT_SAMPLE", score: 0 };
  let score = 25;
  let level = "LOW";
  if (sampleSize >= 500) {
    score = 90;
    level = "VERY_HIGH";
  } else if (sampleSize >= 250) {
    score = 75;
    level = "HIGH";
  } else if (sampleSize >= 100) {
    score = 55;
    level = "MEDIUM";
  } else if (sampleSize >= 50) {
    score = 40;
    level = "MEDIUM_LOW";
  }
  score = Math.min(100, score + Math.min(10, Math.round(Math.abs(delta) * 10)));
  return { level, score };
}

function riskForRecommendation(sampleSize, confidenceLevel) {
  if (sampleSize < 20) return "high";
  if (confidenceLevel === "VERY_HIGH" || confidenceLevel === "HIGH") return "low";
  if (confidenceLevel === "MEDIUM" || confidenceLevel === "MEDIUM_LOW") return "medium";
  return "high";
}

function summarizeItems(items, baseline = null) {
  const closed = items.filter((item) => CLOSED_OUTCOMES.has(item.outcome?.outcome_type));
  const wins = closed.filter((item) => WIN_OUTCOMES.has(item.outcome?.outcome_type));
  const losses = closed.filter((item) => LOSS_OUTCOMES.has(item.outcome?.outcome_type));
  const rValues = closed.map((item) => outcomeR(item.alert, item.outcome)).filter((value) => value !== null);
  const moveValues = closed.map((item) => outcomeMove(item.outcome)).filter((value) => value !== null);

  const expectancy = avg(rValues);
  const winrate = closed.length ? (wins.length / closed.length) * 100 : null;
  const baselineExpectancy = baseline?.expectancy_r ?? null;
  const baselineWinrate = baseline?.winrate_pct ?? null;
  const expectancyDelta = expectancy !== null && baselineExpectancy !== null ? expectancy - baselineExpectancy : null;
  const winrateDelta = winrate !== null && baselineWinrate !== null ? winrate - baselineWinrate : null;

  return {
    alerts: items.length,
    closed: closed.length,
    tp: closed.filter((item) => ["TP", "TP1", "TP2", "TP_FULL"].includes(item.outcome?.outcome_type)).length,
    sl: closed.filter((item) => item.outcome?.outcome_type === "SL").length,
    time_exit_profit: closed.filter((item) => item.outcome?.outcome_type === "TIME_EXIT_PROFIT").length,
    time_exit_loss: closed.filter((item) => item.outcome?.outcome_type === "TIME_EXIT_LOSS").length,
    expired: closed.filter((item) => item.outcome?.outcome_type === "EXPIRED").length,
    open: items.length - closed.length,
    winrate_pct: round(winrate, 2),
    sl_rate_pct: closed.length ? round((losses.length / closed.length) * 100, 2) : null,
    expectancy_r: round(expectancy, 3),
    average_move_pct: round(avg(moveValues), 4),
    average_r_multiple: round(avg(rValues), 3),
    winrate_delta_pct: round(winrateDelta, 2),
    expectancy_delta_r: round(expectancyDelta, 3),
  };
}

function groupBy(items, keyFn, subjectType, baseline) {
  const groups = new Map();

  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  return [...groups.entries()].map(([subjectName, groupItems]) => {
    const summary = summarizeItems(groupItems, baseline);
    const delta = summary.expectancy_delta_r ?? 0;
    const conf = confidence(summary.closed, delta);
    return {
      subject_type: subjectType,
      subject_name: subjectName,
      ...summary,
      sample_size: summary.closed,
      confidence_level: conf.level,
      confidence_score: conf.score,
    };
  });
}

function recommendationFor(bucket) {
  if (bucket.sample_size < 20) {
    return {
      action: "monitor_only",
      direction: "neutral",
      reason: "Te weinig gesloten outcomes voor betrouwbare actie.",
    };
  }

  if ((bucket.expectancy_delta_r ?? 0) <= -0.15 || (bucket.winrate_delta_pct ?? 0) <= -8) {
    return {
      action: `increase_penalty:${bucket.subject_name}`,
      direction: "penalty",
      reason: "Bucket presteert slechter dan baseline op expectancy of winrate.",
    };
  }

  if ((bucket.expectancy_delta_r ?? 0) >= 0.15 || (bucket.winrate_delta_pct ?? 0) >= 8) {
    return {
      action: `increase_bonus:${bucket.subject_name}`,
      direction: "bonus",
      reason: "Bucket presteert beter dan baseline op expectancy of winrate.",
    };
  }

  return {
    action: "keep_watch",
    direction: "neutral",
    reason: "Geen sterke afwijking van baseline.",
  };
}

function buildRecommendations(buckets) {
  return buckets
    .map((bucket) => {
      const rec = recommendationFor(bucket);
      return {
        subject_type: bucket.subject_type,
        subject_name: bucket.subject_name,
        action: rec.action,
        direction: rec.direction,
        reason: rec.reason,
        sample_size: bucket.sample_size,
        confidence: bucket.confidence_level,
        confidence_score: bucket.confidence_score,
        expected_impact: {
          expectancy_delta_r: bucket.expectancy_delta_r,
          winrate_delta_pct: bucket.winrate_delta_pct,
        },
        risk: riskForRecommendation(bucket.sample_size, bucket.confidence_level),
      };
    })
    .sort((a, b) => {
      const rank = { penalty: 2, bonus: 1, neutral: 0 };
      if (rank[b.direction] !== rank[a.direction]) return rank[b.direction] - rank[a.direction];
      if ((b.confidence_score || 0) !== (a.confidence_score || 0)) return (b.confidence_score || 0) - (a.confidence_score || 0);
      return Math.abs(b.expected_impact.expectancy_delta_r || 0) - Math.abs(a.expected_impact.expectancy_delta_r || 0);
    });
}

function filterPeriod(items, period, nowMs) {
  if (period.type === "days") {
    const startMs = nowMs - period.days * 24 * 60 * 60 * 1000;
    return items.filter((item) => {
      const signalMs = parseDateMs(item.alert.signal_time_utc || item.alert.created_at);
      return signalMs !== null && signalMs >= startMs && signalMs <= nowMs;
    });
  }

  if (period.type === "latest") {
    return items.slice(0, period.limit);
  }

  return items;
}

function latestOutcomeByIdentity(outcomes) {
  const byAlert = new Map();
  const byRef = new Map();

  for (const outcome of outcomes) {
    const timeMs = parseDateMs(getOutcomeTime(outcome)) || 0;
    const add = (map, key) => {
      if (!key) return;
      const previous = map.get(String(key));
      const previousMs = parseDateMs(getOutcomeTime(previous)) || 0;
      if (!previous || timeMs >= previousMs) map.set(String(key), outcome);
    };
    add(byAlert, outcome.alert_id);
    add(byRef, outcome.ref_id);
  }

  return { byAlert, byRef };
}

function joinAlertsAndOutcomes(alerts, outcomes) {
  const { byAlert, byRef } = latestOutcomeByIdentity(outcomes);

  return alerts.map((alert) => ({
    alert,
    outcome: byAlert.get(String(alert.alert_id)) || byRef.get(String(alert.ref_id)) || null,
  }));
}

function buildPeriodReport(items, period, generatedAtUtc) {
  const baseline = summarizeItems(items);
  const buckets = [
    ...groupBy(items, (item) => normalize(item.alert.symbol), "symbol", baseline),
    ...groupBy(items, (item) => normalize(item.alert.setup_type), "setup", baseline),
    ...groupBy(items, (item) => normalize(item.alert.session_name), "session", baseline),
    ...groupBy(items, (item) => normalize(item.alert.direction), "direction", baseline),
    ...groupBy(items, (item) => normalize(item.alert.market_regime), "regime", baseline),
    ...groupBy(items, (item) => scoreBand(item.alert.quality_score), "score_band", baseline),
  ];
  const recommendations = buildRecommendations(buckets).slice(0, 30);

  return {
    period_key: period.key,
    period_label: period.label,
    generated_at_utc: generatedAtUtc,
    baseline,
    bucket_count: buckets.length,
    buckets,
    recommendations,
    top_performers: buckets
      .filter((bucket) => bucket.sample_size > 0)
      .sort((a, b) => (b.expectancy_r ?? -999) - (a.expectancy_r ?? -999))
      .slice(0, 10),
    worst_performers: buckets
      .filter((bucket) => bucket.sample_size > 0)
      .sort((a, b) => (a.expectancy_r ?? 999) - (b.expectancy_r ?? 999))
      .slice(0, 10),
  };
}

async function buildShadowComparison(supabase, nowMs) {
  const start = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
  const query = [
    "?select=candidate_key,alert_id,ref_id,symbol,direction,setup_type,live_decision,current_grade,proposed_grade,recommended_action,outcome_type,outcome_time_utc,market_move_pct,r_multiple",
    `evaluated_at_utc=gte.${encodeURIComponent(start)}`,
    "limit=10000",
  ].join("&");
  const rows = await supabase.selectRows("shadow_score_evaluations", query);
  const closed = rows.filter((row) => CLOSED_OUTCOMES.has(row.outcome_type));
  const current = summarizeItems(closed.map((row) => ({
    alert: { rr: null },
    outcome: {
      outcome_type: row.outcome_type,
      move_pct: row.market_move_pct,
      r_multiple: row.r_multiple,
    },
  })));
  const shadowKeptRows = closed.filter((row) => ["A+", "A"].includes(row.proposed_grade));
  const shadow = summarizeItems(shadowKeptRows.map((row) => ({
    alert: { rr: null },
    outcome: {
      outcome_type: row.outcome_type,
      move_pct: row.market_move_pct,
      r_multiple: row.r_multiple,
    },
  })), current);

  return {
    period: "last_7_days",
    current_model: current,
    shadow_model: shadow,
    improvement: {
      winrate_delta_pct: shadow.winrate_delta_pct,
      expectancy_delta_r: shadow.expectancy_delta_r,
      volume_delta: shadow.alerts - current.alerts,
    },
  };
}

export function createQualityOptimizerService({
  supabase,
  enabled = true,
  autoTuning = false,
}) {
  async function runReport({ now = new Date(), persist = true } = {}) {
    if (!enabled) {
      return { ok: false, skipped: true, reason: "quality_optimizer_disabled" };
    }
    if (!supabase.ready()) {
      return { ok: false, skipped: true, reason: "supabase_not_ready" };
    }

    const generatedAtUtc = now.toISOString();
    const nowMs = now.getTime();
    const alertQuery = [
      "?select=alert_id,ref_id,symbol,direction,timeframe,setup_type,entry_price,tp_price,sl_price,rr,quality_score,quality_grade,signal_time_utc,created_at,session_name,market_regime,raw_payload",
      "order=signal_time_utc.desc",
      "limit=1000",
    ].join("&");
    const outcomeQuery = [
      "?select=alert_id,ref_id,symbol,direction,outcome_type,outcome_time_utc,closed_at_utc,created_at,move_pct,pnl_percent,r_multiple,duration_minutes,exit_price",
      "order=outcome_time_utc.desc",
      "limit=5000",
    ].join("&");

    const [alerts, outcomes, shadowComparison] = await Promise.all([
      supabase.selectRows("alerts", alertQuery),
      supabase.selectRows("outcomes", outcomeQuery),
      buildShadowComparison(supabase, nowMs).catch((err) => ({
        error: err?.message || String(err),
      })),
    ]);

    const joined = joinAlertsAndOutcomes(alerts, outcomes);
    const periods = [
      { key: "last_7_days", label: "Last 7 days", type: "days", days: 7 },
      { key: "last_30_days", label: "Last 30 days", type: "days", days: 30 },
      { key: "last_90_days", label: "Last 90 days", type: "days", days: 90 },
      { key: "last_500_alerts", label: "Last 500 alerts", type: "latest", limit: 500 },
      { key: "last_1000_alerts", label: "Last 1000 alerts", type: "latest", limit: 1000 },
    ];

    const reports = periods.map((period) => buildPeriodReport(
      filterPeriod(joined, period, nowMs),
      period,
      generatedAtUtc,
    ));

    const weekly = {
      generated_at_utc: generatedAtUtc,
      current_model: reports.find((report) => report.period_key === "last_7_days")?.baseline || {},
      shadow_model: shadowComparison?.shadow_model || {},
      optimizer_recommendations: reports.find((report) => report.period_key === "last_30_days")?.recommendations?.slice(0, 10) || [],
      top_performers: reports.find((report) => report.period_key === "last_30_days")?.top_performers?.slice(0, 10) || [],
      worst_performers: reports.find((report) => report.period_key === "last_30_days")?.worst_performers?.slice(0, 10) || [],
    };

    const result = {
      ok: true,
      generated_at_utc: generatedAtUtc,
      auto_tuning_enabled: Boolean(autoTuning),
      source_counts: {
        alerts: alerts.length,
        outcomes: outcomes.length,
      },
      reports,
      shadow_comparison: shadowComparison,
      weekly_quality_report: weekly,
    };

    if (persist) {
      await supabase.request("optimizer_monitoring_reports", {
        query: "?on_conflict=report_key",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          report_key: `quality:${generatedAtUtc.slice(0, 10)}`,
          report_type: "quality_optimizer_v1",
          period_type: "multi",
          period_start_utc: null,
          period_end_utc: generatedAtUtc,
          generated_at_utc: generatedAtUtc,
          summary: {
            auto_tuning_enabled: Boolean(autoTuning),
            alerts: alerts.length,
            outcomes: outcomes.length,
            periods: reports.map((report) => ({
              period_key: report.period_key,
              alerts: report.baseline.alerts,
              closed: report.baseline.closed,
              winrate_pct: report.baseline.winrate_pct,
              expectancy_r: report.baseline.expectancy_r,
              recommendations: report.recommendations.length,
            })),
          },
          top_rules: weekly.optimizer_recommendations,
          top_combos: reports,
          fastest_improving: weekly.top_performers,
          fastest_declining: weekly.worst_performers,
          highest_confidence: reports.flatMap((report) => report.recommendations).sort((a, b) => b.confidence_score - a.confidence_score).slice(0, 10),
          largest_sample: reports.flatMap((report) => report.buckets).sort((a, b) => b.sample_size - a.sample_size).slice(0, 10),
        },
      });
    }

    return result;
  }

  function createScheduler({
    utcHour = 2,
    utcMinute = 10,
    intervalMs = 60 * 1000,
  } = {}) {
    let lastRunDate = "";
    let running = false;

    async function tick(now = new Date()) {
      if (!enabled || running) return { ran: false };
      const dateKey = now.toISOString().slice(0, 10);
      if (lastRunDate === dateKey) return { ran: false };
      if (now.getUTCHours() !== utcHour || now.getUTCMinutes() < utcMinute) return { ran: false };

      running = true;
      try {
        const report = await runReport({ now, persist: true });
        lastRunDate = dateKey;
        console.log("QUALITY OPTIMIZER REPORT GENERATED:", {
          generatedAtUtc: report.generated_at_utc,
          alerts: report.source_counts?.alerts,
          outcomes: report.source_counts?.outcomes,
          autoTuningEnabled: Boolean(autoTuning),
        });
        return { ran: true, report };
      } catch (err) {
        console.error("QUALITY OPTIMIZER ERROR:", err);
        return { ran: false, error: err?.message || String(err) };
      } finally {
        running = false;
      }
    }

    const timer = setInterval(() => {
      void tick();
    }, intervalMs);
    timer.unref?.();

    return { tick, stop: () => clearInterval(timer) };
  }

  return {
    runReport,
    createScheduler,
  };
}
