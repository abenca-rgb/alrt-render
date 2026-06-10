import { createTelegramService } from "./telegramService.js";

export function createTelegramDispatchService({
  botToken,
  defaultChatId,
  appendChartLinkIfMissing,
}) {
  const telegram = createTelegramService({
    botToken,
    defaultChatId,
    appendChartLinkIfMissing,
  });

  async function sendTelegramMessage(text, chatId = defaultChatId) {
    return telegram.sendMessage(text, chatId);
  }

  async function sendTelegramPhoto({
    photoUrl = null,
    photoBuffer = null,
    filename = "chart.png",
    caption = "",
    chatId = defaultChatId,
  }) {
    return telegram.sendPhoto({ photoUrl, photoBuffer, filename, caption, chatId });
  }

  async function sendTelegramAlert({
    text,
    imageUrl = null,
    imageBuffer = null,
    imageFilename = "chart.png",
    fallbackChartLink = "N/A",
    chatId = defaultChatId,
  }) {
    return telegram.sendAlert({
      text,
      imageUrl,
      imageBuffer,
      imageFilename,
      fallbackChartLink,
      chatId,
    });
  }

  return {
    sendTelegramMessage,
    sendTelegramPhoto,
    sendTelegramAlert,
  };
}
