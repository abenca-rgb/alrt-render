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
const STATE_FILE = path.join(DATA_DIR, "state.json");

// ===== STATE =====
const activeTrades = new Map();
const recentHitKeys = new Map();

const MAX_TRADE_AGE_MS = 24 * 60 * 60 * 1000;
const HIT_DEDUP_TTL_MS = 36 * 60 * 60 * 1000;

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

function fmtPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "N/A";
  return `${n.toFixed(2)}%`;
}

function fmtRR(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "N/A";
  return `${n.toFixed(2)}R`;
}

function normalizeSymbol(v) {
  return String(v || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(".P", "")
    .replace("BINANCE:", "");
}

function normalizeSide(v) {
  const x = String(v || "").toUpperCase().trim();
  if (x === "LONG" || x === "SHORT") return x;
  if (x === "BUY") return "LONG";
  if (x === "SELL") return "SHORT";
  return "N/A";
}

function normalizeEventType(v) {
  return String(v || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
}

function normalizeSetupType(v) {
  const x = String(v || "").toLowerCase().trim();

  if (!x) return "";

  if (x.includes("break")) return "BREAKOUT";
  if (x.includes("pull")) return "PULLBACK";
  if (x.includes("trend")) return "TREND";
  if (x.includes("reversal") || x.includes("reverse")) return "REVERSAL";
  if (x.includes("compress") || x.includes("squeeze")) return "COMPRESSION";
  if (x.includes("momentum")) return "MOMENTUM";
  return x.toUpperCase();
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

function stableHash(str) {
  let hash = 0;
  const input = String(str || "");
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) % 2147483647;
  }
  return hash;
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

  return String(100000 + (stableHash(base) % 900000));
}

function isMajorSymbol(symbol) {
  return ["BTCUSDT", "ETHUSDT"].includes(symbol);
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

function pctMove(side, entry, price) {
  const e = parseNum(entry);
  const p = parseNum(price);

  if (!Number.isFinite(e) || !Number.isFinite(p) || e <= 0) return null;

  if (side === "LONG") return ((p - e) / e) * 100;
  if (side === "SHORT") return ((e - p) / e) * 100;

  return null;
}

function rrFromLevels(side, entry, tp, sl) {
  const e = parseNum(entry);
  const t = parseNum(tp);
  const s = parseNum(sl);

  if (!Number.isFinite(e) || !Number.isFinite(t) || !Number.isFinite(s)) return null;

  let reward = null;
  let risk = null;

  if (side === "LONG") {
    reward = t - e;
    risk = e - s;
  } else if (side === "SHORT") {
    reward = e - t;
    risk = s - e;
  }

  if (!Number.isFinite(reward) || !Number.isFinite(risk) || reward <= 0 || risk <= 0) return null;
  return reward / risk;
}

function getStrengthBucket({ symbol, side, rsi, atrPct, score, risk }) {
  const numericScore = parseNum(score);
  const numericRisk = parseNum(risk);
  const numericRsi = parseNum(rsi);
  const numericAtr = parseNum(atrPct);

  if (Number.isFinite(numericScore)) {
    if (numericScore >= 90) return "A+";
    if (numericScore >= 75) return "A";
    if (numericScore >= 60) return "B";
    return "C";
  }

  if (Number.isFinite(numericRisk)) {
    if (numericRisk >= 5) return "A";
    if (numericRisk >= 4) return "B";
    return "C";
  }

  if (side === "LONG") {
    if (Number.isFinite(numericRsi)) {
      if (numericRsi >= 57 && numericAtr <= 3.2) return "A";
      if (numericRsi >= 50) return "B";
      return "C";
    }
  }

  if (side === "SHORT") {
    if (Number.isFinite(numericRsi)) {
      if (numericRsi <= 43 && numericAtr <= 3.2) return "A";
      if (numericRsi <= 50) return "B";
      return "C";
    }
  }

  if (isMajorSymbol(symbol)) return "B";
  return "C";
}

function getTargetProfile({ symbol, strength }) {
  const major = isMajorSymbol(symbol);

  if (strength === "A+") {
    return major
      ? { tpPct: 3.2, slPct: 1.25 }
      : { tpPct: 3.5, slPct: 1.55 };
  }

  if (strength === "A") {
    return major
      ? { tpPct: 2.8, slPct: 1.20 }
      : { tpPct: 3.0, slPct: 1.50 };
  }

  if (strength === "B") {
    return major
      ? { tpPct: 2.2, slPct: 1.10 }
      : { tpPct: 2.4, slPct: 1.35 };
  }

  return major
    ? { tpPct: 1.6, slPct: 1.00 }
    : { tpPct: 1.8, slPct: 1.25 };
}

function applyProfileLevels(side, entry, tpPct, slPct) {
  const e = parseNum(entry);
  if (!Number.isFinite(e) || e <= 0) {
    return { tp: null, sl: null };
  }

  if (side === "LONG") {
    return {
      tp: e * (1 + tpPct / 100),
      sl: e * (1 - slPct / 100),
    };
  }

  if (side === "SHORT") {
    return {
      tp: e * (1 - tpPct / 100),
      sl: e * (1 + slPct / 100),
    };
  }

  return { tp: null, sl: null };
}

function deriveSetupType({ body, side, rsi, atrPct }) {
  const explicit = normalizeSetupType(
    pick(
      body.setup_type,
      body.reason_type,
      body.setup,
      body.pattern,
      body.signal_name,
      body.strategy_name
    )
  );

  if (explicit) return explicit;

  const numericRsi = parseNum(rsi);
  const numericAtr = parseNum(atrPct);

  if (Number.isFinite(numericAtr) && numericAtr <= 1.2) return "COMPRESSION";

  if (side === "LONG") {
    if (Number.isFinite(numericRsi) && numericRsi < 42) return "REVERSAL";
    if (Number.isFinite(numericRsi) && numericRsi >= 58) return "MOMENTUM";
    if (Number.isFinite(numericRsi) && numericRsi >= 50) return "TREND";
    return "PULLBACK";
  }

  if (side === "SHORT") {
    if (Number.isFinite(numericRsi) && numericRsi > 58) return "REVERSAL";
    if (Number.isFinite(numericRsi) && numericRsi <= 42) return "MOMENTUM";
    if (Number.isFinite(numericRsi) && numericRsi <= 50) return "TREND";
    return "PULLBACK";
  }

  return "TREND";
}

function chooseVariant(seed, variants) {
  if (!Array.isArray(variants) || variants.length === 0) return "";
  const index = stableHash(seed) % variants.length;
  return variants[index];
}

function buildReasonEngine({ symbol, side, rsi, atrPct, eventTime, setupType, strength }) {
  const r = parseNum(rsi);
  const atr = parseNum(atrPct);
  const seed = `${symbol}|${side}|${eventTime}|${setupType}|${strength}`;

  const introBySetup = {
    BREAKOUT: {
      LONG: [
        "Bullish breakout structure is developing with price pressing through resistance.",
        "Breakout conditions are active and buyers are defending continuation.",
        "Price is expanding above local resistance with constructive momentum."
      ],
      SHORT: [
        "Bearish breakdown structure is developing with price slipping under support.",
        "Breakdown conditions are active and sellers are pressing continuation.",
        "Price is expanding below local support with downside momentum."
      ],
    },
    PULLBACK: {
      LONG: [
        "This looks like a continuation setup after a healthy pullback.",
        "Price is retracing inside the trend while buyers remain in control.",
        "The setup reflects a bullish pullback rather than trend failure."
      ],
      SHORT: [
        "This looks like a continuation setup after a corrective bounce.",
        "Price is retracing into weakness while sellers remain in control.",
        "The setup reflects a bearish pullback rather than trend failure."
      ],
    },
    TREND: {
      LONG: [
        "Trend structure remains constructive on the 60M chart.",
        "The broader 60M flow still favors continuation to the upside.",
        "This setup aligns with the prevailing bullish structure."
      ],
      SHORT: [
        "Trend structure remains weak on the 60M chart.",
        "The broader 60M flow still favors continuation to the downside.",
        "This setup aligns with the prevailing bearish structure."
      ],
    },
    REVERSAL: {
      LONG: [
        "A potential reversal is forming from a weaker zone.",
        "Buyers are attempting to reclaim structure after prior weakness.",
        "This setup suggests reversal pressure may be building."
      ],
      SHORT: [
        "A potential reversal is forming from an overextended zone.",
        "Sellers are attempting to reclaim control after prior strength.",
        "This setup suggests reversal pressure may be building lower."
      ],
    },
    COMPRESSION: {
      LONG: [
        "Price is compressing and a directional expansion may follow.",
        "Low-volatility structure can fuel a sharper upside release.",
        "This setup reflects compression before a possible bullish expansion."
      ],
      SHORT: [
        "Price is compressing and a directional expansion may follow.",
        "Low-volatility structure can fuel a sharper downside release.",
        "This setup reflects compression before a possible bearish expansion."
      ],
    },
    MOMENTUM: {
      LONG: [
        "Momentum is accelerating to the upside.",
        "Buy-side pressure is increasing and supports continuation.",
        "This setup shows active bullish momentum rather than passive drift."
      ],
      SHORT: [
        "Momentum is accelerating to the downside.",
        "Sell-side pressure is increasing and supports continuation.",
        "This setup shows active bearish momentum rather than passive drift."
      ],
    },
  };

  const fallback = {
    LONG: [
      "Momentum and structure align with this 60M long setup.",
      "The current 60M structure supports a bullish continuation attempt.",
      "Price action and momentum remain supportive for a long setup."
    ],
    SHORT: [
      "Momentum and structure align with this 60M short setup.",
      "The current 60M structure supports a bearish continuation attempt.",
      "Price action and momentum remain supportive for a short setup."
    ],
  };

  const library = introBySetup[setupType] || {};
  const line1 = chooseVariant(seed, library[side] || fallback[side] || ["Structure supports this setup."]);

  let line2 = "";
  if (Number.isFinite(r) && Number.isFinite(atr)) {
    line2 = `RSI ${r.toFixed(2)} and ATR ${atr.toFixed(2)}% fit the current ${strength} setup profile.`;
  } else if (Number.isFinite(r)) {
    line2 = `RSI ${r.toFixed(2)} supports the current ${strength} setup profile.`;
  } else if (Number.isFinite(atr)) {
    line2 = `ATR ${atr.toFixed(2)}% remains acceptable for this ${strength} 60M setup.`;
  } else {
    line2 = `The current setup profile is classified as ${strength} on 60M.`;
  }

  return { line1, line2 };
}

function cleanupState() {
  const now = Date.now();
  let changed = false;

  for (const [key, trade] of activeTrades.entries()) {
    if (!trade?.createdAtMs || now - trade.createdAtMs > MAX_TRADE_AGE_MS) {
      activeTrades.delete(key);
      changed = true;
    }
  }

  for (const [key, ts] of recentHitKeys.entries()) {
    if (!ts || now - ts > HIT_DEDUP_TTL_MS) {
      recentHitKeys.delete(key);
      changed = true;
    }
  }

  if (changed) {
    void persistState();
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

function collectCandidateIds(body) {
  return [
    pick(body.alert_id),
    pick(body.source_alert_id),
    pick(body.signal_alert_id),
    pick(body.parent_alert_id),
    pick(body.strategy_order_id),
    pick(body.order_id),
    pick(body.id),
    pick(body.ref_id),
  ]
    .filter(Boolean)
    .map((x) => String(x));
}

function buildRecentHitKey({ symbol, hitType, ids, eventTime }) {
  const idPart = ids && ids.length ? ids.join("|") : "no-id";
  return `${symbol}|${hitType}|${idPart}|${String(eventTime || "")}`;
}

function wasRecentHitSent(hitKey) {
  return recentHitKeys.has(hitKey);
}

async function markRecentHit(hitKey) {
  recentHitKeys.set(hitKey, Date.now());
  await persistState();
}

function findOpenTradeByCandidateIds(ids) {
  const wanted = ids.filter(Boolean).map(String);
  if (wanted.length === 0) return null;

  for (const [key, trade] of activeTrades.entries()) {
    if (trade.hit) continue;

    const tradeIds = Array.isArray(trade.alertIds) ? trade.alertIds.map(String) : [];
    const matched = tradeIds.some((id) => wanted.includes(id));

    if (matched) {
      return { key, trade };
    }
  }

  return null;
}

function findLatestOpenTradeBySymbolAndSide(symbol, side) {
  let latest = null;

  for (const [key, trade] of activeTrades.entries()) {
    if (trade.symbol !== symbol) continue;
    if (side !== "N/A" && trade.side !== side) continue;
    if (trade.hit) continue;

    if (!latest || trade.createdAtMs > latest.trade.createdAtMs) {
      latest = { key, trade };
    }
  }

  return latest;
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

function buildSyntheticTradeFromHit({
  symbol,
  side,
  entry,
  tp,
  sl,
  eventTime,
  refId,
  ids,
  setupType,
  strength,
}) {
  const rr = rrFromLevels(side, entry, tp, sl);

  return {
    tradeKey: buildTradeKey(symbol || "UNKNOWN", side || "N/A", refId || "000000"),
    refId: refId || "000000",
    symbol: symbol || "UNKNOWN",
    side: side || "N/A",
    entry: parseNum(entry),
    tp: parseNum(tp),
    sl: parseNum(sl),
    createdAtMs: eventTimeToMs(eventTime),
    hit: false,
    hitType: null,
    hitAtMs: null,
    alertIds: ids || [],
    setupType: setupType || "TREND",
    strength: strength || "N/A",
    rr,
  };
}

// ===== PERSISTENCE =====
async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function persistState() {
  savePromise = savePromise
    .then(async () => {
      await ensureDataDir();

      const payload = {
        updatedAt: new Date().toISOString(),
        activeTrades: Array.from(activeTrades.entries()).map(([key, trade]) => [key, trade]),
        recentHitKeys: Array.from(recentHitKeys.entries()).map(([key, ts]) => [key, ts]),
      };

      await fs.writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
    })
    .catch((err) => {
      console.error("PERSIST SAVE ERROR:", err);
    });

  return savePromise;
}

async function loadState() {
  try {
    await ensureDataDir();
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    const active = Array.isArray(parsed?.activeTrades) ? parsed.activeTrades : [];
    const hits = Array.isArray(parsed?.recentHitKeys) ? parsed.recentHitKeys : [];
    const now = Date.now();

    for (const item of active) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [key, trade] = item;
      if (!trade || typeof trade !== "object") continue;
      if (!trade.createdAtMs) continue;
      if (now - trade.createdAtMs > MAX_TRADE_AGE_MS) continue;
      if (trade.hit) continue;

      activeTrades.set(key, trade);
    }

    for (const item of hits) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [key, ts] = item;
      if (!ts || now - ts > HIT_DEDUP_TTL_MS) continue;

      recentHitKeys.set(key, ts);
    }

    console.log(`Loaded ${activeTrades.size} active trades from disk`);
    console.log(`Loaded ${recentHitKeys.size} recent hit keys from disk`);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("No state.json found yet, starting clean");
      return;
    }

    console.error("PERSIST LOAD ERROR:", err);
  }
}

async function removeTrade(tradeKey) {
  if (activeTrades.delete(tradeKey)) {
    await persistState();
  }
}

async function upsertTrade(tradeKey, trade) {
  activeTrades.set(tradeKey, trade);
  await persistState();
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

async function sendHitAlert({ trade, hitType, hitTime, hitPrice = null }) {
  const rr = rrFromLevels(trade.side, trade.entry, trade.tp, trade.sl);
  const movePct =
    hitType === "TP"
      ? pctMove(trade.side, trade.entry, trade.tp)
      : hitType === "SL"
      ? pctMove(trade.side, trade.entry, trade.sl)
      : pctMove(trade.side, trade.entry, hitPrice);

  const hitText = `🎯 ${hitType} HIT

PAIR: ${trade.symbol}
DIRECTION: ${trade.side}

ENTRY: ${fmtPrice(trade.entry)}
TP: ${fmtPrice(trade.tp)}
SL: ${fmtPrice(trade.sl)}

MOVE: ${fmtPct(movePct)}
RR: ${fmtRR(rr)}

SETUP: ${trade.setupType || "N/A"}
STRENGTH: ${trade.strength || "N/A"}

TIMEFRAME: 60M
TIME (UTC): ${formatUtc(hitTime)}

REF: #${trade.refId}
ALERT ID: ${(trade.alertIds && trade.alertIds[0]) || "N/A"}
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
    recentHitKeys: recentHitKeys.size,
  });
});

// ===== WEBHOOK =====
app.post("/webhook/tradingview", async (req, res) => {
  const body = req.body || {};
  res.status(200).json({ ok: true });

  try {
    cleanupState();

    const symbol = normalizeSymbol(
      pick(body.symbol, body.ticker, body.pair, body.coin, body.market, "")
    );

    const side = normalizeSide(
      pick(body.side, body.direction, body.position, body.trade_side, body.action, "")
    );

    const entryRaw = pick(
      body.entry,
      body.entry_price,
      body.entryPrice,
      body.price,
      body.Entry,
      body.close
    );

    const tpRaw = pick(
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

    const slRaw = pick(
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
    const score = pick(body.score, body.strength_score, body.setup_score);
    const risk = pick(body.risk, body.risk_score);

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

    const candidateIds = collectCandidateIds(body);

    const setupType = deriveSetupType({
      body,
      side,
      rsi,
      atrPct,
    });

    const strength = getStrengthBucket({
      symbol,
      side,
      rsi,
      atrPct,
      score,
      risk,
    });

    const profile = getTargetProfile({ symbol, strength });

    const entryParsed = parseNum(entryRaw);
    let tpParsed = parseNum(tpRaw);
    let slParsed = parseNum(slRaw);

    const validIncomingLevels = hasValidTradeLevels(side, entryParsed, tpParsed, slParsed);

    if (!validIncomingLevels && Number.isFinite(entryParsed) && (side === "LONG" || side === "SHORT")) {
      const derived = applyProfileLevels(side, entryParsed, profile.tpPct, profile.slPct);
      tpParsed = derived.tp;
      slParsed = derived.sl;
    }

    const rr = rrFromLevels(side, entryParsed, tpParsed, slParsed);
    const tpPct = pctMove(side, entryParsed, tpParsed);
    const slPct = pctMove(side, entryParsed, slParsed);

    const refId = makeRef6({
      symbol,
      side,
      eventTime,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
    });

    const explicitHitType = detectExplicitHitType(eventType, body);

    if (!BOT_TOKEN || !CHAT_ID) {
      console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
      return;
    }

    // ===== HANDLE EXPLICIT TP/SL HIT WEBHOOKS =====
    if (explicitHitType && symbol) {
      const hitKey = buildRecentHitKey({
        symbol,
        hitType: explicitHitType,
        ids: candidateIds,
        eventTime,
      });

      if (wasRecentHitSent(hitKey)) {
        console.log("DUPLICATE HIT IGNORED:", { symbol, explicitHitType, candidateIds, eventTime });
        return;
      }

      const exact = findOpenTradeByCandidateIds(candidateIds);

      if (exact) {
        exact.trade.hit = true;
        exact.trade.hitType = explicitHitType;
        exact.trade.hitAtMs = Date.now();

        await sendHitAlert({
          trade: exact.trade,
          hitType: explicitHitType,
          hitTime: eventTimeMs,
          hitPrice: currentPrice,
        });

        await markRecentHit(hitKey);

        console.log(`EXPLICIT HIT SENT (ID MATCH): ${symbol} ${explicitHitType} REF ${exact.trade.refId}`);
        console.log("HIT MATCH DATA:", {
          symbol,
          explicitHitType,
          candidateIds,
          matchedRefId: exact.trade.refId,
          tradeAlertIds: exact.trade.alertIds,
        });

        await removeTrade(exact.key);
        return;
      }

      const sideFallback = findLatestOpenTradeBySymbolAndSide(symbol, side);
      if (sideFallback) {
        sideFallback.trade.hit = true;
        sideFallback.trade.hitType = explicitHitType;
        sideFallback.trade.hitAtMs = Date.now();

        await sendHitAlert({
          trade: sideFallback.trade,
          hitType: explicitHitType,
          hitTime: eventTimeMs,
          hitPrice: currentPrice,
        });

        await markRecentHit(hitKey);

        console.log(`EXPLICIT HIT SENT (SYMBOL+SIDE FALLBACK): ${symbol} ${explicitHitType} REF ${sideFallback.trade.refId}`);
        console.log("HIT FALLBACK DATA:", {
          symbol,
          side,
          explicitHitType,
          candidateIds,
          matchedRefId: sideFallback.trade.refId,
          tradeAlertIds: sideFallback.trade.alertIds,
        });

        await removeTrade(sideFallback.key);
        return;
      }

      const symbolFallback = findLatestOpenTradeBySymbol(symbol);
      if (symbolFallback) {
        symbolFallback.trade.hit = true;
        symbolFallback.trade.hitType = explicitHitType;
        symbolFallback.trade.hitAtMs = Date.now();

        await sendHitAlert({
          trade: symbolFallback.trade,
          hitType: explicitHitType,
          hitTime: eventTimeMs,
          hitPrice: currentPrice,
        });

        await markRecentHit(hitKey);

        console.log(`EXPLICIT HIT SENT (SYMBOL FALLBACK): ${symbol} ${explicitHitType} REF ${symbolFallback.trade.refId}`);
        console.log("HIT SYMBOL FALLBACK DATA:", {
          symbol,
          explicitHitType,
          candidateIds,
          matchedRefId: symbolFallback.trade.refId,
          tradeAlertIds: symbolFallback.trade.alertIds,
        });

        await removeTrade(symbolFallback.key);
        return;
      }

      // LAST RESORT: send hit anyway from current payload
      const syntheticTrade = buildSyntheticTradeFromHit({
        symbol,
        side,
        entry: entryParsed,
        tp: tpParsed,
        sl: slParsed,
        eventTime,
        refId,
        ids: candidateIds,
        setupType,
        strength,
      });

      await sendHitAlert({
        trade: syntheticTrade,
        hitType: explicitHitType,
        hitTime: eventTimeMs,
        hitPrice: currentPrice,
      });

      await markRecentHit(hitKey);

      console.log("EXPLICIT HIT SENT (SYNTHETIC FALLBACK):", {
        symbol,
        side,
        explicitHitType,
        candidateIds,
        refId,
      });

      return;
    }

    // ===== INFER HITS FROM PRICE ON NEW WEBHOOKS =====
    if (symbol && Number.isFinite(currentPrice)) {
      const hitKeysToRemove = [];

      for (const [key, trade] of activeTrades.entries()) {
        if (trade.symbol !== symbol) continue;
        if (trade.hit) continue;

        const inferredHit = shouldInferHit(trade, currentPrice);
        if (!inferredHit) continue;

        const inferredHitKey = `${symbol}|${trade.refId}|${inferredHit}|${Math.floor(eventTimeMs / 60000)}`;
        if (wasRecentHitSent(inferredHitKey)) continue;

        trade.hit = true;
        trade.hitType = inferredHit;
        trade.hitAtMs = Date.now();

        await sendHitAlert({
          trade,
          hitType: inferredHit,
          hitTime: eventTimeMs,
          hitPrice: currentPrice,
        });

        await markRecentHit(inferredHitKey);

        console.log(`INFERRED HIT SENT: ${symbol} ${inferredHit} REF ${trade.refId}`);
        hitKeysToRemove.push(key);
      }

      for (const key of hitKeysToRemove) {
        await removeTrade(key);
      }
    }

    // ===== NORMAL SIGNAL ALERT =====
    const isSignal = isLikelySignalEvent(eventType, side, entryParsed);

    if (!isSignal || !symbol || (side !== "LONG" && side !== "SHORT")) {
      console.log("NON-SIGNAL WEBHOOK RECEIVED:", {
        symbol,
        side,
        eventType,
      });
      return;
    }

    const validLevels = hasValidTradeLevels(side, entryParsed, tpParsed, slParsed);

    if (validLevels) {
      const tradeKey = buildTradeKey(symbol, side, refId);

      await upsertTrade(tradeKey, {
        tradeKey,
        refId,
        symbol,
        side,
        entry: entryParsed,
        tp: tpParsed,
        sl: slParsed,
        createdAtMs: eventTimeMs,
        hit: false,
        hitType: null,
        hitAtMs: null,
        alertIds: candidateIds,
        setupType,
        strength,
        rr,
      });
    }

    const { line1, line2 } = buildReasonEngine({
      symbol,
      side,
      rsi,
      atrPct,
      eventTime,
      setupType,
      strength,
    });

    const text = `🚨 ALERT #${refId}

PAIR: ${symbol}
DIRECTION: ${side}

ENTRY: ${fmtPrice(entryParsed)}
TP: ${fmtPrice(tpParsed)} (${fmtPct(tpPct)})
SL: ${fmtPrice(slParsed)} (${fmtPct(slPct)})
RR: ${fmtRR(rr)}

SETUP: ${setupType}
STRENGTH: ${strength}

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
      entry: fmtPrice(entryParsed),
      tp: fmtPrice(tpParsed),
      sl: fmtPrice(slParsed),
      tpPct: fmtPct(tpPct),
      slPct: fmtPct(slPct),
      rr: fmtRR(rr),
      time: prettyTime,
      refId,
      imageUsed: Boolean(CHART_IMAGES[symbol]),
      storedForHits: validLevels,
      activeTrades: activeTrades.size,
      eventType,
      candidateIds,
      setupType,
      strength,
      usedDynamicLevels: !validIncomingLevels && validLevels,
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
  await loadState();

  app.listen(PORT, () => {
    console.log(`ALRT-Render running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("STARTUP ERROR:", err);
  process.exit(1);
});
