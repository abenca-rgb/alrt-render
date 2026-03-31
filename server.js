import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// CONFIG
// =========================
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// =========================
// MIDDLEWARE
// =========================
app.use(express.json({ limit: "1mb" }));

// Optional: log basics
app.use((req, res, next) => {
  const now = new Date().toISOString();
  console.log(`[${now}] ${req.method} ${req.originalUrl}`);
  next();
});

// =========================
// HELPERS
// =========================
function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function safeNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSymbol(raw) {
  const symbol = safeString(raw).toUpperCase().replace(/\s+/g, "");
  return symbol.replace(".P", "");
}

function normalizeInterval(raw) {
  const s = safeString(raw).toLowerCase();

  if (!s) return "";
  if (s === "60" || s === "60m" || s === "1h" || s === "1hr") return "60";
  if (s === "15" || s === "15m") return "15";
  if (s === "240" || s === "4h") return "240";

  return s;
}

function normalizeEvent(raw) {
  const s = safeString(raw).toLowerCase();

  // Future-proof mapping
  if (["signal", "entry", "new_signal"].includes(s)) return "signal";
  if (["tp_hit", "tp1_hit", "tp2_hit", "take_profit_hit"].includes(s)) return "tp_hit";
  if (["sl_hit", "stop_hit", "stop_loss_hit"].includes(s)) return "sl_hit";

  return s || "unknown";
}

function normalizeSide(raw) {
  const s = safeString(raw).toUpperCase();
  if (s === "LONG" || s === "SHORT") return s;
  return "";
}

function buildNormalizedPayload(body) {
  const symbol =
    normalizeSymbol(body.symbol || body.ticker || body.pair || body.coin);

  const interval =
    normalizeInterval(body.interval || body.timeframe || body.tf);

  const event =
    normalizeEvent(body.event || body.type || body.alert_type);

  const side =
    normalizeSide(body.side || body.direction);

  const alertId = safeString(body.alert_id || body.id || body.ref_id);
  const strategy = safeString(body.strategy || body.script_name || body.source, "ALRT-Render");
  const exchange = safeString(body.exchange || body.market, "");
  const time = safeString(body.time || body.timestamp || "");
  const timeClose = safeString(body.time_close || body.bar_close_time || "");

  const entry = safeNumber(body.entry);
  const entryMin = safeNumber(body.entry_min);
  const entryMax = safeNumber(body.entry_max);
  const tp1 = safeNumber(body.tp1);
  const tp2 = safeNumber(body.tp2);
  const tp3 = safeNumber(body.tp3);
  const sl = safeNumber(body.sl);
  const price = safeNumber(body.price || body.close || body.last_price);
  const leverage = safeString(body.leverage || "");
  const reason = safeString(body.reason || "");
  const nfa = safeString(body.nfa || "NFA");

  return {
    received_at: new Date().toISOString(),
    strategy,
    event,
    side,
    symbol,
    exchange,
    interval,
    alert_id: alertId,
    time,
    time_close: timeClose,
    entry,
    entry_min: entryMin,
    entry_max: entryMax,
    tp1,
    tp2,
    tp3,
    sl,
    price,
    leverage,
    reason,
    nfa,
    raw: body
  };
}

function validatePayload(payload) {
  const errors = [];

  if (!payload.event) errors.push("Missing event");
  if (!payload.symbol) errors.push("Missing symbol");
  if (!payload.interval) errors.push("Missing interval");

  if (payload.event === "signal") {
    if (!payload.side) errors.push("Missing side for signal");
    if (!payload.alert_id) errors.push("Missing alert_id for signal");
  }

  if (["tp_hit", "sl_hit"].includes(payload.event)) {
    if (!payload.alert_id) errors.push("Missing alert_id for hit");
  }

  return errors;
}

// =========================
// ROUTES
// =========================
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "ALRT-Render",
    message: "Webhook server is running"
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.post("/webhook/tradingview", (req, res) => {
  try {
    const body = req.body || {};

    const providedSecret =
      safeString(body.secret || req.headers["x-webhook-secret"]);

    if (!WEBHOOK_SECRET) {
      console.error("WEBHOOK_SECRET is not set in environment variables.");
      return res.status(500).json({
        ok: false,
        error: "Server webhook secret is not configured"
      });
    }

    if (!providedSecret || providedSecret !== WEBHOOK_SECRET) {
      console.warn("Unauthorized webhook attempt");
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const normalized = buildNormalizedPayload(body);
    const errors = validatePayload(normalized);

    if (errors.length > 0) {
      console.warn("Webhook validation failed:", errors);
      return res.status(400).json({
        ok: false,
        error: "Invalid payload",
        details: errors
      });
    }

    console.log("=== ALRT WEBHOOK RECEIVED ===");
    console.log(JSON.stringify(normalized, null, 2));

    // Placeholder for future logic:
    // 1) save signal/hit to DB
    // 2) validate hit against active signal
    // 3) send Telegram
    // 4) update stats

    return res.status(200).json({
      ok: true,
      message: "Webhook received",
      event: normalized.event,
      symbol: normalized.symbol,
      alert_id: normalized.alert_id || null
    });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return res.status(500).json({
      ok: false,
      error: "Internal server error"
    });
  }
});

// =========================
// 404
// =========================
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Not found"
  });
});

// =========================
// START
// =========================
app.listen(PORT, () => {
  console.log(`ALRT-Render listening on port ${PORT}`);
});
