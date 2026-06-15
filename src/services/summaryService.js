import { fmtPct } from "../utils/numbers.js";
import { escapeHtml } from "../utils/payload.js";

export function buildDailySummaryText({
  dateKey,
  stat,
  activeTrades = [],
}) {
  const todayClosed =
    stat.tp +
    stat.sl +
    stat.timeExitProfit +
    stat.timeExitLoss +
    stat.expired;

  const todayPositive = stat.tp + stat.timeExitProfit;
  const todayLosses = stat.sl + stat.timeExitLoss;
  const todayWinrate = todayClosed > 0 ? (todayPositive / todayClosed) * 100 : null;

  const openTotal = activeTrades.filter((t) => !t.hit).length;

  const bestSetup = bestBucketLabel(stat.bySetup || {});
  const bestSymbol = bestBucketLabel(stat.bySymbol || {});
  const marketStatus = inferMarketStatus(stat.byRef || {});

  return `📊 <b>D-ALRT DAILY OVERVIEW</b>
<b>UTC DATE</b> ${escapeHtml(dateKey)}

<b>Signals Today</b> ${stat.alerts}
<b>Closed Trades</b> ${todayClosed}
<b>Wins</b> ${todayPositive}
<b>Losses</b> ${todayLosses}
<b>Win Rate</b> ${todayClosed > 0 ? escapeHtml(fmtPct(todayWinrate)) : "N/A"}
<b>Best Setup</b> ${escapeHtml(bestSetup)}
<b>Best Symbol</b> ${escapeHtml(bestSymbol)}
<b>Active Trades</b> ${openTotal}
<b>Market Status</b> ${escapeHtml(marketStatus)}

<b>Shadow Model</b> Monitoring quality improvements

NFA`;
}

function closureCount(stats = {}) {
  return (
    (stats.tp || 0) +
    (stats.sl || 0) +
    (stats.timeExitProfit || 0) +
    (stats.timeExitLoss || 0) +
    (stats.expired || 0)
  );
}

function wins(stats = {}) {
  return (stats.tp || 0) + (stats.timeExitProfit || 0);
}

function bestBucketLabel(buckets = {}) {
  const ranked = Object.entries(buckets)
    .filter(([, stats]) => closureCount(stats) > 0)
    .sort((a, b) => {
      const aClosed = closureCount(a[1]);
      const bClosed = closureCount(b[1]);
      const aWinrate = wins(a[1]) / aClosed;
      const bWinrate = wins(b[1]) / bClosed;
      if (bWinrate !== aWinrate) return bWinrate - aWinrate;
      return bClosed - aClosed;
    });

  return ranked[0]?.[0] || "N/A";
}

function inferMarketStatus(byRef = {}) {
  const refs = Object.values(byRef);
  const longCount = refs.filter((trade) => String(trade.side || "").toUpperCase() === "LONG").length;
  const shortCount = refs.filter((trade) => String(trade.side || "").toUpperCase() === "SHORT").length;
  const total = longCount + shortCount;
  if (!total) return "Mixed";
  if (longCount / total >= 0.6) return "Bullish";
  if (shortCount / total >= 0.6) return "Bearish";
  return "Mixed";
}

export function buildAdminDailySummaryText({
  dateKey,
  stat,
  openAudit = null,
}) {
  const todayClosed =
    stat.tp +
    stat.sl +
    stat.timeExitProfit +
    stat.timeExitLoss +
    stat.expired;

  const todayPositive = stat.tp + stat.timeExitProfit;
  const todayWinrate = todayClosed > 0 ? (todayPositive / todayClosed) * 100 : null;

  const old = stat.oldClosures || {};
  const orphan = stat.orphanClosures || {};
  const oldClosed = closureCount(old);
  const orphanClosed = closureCount(orphan);

  const rejectReasons = Object.entries(stat.rejectsByReason || {})
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .slice(0, 8)
    .map(([reason, count]) => `${reason}: ${count}`);

  const setupSnapshot = Object.entries(stat.bySetup || {})
    .filter(([, s]) => (s.alerts || 0) > 0)
    .sort((a, b) => (b[1].alerts || 0) - (a[1].alerts || 0))
    .slice(0, 6)
    .map(([setup, s]) => {
      return `${setup} ${s.tp || 0}TP/${s.sl || 0}SL`;
    });

  const auditTotals = openAudit?.totals || {};
  const openQuality = openAudit?.open_trade_quality || {};
  const age = openAudit?.open_by_age || {};

  return `🛠 <b>D-ALRT ADMIN DAILY SUMMARY</b>
<b>UTC DATE</b> ${escapeHtml(dateKey)}

<b>POSTED</b> ${stat.alerts}
<b>CLOSED</b> ${todayClosed} | TP ${stat.tp} | SL ${stat.sl} | TIME ${stat.timeExitProfit || 0}/${stat.timeExitLoss || 0}
<b>WINRATE</b> ${todayClosed > 0 ? escapeHtml(fmtPct(todayWinrate)) : "N/A"}
<b>ACTIVE TRADES</b> ${openQuality.active_trades ?? "N/A"}
<b>AVG OPEN DURATION</b> ${openQuality.average_open_duration_hours ?? "N/A"}h
<b>OLDEST ACTIVE</b> ${openQuality.oldest_active_trade_hours ?? "N/A"}h

<b>REJECTED</b> ${stat.rejectedSignals || 0}
<b>FILTERS</b> ${rejectReasons.length ? escapeHtml(rejectReasons.join(" • ")) : "N/A"}

<b>SETUPS</b> ${setupSnapshot.length ? escapeHtml(setupSnapshot.join(" • ")) : "N/A"}

<b>OLD / ORPHAN CLOSED</b> ${oldClosed} / ${orphanClosed}
<b>OPEN AUDIT</b> missing close ${auditTotals.supabase_open_missing_close ?? "N/A"} | active ${auditTotals.genuinely_active ?? "N/A"} | time-exit ${auditTotals.time_exit_required ?? "N/A"} | missing link ${auditTotals.missing_close ?? "N/A"} | orphan outcomes ${auditTotals.orphan_outcomes ?? "N/A"}
<b>OPEN AGE</b> 0-24h ${age["0-24h"] ?? "N/A"} | 1-3d ${age["1-3d"] ?? "N/A"} | 3-7d ${age["3-7d"] ?? "N/A"} | 7+d ${age["7+d"] ?? "N/A"}

NFA`;
}
