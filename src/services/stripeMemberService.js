import { escapeHtml, normalizeEmail, pick } from "../utils/payload.js";

export function createStripeMemberService({
  paidMembers,
  createPaidInviteLink,
  persistState,
  sendTelegramMessage,
  wordpressSync,
}) {
  function syncInBackground(label, task) {
    if (!wordpressSync?.ready?.()) return;

    Promise.resolve()
      .then(task)
      .catch((err) => {
        console.warn(`WORDPRESS SYNC ${label} WARNING:`, err?.message || String(err));
      });
  }

  function findPaidMemberByStripe({
    stripeCustomerId = null,
    stripeSubscriptionId = null,
  }) {
    for (const [email, member] of paidMembers.entries()) {
      if (
        (stripeCustomerId && member.stripeCustomerId === stripeCustomerId) ||
        (stripeSubscriptionId && member.stripeSubscriptionId === stripeSubscriptionId)
      ) {
        return { email, member };
      }
    }

    return null;
  }

  async function handleStripeEvent(event) {
    console.log("STRIPE EVENT:", event?.type);

    if (event?.type === "checkout.session.completed") {
      const session = event.data.object;

      const email = normalizeEmail(
        pick(session.customer_details?.email, session.customer_email)
      );

      if (!email) return;

      const inviteLink = await createPaidInviteLink({ expireHours: 48 });
      const existing = paidMembers.get(email) || {};

      paidMembers.set(email, {
        ...existing,
        email,
        status: "active",
        active: true,
        inviteLink,
        inviteCreatedAt: new Date().toISOString(),
        inviteExpireHours: 48,
        stripeCustomerId: session.customer || existing.stripeCustomerId || null,
        stripeSubscriptionId: session.subscription || existing.stripeSubscriptionId || null,
        stripeSessionId: session.id || existing.stripeSessionId || null,
        telegramUserId: existing.telegramUserId || null,
        createdAt: existing.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastStripeEvent: event.type,
      });

      await persistState();

      syncInBackground("CHECKOUT", () =>
        wordpressSync.syncStripeCheckoutSession({
          email,
          session,
        }),
      );

      await sendTelegramMessage(
`🔥 <b>NEW PAID MEMBER</b>

<b>Email</b> ${escapeHtml(email)}
<b>Status</b> active
<b>Customer</b> ${escapeHtml(session.customer || "N/A")}
<b>Subscription</b> ${escapeHtml(session.subscription || "N/A")}

<b>Invite Link</b>
${inviteLink}`
      );

      return;
    }

    if (
      event?.type === "customer.subscription.deleted" ||
      event?.type === "customer.subscription.updated" ||
      event?.type === "invoice.payment_failed" ||
      event?.type === "invoice.payment_succeeded"
    ) {
      const obj = event.data.object;

      const stripeCustomerId = obj.customer || null;
      const stripeSubscriptionId = obj.subscription || obj.id || null;

      const found = findPaidMemberByStripe({
        stripeCustomerId,
        stripeSubscriptionId,
      });

      if (!found) {
        console.log("STRIPE ACCESS EVENT BUT MEMBER NOT FOUND:", {
          type: event.type,
          stripeCustomerId,
          stripeSubscriptionId,
        });
        return;
      }

      const { email, member } = found;

      let newStatus = member.status || "active";

      if (event.type === "invoice.payment_succeeded") {
        newStatus = "active";
      }

      if (event.type === "invoice.payment_failed") {
        newStatus = "past_due";
      }

      if (event.type === "customer.subscription.deleted") {
        newStatus = "cancelled";
      }

      if (event.type === "customer.subscription.updated") {
        const stripeStatus = String(obj.status || "").toLowerCase();

        if (stripeStatus === "active" || stripeStatus === "trialing") {
          newStatus = "active";
        } else if (stripeStatus === "past_due") {
          newStatus = "past_due";
        } else if (
          stripeStatus === "canceled" ||
          stripeStatus === "cancelled" ||
          stripeStatus === "unpaid" ||
          stripeStatus === "incomplete_expired"
        ) {
          newStatus = stripeStatus;
        }
      }

      member.status = newStatus;
      member.active = newStatus === "active";
      member.updatedAt = new Date().toISOString();
      member.lastStripeEvent = event.type;

      paidMembers.set(email, member);
      await persistState();

      syncInBackground("SUBSCRIPTION", () =>
        wordpressSync.syncStripeSubscriptionEvent({
          email,
          stripeStatus: newStatus,
          currentPeriodEnd: obj.current_period_end || null,
          eventType: event.type,
        }),
      );

      await sendTelegramMessage(
`⚠️ <b>PAID MEMBER ACCESS UPDATE</b>

<b>Email</b> ${escapeHtml(email)}
<b>Status</b> ${escapeHtml(newStatus)}
<b>Stripe Event</b> ${escapeHtml(event.type)}`
      );
    }
  }

  return {
    findPaidMemberByStripe,
    handleStripeEvent,
  };
}
