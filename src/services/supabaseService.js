import fetch from "node-fetch";
import { isoFromMs } from "../utils/date.js";

function normalizeText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeId(value) {
  const text = normalizeText(value);
  return text ? String(text) : null;
}

function buildAlertFallbackFromTrade({ trade, alertId, refId, rawPayload }) {
  const signalTimeMs = Number(trade?.createdAtMs);

  return {
    alert_id: String(alertId),
    ref_id: String(refId),
    symbol: trade?.symbol || "UNKNOWN",
    direction: trade?.side || "LONG",
    timeframe: trade?.timeframe || null,
    setup_type: trade?.setupType || "UNKNOWN",
    entry_price: trade?.entry ?? null,
    tp_price: trade?.tp ?? null,
    sl_price: trade?.sl ?? null,
    rr: trade?.rr ?? null,
    risk_score: null,
    quality_score: trade?.qualityScore ?? null,
    quality_grade: trade?.qualityGrade || null,
    why_text: "Recovered automatically before outcome insert because the alert row was missing.",
    signal_time_utc: isoFromMs(Number.isFinite(signalTimeMs) ? signalTimeMs : Date.now()),
    session_name: trade?.session || null,
    market_regime: trade?.marketRegime || trade?.volatilityState || null,
    pine_version: null,
    backend_version: rawPayload?.backendVersion || null,
    is_free_shared: Boolean(trade?.sharedToFree),
    raw_payload: {
      source: "outcome_alert_fallback",
      candidate_key: trade?.candidateKey || null,
      primary_alert_id: trade?.primaryAlertId || null,
      alert_ids: Array.isArray(trade?.alertIds) ? trade.alertIds : [],
      original_close_payload: rawPayload || null,
    },
  };
}

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
    const alertId = normalizeId(trade?.primaryAlertId || trade?.alertIds?.[0] || trade?.candidateKey || trade?.refId);
    const refId = normalizeId(trade?.refId);
    if (!alertId || !refId) return;

    background("OUTCOME UPSERT", async () => {
      await request("alerts", {
        query: "?on_conflict=alert_id",
        prefer: "resolution=ignore-duplicates,return=minimal",
        body: buildAlertFallbackFromTrade({
          trade,
          alertId,
          refId,
          rawPayload: {
            ...rawPayload,
            backendVersion,
          },
        }),
      });

      await request("outcomes", {
        query: "?on_conflict=alert_id",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          alert_id: String(alertId),
          ref_id: String(refId),
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
      });
    });
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

  function persistShadowScoreEvaluation({
    candidateKey,
    alertId,
    refId,
    symbol,
    side,
    timeframe,
    setupType,
    liveDecision,
    decisionReason,
    shadowVersion,
    eventTimeMs,
    postedToPaid,
    postedToFree,
    currentScore,
    currentGrade,
    proposedScore,
    proposedGrade,
    scoreDelta,
    scoreComponents,
    penaltyReasons,
    bonusReasons,
    majorPenaltyActive,
    recommendedAction,
  }) {
    if (!candidateKey || !shadowVersion) return;

    if (shadowVersion === "shadow_v2_1") {
      background("SHADOW V2.1 CANDIDATE UPDATE", () =>
        request("alert_candidates", {
          method: "PATCH",
          query: `?candidate_key=eq.${encodeURIComponent(String(candidateKey))}`,
          body: {
            current_score: currentScore ?? null,
            current_grade: currentGrade || null,
            proposed_score: proposedScore ?? null,
            proposed_grade: proposedGrade || null,
            score_delta: scoreDelta ?? null,
            score_components: scoreComponents || {},
            shadow_v21_score: proposedScore ?? null,
            shadow_v21_grade: proposedGrade || null,
            shadow_v21_decision: liveDecision || "PENDING",
            shadow_v21_block_reason:
              String(decisionReason || "").includes("shadow_v21_live_gate_blocked")
                ? decisionReason
                : null,
            shadow_v21_scored_at_utc: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        }),
      );
    }

    background("SHADOW SCORE UPSERT", () =>
      request("shadow_score_evaluations", {
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
          live_decision: liveDecision || "PENDING",
          decision_reason: decisionReason || null,
          shadow_version: shadowVersion,
          event_time_utc: isoFromMs(eventTimeMs),
          evaluated_at_utc: new Date().toISOString(),
          posted_to_paid: Boolean(postedToPaid),
          posted_to_free: Boolean(postedToFree),
          current_score: currentScore ?? null,
          current_grade: currentGrade || null,
          proposed_score: proposedScore ?? null,
          proposed_grade: proposedGrade || null,
          score_delta: scoreDelta ?? null,
          score_components: scoreComponents || {},
          penalty_reasons: penaltyReasons || [],
          bonus_reasons: bonusReasons || [],
          major_penalty_active: Boolean(majorPenaltyActive),
          recommended_action: recommendedAction || null,
          updated_at: new Date().toISOString(),
        },
      }),
    );
  }

  function updateShadowScoreOutcome({
    candidateKey,
    alertId,
    refId,
    outcomeType,
    outcomeTimeMs,
    marketMovePct,
    return2x,
    return3x,
    return4x,
    return5x,
    return6x,
    rMultiple,
  }) {
    if (!candidateKey) return;

    background("SHADOW SCORE OUTCOME UPDATE", () =>
      request("shadow_score_evaluations", {
        method: "PATCH",
        query: `?candidate_key=eq.${encodeURIComponent(String(candidateKey))}`,
        body: {
          alert_id: alertId ? String(alertId) : null,
          ref_id: refId ? String(refId) : null,
          outcome_type: outcomeType || null,
          outcome_time_utc: isoFromMs(outcomeTimeMs),
          market_move_pct: marketMovePct ?? null,
          r_multiple: rMultiple ?? null,
          return_2x: return2x ?? null,
          return_3x: return3x ?? null,
          return_4x: return4x ?? null,
          return_5x: return5x ?? null,
          return_6x: return6x ?? null,
          updated_at: new Date().toISOString(),
        },
      }),
    );
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
    persistShadowScoreEvaluation,
    updateShadowScoreOutcome,
    persistRejection,
    persistGuardrailBlock,
    persistDailySummary,
    persistOptimizerReport,
  };
}
