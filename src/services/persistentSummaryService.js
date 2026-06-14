import { buildDailySummaryText } from "./summaryService.js";
import { fmtPct } from "../utils/numbers.js";

const WIN_OUTCOMES = new Set(["TP", "TIME_EXIT_PROFIT"]);
const LOSS_OUTCOMES = new Set(["SL", "TIME_EXIT_LOSS"]);
const CLOSE_OUTCOMES = new Set(["TP", "SL", "TIME_EXIT_PROFIT", "TIME_EXIT_LOSS", "EXPIRED"]);

function startOfUtcDay(dateKey) {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function getUtcWeekKey(nowMs = Date.now()) {
  const date = new Date(nowMs);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function getUtcWeekRange(weekKey) {
  const match = String(weekKey || "").match(/^(\d{4})-W(\d{2})$/);
  if (!match) {
    const now = new Date();
    const day = now.getUTCDay() || 7;
    const monday = addDays(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), 1 - day);
    return { start: monday, end: addDays(monday, 7), key: getUtcWeekKey(now.getTime()) };
  }

  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = addDays(jan4, 1 - jan4Day);
  const start = addDays(week1Monday, (week - 1) * 7);

  return { start, end: addDays(start, 7), key: `${year}-W${String(week).padStart(2, "0")}` };
}

function emptyClosureStats() {
  return {
    tp: 0,
    sl: 0,
    timeExitProfit: 0,
    timeExitLoss: 0,
    expired: 0,
  };
}

function emptyStat(dateKey) {
  return {
    date: dateKey,
    alerts: 0,
    tp: 0,
    sl: 0,
    timeExitProfit: 0,
    timeExitLoss: 0,
    expired: 0,
    freeAlerts: 0,
    rejectedSignals: 0,
    rejectsByReason: {},
    oldClosures: emptyClosureStats(),
    orphanClosures: emptyClosureStats(),
    bySymbol: {},
    bySetup: {},
    byRef: {},
  };
}

function ensureBucket(map, key) {
  const finalKey = key || "UNKNOWN";
  if (!map[finalKey]) {
    map[finalKey] = {
      alerts: 0,
      tp: 0,
      sl: 0,
      timeExitProfit: 0,
      timeExitLoss: 0,
      expired: 0,
    };
  }
  return map[finalKey];
}

function countOutcome(target, outcomeType) {
  if (outcomeType === "TP") target.tp += 1;
  if (outcomeType === "SL") target.sl += 1;
  if (outcomeType === "TIME_EXIT_PROFIT") target.timeExitProfit += 1;
  if (outcomeType === "TIME_EXIT_LOSS") target.timeExitLoss += 1;
  if (outcomeType === "EXPIRED") target.expired += 1;
}

function normalizeOutcomeTime(outcome) {
  return outcome.closed_at_utc || outcome.outcome_time_utc || outcome.created_at || null;
}

function buildWeeklySummaryText({ weekKey, startKey, endKey, stats }) {
  const closed = stats.tp + stats.sl + stats.timeExitProfit + stats.timeExitLoss + stats.expired;
  const wins = stats.tp + stats.timeExitProfit;
  const winrate = closed > 0 ? (wins / closed) * 100 : null;

  return `📊 <b>D-ALRT WEEKLY OVERVIEW</b>
<b>UTC WEEK</b> ${weekKey} (${startKey} → ${endKey})

<b>POSTED</b> ${stats.alerts}
<b>CLOSED</b> ${closed} | TP ${stats.tp} | SL ${stats.sl} | TIME ${stats.timeExitProfit || 0}/${stats.timeExitLoss || 0}
<b>WINRATE</b> ${closed > 0 ? fmtPct(winrate) : "N/A"}
<b>OPEN</b> ${stats.openTotal} total
<b>REJECTED</b> ${stats.rejectedSignals || 0}

NFA`;
}

export function createPersistentSummaryService({
  supabase,
  getDailyStat,
  getActiveTrades,
  sendTelegramMessage,
  paidChatId,
  freeChatId,
  mirrorChatIds = [],
  dispatchScope = "default",
}) {
  function ready() {
    return supabase.ready();
  }

  async function selectRows(table, query) {
    return supabase.selectRows(table, query);
  }

  async function buildPersistentStats({ periodType, periodKey }) {
    const range =
      periodType === "weekly"
        ? getUtcWeekRange(periodKey)
        : { start: startOfUtcDay(periodKey), end: addDays(startOfUtcDay(periodKey), 1), key: periodKey };

    const startIso = range.start.toISOString();
    const endIso = range.end.toISOString();
    const stat = emptyStat(periodKey);

    const [alerts, outcomes, rejections, allAlertsBeforeEnd, allOutcomesBeforeEnd] = await Promise.all([
      selectRows(
        "alerts",
        `?select=alert_id,ref_id,symbol,direction,setup_type,is_free_shared,signal_time_utc&signal_time_utc=gte.${encodeURIComponent(startIso)}&signal_time_utc=lt.${encodeURIComponent(endIso)}&limit=10000`,
      ),
      selectRows(
        "outcomes",
        `?select=alert_id,ref_id,symbol,direction,outcome_type,outcome_time_utc,closed_at_utc,move_pct,pnl_percent,r_multiple&outcome_time_utc=gte.${encodeURIComponent(startIso)}&outcome_time_utc=lt.${encodeURIComponent(endIso)}&limit=10000`,
      ),
      selectRows(
        "alert_rejections",
        `?select=reason,symbol,direction,setup_type,created_at&created_at=gte.${encodeURIComponent(startIso)}&created_at=lt.${encodeURIComponent(endIso)}&limit=10000`,
      ),
      selectRows(
        "alerts",
        `?select=alert_id,ref_id,symbol,direction,setup_type,is_free_shared,signal_time_utc&signal_time_utc=lt.${encodeURIComponent(endIso)}&limit=10000`,
      ),
      selectRows(
        "outcomes",
        `?select=alert_id,ref_id,outcome_type,outcome_time_utc,closed_at_utc&outcome_time_utc=lt.${encodeURIComponent(endIso)}&limit=10000`,
      ),
    ]);

    const periodAlertsByAlertId = new Map();
    const allAlertsByAlertId = new Map();

    for (const alert of allAlertsBeforeEnd) {
      allAlertsByAlertId.set(String(alert.alert_id), alert);
    }

    for (const alert of alerts) {
      periodAlertsByAlertId.set(String(alert.alert_id), alert);
      stat.alerts += 1;
      if (alert.is_free_shared) stat.freeAlerts += 1;

      const symbolStats = ensureBucket(stat.bySymbol, alert.symbol);
      const setupStats = ensureBucket(stat.bySetup, alert.setup_type);
      symbolStats.alerts += 1;
      setupStats.alerts += 1;

      stat.byRef[String(alert.ref_id)] = {
        refId: String(alert.ref_id),
        symbol: alert.symbol,
        side: alert.direction,
        setupType: alert.setup_type || "UNKNOWN",
        sharedToFree: Boolean(alert.is_free_shared),
        openedDateKey: String(alert.signal_time_utc || "").slice(0, 10),
        openedAtUtc: alert.signal_time_utc,
        result: "OPEN",
      };
    }

    for (const rejection of rejections) {
      const reason = String(rejection.reason || "unknown").toLowerCase();
      stat.rejectedSignals += 1;
      stat.rejectsByReason[reason] = (stat.rejectsByReason[reason] || 0) + 1;
    }

    for (const outcome of outcomes) {
      const type = outcome.outcome_type;
      if (!CLOSE_OUTCOMES.has(type)) continue;

      const sourceAlert = allAlertsByAlertId.get(String(outcome.alert_id));
      const periodAlert = periodAlertsByAlertId.get(String(outcome.alert_id));
      const target = periodAlert ? stat : stat.oldClosures;

      countOutcome(target, type);

      if (periodAlert) {
        const symbolStats = ensureBucket(stat.bySymbol, periodAlert.symbol || outcome.symbol);
        const setupStats = ensureBucket(stat.bySetup, periodAlert.setup_type || "UNKNOWN");
        countOutcome(symbolStats, type);
        countOutcome(setupStats, type);

        const ref = String(periodAlert.ref_id || outcome.ref_id);
        if (stat.byRef[ref]) {
          stat.byRef[ref].result = type;
          stat.byRef[ref].closedAtUtc = normalizeOutcomeTime(outcome);
          stat.byRef[ref].movePct = outcome.move_pct ?? outcome.pnl_percent ?? null;
        }
      } else if (!sourceAlert) {
        countOutcome(stat.orphanClosures, type);
      }
    }

    const closedBeforeEnd = new Set(
      allOutcomesBeforeEnd
        .filter((outcome) => CLOSE_OUTCOMES.has(outcome.outcome_type))
        .map((outcome) => String(outcome.alert_id)),
    );
    const openTotal = allAlertsBeforeEnd.filter((alert) => !closedBeforeEnd.has(String(alert.alert_id))).length;

    return {
      periodType,
      periodKey,
      startUtc: startIso,
      endUtc: endIso,
      startKey: toDateKey(range.start),
      endKey: toDateKey(addDays(range.end, -1)),
      stat,
      activeTrades: Array.from(stat.byRef ? Object.values(stat.byRef) : []).filter((trade) => trade.result === "OPEN"),
      openTotal,
      source: "supabase",
    };
  }

  function buildFallbackDailySummary(dateKey) {
    return {
      periodType: "daily",
      periodKey: dateKey,
      stat: getDailyStat(dateKey),
      activeTrades: getActiveTrades(),
      openTotal: getActiveTrades().filter((trade) => !trade.hit).length,
      source: "state_fallback",
    };
  }

  async function buildSummary({ periodType = "daily", periodKey }) {
    if (ready()) {
      try {
        const data = await buildPersistentStats({ periodType, periodKey });
        if (periodType === "weekly") {
          const text = buildWeeklySummaryText({
            weekKey: periodKey,
            startKey: data.startKey,
            endKey: data.endKey,
            stats: { ...data.stat, openTotal: data.openTotal },
          });
          return { ...data, text };
        }

        const text = buildDailySummaryText({
          dateKey: periodKey,
          stat: data.stat,
          activeTrades: new Array(data.openTotal).fill({ hit: false }),
        });
        return { ...data, text };
      } catch (err) {
        console.warn("PERSISTENT SUMMARY FALLBACK:", err?.message || String(err));
      }
    }

    if (periodType === "weekly") {
      throw new Error("weekly summary requires Supabase");
    }

    const data = buildFallbackDailySummary(periodKey);
    return {
      ...data,
      text: buildDailySummaryText({
        dateKey: periodKey,
        stat: data.stat,
        activeTrades: data.activeTrades,
      }),
    };
  }

  async function claimSummary({ periodType, periodKey, force = false }) {
    if (!ready()) {
      return { claimed: true, alreadySent: false, source: "state_fallback" };
    }
    try {
      return await supabase.rpc("claim_summary_dispatch", {
        p_period_type: periodType,
        p_period_key: periodKey,
        p_force: Boolean(force),
        p_dispatch_scope: dispatchScope,
      });
    } catch (err) {
      console.warn("SUMMARY DISPATCH SCOPE FALLBACK:", err?.message || String(err));
      return supabase.rpc("claim_summary_dispatch", {
        p_period_type: periodType,
        p_period_key: periodKey,
        p_force: Boolean(force),
      });
    }
  }

  async function completeSummary({ periodType, periodKey, status, text = null, stats = {}, error = null }) {
    if (!ready()) return { skipped: true };
    try {
      return await supabase.rpc("complete_summary_dispatch", {
        p_period_type: periodType,
        p_period_key: periodKey,
        p_status: status,
        p_summary_text: text,
        p_stats: stats,
        p_error: error,
        p_dispatch_scope: dispatchScope,
      });
    } catch (err) {
      console.warn("SUMMARY COMPLETE SCOPE FALLBACK:", err?.message || String(err));
      return supabase.rpc("complete_summary_dispatch", {
        p_period_type: periodType,
        p_period_key: periodKey,
        p_status: status,
        p_summary_text: text,
        p_stats: stats,
        p_error: error,
      });
    }
  }

  async function preview({ periodType = "daily", periodKey }) {
    return buildSummary({ periodType, periodKey });
  }

  async function send({ periodType = "daily", periodKey, force = false }) {
    const claim = await claimSummary({ periodType, periodKey, force });
    if (claim?.alreadySent && !force) {
      return { ok: true, sent: false, alreadySent: true, periodType, periodKey };
    }

    const built = await buildSummary({ periodType, periodKey });
    const stats = {
      periodType,
      periodKey,
      source: built.source,
      alerts: built.stat.alerts,
      tp: built.stat.tp,
      sl: built.stat.sl,
      timeExitProfit: built.stat.timeExitProfit,
      timeExitLoss: built.stat.timeExitLoss,
      expired: built.stat.expired,
      rejectedSignals: built.stat.rejectedSignals,
      openTotal: built.openTotal,
    };

    try {
      await sendTelegramMessage(built.text, paidChatId);
      if (freeChatId) {
        await sendTelegramMessage(built.text, freeChatId);
      }
      for (const mirrorChatId of mirrorChatIds) {
        try {
          await sendTelegramMessage(built.text, mirrorChatId);
        } catch (err) {
          console.error("MIRROR SUMMARY SEND FAILED:", {
            periodType,
            periodKey,
            error: err?.message || String(err),
          });
        }
      }

      await completeSummary({
        periodType,
        periodKey,
        status: "sent",
        text: built.text,
        stats,
      });

      return { ok: true, sent: true, alreadySent: false, periodType, periodKey, source: built.source };
    } catch (err) {
      await completeSummary({
        periodType,
        periodKey,
        status: "failed",
        text: built.text,
        stats,
        error: err?.message || String(err),
      });
      throw err;
    }
  }

  return {
    getUtcWeekKey,
    preview,
    send,
  };
}
