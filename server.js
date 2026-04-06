import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ===== PATHS =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const TRADES_FILE = path.join(DATA_DIR, "active-trades.json");

// ===== ACTIVE TRADES =====
const activeTrades = new Map();
const MAX_TRADE_AGE_MS = 24 * 60 * 60 * 1000;

// serialize saves so file writes never overlap
let savePromise = Promise.resolve();

app.use(express.json({ limit: "1mb" }));

// ===== CHART PAGE LINKS =====
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

// ===== OPTIONAL DIRECT IMAGE LINKS =====
// Vul later alleen echte directe image-urls in.
// Anders valt het systeem automatisch terug op sendMessage.
const CHART_IMAGES = {
  // BTCUSDT: "https://....png",
  // ETHUSDT: "https://....png",
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

function parseNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtPrice(v) {
  if (v === null || v === undefined || v === "") return "N/A";

  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);

  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  if (n >= 0.0001) return n.toFixed(8);
  return n.toFixed(10);
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

function normalizeEventType(v) {
  return String(v || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
}

function formatUtc(ts) {
  let d;

  if (ts === null || ts === undefined || ts === "") {
    d = new Date();
  } else {
    const raw = String(ts).trim();

    if (/^\d+$/.test(raw)) {
      const num = Number(raw);
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

function eventTimeToMs(ts) {
  if (ts === null || ts === undefined || ts === "") return Date.now();

  const raw = String(ts).trim();

  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    return raw.length <= 10 ? num * 1000 : num;
  }

  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? Date.now() : d.getTime();
}

function makeRef6({ symbol, side, eventTime, entry, tp, sl }) {
  const base = [
    symbol || "",
    side || "",
    String(eventTime || ""),
    String(entry || ""),
    String(tp || ""),
    String(sl || ""),
  ].join("|");

  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = (hash * 31 + base.charCodeAt(i)) % 900000;
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

function hasValidTradeLevels(side, entry, tp, sl) {
  const e = parseNum(entry);
  const t = parseNum(tp);
  const s = parseNum(sl);

  if (!Number.isFinite(e) || !Number.isFinite(t) || !Number.isFinite(s)) return false;
  if (e <= 0 || t <= 0 || s <= 0) return false;

  if (side === "LONG") return t > e && s < e;
  if (side === "SHORT") return t < e && s > e;

  return false;
}

function cleanupActiveTrades() {
  const now = Date.now();
  let changed = false;

  for (const [key, trade] of activeTrades.entries()) {
    if (now - trade.createdAtMs > MAX_TRADE_AGE_MS) {
      activeTrades.delete(key);
      changed = true;
    }
  }

  if (changed) {
    void persistActiveTrades();
  }
}

function detectExplicitHitType(eventType, body) {
  const normalized = normalizeEventType(eventType);
  const rawText = JSON.stringify(body).toLowerCase();

  if (
    normalized.includes("tp_hit") ||
    normalized.includes("take_profit_hit") ||
    normalized === "tp" ||
    rawText.includes('"event":"tp_hit"') ||
    rawText.includes('"type":"tp_hit"') ||
    rawText.includes('"event_type":"tp_hit"') ||
    rawText.includes('"hit_type":"tp"')
  ) {
    return "TP";
  }

  if (
    normalized.includes("sl_hit") ||
    normalized.includes("stop_loss_hit") ||
    normalized === "sl" ||
    rawText.includes('"event":"sl_hit"') ||
    rawText.includes('"type":"sl_hit"') ||
    rawText.includes('"event_type":"sl_hit"') ||
    rawText.includes('"hit_type":"sl"')
  ) {
    return "SL";
  }

  return null;
}

function isLikelySignalEvent(eventType, side, entry) {
  const normalized = normalizeEventType(eventType);

  if (normalized.includes("signal")) return true;
  if (normalized.includes("entry")) return true;
  if (normalized.includes("alert")) return true;

  return (side === "LONG" || side === "SHORT") && entry !== null && entry !== undefined && entry !== "";
}

function buildTradeKey(symbol, side, refId) {
  return `${symbol}|${side}|${refId}`;
}

function findOpenTradeByAlertIds(ids) {
  const cleanIds = ids.filter(Boolean).map(String);

  if (cleanIds.length === 0) return null;

  for (const [key, trade] of activeTrades.entries()) {
    if (trade.hit) continue;

    if (
      cleanIds.includes(String(trade.sourceAlertId || "")) ||
      cleanIds.includes(String(trade.signalAlertId || "")) ||
      cleanIds.includes(String(trade.parentAlertId || ""))
    ) {
      return { key, trade };
    }
  }

  return null;
}

function findLatestOpenTradeBySymbol(symbol) {
  let latest = null;

  for (const [key, trade] of activeTrades.entries()) {
    if (trade.symbol !== symbol) continue;
    if (trade.hit) continue;

    if (!latest || trade.createdAtMs > latest.trade.createdAtMs) {
      latest = { key, trade };
    }
  }

  return latest;
}

function shouldInferHit(trade, currentPrice) {
  if (!Number.isFinite(currentPrice)) return null;
  if (trade.hit) return null;

  if (trade.side === "LONG") {
    if (currentPrice >= trade.tp) return "TP";
    if (currentPrice <= trade.sl) return "SL";
  }

  if (trade.side === "SHORT") {
    if (currentPrice <= trade.tp) return "TP";
    if (currentPrice >= trade.sl) return "SL";
  }

  return null;
}

// ===== PERSISTENCE =====
async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function persistActiveTrades() {
  savePromise = savePromise.then(async () => {
    await ensureDataDir();

    const payload = {
      updatedAt: new Date().toISOString(),
      trades: Array.from(activeTrades.entries()).map(([key, trade]) => [key, trade]),
    };

    await fs.writeFile(TRADES_FILE, JSON.stringify(payload, null, 2), "utf8");
  }).catch((err) => {
    console.error("PERSIST SAVE ERROR:", err);
  });

  return savePromise;
}

async function loadActiveTrades() {
  try {
    await ensureDataDir();
    const raw = await fs.readFile(TRADES_FILE, "utf8");
    const parsed = JSON.parse(raw);

    const items = Array.isArray(parsed?.trades) ? parsed.trades : [];
    const now = Date.now();

    for (const item of items) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [key, trade] = item;
      if (!trade || typeof trade !== "object") continue;
      if (!trade.createdAtMs) continue;
      if (now - trade.createdAtMs > MAX_TRADE_AGE_MS) continue;
      if (trade.hit) continue;

      activeTrades.set(key, trade);
    }

    console.log(`Loaded ${activeTrades.size} active trades from disk`);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("No active-trades.json found yet, starting clean");
      return;
    }

    console.error("PERSIST LOAD ERROR:", err);
  }
}

async function removeTrade(tradeKey) {
  if (activeTrades.delete(tradeKey)) {
    await persistActiveTrades();
  }
}

async function upsertTrade(tradeKey, trade) {
  activeTrades.set(tradeKey, trade);
  await persistActiveTrades();
}

// ===== TELEGRAM =====
async function sendTelegramAlert({ symbol, text }) {
  const imageUrl = CHART_IMAGES[symbol] || null;

  if (imageUrl) {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        photo: imageUrl,
        caption: text,
      }),
    });

    const data = await response.json();
    console.log("TELEGRAM PHOTO RESPONSE:", data);

    if (!response.ok || !data.ok) {
      throw new Error(`Telegram sendPhoto failed: ${JSON.stringify(data)}`);
    }

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
  console.log("TELEGRAM MESSAGE RESPONSE:", data);

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendMessage failed: ${JSON.stringify(data)}`);
  }
}

async function sendHitAlert({ trade, hitType, hitTime }) {
  const hitText = `🎯 ${hitType} HIT

PAIR: ${trade.symbol}
DIRECTION: ${trade.side}

ENTRY: ${fmtPrice(trade.entry)}
TP: ${fmtPrice(trade.tp)}
SL: ${fmtPrice(trade.sl)}

TIMEFRAME: 60M
TIME (UTC): ${formatUtc(hitTime)}

REF: #${trade.refId}
ALERT ID: ${trade.sourceAlertId || trade.signalAlertId || trade.parentAlertId || "N/A"}
RESULT: ${hitType}
NFA (Not Financial Advice)`;

  await sendTelegramAlert({
    symbol: trade.symbol,
    text: hitText,
  });
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
    activeTrades: activeTrades.size,
  });
});

// ===== WEBHOOK =====
app.post("/webhook/tradingview", async (req, res) => {
  const body = req.body || {};
  res.status(200).json({ ok: true });

  try {
    cleanupActiveTrades();

    const symbol = normalizeSymbol(
      pick(body.symbol, body.ticker, body.pair, body.coin, body.market, "")
    );

    const side = normalizeSide(
      pick(body.side, body.direction, body.position, body.trade_side, "")
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

    const rsi = pick(body.rsi, body.rsi_value);
    const atrPct = pick(body.atr_pct, body.atrPercent, body.atr_percent);

    const eventTime = pick(
      body.time_close,
      body.bar_close_time,
      body.timestamp,
      body.time,
      Date.now()
    );

    const eventTimeMs = eventTimeToMs(eventTime);
    const prettyTime = formatUtc(eventTime);

    const eventType = pick(
      body.event,
      body.type,
      body.event_type,
      body.kind,
      body.signal_type,
      ""
    );

    const currentPrice = parseNum(
      pick(body.price, body.close, body.last, body.last_price, body.market_price, body.hit_price)
    );

    const sourceAlertId = pick(body.alert_id);
    const signalAlertId = pick(body.signal_alert_id, body.parent_alert_id, body.alert_id);
    const parentAlertId = pick(body.parent_alert_id, body.signal_alert_id, body.alert_id);

    const refId = makeRef6({
      symbol,
      side,
      eventTime,
      entry,
      tp,
      sl,
    });

    const explicitHitType = detectExplicitHitType(eventType, body);

    if (!BOT_TOKEN || !CHAT_ID) {
      console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
      return;
    }

    // ===== HANDLE EXPLICIT TP/SL HIT WEBHOOKS =====
    if (explicitHitType && symbol) {
      const exact = findOpenTradeByAlertIds([
        signalAlertId,
        parentAlertId,
        sourceAlertId,
      ]);

      if (exact) {
        exact.trade.hit = true;
        exact.trade.hitType = explicitHitType;
        exact.trade.hitAtMs = Date.now();

        await sendHitAlert({
          trade: exact.trade,
          hitType: explicitHitType,
          hitTime: Date.now(),
        });

        console.log(`EXPLICIT HIT SENT (ID MATCH): ${symbol} ${explicitHitType} REF ${exact.trade.refId}`);
        console.log("HIT MATCH DATA:", {
          symbol,
          explicitHitType,
          sourceAlertId,
          signalAlertId,
          parentAlertId,
          matchedRefId: exact.trade.refId,
          matchedSourceAlertId: exact.trade.sourceAlertId,
        });

        await removeTrade(exact.key);
        return;
      }

      const fallback = findLatestOpenTradeBySymbol(symbol);

      if (fallback) {
        fallback.trade.hit = true;
        fallback.trade.hitType = explicitHitType;
        fallback.trade.hitAtMs = Date.now();

        await sendHitAlert({
          trade: fallback.trade,
          hitType: explicitHitType,
          hitTime: Date.now(),
        });

        console.log(`EXPLICIT HIT SENT (SYMBOL FALLBACK): ${symbol} ${explicitHitType} REF ${fallback.trade.refId}`);
        console.log("HIT FALLBACK DATA:", {
          symbol,
          explicitHitType,
          sourceAlertId,
          signalAlertId,
          parentAlertId,
          matchedRefId: fallback.trade.refId,
          matchedSourceAlertId: fallback.trade.sourceAlertId,
        });

        await removeTrade(fallback.key);
        return;
      }

      console.log("EXPLICIT HIT RECEIVED BUT NO OPEN TRADE FOUND:", {
        symbol,
        explicitHitType,
        sourceAlertId,
        signalAlertId,
        parentAlertId,
        activeTrades: activeTrades.size,
      });

      return;
    }

    // ===== INFER HITS FROM PRICE ON NEW WEBHOOKS =====
    if (symbol && Number.isFinite(currentPrice)) {
      const hitKeys = [];

      for (const [key, trade] of activeTrades.entries()) {
        if (trade.symbol !== symbol) continue;
        if (trade.hit) continue;

        const inferredHit = shouldInferHit(trade, currentPrice);
        if (!inferredHit) continue;

        trade.hit = true;
        trade.hitType = inferredHit;
        trade.hitAtMs = Date.now();

        await sendHitAlert({
          trade,
          hitType: inferredHit,
          hitTime: Date.now(),
        });

        console.log(`INFERRED HIT SENT: ${symbol} ${inferredHit} REF ${trade.refId}`);
        hitKeys.push(key);
      }

      for (const key of hitKeys) {
        await removeTrade(key);
      }
    }

    // ===== NORMAL SIGNAL ALERT =====
    const isSignal = isLikelySignalEvent(eventType, side, entry);

    if (!isSignal || !symbol || (side !== "LONG" && side !== "SHORT")) {
      console.log("NON-SIGNAL WEBHOOK RECEIVED:", {
        symbol,
        side,
        eventType,
      });
      return;
    }

    const validLevels = hasValidTradeLevels(side, entry, tp, sl);

    if (validLevels) {
      const tradeKey = buildTradeKey(symbol, side, refId);

      await upsertTrade(tradeKey, {
        tradeKey,
        refId,
        symbol,
        side,
        entry: parseNum(entry),
        tp: parseNum(tp),
        sl: parseNum(sl),
        createdAtMs: eventTimeMs,
        hit: false,
        hitType: null,
        hitAtMs: null,
        sourceAlertId,
        signalAlertId,
        parentAlertId,
      });
    }

    const chartLink = CHARTS[symbol] || "N/A";
    const { line1, line2 } = buildExplanation(side, rsi, atrPct);

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

    await sendTelegramAlert({ symbol, text });

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
      imageUsed: Boolean(CHART_IMAGES[symbol]),
      storedForHits: validLevels,
      activeTrades: activeTrades.size,
      eventType,
      sourceAlertId,
      signalAlertId,
      parentAlertId,
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
async function startServer() {
  await loadActiveTrades();

  app.listen(PORT, () => {
    console.log(`ALRT-Render running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("STARTUP ERROR:", err);
  process.exit(1);
});
