import express from "express";
import crypto from "node:crypto";

function parseStripeSignature(header = "") {
  return String(header)
    .split(",")
    .map((part) => part.split("="))
    .reduce((acc, [key, value]) => {
      if (!key || !value) return acc;
      const normalizedKey = key.trim();
      if (!acc[normalizedKey]) acc[normalizedKey] = [];
      acc[normalizedKey].push(value.trim());
      return acc;
    }, {});
}

function safeEqualHex(left = "", right = "") {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyStripeSignature({ payload, signatureHeader, secret, toleranceSeconds = 300 }) {
  if (!secret) return { ok: true, skipped: true };
  if (!signatureHeader) return { ok: false, reason: "missing signature" };

  const parsed = parseStripeSignature(signatureHeader);
  const timestamp = Number(parsed.t?.[0]);
  const signatures = parsed.v1 || [];

  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    return { ok: false, reason: "invalid signature header" };
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (ageSeconds > toleranceSeconds) {
    return { ok: false, reason: "stale signature" };
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  const matched = signatures.some((signature) => {
    try {
      return safeEqualHex(signature, expected);
    } catch {
      return false;
    }
  });

  return matched ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

export function registerStripeRoutes(app, {
  handleStripeEvent,
  stripeWebhookSecret = "",
} = {}) {
  app.post(
    "/webhook/stripe",
    express.raw({ type: "application/json", limit: "2mb" }),
    async (req, res) => {
      let event;
      const rawBody = req.body.toString("utf8");
      const verification = verifyStripeSignature({
        payload: rawBody,
        signatureHeader: req.get("stripe-signature"),
        secret: stripeWebhookSecret,
      });

      if (!verification.ok) {
        console.warn("STRIPE WEBHOOK SIGNATURE WARNING:", verification.reason);
        return res.status(400).send("Invalid Stripe signature");
      }

      try {
        event = JSON.parse(rawBody);
      } catch (err) {
        console.error("STRIPE WEBHOOK PARSE ERROR:", err);
        return res.status(400).send("Invalid payload");
      }

      res.status(200).json({ received: true });

      try {
        await handleStripeEvent(event);
      } catch (err) {
        console.error("STRIPE EVENT HANDLE ERROR:", err);
      }
    }
  );
}

export const __stripeWebhookInternals = {
  parseStripeSignature,
  verifyStripeSignature,
};
