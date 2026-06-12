import { normalizeSetupGroup } from "../../src/services/clusterGuardrailService.js";

const SUPABASE_ENABLED = String(process.env.SUPABASE_ENABLED || "false").toLowerCase() === "true";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const WINDOW_MINUTES = Number(process.env.CLUSTER_GUARDRAIL_WINDOW_MINUTES || 60);
const GUARDRAIL_VERSION = process.env.CLUSTER_GUARDRAIL_VERSION || "v1";
const PERIODS = [7, 14, 30];

const WIN_OUTCOMES = new Set(["TP", "TP1", "TP2", "TP_FULL", "TIME_EXIT_PROFIT"]);
const LOSS_OUTCOMES = new Set(["SL", "TIME_EXIT_LOSS"]);

function ready() {
  return Boolean(SUPABASE_ENABLED && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
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

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function normalizeSide(side) {
  return String(side || "").trim().toUpperCase();
}

function setupGroupsMatch(currentSetupGroup, previousSetupGroup) {
  if (currentSetupGroup === "UNKNOWN" && previousSetupGroup === "UNKNOWN") return true;
  if (currentSetupGroup === "UNKNOWN" || previousSetupGroup === "UNKNOWN") return false;
  return currentSetupGroup === previousSetupGroup;
}

function countBy(rows, keyFn) {
  const counts = {};
  for (const row of rows) {
    const key = keyFn(row) || "UNKNOWN";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function pct(part, total) {
  if (!total) return 0;
  return Number(((part / total) * 100).toFixed(2));
}

function analyzePeriod(alerts, days) {
  const start = Date.parse(isoDaysAgo(days));
  const periodAlerts = alerts
    .filter((alert) => alert.signalTimeMs >= start)
    .sort((a, b) => a.signalTimeMs - b.signalTimeMs);

  const accepted = [];
  const blocked = [];
  const windowMs = WINDOW_MINUTES * 60 * 1000;

  for (const alert of periodAlerts) {
    const previous = [...accepted]
      .reverse()
      .find((item) => {
        if (item.symbol !== alert.symbol || item.side !== alert.side) return false;
        if (!setupGroupsMatch(alert.setupGroup, item.setupGroup)) return false;
        const ageMs = alert.signalTimeMs - item.signalTimeMs;
        return ageMs > 0 && ageMs <= windowMs;
      });

    if (previous) {
      const secondsSincePreviousAlert = Math.max(0, Math.round((alert.signalTimeMs - previous.signalTimeMs) / 1000));
      blocked.push({
        ...alert,
        matchedPreviousAlertId: previous.alertId,
        secondsSincePreviousAlert,
        minutesSincePreviousAlert: Math.max(0, Math.round((alert.signalTimeMs - previous.signalTimeMs) / 60000)),
      });
      continue;
    }

    accepted.push(alert);
  }

  const winsMissed = blocked.filter((alert) => WIN_OUTCOMES.has(alert.outcomeType)).length;
  const lossesAvoided = blocked.filter((alert) => LOSS_OUTCOMES.has(alert.outcomeType)).length;
  const freeBlocked = blocked.filter((alert) => alert.isFreeShared).length;

  return {
    periodDays: days,
    guardrail: "cluster_60m_guardrail",
    guardrailVersion: GUARDRAIL_VERSION,
    windowMinutes: WINDOW_MINUTES,
    totalAlerts: periodAlerts.length,
    blockedAlerts: blocked.length,
    percentageBlocked: pct(blocked.length, periodAlerts.length),
    symbolsInvolved: countBy(blocked, (alert) => alert.symbol),
    directionsInvolved: countBy(blocked, (alert) => alert.side),
    setupGroupsInvolved: countBy(blocked, (alert) => alert.setupGroup),
    winsMissed,
    lossesAvoided,
    netValue: lossesAvoided - winsMissed,
    paidVolumeImpactPct: pct(blocked.length, periodAlerts.length),
    freeSelectionImpact: {
      freeAlertsThatWouldHaveBeenBlocked: freeBlocked,
      freeBlockedPctOfAllBlocked: pct(freeBlocked, blocked.length),
    },
    sampleBlockedAlerts: blocked.slice(0, 10).map((alert) => ({
      alertId: alert.alertId,
      symbol: alert.symbol,
      direction: alert.side,
      setupGroup: alert.setupGroup,
      signalTimeUtc: alert.signalTimeUtc,
      matchedPreviousAlertId: alert.matchedPreviousAlertId,
      secondsSincePreviousAlert: alert.secondsSincePreviousAlert,
      minutesSincePreviousAlert: alert.minutesSincePreviousAlert,
      outcomeType: alert.outcomeType,
    })),
  };
}

async function loadAlerts() {
  const startIso = isoDaysAgo(Math.max(...PERIODS));
  const query = [
    "?select=alert_id,ref_id,symbol,direction,timeframe,setup_type,signal_time_utc,is_free_shared,outcomes(outcome_type)",
    `signal_time_utc=gte.${encodeURIComponent(startIso)}`,
    "order=signal_time_utc.asc",
    "limit=10000",
  ].join("&");

  const rows = await selectRows("alerts", query);

  return rows.map((row) => ({
    alertId: String(row.alert_id),
    refId: String(row.ref_id),
    symbol: normalizeSymbol(row.symbol),
    side: normalizeSide(row.direction),
    timeframe: row.timeframe || null,
    setupType: row.setup_type || "UNKNOWN",
    setupGroup: normalizeSetupGroup(row.setup_type),
    signalTimeUtc: row.signal_time_utc,
    signalTimeMs: Date.parse(row.signal_time_utc),
    isFreeShared: Boolean(row.is_free_shared),
    outcomeType: Array.isArray(row.outcomes) && row.outcomes[0]?.outcome_type
      ? row.outcomes[0].outcome_type
      : null,
  })).filter((row) => Number.isFinite(row.signalTimeMs));
}

async function main() {
  if (!ready()) {
    console.error("Missing live Supabase env: SUPABASE_ENABLED=true, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }

  if (!Number.isFinite(WINDOW_MINUTES) || WINDOW_MINUTES <= 0) {
    console.error("Invalid CLUSTER_GUARDRAIL_WINDOW_MINUTES");
    process.exit(2);
  }

  const alerts = await loadAlerts();
  const report = {
    generatedAtUtc: new Date().toISOString(),
    source: "supabase.alerts",
    periods: PERIODS.map((days) => analyzePeriod(alerts, days)),
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
