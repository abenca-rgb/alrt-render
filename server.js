import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || "").trim();

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

function s(v, fallback = "") {
  if (v === undefined || v === null) return fallback;
  return String(v).trim();
}

function n(v, fallback = null) {
  if (v === undefined || v === null || v === "") return fallback;
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function normalizeSymbol(v) {
  return s(v).toUpperCase().replace(/\s+/g, "").replace(".P", "");
}

function normalizeInterval(v) {
  const x = s(v).toLowerCase();
  if (!x) return "";
  if (x === "1h") return "60";
  if (x === "60m") return "60";
  if (x === "15m") return "15";
  if (x === "4h") return "240";
  return x;
}

function normalizeEvent(v) {
  const x = s(v).toLowerCase();
  if (!x) return "unknown";
  if (["signal", "entry", "new_signal"].includes(x)) return "signal";
  if (["tp_hit", "tp1_hit", "tp2_hit", "take_profit_hit"].includes(x)) return "tp_hit";
  if (["sl_hit", "stop_hit", "stop_loss_hit"].includes(x)) return "sl_hit";
  return x;
}

function normalizeSide(v) {
  const x = s(v).toUpperCase();
  if (x === "LONG" || x === "SHORT") return x;
  return "";
}

function buildPayload(body) {
  const symbol = normalizeSymbol(body.symbol || body.ticker || body.pair || body.coin);
  const interval = normalizeInterval(body.interval || body.timeframe || body.tf);
  const event = normalizeEvent(body.event || body.type || body.alert_type);
  const side = normalizeSide(body.side || body.direction);

  const timeClose = s(body.time_close || body.bar_close_time || body.timestamp || "");
  const time = s(body.time || body.timestamp || "");
  const alertId = s(body.alert_id || body.id || body.ref_id || timeClose || time || Date.now());

  return {
    received_at: new Date().toISOString(),
    secret: s(body.secret),
    event,
    system: s(body.system),
    version: s(body.version),
    side,
    symbol,
    exchange: s(body.exchange || body.market),
    interval,
    tf: s(body.tf),
    alert_id: alertId,
    time,
    time_close: timeClose,
    timestamp: s(body.timestamp),
    entry: n(body.entry),
    tp1: n(body.tp1),
    tp2: n(body.tp2),
    tp3: n(body.tp3),
    sl: n(body.sl),
    rsi: n(body.rsi),
    atr_pct: n(body.atr_pct),
    risk: s(body.risk),
    leverage: s(body.leverage),
    nfa: s(body.nfa),
    raw: body
  };
}

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "ALRT-Render"
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
    const payload = buildPayload(body);

    if (!WEBHOOK_SECRET) {
      console.error("WEBHOOK_SECRET missing on server");
      return res.status(500).json({ ok: false, error: "Server secret missing" });
    }

    if (!payload.secret || payload.secret !== WEBHOOK_SECRET) {
      console.warn("Unauthorized webhook attempt");
      console.log("Received secret:", JSON.stringify(payload.secret));
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // TradingView moet snel antwoord krijgen
    res.status(200).json({
      ok: true,
      received: true,
      event: payload.event,
      symbol: payload.symbol,
      alert_id: payload.alert_id
    });

    // Alles hieronder alleen loggen
    console.log("=== ALRT WEBHOOK RECEIVED ===");
    console.log(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`ALRT-Render listening on port ${PORT}`);
});
