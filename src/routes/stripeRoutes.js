import express from "express";

export function registerStripeRoutes(app, {
  handleStripeEvent,
} = {}) {
  app.post(
    "/webhook/stripe",
    express.raw({ type: "application/json", limit: "2mb" }),
    async (req, res) => {
      let event;

      try {
        event = JSON.parse(req.body.toString("utf8"));
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
