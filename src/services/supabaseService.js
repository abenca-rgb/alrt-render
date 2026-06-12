import fetch from "node-fetch";
import { isoFromMs } from "../utils/date.js";

export function createSupabaseService({ enabled, url, serviceRoleKey, backendVersion }) {
  function ready() {
    return Boolean(enabled && url && serviceRoleKey);
  }

  async function request(table, { method = "POST", body, query = "", prefer = "return=minimal" } = {}) {
    if (!ready()) return { skipped: true };

    const response = await fetch(`${url}/rest/v1/${table}${query}`, {
      method,
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: prefer,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Supabase ${table} ${method} failed ${response.status}: ${text}`);
    }

    return { ok: true };
  }

  async function rpc(functionName, body = {}) {
    if (!ready()) return { skipped: true };

    const response = await fetch(`${url}/rest/v1/rpc/${functionName}`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Supabase RPC ${functionName} failed ${response.status}: ${text}`);
    }

    return response.json();
  }

  async function selectRows(table, query = "") {
    if (!ready()) return [];

    const response = await fetch(`${url}/rest/v1/${table}${query}`, {
      method: "GET",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Supabase ${table} SELECT failed ${response.status}: ${text}`);
    }

    return response.json();
  }

  function background(label, task) {
    if (!ready()) return;

    Promise.resolve()
      .then(task)
      .catch((err) => {
        console.warn(`SUPABASE ${label} WARNING:`, err?.message || String(err));
      });
  }

  function persistAlert({
    alertId,
    refId,
    symbol,
    side,
    timeframe,
    setupType,
    entry,
    tp,
    sl,
    rr,
    riskScore,
    qualityScore,
    qualityGrade,
    whyText,
    signalTimeMs,
    session,
    marketRegime,
    pineVersion,
    isFreeShared,
    rawPayload,
  }) {
    background("ALERT INSERT", () =>
      request("alerts", {
        body: {
          alert_id: String(alertId),
          ref_id: String(refId),
          symbol,
          direction: side,
          timeframe,
          setup_type: setupType,
          entry_price: entry,
          tp_price: tp,
          sl_price: sl,
          rr,
          risk_score: riskScore ?? null,
          quality_score: qualityScore ?? null,
          quality_grade: qualityGrade || null,
          why_text: whyText || null,
          signal_time_utc: isoFromMs(signalTimeMs),
          session_name: session || null,
          market_regime: marketRegime || null,
          pine_version: pineVersion || null,
          backend_version: backendVersion,
          is_free_shared: Boolean(isFreeShared),
          raw_payload: rawPayload || null,
        },
      }),
    );
  }

  function persistCandidate({
    candidateKey,
    alertId,
    refId,
    symbol,
    side,
    timeframe,
    entry,
    tp1,
    tp2,
    tp3,
    sl,
    rr,
    rsi,
    trendStrength,
    atrPct,
    volatilityPct,
    session,
    marketRegime,
    setupType,
    setupScore,
    strength,
    pineVersion,
    renderVersion,
    eventType,
    eventTimeMs,
    rawPayload,
  }) {
    if (!candidateKey) return;

    background("CANDIDATE UPSERT", () =>
      request("alert_candidates", {
        query: "?on_conflict=candidate_key",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          candidate_key: String(candidateKey),
          alert_id: alertId ? String(alertId) : null,
          ref_id: refId ? String(refId) : null,
          symbol: symbol || null,
          direction: side || null,
          timeframe: timeframe || null,
          entry_price: entry ?? null,
          tp1_price: tp1 ?? null,
          tp2_price: tp2 ?? null,
          tp3_price: tp3 ?? null,
          sl_price: sl ?? null,
          rr: rr ?? null,
          rsi: rsi ?? null,
          trend_strength: trendStrength ?? null,
          atr_pct: atrPct ?? null,
          volatility_pct: volatilityPct ?? null,
          session_name: session || null,
          market_regime: marketRegime || null,
          setup_type: setupType || null,
          setup_score: setupScore ?? null,
          strength: strength || null,
          pine_version: pineVersion || null,
          render_version: renderVersion || backendVersion,
          event_type: eventType || null,
          event_time_utc: isoFromMs(eventTimeMs),
          raw_payload: rawPayload || null,
          updated_at: new Date().toISOString(),
        },
      }),
    );
  }

  function updateCandidateDecision({
    candidateKey,
    decision,
    reason,
    qualityScore,
    qualityGrade,
    refId,
    alertId,
    postedToPaid,
    postedToFree,
  }) {
    if (!candidateKey) return;

    background("CANDIDATE DECISION UPDATE", () =>
      request("alert_candidates", {
        method: "PATCH",
        query: `?candidate_key=eq.${encodeURIComponent(String(candidateKey))}`,
        body: {
          decision: decision || "PENDING",
          decision_reason: reason || null,
          quality_score: qualityScore ?? null,
          quality_grade: qualityGrade || null,
          ref_id: refId ? String(refId) : null,
          alert_id: alertId ? String(alertId) : null,
          posted_to_paid: Boolean(postedToPaid),
          posted_to_free: Boolean(postedToFree),
          updated_at: new Date().toISOString(),
        },
      }),
    );
  }

  function persistOutcome({ trade, outcomeType, outcomeTimeMs, pnlPercent, durationMinutes, exitPrice, rawPayload }) {
    const alertId = trade?.primaryAlertId || trade?.alertIds?.[0] || trade?.refId;
    if (!alertId || !trade?.refId) return;

    background("OUTCOME INSERT", () =>
      request("outcomes", {
        body: {
          alert_id: String(alertId),
          ref_id: String(trade.refId),
          candidate_key: trade.candidateKey || trade.primaryAlertId || null,
          symbol: trade.symbol || null,
          direction: trade.side || null,
          outcome_type: outcomeType,
          outcome_time_utc: isoFromMs(outcomeTimeMs),
          closed_at_utc: isoFromMs(outcomeTimeMs),
          pnl_percent: pnlPercent ?? null,
          move_pct: pnlPercent ?? null,
          r_multiple: rawPayload?.rMultiple ?? null,
          duration_minutes: durationMinutes ?? null,
          exit_price: exitPrice ?? null,
          matched_by: rawPayload?.matchType || null,
          raw_payload: rawPayload || null,
        },
      }),
    );
  }

  function persistShadowEvaluation({
    candidateKey,
    alertId,
    refId,
    symbol,
    side,
    timeframe,
    setupType,
    liveDecision,
    shadowVersion,
    eventTimeMs,
    rawContext,
    ruleResults = [],
    comboResults = [],
  }) {
    if (!candidateKey || !shadowVersion) return;

    background("SHADOW EVALUATION UPSERT", async () => {
      const evaluatedAtUtc = new Date().toISOString();

      await request("shadow_evaluations", {
        query: "?on_conflict=candidate_key,shadow_version",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          candidate_key: String(candidateKey),
          alert_id: alertId ? String(alertId) : null,
          ref_id: refId ? String(refId) : null,
          symbol: symbol || null,
          direction: side || null,
          timeframe: timeframe || null,
          setup_type: setupType || null,
          live_decision: liveDecision || "ACCEPTED",
          shadow_version: shadowVersion,
          event_time_utc: isoFromMs(eventTimeMs),
          evaluated_at_utc: evaluatedAtUtc,
          raw_context: rawContext || null,
        },
      });

      if (ruleResults.length) {
        await request("shadow_rule_results", {
          query: "?on_conflict=candidate_key,shadow_version,rule_name",
          prefer: "resolution=merge-duplicates,return=minimal",
          body: ruleResults.map((rule) => ({
            candidate_key: String(candidateKey),
            alert_id: alertId ? String(alertId) : null,
            ref_id: refId ? String(refId) : null,
            rule_name: rule.ruleName,
            rule_status: rule.status,
            score_adjustment: rule.scoreAdjustment ?? 0,
            would_reject: Boolean(rule.wouldReject),
            reason: rule.reason || null,
            details: rule.details || null,
            shadow_version: shadowVersion,
            evaluated_at_utc: evaluatedAtUtc,
          })),
        });
      }

      if (comboResults.length) {
        await request("shadow_combo_results", {
          query: "?on_conflict=candidate_key,shadow_version,combo_name",
          prefer: "resolution=merge-duplicates,return=minimal",
          body: comboResults.map((combo) => ({
            candidate_key: String(candidateKey),
            alert_id: alertId ? String(alertId) : null,
            ref_id: refId ? String(refId) : null,
            combo_name: combo.comboName,
            rule_names: combo.ruleNames,
            combo_status: combo.status,
            total_score_adjustment: combo.totalScoreAdjustment ?? 0,
            would_reject: Boolean(combo.wouldReject),
            reasons: combo.reasons || [],
            details: combo.details || null,
            shadow_version: shadowVersion,
            evaluated_at_utc: evaluatedAtUtc,
          })),
        });
      }
    });
  }

  function updateShadowOutcome({
    candidateKey,
    alertId,
    refId,
    outcomeType,
    outcomeTimeMs,
    movePct,
    rMultiple,
    outcomeEffect,
  }) {
    if (!candidateKey) return;

    const outcomeTimeUtc = isoFromMs(outcomeTimeMs);

    background("SHADOW OUTCOME UPDATE", async () => {
      await request("shadow_evaluations", {
        method: "PATCH",
        query: `?candidate_key=eq.${encodeURIComponent(String(candidateKey))}`,
        body: {
          alert_id: alertId ? String(alertId) : null,
          ref_id: refId ? String(refId) : null,
          outcome_type: outcomeType || null,
          outcome_time_utc: outcomeTimeUtc,
          move_pct: movePct ?? null,
          r_multiple: rMultiple ?? null,
        },
      });

      const ruleResponse = await fetch(
        `${url}/rest/v1/shadow_rule_results?candidate_key=eq.${encodeURIComponent(String(candidateKey))}&select=id,would_reject`,
        {
          method: "GET",
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            "Content-Type": "application/json",
          },
        },
      );
      const ruleRows = ruleResponse.ok ? await ruleResponse.json() : [];

      for (const row of ruleRows) {
        const effect = outcomeEffect(outcomeType, Boolean(row.would_reject));
        await request("shadow_rule_results", {
          method: "PATCH",
          query: `?id=eq.${encodeURIComponent(String(row.id))}`,
          body: {
            alert_id: alertId ? String(alertId) : null,
            ref_id: refId ? String(refId) : null,
            outcome_type: outcomeType || null,
            outcome_time_utc: outcomeTimeUtc,
            move_pct: movePct ?? null,
            r_multiple: rMultiple ?? null,
            rejection_would_help: effect.rejectionWouldHelp,
            rejection_would_hurt: effect.rejectionWouldHurt,
          },
        });
      }

      const comboResponse = await fetch(
        `${url}/rest/v1/shadow_combo_results?candidate_key=eq.${encodeURIComponent(String(candidateKey))}&select=id,would_reject`,
        {
          method: "GET",
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            "Content-Type": "application/json",
          },
        },
      );
      const comboRows = comboResponse.ok ? await comboResponse.json() : [];

      for (const row of comboRows) {
        const effect = outcomeEffect(outcomeType, Boolean(row.would_reject));
        await request("shadow_combo_results", {
          method: "PATCH",
          query: `?id=eq.${encodeURIComponent(String(row.id))}`,
          body: {
            alert_id: alertId ? String(alertId) : null,
            ref_id: refId ? String(refId) : null,
            outcome_type: outcomeType || null,
            outcome_time_utc: outcomeTimeUtc,
            move_pct: movePct ?? null,
            r_multiple: rMultiple ?? null,
            rejection_would_help: effect.rejectionWouldHelp,
            rejection_would_hurt: effect.rejectionWouldHurt,
          },
        });
      }
    });
  }

  function persistRejection({ symbol, side, setupType, reason, qualityScore, qualityGrade, rawPayload }) {
    background("REJECTION INSERT", () =>
      request("alert_rejections", {
        body: {
          symbol: symbol || null,
          direction: side || null,
          setup_type: setupType || "UNKNOWN",
          reason: String(reason || "unknown").toLowerCase(),
          quality_score: qualityScore ?? null,
          quality_grade: qualityGrade || null,
          raw_payload: rawPayload || null,
        },
      }),
    );
  }

  function persistGuardrailBlock({
    alertId,
    candidateKey,
    symbol,
    side,
    setupType,
    setupGroup,
    blockedBy,
    matchedPreviousAlertId,
    matchedPreviousRefId,
    minutesSincePreviousAlert,
    timestampMs,
    guardrailVersion,
    mode,
    windowMinutes,
    rawPayload,
  }) {
    if (!alertId || !blockedBy) return;

    background("GUARDRAIL BLOCK INSERT", () =>
      request("guardrail_blocks", {
        query: "?on_conflict=alert_id,blocked_by,guardrail_version",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          alert_id: String(alertId),
          candidate_key: candidateKey ? String(candidateKey) : null,
          symbol: symbol || null,
          direction: side || null,
          setup_type: setupType || "UNKNOWN",
          setup_group: setupGroup || "UNKNOWN",
          blocked_by: blockedBy,
          matched_previous_alert_id: matchedPreviousAlertId ? String(matchedPreviousAlertId) : null,
          matched_previous_ref_id: matchedPreviousRefId ? String(matchedPreviousRefId) : null,
          minutes_since_previous_alert: minutesSincePreviousAlert ?? null,
          timestamp_utc: isoFromMs(timestampMs),
          guardrail_version: guardrailVersion || null,
          mode: mode || null,
          window_minutes: windowMinutes ?? null,
          raw_payload: rawPayload || null,
        },
      }),
    );
  }

  function persistDailySummary({ dateKey, stat, openCount, winrate }) {
    background("DAILY SUMMARY UPSERT", () =>
      request("daily_summaries", {
        query: "?on_conflict=date_key",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          date_key: dateKey,
          alerts_count: stat.alerts || 0,
          tp_count: stat.tp || 0,
          sl_count: stat.sl || 0,
          expired_count: stat.expired || 0,
          time_exit_profit_count: stat.timeExitProfit || 0,
          time_exit_loss_count: stat.timeExitLoss || 0,
          open_count: openCount,
          rejected_count: stat.rejectedSignals || 0,
          winrate,
          updated_at: new Date().toISOString(),
        },
      }),
    );
  }

  async function persistOptimizerReport({
    period,
    generatedAtUtc,
    ruleSnapshots = [],
    comboSnapshots = [],
    recommendations = [],
    summary = {},
    monitoringReport = null,
  }) {
    if (!ready()) return { skipped: true };

    if (ruleSnapshots.length) {
      await request("optimizer_rule_snapshots", {
        query: "?on_conflict=snapshot_key",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: ruleSnapshots,
      });
    }

    if (comboSnapshots.length) {
      await request("optimizer_combo_snapshots", {
        query: "?on_conflict=snapshot_key",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: comboSnapshots,
      });
    }

    if (recommendations.length) {
      await request("optimizer_recommendations", {
        query: "?on_conflict=recommendation_key",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: recommendations,
      });
    }

    await request("shadow_optimizer_reports", {
      query: "?on_conflict=report_key",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        report_key: `phase4a:${period.periodType}:${period.start ? period.start.toISOString() : "all"}`,
        report_type: `phase4a_${period.periodType}`,
        shadow_version: summary.shadowVersion || "mixed",
        period_start_utc: period.start ? period.start.toISOString() : null,
        period_end_utc: period.end ? period.end.toISOString() : null,
        generated_at_utc: generatedAtUtc,
        summary,
        recommendations,
      },
    });

    if (monitoringReport) {
      await request("optimizer_monitoring_reports", {
        query: "?on_conflict=report_key",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: monitoringReport,
      });
    }

    return { ok: true };
  }

  return {
    ready,
    request,
    rpc,
    selectRows,
    persistAlert,
    persistCandidate,
    updateCandidateDecision,
    persistOutcome,
    persistShadowEvaluation,
    updateShadowOutcome,
    persistRejection,
    persistGuardrailBlock,
    persistDailySummary,
    persistOptimizerReport,
  };
}
