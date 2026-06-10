import { getUtcDateKey } from "../utils/date.js";
import { buildDailySummaryText } from "./summaryService.js";

export function createDailySummaryRunnerService({
  enabled,
  utcHour,
  utcMinute,
  getDailyStat,
  getActiveTrades,
  getLastSummarySentDate,
  setLastSummarySentDate,
  sendTelegramMessage,
  paidChatId,
  freeChatId,
  persistDailySummaryToSupabase,
  persistState,
}) {
  function buildSummaryText(dateKey) {
    const stat = getDailyStat(dateKey);

    return buildDailySummaryText({
      dateKey,
      stat,
      activeTrades: getActiveTrades(),
    });
  }

  async function sendDailySummary(dateKey, force = false) {
    if (!enabled && !force) return false;
    if (!force && getLastSummarySentDate() === dateKey) return false;

    const text = buildSummaryText(dateKey);

    await sendTelegramMessage(text, paidChatId);

    if (freeChatId) {
      await sendTelegramMessage(text, freeChatId);
    }

    persistDailySummaryToSupabase(dateKey);

    setLastSummarySentDate(dateKey);
    await persistState();

    console.log("DAILY SUMMARY SENT:", {
      dateKey,
      force,
      lastSummarySentDate: getLastSummarySentDate(),
    });

    return true;
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
