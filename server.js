import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));

// ===== CONFIG =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ===== REF ID =====
let currentRef = 100000;

// ===== CHART LINKS =====
const CHARTS = {
  BTCUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT",
  ETHUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:ETHUSDT",
  XRPUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:XRPUSDT",
  SOLUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:SOLUSDT",
  BNBUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:BNBUSDT",
  DOGEUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:DOGEUSDT",
  LTCUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:LTCUSDT",
  ADAUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:ADAUSDT",
  OPUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:OPUSDT",
  ARBUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:ARBUSDT",
  ATOMUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:ATOMUSDT",
  LINKUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:LINKUSDT",
  AVAXUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:AVAXUSDT",
  SHIBUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:SHIBUSDT",
};

// ===== WEBHOOK =====
app.post("/webhook/tradingview", async (req, res) => {
  const body = req.body || {};

  // DIRECT RESPONSE (BELANGRIJK)
  res.status(200).json({ ok: true });

  try {
    const symbol = (body.symbol || "").toUpperCase();
    const side = (body.side || "").toUpperCase();
    const entry = body.entry;
    const tp = body.tp1;
    const sl = body.sl;
    const rsi = body.rsi;

    currentRef++;

   const explanation1 =
  side === "LONG"
    ? "Momentum is turning upward and the trend remains bullish."
    : "Momentum is turning downward and the trend remains bearish.";

const explanation2 =
  rsi
    ? `RSI supports this setup (${rsi}).`
    : "Price action supports this setup.";

const text = `
🚨 ALERT #${currentRef}

PAIR: ${symbol}
DIRECTION: ${side}

ENTRY: ${entry}
TP: ${tp}
SL: ${sl}

TIMEFRAME: 60M
TIME (UTC): ${new Date().toISOString()}

${explanation1}
${explanation2}

CHART: attached
NFA (Not Financial Advice)
`;

    // SEND TELEGRAM
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: text,
      }),
    });

    console.log("ALERT SENT:", symbol, side);
  } catch (err) {
    console.error("ERROR:", err);
  }
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`ALRT-Render running on port ${PORT}`);
});
