import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

app.use(express.json({ limit: "1mb" }));

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

// ===== HELPERS =====
function pick(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return v;
    }
  }
  return null;
}

function fmtPrice(v) {
  if (v === null || v === undefined || v === "") return "N/A";

  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);

  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  return n.toFixed(6);
}

function normalizeSymbol(v) {
  return String(v || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(".P", "");
}

function normalizeSide(v) {
  const x = String(v || "").toUpperCase().trim();
  if (x === "LONG" || x === "SHORT") return x;
  return "N/A";
}

function formatUtc(ts) {
  let d;

  if (ts === null || ts === undefined || ts === "") {
    d = new Date();
  } else {
    const raw = String(ts).trim();

    if (/^\d+$/.test(raw)) {
      const num = Number(raw);

      // seconden vs milliseconden
      d = raw.length <= 10 ? new Date(num * 1000) : new Date(num);
    } else {
      d = new Date(raw);
    }
  }

  if (Number.isNaN(d.getTime())) return "N/A";

  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");

  return `${y}-${m}-${day} ${hh}:${mm} UTC`;
}

function makeRef6(seed) {
  const str = String(seed || Date.now());
  let hash = 0;

  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) % 900000;
  }

  return String(100000 + hash);
}

function buildExplanation(side, rsi, atrPct) {
  const r = Number(rsi);
  const atr = Number(atrPct);

  let line1 = "Momentum and structure align with this setup.";
  let line2 = "The 60M trend context supports the trade.";

  if (side === "LONG") {
    if (Number.isFinite(r)) {
      if (r < 40) {
        line1 = `Momentum is recovering from weaker RSI conditions (${r.toFixed(2)}).`;
      } else if (r < 55) {
        line1 = `RSI is supportive for a developing long setup (${r.toFixed(2)}).`;
      } else {
        line1 = `Momentum remains constructive for continuation on the long side (${r.toFixed(2)}).`;
      }
    } else {
      line1 = "Momentum is improving and the short-term structure supports a long setup.";
    }

    if (Number.isFinite(atr)) {
      line2 = `Volatility remains acceptable for this 60M long setup (ATR ${atr.toFixed(2)}%).`;
    } else {
      line2 = "Trend structure and price action support continuation on 60M.";
    }
  }

  if (side === "SHORT") {
    if (Number.isFinite(r)) {
      if (r > 60) {
        line1 = `Momentum remains weak for buyers and supports downside continuation (${r.toFixed(2)} RSI).`;
      } else if (r > 45) {
        line1 = `RSI is rolling over and supports a developing short setup (${r.toFixed(2)}).`;
      } else {
        line1 = `Momentum is already leaning bearish and supports downside pressure (${r.toFixed(2)}).`;
      }
    } else {
      line1 = "Momentum is weakening and the short-term structure supports a short setup.";
    }

    if (Number.isFinite(atr)) {
      line2 = `Volatility remains acceptable for this 60M short setup (ATR ${atr.toFixed(2)}%).`;
    } else {
      line2 = "Trend structure and price action support downside continuation on 60M.";
    }
  }

  return { line1, line2 };
}

// ===== BASIC ROUTES =====
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "ALRT-Render",
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
  });
});

// ===== WEBHOOK =====
app.post("/webhook/tradingview", async (req, res) => {
  const body = req.body || {};

  // Snel antwoorden aan TradingView
  res.status(200).json({ ok: true });

  try {
    const symbol = normalizeSymbol(
      pick(body.symbol, body.ticker, body.pair, body.coin, "")
    );

    const side = normalizeSide(
      pick(body.side, body.direction, "")
    );

    const entry = pick(
  body.entry,
  body.entry_price,
  body.price,
  body.entryPrice,
  body.Entry,
  body.close
);

const tp = pick(
  body.tp1,
  body.tp,
  body.take_profit,
  body.takeProfit,
  body.tp_price,
  body.target,
  body.target_price,
  body.TP,
  body.tpPrice
);

const sl = pick(
  body.sl,
  body.stop_loss,
  body.stop,
  body.stopLoss,
  body.sl_price,
  body.stop_price,
  body.SL,
  body.slPrice
);

    const rsi = pick(body.rsi);
    const atrPct = pick(body.atr_pct, body.atrPercent);

    const eventTime = pick(
      body.time_close,
      body.bar_close_time,
      body.timestamp,
      body.time,
      Date.now()
    );

    const alertSeed = pick(
      body.alert_id,
      body.id,
      `${symbol}-${side}-${eventTime}`
    );

    const refId = makeRef6(alertSeed);
    const prettyTime = formatUtc(eventTime);
    const { line1, line2 } = buildExplanation(side, rsi, atrPct);

    const chartLink = CHARTS[symbol] || "N/A";

    const text = `🚨 ALERT #${refId}

PAIR: ${symbol}
DIRECTION: ${side}

ENTRY: ${fmtPrice(entry)}
TP: ${fmtPrice(tp)}
SL: ${fmtPrice(sl)}

TIMEFRAME: 60M
TIME (UTC): ${prettyTime}

${line1}
${line2}

CHART: attached
NFA (Not Financial Advice)`;

    if (!BOT_TOKEN || !CHAT_ID) {
      console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
      console.log("Payload received but Telegram config is missing:", {
        symbol,
        side,
        refId,
        chartLink,
      });
      return;
    }

    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
      }),
    });

    const data = await response.json();

    console.log("TELEGRAM RESPONSE:", data);

    if (!response.ok || !data.ok) {
      console.error("Telegram send failed:", data);
      return;
    }

    console.log(`ALERT SENT: ${symbol} ${side} REF ${refId}`);
    console.log("ALERT DATA:", {
      symbol,
      side,
      entry: fmtPrice(entry),
      tp: fmtPrice(tp),
      sl: fmtPrice(sl),
      time: prettyTime,
      refId,
      chartLink,
    });
  } catch (err) {
    console.error("ERROR:", err);
  }
});

// ===== 404 =====
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`ALRT-Render running on port ${PORT}`);
});
