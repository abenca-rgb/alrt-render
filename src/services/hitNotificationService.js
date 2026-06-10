import { buildHitText } from "./messageTemplates.js";
import { parseNum } from "../utils/numbers.js";
import { pctMove } from "../utils/tradeMath.js";

export function createHitNotificationService({
  chartService,
  sendTelegramAlert,
  defaultChatId,
}) {
  async function sendHitAlert({
    trade,
    closeType,
    hitPrice = null,
    chatId = defaultChatId,
  }) {
    const parsedHitPrice = parseNum(hitPrice);
    const exitPrice =
      closeType === "TP"
        ? trade.tp
        : closeType === "SL"
        ? trade.sl
        : Number.isFinite(parsedHitPrice)
        ? parsedHitPrice
        : trade.entry;

    const movePct = pctMove(trade.side, trade.entry, exitPrice);
    const chartLink = trade.chartLink || chartService.resolveChartLink(trade.symbol);

    const chartAssets = await chartService.buildChartDeliveryAssets({
      symbol: trade.symbol,
      side: trade.side,
      refId: trade.refId,
      inlineBody: {
        chart_image_url: trade.chartImageUrl,
      },
    });

    const showChartLink = !chartAssets.imageUrl && !chartAssets.imageBuffer;

    const hitText = buildHitText({
      trade,
      closeType,
      exitPrice,
      movePct,
      chartLink,
      showChartLink,
    });

    await sendTelegramAlert({
      text: hitText,
      imageUrl: chartAssets.imageUrl,
      imageBuffer: chartAssets.imageBuffer,
      imageFilename: chartAssets.imageFilename,
      fallbackChartLink: chartLink,
      chatId,
    });

    return {
      exitPrice,
      movePct,
    };
  }

  return {
    sendHitAlert,
  };
}
