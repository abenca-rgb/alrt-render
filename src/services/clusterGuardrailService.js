function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function normalizeSide(side) {
  return String(side || "").trim().toUpperCase();
}

export function normalizeSetupGroup(setupType) {
  const value = String(setupType || "").trim().toUpperCase();
  if (!value || value === "UNKNOWN" || value === "N/A") return "UNKNOWN";

  if (value.includes("TREND_PULLBACK") || value.includes("PULLBACK")) return "TREND_PULLBACK";
  if (value.includes("COMPRESSION") || value.includes("BREAKOUT") || value.includes("SQUEEZE")) {
    return "COMPRESSION_BREAKOUT";
  }
  if (value.includes("LIQUIDITY") || value.includes("RECLAIM")) return "LIQUIDITY_RECLAIM";
  if (value.includes("HTF") || value.includes("CONTINUATION")) return "HTF_CONTINUATION";
  if (value.includes("REVERSAL") || value.includes("EXPANSION")) return "REVERSAL_EXPANSION";

  return value;
}

function setupGroupsMatch(currentSetupGroup, previousSetupGroup) {
  if (currentSetupGroup === "UNKNOWN" && previousSetupGroup === "UNKNOWN") return true;
  if (currentSetupGroup === "UNKNOWN" || previousSetupGroup === "UNKNOWN") return false;
  return currentSetupGroup === previousSetupGroup;
}

function collectAcceptedAlerts(dailyStats) {
  const alerts = [];

  for (const [, stat] of dailyStats.entries()) {
    if (!stat?.byRef) continue;

    for (const item of Object.values(stat.byRef)) {
      if (!item?.refId || !item?.symbol || !item?.side) continue;
      const openedAtMs = Number(item.openedAtMs);
      if (!Number.isFinite(openedAtMs)) continue;

      alerts.push({
        alertId: item.primaryAlertId || item.alertId || item.refId,
        refId: item.refId,
        symbol: normalizeSymbol(item.symbol),
        side: normalizeSide(item.side),
        setupType: item.setupType || "UNKNOWN",
        setupGroup: normalizeSetupGroup(item.setupType),
        openedAtMs,
        openedAtUtc: item.openedAtUtc || new Date(openedAtMs).toISOString(),
        sharedToFree: Boolean(item.sharedToFree),
      });
    }
  }

  return alerts;
}

export function evaluateClusterGuardrail({
  enabled,
  rollbackEnabled,
  mode,
  version,
  windowMinutes,
  dailyStats,
  context,
  receivedAtMs,
}) {
  const normalizedMode = String(mode || "").toLowerCase();
  const window = Number(windowMinutes);

  if (!enabled || !rollbackEnabled) return { blocked: false, reason: "disabled" };
  if (normalizedMode !== "conservative") return { blocked: false, reason: "mode_not_conservative" };
  if (!Number.isFinite(window) || window <= 0) return { blocked: false, reason: "invalid_window" };

  const symbol = normalizeSymbol(context?.symbol);
  const side = normalizeSide(context?.side);
  const setupType = context?.setupType || "UNKNOWN";
  const setupGroup = normalizeSetupGroup(setupType);
  const eventTimeMs = Number.isFinite(Number(context?.eventTimeMs))
    ? Number(context.eventTimeMs)
    : receivedAtMs;

  if (!symbol || (side !== "LONG" && side !== "SHORT")) {
    return { blocked: false, reason: "not_signal" };
  }

  const windowMs = window * 60 * 1000;
  const matches = collectAcceptedAlerts(dailyStats)
    .filter((alert) => {
      if (alert.symbol !== symbol || alert.side !== side) return false;
      if (!setupGroupsMatch(setupGroup, alert.setupGroup)) return false;

      const ageMs = eventTimeMs - alert.openedAtMs;
      return ageMs > 0 && ageMs <= windowMs;
    })
    .sort((a, b) => b.openedAtMs - a.openedAtMs);

  const previous = matches[0] || null;
  if (!previous) return { blocked: false, reason: "no_cluster_match" };

  const ageMs = eventTimeMs - previous.openedAtMs;

  return {
    blocked: true,
    blockedBy: "cluster_60m_guardrail",
    guardrailVersion: version,
    mode: normalizedMode,
    windowMinutes: window,
    symbol,
    side,
    setupType,
    setupGroup,
    matchedPreviousAlertId: previous.alertId,
    matchedPreviousRefId: previous.refId,
    matchedPreviousOpenedAtUtc: previous.openedAtUtc,
    minutesSincePreviousAlert: Math.max(0, Math.round(ageMs / 60000)),
    previousSharedToFree: previous.sharedToFree,
  };
}

export function buildClusterGuardrailBlockRecord({
  result,
  alertId,
  candidateKey,
  eventTimeMs,
  rawPayload,
}) {
  return {
    alertId: String(alertId || candidateKey || ""),
    candidateKey: candidateKey ? String(candidateKey) : null,
    symbol: result.symbol,
    side: result.side,
    setupType: result.setupType,
    setupGroup: result.setupGroup,
    blockedBy: result.blockedBy,
    matchedPreviousAlertId: result.matchedPreviousAlertId,
    matchedPreviousRefId: result.matchedPreviousRefId,
    minutesSincePreviousAlert: result.minutesSincePreviousAlert,
    timestampMs: eventTimeMs,
    guardrailVersion: result.guardrailVersion,
    mode: result.mode,
    windowMinutes: result.windowMinutes,
    rawPayload,
  };
}
