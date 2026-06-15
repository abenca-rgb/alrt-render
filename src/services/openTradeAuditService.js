const CLOSE_OUTCOMES = new Set(["TP", "SL", "TIME_EXIT_PROFIT", "TIME_EXIT_LOSS", "EXPIRED", "MANUAL_CLOSE"]);

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

function normalizeId(value) {
  return String(value || "").trim();
}

function normalizeText(value, fallback = "UNKNOWN") {
  const text = String(value || "").trim();
  return text || fallback;
}

function closeTime(outcome) {
  return outcome?.closed_at_utc || outcome?.outcome_time_utc || outcome?.created_at || null;
}

function ageBucket(ageHours) {
  if (ageHours < 24) return "0-24h";
  if (ageHours < 72) return "1-3d";
  if (ageHours < 168) return "3-7d";
  return "7+d";
}

function classifyOpenAlert({ alert, nowMs, maxTradeAgeMs, runtimeOpenIds, closedByRef }) {
  const openedMs = new Date(alert.signal_time_utc || alert.created_at || 0).getTime();
  const ageMs = Number.isFinite(openedMs) ? Math.max(0, nowMs - openedMs) : null;
  const ageHours = ageMs === null ? null : ageMs / 3600000;
  const alertId = normalizeId(alert.alert_id);
  const refId = normalizeId(alert.ref_id);
  const hasRuntimeTrade = runtimeOpenIds.has(alertId) || runtimeOpenIds.has(refId);
  const hasRefClose = refId && closedByRef.has(refId);

  if (hasRefClose) {
    return {
      current_status: "MISSING_CLOSE",
      reason_still_open: "Supabase outcome exists by ref_id, but the alert_id close link is missing.",
      age_hours: round(ageHours, 2),
      has_runtime_trade: hasRuntimeTrade,
    };
  }

  if (ageMs !== null && ageMs > maxTradeAgeMs) {
    return {
      current_status: "TIME_EXIT_REQUIRED",
      reason_still_open: `No close outcome found and age is ${round(ageHours, 1)}h, above lifecycle limit.`,
      age_hours: round(ageHours, 2),
      has_runtime_trade: hasRuntimeTrade,
    };
  }

  return {
    current_status: "ACTIVE",
    reason_still_open: hasRuntimeTrade
      ? "Still inside lifecycle limit and present in runtime active trades."
      : "Still inside lifecycle limit, but not confirmed in runtime active trades.",
    age_hours: round(ageHours, 2),
    has_runtime_trade: hasRuntimeTrade,
  };
}

export function createOpenTradeAuditService({
  supabase,
  getActiveTrades = () => [],
  maxTradeAgeMs = 24 * 60 * 60 * 1000,
} = {}) {
  async function selectRows(table, query) {
    return supabase.selectRows(table, query);
  }

  async function runOpenTradeAudit({ nowMs = Date.now(), limit = 10000 } = {}) {
    if (!supabase.ready()) {
      return {
        ok: false,
        error: "Supabase is not enabled",
        generated_at_utc: new Date(nowMs).toISOString(),
      };
    }

    const nowIso = new Date(nowMs).toISOString();
    const encodedNow = encodeURIComponent(nowIso);
    const [alerts, outcomes] = await Promise.all([
      selectRows(
        "alerts",
        `?select=alert_id,ref_id,symbol,direction,setup_type,signal_time_utc,created_at&signal_time_utc=lte.${encodedNow}&limit=${limit}`,
      ),
      selectRows(
        "outcomes",
        `?select=alert_id,ref_id,symbol,direction,outcome_type,outcome_time_utc,closed_at_utc,created_at&outcome_time_utc=lte.${encodedNow}&limit=${limit}`,
      ),
    ]);

    const alertsById = new Map();
    const closedByAlertId = new Map();
    const closedByRef = new Map();

    for (const alert of alerts) {
      const alertId = normalizeId(alert.alert_id);
      if (alertId) alertsById.set(alertId, alert);
    }

    for (const outcome of outcomes) {
      if (!CLOSE_OUTCOMES.has(outcome.outcome_type)) continue;

      const alertId = normalizeId(outcome.alert_id);
      const refId = normalizeId(outcome.ref_id);
      const previousAlertClose = closedByAlertId.get(alertId);
      const previousRefClose = closedByRef.get(refId);
      const outcomeMs = new Date(closeTime(outcome) || 0).getTime();
      const previousAlertMs = new Date(closeTime(previousAlertClose) || 0).getTime();
      const previousRefMs = new Date(closeTime(previousRefClose) || 0).getTime();

      if (alertId && (!previousAlertClose || outcomeMs >= previousAlertMs)) {
        closedByAlertId.set(alertId, outcome);
      }
      if (refId && (!previousRefClose || outcomeMs >= previousRefMs)) {
        closedByRef.set(refId, outcome);
      }
    }

    const runtimeOpenIds = new Set();
    for (const trade of getActiveTrades() || []) {
      const alertId = normalizeId(trade.alertId || trade.alert_id || trade.candidateId || trade.candidate_key);
      const refId = normalizeId(trade.refId || trade.ref_id || trade.ref);
      if (alertId) runtimeOpenIds.add(alertId);
      if (refId) runtimeOpenIds.add(refId);
    }

    const openAlerts = alerts.filter((alert) => !closedByAlertId.has(normalizeId(alert.alert_id)));
    const trades = openAlerts
      .map((alert) => {
        const classification = classifyOpenAlert({
          alert,
          nowMs,
          maxTradeAgeMs,
          runtimeOpenIds,
          closedByRef,
        });
        return {
          trade_id: normalizeId(alert.alert_id),
          ref_id: normalizeId(alert.ref_id),
          symbol: normalizeText(alert.symbol),
          direction: normalizeText(alert.direction),
          setup: normalizeText(alert.setup_type),
          opened_utc: alert.signal_time_utc || alert.created_at || null,
          ...classification,
        };
      })
      .sort((a, b) => new Date(a.opened_utc || 0).getTime() - new Date(b.opened_utc || 0).getTime());

    const orphanOutcomes = outcomes
      .filter((outcome) => CLOSE_OUTCOMES.has(outcome.outcome_type))
      .filter((outcome) => !alertsById.has(normalizeId(outcome.alert_id)))
      .map((outcome) => ({
        alert_id: normalizeId(outcome.alert_id),
        ref_id: normalizeId(outcome.ref_id),
        symbol: normalizeText(outcome.symbol),
        direction: normalizeText(outcome.direction),
        outcome_type: outcome.outcome_type,
        closed_utc: closeTime(outcome),
      }));

    const byStatus = trades.reduce((acc, trade) => {
      acc[trade.current_status] = (acc[trade.current_status] || 0) + 1;
      return acc;
    }, {});

    const openByAge = {
      "0-24h": 0,
      "1-3d": 0,
      "3-7d": 0,
      "7+d": 0,
    };

    for (const trade of trades) {
      const ageHours = numberOrNull(trade.age_hours);
      if (ageHours !== null) openByAge[ageBucket(ageHours)] += 1;
    }

    const activeTrades = trades.filter((trade) => trade.current_status === "ACTIVE");
    const activeAges = activeTrades.map((trade) => numberOrNull(trade.age_hours)).filter((value) => value !== null);
    const averageOpenDurationHours =
      activeAges.length > 0 ? round(activeAges.reduce((sum, value) => sum + value, 0) / activeAges.length, 2) : null;
    const oldestActiveTradeHours = activeAges.length > 0 ? round(Math.max(...activeAges), 2) : null;

    return {
      ok: true,
      generated_at_utc: nowIso,
      lifecycle_limit_hours: round(maxTradeAgeMs / 3600000, 2),
      totals: {
        alerts_checked: alerts.length,
        outcomes_checked: outcomes.length,
        supabase_open_missing_close: trades.length,
        genuinely_active: byStatus.ACTIVE || 0,
        time_exit_required: byStatus.TIME_EXIT_REQUIRED || 0,
        missing_close: byStatus.MISSING_CLOSE || 0,
        orphan_outcomes: orphanOutcomes.length,
        runtime_active_trades: runtimeOpenIds.size,
      },
      open_trade_quality: {
        active_trades: activeTrades.length,
        average_open_duration_hours: averageOpenDurationHours,
        oldest_active_trade_hours: oldestActiveTradeHours,
      },
      open_by_age: openByAge,
      status_counts: byStatus,
      trades,
      orphan_outcomes: orphanOutcomes,
    };
  }

  return {
    runOpenTradeAudit,
  };
}
