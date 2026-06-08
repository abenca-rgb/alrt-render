export function registerTradingViewRoutes(app, {
  handleTradingViewWebhook,
} = {}) {
  app.post("/webhook", handleTradingViewWebhook);
  app.post("/webhook/tradingview", handleTradingViewWebhook);
}
