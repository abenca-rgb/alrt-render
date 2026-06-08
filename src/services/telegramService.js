import fetch, { Blob, FormData } from "node-fetch";

export function createTelegramService({ botToken, defaultChatId, appendChartLinkIfMissing }) {
  async function sendMessage(text, chatId = defaultChatId) {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    const data = await response.json();

    console.log("TELEGRAM MESSAGE RESPONSE:", {
      chatId,
      data,
    });

    if (!response.ok || !data.ok) {
      throw new Error(`Telegram sendMessage failed: ${JSON.stringify(data)}`);
    }
  }

  async function sendPhoto({
    photoUrl = null,
    photoBuffer = null,
    filename = "chart.png",
    caption = "",
    chatId = defaultChatId,
  }) {
    let response;

    if (photoBuffer) {
      const form = new FormData();

      form.append("chat_id", chatId);
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
      form.append("photo", new Blob([photoBuffer], { type: "image/png" }), filename);

      response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: "POST",
        body: form,
      });
    } else {
      response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          photo: photoUrl,
          caption,
          parse_mode: "HTML",
        }),
      });
    }

    const data = await response.json();

    console.log("TELEGRAM PHOTO RESPONSE:", {
      chatId,
      data,
    });

    if (!response.ok || !data.ok) {
      throw new Error(`Telegram sendPhoto failed: ${JSON.stringify(data)}`);
    }
  }

  async function sendAlert({
    text,
    imageUrl = null,
    imageBuffer = null,
    imageFilename = "chart.png",
    fallbackChartLink = "N/A",
    chatId = defaultChatId,
  }) {
    if (imageBuffer || imageUrl) {
      try {
        await sendPhoto({
          photoUrl: imageUrl,
          photoBuffer: imageBuffer,
          filename: imageFilename,
          caption: text,
          chatId,
        });

        return { usedPhoto: true };
      } catch (err) {
        console.error("PHOTO SEND FAILED, FALLING BACK TO MESSAGE:", err.message);

        const fallbackText = appendChartLinkIfMissing(text, fallbackChartLink);
        await sendMessage(fallbackText, chatId);

        return { usedPhoto: false, photoFailed: true };
      }
    }

    const fallbackText = appendChartLinkIfMissing(text, fallbackChartLink);
    await sendMessage(fallbackText, chatId);

    return { usedPhoto: false };
  }

  return {
    sendAlert,
    sendMessage,
    sendPhoto,
  };
}
