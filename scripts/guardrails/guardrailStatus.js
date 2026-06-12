const SUPABASE_ENABLED = String(process.env.SUPABASE_ENABLED || "false").toLowerCase() === "true";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const GUARDRAIL_NAME = "cluster_60m_guardrail";
const GUARDRAIL_ENABLED = String(process.env.CLUSTER_GUARDRAIL_ENABLED || "false").toLowerCase() === "true";
const GUARDRAIL_MODE = process.env.CLUSTER_GUARDRAIL_MODE || "conservative";
const GUARDRAIL_WINDOW_MINUTES = Number(process.env.CLUSTER_GUARDRAIL_WINDOW_MINUTES || 60);
const GUARDRAIL_VERSION = process.env.CLUSTER_GUARDRAIL_VERSION || "v1";
const GUARDRAIL_ROLLBACK_ENABLED =
  String(process.env.CLUSTER_GUARDRAIL_ROLLBACK_ENABLED || "true").toLowerCase() !== "false";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function ready() {
  return Boolean(SUPABASE_ENABLED && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function pct(part, total) {
  if (!total) return 0;
  return Number(((part / total) * 100).toFixed(2));
}

function countBy(rows, keyFn) {
  const counts = {};
  for (const row of rows) {
    const key = keyFn(row) || "UNKNOWN";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function inFilter(values) {
  return `in.(${values.map((value) => `"${String(value).replace(/"/g, '\\"')}"`).join(",")})`;
}

async function selectRows(table, query) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: "GET",
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

async function rowsInRange(table, timeColumn, startUtc, select = "*") {
  return selectRows(
    table,
    [
      `?select=${select}`,
      `${timeColumn}=gte.${encodeURIComponent(startUtc)}`,
      "limit=10000",
    ].join("&"),
  );
}

function currentWeekendRange(now = new Date()) {
  const day = now.getUTCDay();
  const start = startOfUtcDay(now);
  const daysSinceFriday = day >= 5 ? day - 5 : day + 2;
  start.setUTCDate(start.getUTCDate() - daysSinceFriday);
  return {
    start,
    end: now,
  };
}

async function findMissingSentAlerts(blocks) {
  const ids = [...new Set(blocks.map((row) => row.alert_id).filter(Boolean))];
  if (!ids.length) return [];

  const rows = await selectRows(
    "alerts",
    `?select=alert_id&alert_id=${encodeURIComponent(inFilter(ids))}&limit=10000`,
  );
  const sentIds = new Set(rows.map((row) => String(row.alert_id)));
  return ids.filter((id) => !sentIds.has(String(id)));
}

async function getMatchedPreviousFreeCount(blocks) {
  const ids = [...new Set(blocks.map((row) => row.matched_previous_alert_id).filter(Boolean))];
  if (!ids.length) return 0;

  const rows = await selectRows(
    "alerts",
    `?select=alert_id,is_free_shared&alert_id=${encodeURIComponent(inFilter(ids))}&limit=10000`,
  );
  return rows.filter((row) => row.is_free_shared).length;
}

async function latestDailySummaryStatus() {
  const rows = await selectRows(
    "summary_dispatches",
    "?select=period_type,period_key,status,sent_at_utc,last_error,updated_at_utc&period_type=eq.daily&order=period_key.desc&limit=1",
  ).catch(() => []);

  return rows[0] || null;
}

function recommendationFor({ blockedPct, blockedStoredNotSentOk, dailySummaryStatus }) {
  if (!blockedStoredNotSentOk) return "rollback";
  if (dailySummaryStatus?.status === "failed") return "investigate";
  if (blockedPct >= 30) return "investigate";
  return "keep active";
}

function summarizeRange({ sentAlerts, blocks, missingSentAlertIds, matchedPreviousFreeCount }) {
  const alertsSent = sentAlerts.length;
  const alertsBlocked = blocks.length;
  const totalCandidates = alertsSent + alertsBlocked;

  return {
    alertsSent,
    alertsBlocked,
    blockedPct: pct(alertsBlocked, totalCandidates),
    symbolsBlocked: countBy(blocks, (row) => row.symbol),
    directionsBlocked: countBy(blocks, (row) => row.direction),
    freeChannelImpact: {
      freeSlotsPreserved: alertsBlocked,
      matchedPreviousFreeShared: matchedPreviousFreeCount,
    },
    paidChannelImpact: {
      paidAlertsBlocked: alertsBlocked,
      paidVolumeReductionPct: pct(alertsBlocked, totalCandidates),
    },
    storageCheck: {
      blockedRowsStored: alertsBlocked,
      blockedAlertIdsNotInSentAlerts: missingSentAlertIds.length,
      blockedStoredButNotSentOk: missingSentAlertIds.length === alertsBlocked,
    },
  };
}

function renderText(report) {
  const lines = [];
  lines.push("D-ALRT GUARDRAIL STATUS");
  lines.push(`Rule: ${GUARDRAIL_NAME}`);
  lines.push(`Enabled: ${report.config.clusterGuardrailEnabled}`);
  lines.push(`Mode: ${report.config.clusterGuardrailMode}`);
  lines.push(`Window: ${report.config.clusterGuardrailWindowMinutes}m`);
  lines.push(`Version: ${report.config.clusterGuardrailVersion}`);
  lines.push(`Rollback: ${report.config.rollbackStatus}`);
  lines.push("");
  lines.push("TODAY");
  lines.push(`Alerts sent: ${report.today.alertsSent}`);
  lines.push(`Alerts blocked: ${report.today.alertsBlocked}`);
  lines.push(`Blocked %: ${report.today.blockedPct}`);
  lines.push(`Symbols blocked: ${JSON.stringify(report.today.symbolsBlocked)}`);
  lines.push(`Last blocked alert: ${report.today.lastBlockedAlert?.alertId || "none"}`);
  lines.push(`Free impact: ${JSON.stringify(report.today.freeChannelImpact)}`);
  lines.push(`Paid impact: ${JSON.stringify(report.today.paidChannelImpact)}`);
  lines.push("");
  lines.push("SINCE ACTIVATION");
  lines.push(`Start: ${report.sinceActivation.startUtc}`);
  lines.push(`Alerts sent: ${report.sinceActivation.alertsSent}`);
  lines.push(`Alerts blocked: ${report.sinceActivation.alertsBlocked}`);
  lines.push(`Blocked %: ${report.sinceActivation.blockedPct}`);
  lines.push(`Symbols blocked: ${JSON.stringify(report.sinceActivation.symbolsBlocked)}`);
  lines.push("");
  lines.push("WEEKEND REPORT");
  lines.push(`Range: ${report.weekend.startUtc} -> ${report.weekend.endUtc}`);
  lines.push(`Alerts sent: ${report.weekend.alertsSent}`);
  lines.push(`Alerts blocked: ${report.weekend.alertsBlocked}`);
  lines.push(`Blocked %: ${report.weekend.blockedPct}`);
  lines.push(`Symbols affected: ${JSON.stringify(report.weekend.symbolsBlocked)}`);
  lines.push(`TP/SL tracking: ${report.weekend.tpSlTrackingStatus.status}`);
  lines.push(`Daily summary: ${report.weekend.dailySummaryStatus.status}`);
  lines.push(`Recommendation: ${report.weekend.recommendation}`);
  lines.push("");
  lines.push(`Blocked stored but not sent: ${report.today.storageCheck.blockedStoredButNotSentOk}`);
  return lines.join("\n");
}

async function buildReport() {
  if (!ready()) {
    throw new Error("Missing live Supabase env: SUPABASE_ENABLED=true, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  }

  const now = new Date();
  const todayStart = startOfUtcDay(now);
  const activationStartRaw = argValue("--since") || process.env.GUARDRAIL_ACTIVATED_AT_UTC || todayStart.toISOString();
  const activationStart = new Date(activationStartRaw);
  if (Number.isNaN(activationStart.getTime())) throw new Error("Invalid --since or GUARDRAIL_ACTIVATED_AT_UTC");

  const weekend = currentWeekendRange(now);

  const [todayAlerts, todayBlocks, sinceAlerts, sinceBlocks, weekendAlerts, weekendBlocks, weekendOutcomes, dailySummary] =
    await Promise.all([
      rowsInRange("alerts", "signal_time_utc", todayStart.toISOString(), "alert_id,symbol,direction,is_free_shared,signal_time_utc"),
      rowsInRange("guardrail_blocks", "timestamp_utc", todayStart.toISOString(), "*"),
      rowsInRange("alerts", "signal_time_utc", activationStart.toISOString(), "alert_id,symbol,direction,is_free_shared,signal_time_utc"),
      rowsInRange("guardrail_blocks", "timestamp_utc", activationStart.toISOString(), "*"),
      rowsInRange("alerts", "signal_time_utc", weekend.start.toISOString(), "alert_id,symbol,direction,is_free_shared,signal_time_utc"),
      rowsInRange("guardrail_blocks", "timestamp_utc", weekend.start.toISOString(), "*"),
      rowsInRange("outcomes", "outcome_time_utc", weekend.start.toISOString(), "outcome_type,alert_id,ref_id,symbol,direction,outcome_time_utc"),
      latestDailySummaryStatus(),
    ]);

  const [todayMissing, sinceMissing, weekendMissing, todayFreeCount, sinceFreeCount, weekendFreeCount] = await Promise.all([
    findMissingSentAlerts(todayBlocks),
    findMissingSentAlerts(sinceBlocks),
    findMissingSentAlerts(weekendBlocks),
    getMatchedPreviousFreeCount(todayBlocks),
    getMatchedPreviousFreeCount(sinceBlocks),
    getMatchedPreviousFreeCount(weekendBlocks),
  ]);

  const today = summarizeRange({
    sentAlerts: todayAlerts,
    blocks: todayBlocks,
    missingSentAlertIds: todayMissing,
    matchedPreviousFreeCount: todayFreeCount,
  });
  const sinceActivation = summarizeRange({
    sentAlerts: sinceAlerts,
    blocks: sinceBlocks,
    missingSentAlertIds: sinceMissing,
    matchedPreviousFreeCount: sinceFreeCount,
  });
  const weekendSummary = summarizeRange({
    sentAlerts: weekendAlerts,
    blocks: weekendBlocks,
    missingSentAlertIds: weekendMissing,
    matchedPreviousFreeCount: weekendFreeCount,
  });

  const latestBlock = [...todayBlocks].sort((a, b) => Date.parse(b.timestamp_utc) - Date.parse(a.timestamp_utc))[0] || null;
  const tpCount = weekendOutcomes.filter((row) => row.outcome_type === "TP").length;
  const slCount = weekendOutcomes.filter((row) => row.outcome_type === "SL").length;
  const closeCount = weekendOutcomes.length;
  const dailySummaryStatus = dailySummary
    ? {
        status: dailySummary.status,
        periodKey: dailySummary.period_key,
        sentAtUtc: dailySummary.sent_at_utc,
        lastError: dailySummary.last_error,
      }
    : { status: "unknown", periodKey: null, sentAtUtc: null, lastError: null };

  return {
    generatedAtUtc: now.toISOString(),
    config: {
      clusterGuardrailEnabled: GUARDRAIL_ENABLED,
      clusterGuardrailMode: GUARDRAIL_MODE,
      clusterGuardrailWindowMinutes: GUARDRAIL_WINDOW_MINUTES,
      clusterGuardrailVersion: GUARDRAIL_VERSION,
      rollbackStatus: GUARDRAIL_ROLLBACK_ENABLED ? "available via CLUSTER_GUARDRAIL_ENABLED=false" : "disabled",
    },
    today: {
      startUtc: todayStart.toISOString(),
      ...today,
      lastBlockedAlert: latestBlock
        ? {
            alertId: latestBlock.alert_id,
            symbol: latestBlock.symbol,
            direction: latestBlock.direction,
            setupType: latestBlock.setup_type,
            timestampUtc: latestBlock.timestamp_utc,
            matchedPreviousAlertId: latestBlock.matched_previous_alert_id,
          }
        : null,
    },
    sinceActivation: {
      startUtc: activationStart.toISOString(),
      startSource: argValue("--since") ? "cli" : process.env.GUARDRAIL_ACTIVATED_AT_UTC ? "env" : "utc_today_fallback",
      ...sinceActivation,
    },
    weekend: {
      startUtc: weekend.start.toISOString(),
      endUtc: iso(weekend.end),
      ...weekendSummary,
      tpSlTrackingStatus: {
        status: closeCount > 0 ? "active" : "no closes observed in weekend range",
        tp: tpCount,
        sl: slCount,
        totalOutcomes: closeCount,
      },
      dailySummaryStatus,
      recommendation: recommendationFor({
        blockedPct: weekendSummary.blockedPct,
        blockedStoredNotSentOk: weekendSummary.storageCheck.blockedStoredButNotSentOk,
        dailySummaryStatus,
      }),
    },
  };
}

async function main() {
  const report = await buildReport();
  if (hasFlag("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(renderText(report));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
