import { buildCloseFingerprint } from "./duplicateGuardService.js";
import { buildRecentHitKey } from "./tradeIdentityService.js";
import { eventTimeToMs } from "../utils/date.js";
import { fmtPct, fmtPrice, parseNum } from "../utils/numbers.js";
import { getTimeExitResult } from "../utils/outcomes.js";

export function createCloseFlowService({
  closeCompletionService,
  hitNotificationService,
  mirrorHitNotificationService = hitNotificationService,
  wasRecentHitSent,
  markRecentHit,
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
    hitNotificationTarget = hitNotificationService,
  }) {
    return hitNotificationTarget.sendHitAlert({
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
    const duplicateCloseKey = buildCloseFingerprint({
      trade,
      closeType,
      hitPrice: currentPrice,
      eventTimeMs: closedAtMs,
      windowMs: 60 * 1000,
    });

    if (wasRecentHitSent(hitKey) || wasRecentHitSent(duplicateCloseKey)) {
      console.log("DUPLICATE CLOSE IGNORED:", {
        symbol: trade.symbol,
        closeType,
        refId: trade.refId,
        eventTime,
        duplicateCloseKey,
        source,
      });
      return false;
    }

    if (markRecentHit) {
      await markRecentHit(hitKey);
      await markRecentHit(duplicateCloseKey);
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
          hitNotificationTarget: mirrorHitNotificationService,
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
