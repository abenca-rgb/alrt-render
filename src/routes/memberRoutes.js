import { escapeHtml, normalizeEmail } from "../utils/payload.js";

export function registerMemberRoutes(app, {
  summaryAdminToken = "",
  getFreeMember,
  setFreeMember,
  getPaidMembers,
  getFreeMembers,
  setPaidMember,
  createFreeInviteLink,
  createPaidInviteLink,
  persistState,
  sendTelegramMessage,
} = {}) {
  app.post("/signup/free", async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);

      if (!email || !email.includes("@")) {
        return res.status(400).json({
          ok: false,
          error: "valid email required",
        });
      }

      const existing = getFreeMember(email);

      if (existing?.inviteLink) {
        return res.status(200).json({
          ok: true,
          email,
          inviteLink: existing.inviteLink,
          existing: true,
        });
      }

      const inviteLink = await createFreeInviteLink({ expireHours: 48 });

      setFreeMember(email, {
        email,
        status: "free",
        active: true,
        inviteLink,
        inviteCreatedAt: new Date().toISOString(),
        inviteExpireHours: 48,
        telegramUserId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await persistState();

      await sendTelegramMessage(
`🆓 <b>NEW FREE MEMBER</b>

<b>Email</b> ${escapeHtml(email)}

<b>Free Invite</b>
${inviteLink}`
      );

      return res.status(200).json({
        ok: true,
        email,
        inviteLink,
      });
    } catch (err) {
      console.error("FREE SIGNUP ERROR:", err);

      return res.status(500).json({
        ok: false,
        error: "free signup failed",
      });
    }
  });

  app.get("/admin/members", async (req, res) => {
    const token = String(req.query.token || "");

    if (!summaryAdminToken || token !== summaryAdminToken) {
      return res.status(403).json({
        ok: false,
        error: "forbidden",
      });
    }

    const paidMembers = getPaidMembers();
    const freeMembers = getFreeMembers();

    res.status(200).json({
      ok: true,
      paidCount: paidMembers.length,
      freeCount: freeMembers.length,
      paidMembers,
      freeMembers,
    });
  });

  app.post("/admin/telegram/invite", async (req, res) => {
    const token = String(req.query.token || req.headers["x-summary-token"] || "");

    if (!summaryAdminToken || token !== summaryAdminToken) {
      return res.status(403).json({
        ok: false,
        error: "forbidden",
      });
    }

    try {
      const email = normalizeEmail(req.body?.email);
      const expireHours = Math.max(1, Math.min(168, Number(req.body?.expireHours || 48)));

      if (!email || !email.includes("@")) {
        return res.status(400).json({
          ok: false,
          error: "valid email required",
        });
      }

      if (typeof createPaidInviteLink !== "function") {
        return res.status(500).json({
          ok: false,
          error: "paid invite link service unavailable",
        });
      }

      const existing = getPaidMembers().find((member) => normalizeEmail(member?.email) === email) || {};
      const inviteLink = await createPaidInviteLink({ expireHours });
      const now = new Date().toISOString();

      if (typeof setPaidMember === "function") {
        setPaidMember(email, {
          ...existing,
          email,
          status: existing.status || "active",
          active: existing.active !== false,
          inviteLink,
          inviteCreatedAt: now,
          inviteExpireHours: expireHours,
          updatedAt: now,
          lastAdminInviteEvent: "admin.telegram.invite",
        });
      }

      await persistState();

      return res.status(200).json({
        ok: true,
        email,
        inviteLink,
        inviteExpireHours: expireHours,
        inviteCreatedAt: now,
      });
    } catch (err) {
      console.error("ADMIN TELEGRAM INVITE ERROR:", err);
      return res.status(500).json({
        ok: false,
        error: err?.message || String(err),
      });
    }
  });
}
