import fetch from "node-fetch";

export function createInviteService({
  botToken,
  paidChatId,
  freeChatId = "",
} = {}) {
  async function createInviteLink({ chatId, expireHours = 48, label = "Telegram invite" } = {}) {
    if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN missing");
    if (!chatId) throw new Error(`${label} chat id missing`);

    const expireDate = Math.floor(Date.now() / 1000 + expireHours * 60 * 60);

    const response = await fetch(`https://api.telegram.org/bot${botToken}/createChatInviteLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        member_limit: 1,
        expire_date: expireDate,
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(`${label} failed: ${JSON.stringify(data)}`);
    }

    return data.result.invite_link;
  }

  function createPaidInviteLink({ expireHours = 48 } = {}) {
    return createInviteLink({
      chatId: paidChatId,
      expireHours,
      label: "Telegram invite",
    });
  }

  function createFreeInviteLink({ expireHours = 48 } = {}) {
    return createInviteLink({
      chatId: freeChatId,
      expireHours,
      label: "Free Telegram invite",
    });
  }

  return {
    createPaidInviteLink,
    createFreeInviteLink,
  };
}
