import { buildWhyLine } from "./alertEnrichmentService.js";
import { buildAlertText } from "./messageTemplates.js";
import { buildTradeKey } from "./tradeIdentityService.js";
import { parseNum } from "../utils/numbers.js";
import { sanitizePayloadForStorage, uniqueStrings } from "../utils/payload.js";

export function createSignalDeliveryService({
  allocSignalRef,
  chartService,
  sendTelegramAlert,
  canSendFreeSignal,
  markFreeSignalShared,
  upsertTrade,
  recordSignalStat,
  persistAlertToSupabase,
  maxTradeAgeMs,
  paidChatId,
  freeChatId,
  mirrorChatIds = [],
}) {
  async function deliverSignal({
    body,
    context,
    quality,
    incomingRef,
    candidateIdsBase,
    prettyTime,
    chartLink,
    receivedAtMs,
  }) {
    const {
      symbol,
      side,
      entryParsed,
      tpParsed,
      slParsed,
      rr,
      tpPct,
      leverage,
      strength,
      setupType,
      setupScore,
      trendStrength,
      volatilityState,
      marketRegime,
      session,
      candidateKey,
      confidenceLevel,
      estimatedHoldDuration,
      timeframe,
      pineVersion,
      risk,
    } = context;

    const refId = incomingRef || await allocSignalRef();

    const candidateIds = uniqueStrings([
      ...candidateIdsBase,
      refId,
    ]);

    const primaryAlertId = candidateIds[0] || refId;

    const chartAssets = await chartService.buildChartDeliveryAssets({
      symbol,
      side,
      refId,
      inlineBody: body,
    });

    const whyLine = buildWhyLine({
      body,
      symbol,
      side,
      setupType,
      strength,
      rr,
      session,
      marketRegime,
    });

    const showChartLink = !chartAssets.imageUrl && !chartAssets.imageBuffer;

    const text = buildAlertText({
      symbol,
      side,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      rr,
      leverage,
      strength,
      prettyTime,
      whyLine,
      chartLink,
      showChartLink,
      refId,
      tpPct,
      setupType,
      setupScore,
      qualityScore: quality.score,
      qualityGrade: quality.grade,
      session,
      marketRegime,
      confidenceLevel,
    });

    const sendResult = await sendTelegramAlert({
      text,
      imageUrl: chartAssets.imageUrl,
      imageBuffer: chartAssets.imageBuffer,
      imageFilename: chartAssets.imageFilename,
      fallbackChartLink: chartLink,
      chatId: paidChatId,
    });

    for (const mirrorChatId of mirrorChatIds) {
      try {
        await sendTelegramAlert({
          text,
          imageUrl: chartAssets.imageUrl,
          imageBuffer: chartAssets.imageBuffer,
          imageFilename: chartAssets.imageFilename,
          fallbackChartLink: chartLink,
          chatId: mirrorChatId,
        });
      } catch (err) {
        console.error("MIRROR SIGNAL SEND FAILED:", {
          refId,
          error: err?.message || String(err),
        });
      }
    }

    let sharedToFree = false;

    if (canSendFreeSignal(receivedAtMs)) {
      try {
        await sendTelegramAlert({
          text,
          imageUrl: chartAssets.imageUrl,
          imageBuffer: chartAssets.imageBuffer,
          imageFilename: chartAssets.imageFilename,
          fallbackChartLink: chartLink,
          chatId: freeChatId,
        });

        await markFreeSignalShared({
          refId,
          symbol,
          side,
          sharedAtMs: receivedAtMs,
        });

        sharedToFree = true;
      } catch (err) {
        console.error("FREE SIGNAL SEND FAILED:", {
          refId,
          error: err?.message || String(err),
        });
      }
    }

    const tradeKey = buildTradeKey(symbol, side, refId);

    await upsertTrade(tradeKey, {
      tradeKey,
      refId,
      symbol,
      side,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      leverage,
      createdAtMs: receivedAtMs,
      createdAtUtc: prettyTime,
      maxAgeMs: maxTradeAgeMs,
      hit: false,
      hitType: null,
      hitAtMs: null,
      primaryAlertId,
      candidateKey,
      alertIds: candidateIds,
      setupType,
      setupScore,
      qualityScore: quality.score,
      qualityGrade: quality.grade,
      trendStrength,
      volatilityState,
      marketRegime,
      session,
      confidenceLevel,
      estimatedHoldDuration,
      strength,
      rr,
      chartLink,
      chartImageUrl: chartAssets.imageUrl,
      postedUtc: prettyTime,
    });

    await recordSignalStat({
      refId,
      alertId: primaryAlertId,
      symbol,
      side,
      strength,
      setupType,
      setupScore,
      qualityScore: quality.score,
      qualityGrade: quality.grade,
      trendStrength,
      volatilityState,
      marketRegime,
      session,
      confidenceLevel,
      estimatedHoldDuration,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      rr,
      sharedToFree,
      ts: receivedAtMs,
    });

    persistAlertToSupabase({
      alertId: primaryAlertId,
      refId,
      symbol,
      side,
      timeframe,
      setupType,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      rr,
      riskScore: parseNum(risk),
      qualityScore: quality.score,
      qualityGrade: quality.grade,
      whyText: whyLine,
      signalTimeMs: receivedAtMs,
      session,
      marketRegime,
      pineVersion,
      isFreeShared: sharedToFree,
      rawPayload: sanitizePayloadForStorage(body),
    });

    return {
      refId,
      primaryAlertId,
      candidateKey,
      setupType,
      setupScore,
      qualityScore: quality.score,
      qualityGrade: quality.grade,
      rr,
      tpPct,
      imageUsed: sendResult.usedPhoto,
      sharedToFree,
    };
  }

  return {
    deliverSignal,
  };
}
