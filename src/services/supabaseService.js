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

  function background(label, task) {
    if (!ready()) return;

    Promise.resolve()
      .then(task)
      .catch((err) => {
        console.error(`SUPABASE ${label} FAILED:`, err?.message || String(err));
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

  function persistOutcome({ trade, outcomeType, outcomeTimeMs, pnlPercent, durationMinutes, exitPrice, rawPayload }) {
    const alertId = trade?.primaryAlertId || trade?.alertIds?.[0] || trade?.refId;
    if (!alertId || !trade?.refId) return;

    background("OUTCOME INSERT", () =>
      request("outcomes", {
        body: {
          alert_id: String(alertId),
          ref_id: String(trade.refId),
          outcome_type: outcomeType,
          outcome_time_utc: isoFromMs(outcomeTimeMs),
          pnl_percent: pnlPercent ?? null,
          duration_minutes: durationMinutes ?? null,
          exit_price: exitPrice ?? null,
          raw_payload: rawPayload || null,
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

  return {
    ready,
    request,
    rpc,
    persistAlert,
    persistOutcome,
    persistRejection,
    persistDailySummary,
  };
}
