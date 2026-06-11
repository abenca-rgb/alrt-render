import { getUtcDateKey } from "../utils/date.js";

export function createDailySummaryRunnerService({
  enabled,
  utcHour,
  utcMinute,
  getLastSummarySentDate,
  setLastSummarySentDate,
  summaryService,
  persistState,
}) {
  async function buildSummaryText(dateKey) {
    const summary = await summaryService.preview({
      periodType: "daily",
      periodKey: dateKey,
    });
    return summary.text;
  }

  async function sendDailySummary(dateKey, force = false) {
    if (!enabled && !force) return false;
    if (!force && getLastSummarySentDate() === dateKey) {
      return false;
    }

    const result = await summaryService.send({
      periodType: "daily",
      periodKey: dateKey,
      force,
    });

    if (result.sent || result.alreadySent) {
      setLastSummarySentDate(dateKey);
      await persistState();
    }

    console.log("DAILY SUMMARY SENT:", {
      dateKey,
      force,
      sent: result.sent,
      alreadySent: result.alreadySent,
      lastSummarySentDate: getLastSummarySentDate(),
    });

    return result.sent;
  }

  async function maybeSendDailySummary(nowMs = Date.now()) {
    if (!enabled) return false;

    const now = new Date(nowMs);
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();

    if (hour !== utcHour || minute !== utcMinute) return false;

    const dateKey = getUtcDateKey(nowMs);

    if (getLastSummarySentDate() === dateKey) return false;

    return sendDailySummary(dateKey, false);
  }

  return {
    buildSummaryText,
    sendDailySummary,
    maybeSendDailySummary,
  };
}
