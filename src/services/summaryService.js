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
  const todayWinrate = todayClosed > 0 ? (todayPositive / todayClosed) * 100 : null;

  const old = stat.oldClosures || {
    tp: 0,
    sl: 0,
    timeExitProfit: 0,
    timeExitLoss: 0,
    expired: 0,
  };

  const orphan = stat.orphanClosures || {
    tp: 0,
    sl: 0,
    timeExitProfit: 0,
    timeExitLoss: 0,
    expired: 0,
  };

  const oldClosed =
    old.tp +
    old.sl +
    old.timeExitProfit +
    old.timeExitLoss +
    old.expired;

  const orphanClosed =
    orphan.tp +
    orphan.sl +
    orphan.timeExitProfit +
    orphan.timeExitLoss +
    orphan.expired;

  const openToday = Object.values(stat.byRef || {}).filter((t) => {
    return t.openedDateKey === dateKey && t.result === "OPEN";
  }).length;

  const openTotal = activeTrades.filter((t) => !t.hit).length;

  const rejectReasons = Object.entries(stat.rejectsByReason || {})
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .slice(0, 3)
    .map(([reason, count]) => `${reason}: ${count}`);

  const worstSymbols = Object.entries(stat.bySymbol || {})
    .filter(([, s]) => (s.alerts || 0) > 0)
    .sort((a, b) => (b[1].sl || 0) - (a[1].sl || 0))
    .slice(0, 4)
    .map(([symbol, s]) => {
      return `${symbol} ${s.tp || 0}TP/${s.sl || 0}SL`;
    });

  const setupSnapshot = Object.entries(stat.bySetup || {})
    .filter(([, s]) => (s.alerts || 0) > 0)
    .sort((a, b) => (b[1].alerts || 0) - (a[1].alerts || 0))
    .slice(0, 3)
    .map(([setup, s]) => {
      return `${setup} ${s.tp || 0}TP/${s.sl || 0}SL`;
    });

  return `📊 <b>D-ALRT DAILY OVERVIEW</b>
<b>UTC DATE</b> ${escapeHtml(dateKey)}

<b>POSTED</b> ${stat.alerts}
<b>CLOSED</b> ${todayClosed} | TP ${stat.tp} | SL ${stat.sl} | TIME ${stat.timeExitProfit || 0}/${stat.timeExitLoss || 0}
<b>WINRATE</b> ${todayClosed > 0 ? escapeHtml(fmtPct(todayWinrate)) : "N/A"}
<b>OPEN</b> ${openTotal} total | ${openToday} from today
<b>REJECTED</b> ${stat.rejectedSignals || 0}

<b>SYMBOLS</b> ${worstSymbols.length ? escapeHtml(worstSymbols.join(" • ")) : "N/A"}
<b>SETUPS</b> ${setupSnapshot.length ? escapeHtml(setupSnapshot.join(" • ")) : "N/A"}
<b>FILTERS</b> ${rejectReasons.length ? escapeHtml(rejectReasons.join(" • ")) : "N/A"}

<b>OLD / ORPHAN CLOSED</b> ${oldClosed} / ${orphanClosed}

NFA`;
}
