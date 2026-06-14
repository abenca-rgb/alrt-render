import { buildRecentHitKey } from "./tradeIdentityService.js";
import { eventTimeToMs } from "../utils/date.js";
import { fmtPct, fmtPrice, parseNum } from "../utils/numbers.js";
import { getTimeExitResult } from "../utils/outcomes.js";

export function createCloseFlowService({
  closeCompletionService,
  hitNotificationService,
  wasRecentHitSent,
  wasSharedToFree,
  paidChatId,
  freeChatId,
  mirrorChatIds = [],
}) {
  async function sendHitAlert({
    trade,
    closeType,
    hitPrice = null,
    chatId = paidChatId,
  }) {
    return hitNotificationService.sendHitAlert({
      trade,
      closeType,
      hitPrice,
      chatId,
    });
  }

  async function closeTrade({
    matched,
    closeType,
    eventTime,
    currentPrice,
    source = "unknown",
  }) {
    if (!matched?.trade || !matched?.key) {
      return false;
    }

    const trade = matched.trade;
    const closedAtMs = eventTimeToMs(eventTime);
    const hitEventBucket = Number.isFinite(closedAtMs)
      ? Math.floor(closedAtMs / 60000)
      : eventTime;

    const hitKey = buildRecentHitKey({
      symbol: trade.symbol,
      closeType,
      refId: trade.refId,
      eventTime: hitEventBucket,
    });

    if (wasRecentHitSent(hitKey)) {
      console.log("DUPLICATE CLOSE IGNORED:", {
        symbol: trade.symbol,
        closeType,
        refId: trade.refId,
        eventTime,
        source,
      });
      return false;
    }

    let finalCloseType = closeType;
    let exitPrice = currentPrice;

    if (closeType === "EXPIRED") {
      exitPrice = Number.isFinite(parseNum(currentPrice))
        ? parseNum(currentPrice)
        : trade.entry;
      finalCloseType = getTimeExitResult(trade, exitPrice);
    }

    trade.hit = true;
    trade.hitType = finalCloseType;
    trade.hitAtMs = closedAtMs;

    const sent = await sendHitAlert({
      trade,
      closeType: finalCloseType,
      hitPrice: exitPrice,
      chatId: paidChatId,
    });

    for (const mirrorChatId of mirrorChatIds) {
      try {
        await sendHitAlert({
          trade,
          closeType: finalCloseType,
          hitPrice: exitPrice,
          chatId: mirrorChatId,
        });
      } catch (err) {
        console.error("MIRROR CLOSE SEND FAILED:", {
          refId: trade.refId,
          error: err?.message || String(err),
        });
      }
    }

    if (wasSharedToFree(trade.refId)) {
      try {
        await sendHitAlert({
          trade,
          closeType: finalCloseType,
          hitPrice: exitPrice,
          chatId: freeChatId,
        });
      } catch (err) {
        console.error("FREE CLOSE SEND FAILED:", {
          refId: trade.refId,
          error: err?.message || String(err),
        });
      }
    }

    await closeCompletionService.completeClosedTrade({
      matched,
      trade,
      finalCloseType,
      closedAtMs,
      sent,
      hitKey,
      source,
    });

    console.log("TRADE CLOSED:", {
      symbol: trade.symbol,
      side: trade.side,
      refId: trade.refId,
      closeType: finalCloseType,
      source,
      matchType: matched.matchType,
      exitPrice: fmtPrice(sent.exitPrice),
      movePct: fmtPct(sent.movePct, { signed: true }),
    });

    return true;
  }

  return {
    closeTrade,
    sendHitAlert,
  };
}
