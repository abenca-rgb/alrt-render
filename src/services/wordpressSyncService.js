function safeDateFromSeconds(seconds) {
  const number = Number(seconds);
  if (!Number.isFinite(number) || number <= 0) return "";
  return new Date(number * 1000).toISOString().slice(0, 10);
}

function mapAccountStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "trialing") return "Trial";
  if (normalized === "active" || normalized === "past_due") return "Paid";
  if (["canceled", "cancelled", "unpaid", "incomplete_expired"].includes(normalized)) {
    return "Cancelled / expired";
  }
  return "Paid";
}

function mapTelegramStatus(accountStatus) {
  return accountStatus === "Paid" || accountStatus === "Trial" ? "pending" : "expired";
}

export function createWordPressSyncService({
  enabled = false,
  baseUrl = "",
  token = "",
  fetchImpl = fetch,
} = {}) {
  function ready() {
    return Boolean(enabled && baseUrl && token);
  }

  async function post(path, payload) {
    if (!ready()) {
      return { skipped: true, reason: "wordpress sync disabled" };
    }

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await response.text().catch(() => "");
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = { raw: bodyText.slice(0, 500) };
    }

    if (!response.ok) {
      return { ok: false, status: response.status, body };
    }

    return { ok: true, status: response.status, body };
  }

  async function syncMember(payload) {
    const result = await post("/wp-json/dalrt-portal/v1/member-sync", {
      ...payload,
      source: payload?.source || "render",
    });

    if (result?.ok === false) {
      console.warn("WORDPRESS MEMBER SYNC WARNING:", {
        status: result.status,
        email: payload?.email || null,
        message: result.body?.message || result.body?.error || "sync failed",
      });
    }

    return result;
  }

  async function syncStripeCheckoutSession({ email, session }) {
    return syncMember({
      email,
      account_status: "Paid",
      subscription_plan: "Paid",
      renewal_date: "",
      telegram_status: "pending",
      source: "render_stripe_checkout",
      stripe_customer_id: session?.customer || null,
      stripe_subscription_id: session?.subscription || null,
    });
  }

  async function syncStripeSubscriptionEvent({ email, stripeStatus, currentPeriodEnd, eventType }) {
    const accountStatus = mapAccountStatus(stripeStatus);
    return syncMember({
      email,
      account_status: accountStatus,
      subscription_plan: "Paid",
      renewal_date: safeDateFromSeconds(currentPeriodEnd),
      telegram_status: mapTelegramStatus(accountStatus),
      source: "render_stripe_subscription",
      stripe_status: stripeStatus || null,
      stripe_event: eventType || null,
    });
  }

  return {
    ready,
    syncMember,
    syncStripeCheckoutSession,
    syncStripeSubscriptionEvent,
  };
}
