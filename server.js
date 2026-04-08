import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";
import { chromium } from "playwright";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Zet dit in Render op je eigen service URL, bijvoorbeeld:
// https://alrt-render.onrender.com
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");

// Optional:
// CHART_IMAGE_TEMPLATE=https://your-domain.com/charts/{symbol}.png
const CHART_IMAGE_TEMPLATE = process.env.CHART_IMAGE_TEMPLATE || "";

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

let nextRef = 100000;
let savePromise = Promise.resolve();

app.use(express.json({ limit: "2mb" }));

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
const CHART_IMAGES = {
  // BTCUSDT: "https://your-domain.com/charts/BTCUSDT.png",
  // ETHUSDT: "https://your-domain.com/charts/ETHUSDT.png",
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

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map((v) => String(v).trim()).filter(Boolean))];
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

function fmtPct(v, { signed = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "N/A";
  if (signed && n > 0) return `+${n.toFixed(2)}%`;
  if (signed && n < 0) return `${n.toFixed(2)}%`;
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
    .replace("BINANCE:", "")
    .replace("/", "");
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toTvSymbol(symbol) {
  const clean = normalizeSymbol(symbol);
  if (!clean) return "BINANCE:BTCUSDT";
  return `BINANCE:${clean}`;
}

function getBaseUrl(req = null) {
  if (APP_BASE_URL) return APP_BASE_URL;
  if (req) {
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers["x-forwarded-host"] || req.get("host");
    if (host) return `${proto}://${host}`;
  }
  return "";
}

function buildLocalChartImageUrl({ req = null, symbol, side, refId }) {
  const baseUrl = getBaseUrl(req);
  if (!baseUrl || !symbol) return null;

  const params = new URLSearchParams({
    symbol: toTvSymbol(symbol),
    side: String(side || "LONG"),
    ref: String(refId || ""),
    interval: "60",
  });

  return `${baseUrl}/chart-image?${params.toString()}`;
}

function stableHash(str) {
  let hash = 0;
  const input = String(str || "");
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) % 2147483647;
  }
  return hash;
}

function allocNextRef() {
  nextRef += 1;
  if (nextRef > 999999) nextRef = 100000;
  return String(nextRef).padStart(6, "0");
}

function parseIncomingRef(body) {
  const raw = pick(body.ref_id, body.ref, body.reference, body.alert_ref);
  if (!raw) return null;

  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 6) return digits;
  return null;
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

function tpPctFromLevels(side, entry, tp) {
  const e = parseNum(entry);
  const t = parseNum(tp);

  if (!Number.isFinite(e) || !Number.isFinite(t) || e <= 0) return null;

  if (side === "LONG") return ((t - e) / e) * 100;
  if (side === "SHORT") return ((e - t) / e) * 100;

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
      ? { tpPct: 2.8, slPct: 1.2 }
      : { tpPct: 3.0, slPct: 1.5 };
  }

  if (strength === "B") {
    return major
      ? { tpPct: 2.2, slPct: 1.1 }
      : { tpPct: 2.4, slPct: 1.35 };
  }

  return major
    ? { tpPct: 1.6, slPct: 1.0 }
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

function getRsiBucket(side, rsi) {
  const r = parseNum(rsi);
  if (!Number.isFinite(r)) return "UNKNOWN";

  if (side === "LONG") {
    if (r >= 70) return "HOT";
    if (r >= 60) return "STRONG";
    if (r >= 50) return "STEADY";
    if (r >= 40) return "EARLY";
    return "RECOVERY";
  }

  if (side === "SHORT") {
    if (r <= 30) return "HOT";
    if (r <= 40) return "STRONG";
    if (r <= 50) return "STEADY";
    if (r <= 60) return "EARLY";
    return "ROLLING";
  }

  return "UNKNOWN";
}

function getAtrBucket(atrPct) {
  const a = parseNum(atrPct);
  if (!Number.isFinite(a)) return "UNKNOWN";
  if (a <= 0.9) return "TIGHT";
  if (a <= 1.5) return "CONTROLLED";
  if (a <= 2.6) return "NORMAL";
  return "EXPANDED";
}

function chooseVariant(seed, variants) {
  if (!Array.isArray(variants) || variants.length === 0) return "";
  const index = stableHash(seed) % variants.length;
  return variants[index];
}

function getWhyBank() {
  return {
    COMPRESSION: {
      LONG: {
        TIGHT: [
          "Compression is tight and buyers still hold control.",
          "Price is coiled for a cleaner bullish release.",
          "Tight structure supports an upside expansion.",
          "Volatility is compressed and favors a push higher.",
          "Setup stays compact with bullish pressure intact."
        ],
        CONTROLLED: [
          "The structure stays compact with bullish pressure intact.",
          "Controlled volatility supports a cleaner move higher.",
          "Buyers keep the edge inside a tight structure.",
          "The setup remains orderly for upside continuation.",
          "Compression still leaves room for extension higher."
        ],
        NORMAL: [
          "The structure remains constructive for upside continuation.",
          "Price still holds a compact bullish profile.",
          "Volatility remains stable enough for continuation higher.",
          "The setup keeps a bullish bias despite broader candles.",
          "Momentum still supports a measured upside expansion."
        ],
        EXPANDED: [
          "Momentum remains supportive as price expands higher.",
          "The bullish bias holds even as volatility widens.",
          "Expansion is active, but buyers still control the move.",
          "The structure is less tight, yet still constructive.",
          "Price is opening up, but the upside case remains valid."
        ],
      },
      SHORT: {
        TIGHT: [
          "Compression is tight and sellers still hold control.",
          "Price is coiled for a cleaner bearish release.",
          "Tight structure supports a downside expansion.",
          "Volatility is compressed and favors a push lower.",
          "Setup stays compact with bearish pressure intact."
        ],
        CONTROLLED: [
          "The structure stays compact while downside pressure stays active.",
          "Controlled volatility supports a cleaner move lower.",
          "Sellers keep the edge inside a tight structure.",
          "The setup remains orderly for downside continuation.",
          "Compression still leaves room for extension lower."
        ],
        NORMAL: [
          "The structure remains weak enough for downside continuation.",
          "Price still holds a compact bearish profile.",
          "Volatility remains stable enough for continuation lower.",
          "The setup keeps a bearish bias despite broader candles.",
          "Momentum still supports a measured downside expansion."
        ],
        EXPANDED: [
          "Momentum remains supportive as price expands lower.",
          "The bearish bias holds even as volatility widens.",
          "Expansion is active, but sellers still control the move.",
          "The structure is less tight, yet still weak.",
          "Price is opening up, but the downside case remains valid."
        ],
      },
    },
    PULLBACK: {
      LONG: {
        RECOVERY: [
          "The retrace is stabilizing and buyers are stepping back in.",
          "Price is recovering cleanly from a controlled dip.",
          "This pullback still looks constructive for continuation.",
          "Buyers are absorbing the retrace without structural damage.",
          "The dip remains healthy inside a bullish setup."
        ],
        EARLY: [
          "The retrace remains controlled and trend structure is intact.",
          "Buyers are defending the pullback zone cleanly.",
          "This still looks like a healthy reset inside the trend.",
          "The market is retracing without losing bullish shape.",
          "Price remains constructive after a controlled dip."
        ],
        STEADY: [
          "Momentum stays steady through the pullback.",
          "The retrace remains orderly and trend-friendly.",
          "Buyers still control the broader structure.",
          "This pullback fits continuation rather than breakdown.",
          "The setup stays aligned with the bullish trend."
        ],
        STRONG: [
          "Buy-side pressure remains firm after the retrace.",
          "The pullback is shallow relative to the trend strength.",
          "Momentum still favors continuation higher.",
          "The dip has not weakened the bullish structure.",
          "The trend remains strong despite the temporary reset."
        ],
        HOT: [
          "Bullish momentum remains dominant through the retrace.",
          "The market still treats the dip as a continuation zone.",
          "The setup remains strong with buyers in control.",
          "The pullback has not dented momentum.",
          "This still behaves like a high-pressure continuation setup."
        ],
      },
      SHORT: {
        ROLLING: [
          "The bounce is stalling and sellers are leaning back in.",
          "The recovery still looks corrective rather than bullish.",
          "This rebound remains vulnerable to renewed selling.",
          "The bounce has not repaired the bearish structure.",
          "Sellers are reclaiming control after a weak rebound."
        ],
        EARLY: [
          "The bounce remains contained inside a weak structure.",
          "Sellers are defending the rebound area cleanly.",
          "This still looks like a controlled reset lower.",
          "The market is bouncing without repairing the trend.",
          "Price remains weak after a limited rebound."
        ],
        STEADY: [
          "Momentum stays steady through the rebound.",
          "The bounce remains orderly but still bearish overall.",
          "Sellers still control the broader structure.",
          "This rebound fits continuation rather than reversal.",
          "The setup stays aligned with the downside trend."
        ],
        STRONG: [
          "Sell-side pressure remains firm after the rebound.",
          "The bounce is shallow relative to the downside strength.",
          "Momentum still favors continuation lower.",
          "The rebound has not repaired the bearish structure.",
          "The trend remains strong despite the temporary reset."
        ],
        HOT: [
          "Bearish momentum remains dominant through the rebound.",
          "The market still treats the bounce as a selling zone.",
          "The setup remains weak with sellers in control.",
          "The rebound has not dented downside momentum.",
          "This still behaves like a high-pressure continuation setup."
        ],
      },
    },
    TREND: {
      LONG: {
        HOT: [
          "The 60M trend remains strong with buyers in control.",
          "Momentum continues to support bullish continuation.",
          "The broader structure still favors another leg higher.",
          "Trend pressure remains constructive on this setup.",
          "Buyers continue to control the pace on 60M."
        ],
        STRONG: [
          "The trend stays healthy and continuation remains valid.",
          "Price structure continues to support upside flow.",
          "The broader move still leans bullish.",
          "This setup remains aligned with trend continuation.",
          "Bullish structure remains intact on 60M."
        ],
        STEADY: [
          "The trend remains intact and constructive.",
          "Price still behaves cleanly inside the trend.",
          "Continuation remains favored while structure holds.",
          "The market keeps a stable bullish profile.",
          "The broader flow remains supportive."
        ],
        EARLY: [
          "The trend is rebuilding and improving step by step.",
          "Price continues to recover into a stronger structure.",
          "This setup is early, but constructive.",
          "Bullish trend behavior is starting to rebuild.",
          "The market is slowly restoring a bullish profile."
        ],
        RECOVERY: [
          "Recovery conditions continue to improve.",
          "The market is rotating from weakness into strength.",
          "This setup leans constructive as recovery builds.",
          "Buyers are rebuilding structure after earlier weakness.",
          "Recovery is in progress and still supportive."
        ],
      },
      SHORT: {
        HOT: [
          "The 60M trend remains strong with sellers in control.",
          "Momentum continues to support bearish continuation.",
          "The broader structure still favors another leg lower.",
          "Trend pressure remains weak on this setup.",
          "Sellers continue to control the pace on 60M."
        ],
        STRONG: [
          "The trend stays healthy for sellers and continuation remains valid.",
          "Price structure continues to support downside flow.",
          "The broader move still leans bearish.",
          "This setup remains aligned with trend continuation.",
          "Bearish structure remains intact on 60M."
        ],
        STEADY: [
          "The trend remains intact and bearish.",
          "Price still behaves weakly inside the trend.",
          "Continuation remains favored while structure holds.",
          "The market keeps a stable bearish profile.",
          "The broader flow remains supportive for downside."
        ],
        EARLY: [
          "The trend is rebuilding lower and weakness is increasing.",
          "Price continues to roll into a softer structure.",
          "This setup is early, but still weak.",
          "Bearish trend behavior is starting to rebuild.",
          "The market is slowly restoring a bearish profile."
        ],
        ROLLING: [
          "Weakness is returning after a brief pause.",
          "The market is rotating back into downside pressure.",
          "This setup still leans weak as sellers re-engage.",
          "Bearish structure is rebuilding after stabilization.",
          "The downside case improves as price rolls over."
        ],
      },
    },
    BREAKOUT: {
      LONG: {
        DEFAULT: [
          "Price is pressing into breakout territory.",
          "Buyers are leaning on resistance with momentum.",
          "Breakout pressure remains active on this setup.",
          "The market is testing for upside release.",
          "The setup still favors a bullish break."
        ],
      },
      SHORT: {
        DEFAULT: [
          "Price is pressing into breakdown territory.",
          "Sellers are leaning on support with momentum.",
          "Breakdown pressure remains active on this setup.",
          "The market is testing for downside release.",
          "The setup still favors a bearish break."
        ],
      },
    },
    REVERSAL: {
      LONG: {
        DEFAULT: [
          "The setup suggests an early bullish reversal attempt.",
          "Buyers are trying to reclaim structure from weakness.",
          "This looks more like reversal than continuation.",
          "The market is attempting to turn from a softer zone.",
          "Bullish recovery pressure is starting to build."
        ],
      },
      SHORT: {
        DEFAULT: [
          "The setup suggests an early bearish reversal attempt.",
          "Sellers are trying to reclaim control from strength.",
          "This looks more like reversal than continuation.",
          "The market is attempting to turn from an extended zone.",
          "Bearish recovery pressure is starting to build."
        ],
      },
    },
    MOMENTUM: {
      LONG: {
        DEFAULT: [
          "Momentum remains active and supports continuation higher.",
          "Buy-side acceleration still favors the move.",
          "The move is being driven by active bullish pressure.",
          "Momentum remains supportive for further upside.",
          "The setup still carries bullish speed."
        ],
      },
      SHORT: {
        DEFAULT: [
          "Momentum remains active and supports continuation lower.",
          "Sell-side acceleration still favors the move.",
          "The move is being driven by active bearish pressure.",
          "Momentum remains supportive for further downside.",
          "The setup still carries bearish speed."
        ],
      },
    },
  };
}

function buildWhyLine({ symbol, side, setupType, strength, rsi, atrPct, eventTime, refId }) {
  const rsiBucket = getRsiBucket(side, rsi);
  const atrBucket = getAtrBucket(atrPct);
  const majorTag = isMajorSymbol(symbol) ? "MAJOR" : "ALT";
  const seedBase = `${symbol}|${side}|${setupType}|${strength}|${rsiBucket}|${atrBucket}|${majorTag}|${eventTime}|${refId}`;

  const reasons = getWhyBank();
  const setupBlock = reasons[setupType] || {};
  const sideBlock = setupBlock[side] || {};
  const bucketList =
    sideBlock[atrBucket] ||
    sideBlock[rsiBucket] ||
    sideBlock.DEFAULT ||
    [
      side === "LONG"
        ? "Structure remains constructive for this long setup."
        : "Structure remains supportive for this short setup."
    ];

  return chooseVariant(seedBase, bucketList);
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
    normalized.includes("takeprofit_hit") ||
    normalized === "tp" ||
    rawText.includes('"event":"tp_hit"') ||
    rawText.includes('"type":"tp_hit"') ||
    rawText.includes('"event_type":"tp_hit"') ||
    rawText.includes('"hit_type":"tp"') ||
    rawText.includes("take_profit_hit") ||
    rawText.includes("tp hit")
  ) {
    return "TP";
  }

  if (
    normalized.includes("sl_hit") ||
    normalized.includes("stop_loss_hit") ||
    normalized.includes("stoploss_hit") ||
    normalized === "sl" ||
    rawText.includes('"event":"sl_hit"') ||
    rawText.includes('"type":"sl_hit"') ||
    rawText.includes('"event_type":"sl_hit"') ||
    rawText.includes('"hit_type":"sl"') ||
    rawText.includes("stop_loss_hit") ||
    rawText.includes("sl hit")
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

function collectRawCandidateIds(body) {
  return uniqueStrings([
    pick(body.alert_id),
    pick(body.source_alert_id),
    pick(body.signal_alert_id),
    pick(body.parent_alert_id),
    pick(body.strategy_order_id),
    pick(body.order_id),
    pick(body.id),
    pick(body.ref_id),
  ]);
}

function buildSyntheticIds({ symbol, side, eventTimeMs, refId }) {
  const ms = Number.isFinite(eventTimeMs) ? String(eventTimeMs) : "";
  const sec = Number.isFinite(eventTimeMs) ? String(Math.floor(eventTimeMs / 1000)) : "";

  return uniqueStrings([
    refId ? String(refId) : null,
    symbol && side && ms ? `${symbol}-${side}-${ms}` : null,
    symbol && side && sec ? `${symbol}-${side}-${sec}` : null,
  ]);
}

function collectAllCandidateIds({ body, symbol, side, eventTimeMs, refId }) {
  return uniqueStrings([
    ...collectRawCandidateIds(body),
    ...buildSyntheticIds({ symbol, side, eventTimeMs, refId }),
  ]);
}

function buildRecentHitKey({ symbol, hitType, refId, eventTime }) {
  return `${symbol}|${hitType}|${refId}|${String(eventTime || "")}`;
}

function wasRecentHitSent(hitKey) {
  return recentHitKeys.has(hitKey);
}

async function markRecentHit(hitKey) {
  recentHitKeys.set(hitKey, Date.now());
  await persistState();
}

function findTradeByRefId(refId) {
  if (!refId) return null;

  for (const [key, trade] of activeTrades.entries()) {
    if (trade.hit) continue;
    if (String(trade.refId) === String(refId)) {
      return { key, trade, matchType: "ref_id", score: 2000 };
    }
  }

  return null;
}

function findOpenTradeByCandidateIds(ids) {
  const wanted = uniqueStrings(ids);
  if (wanted.length === 0) return null;

  for (const [key, trade] of activeTrades.entries()) {
    if (trade.hit) continue;

    const tradeIds = uniqueStrings(Array.isArray(trade.alertIds) ? trade.alertIds : []);
    const matched = tradeIds.some((id) => wanted.includes(id));

    if (matched) {
      return { key, trade, matchType: "candidate_id", score: 1000 };
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
      latest = { key, trade, matchType: "symbol_side_latest", score: 700 };
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
      latest = { key, trade, matchType: "symbol_latest", score: 500 };
    }
  }

  return latest;
}

function findNearestOpenTradeBySymbolTime(symbol, hitTimeMs, side = "N/A") {
  let nearest = null;

  for (const [key, trade] of activeTrades.entries()) {
    if (trade.symbol !== symbol) continue;
    if (trade.hit) continue;
    if (side !== "N/A" && trade.side !== side) continue;

    const diff = Math.abs((trade.createdAtMs || 0) - hitTimeMs);

    if (!nearest || diff < nearest.diff) {
      nearest = {
        key,
        trade,
        diff,
        matchType: "symbol_time_nearest",
        score: 600 - Math.min(599, Math.floor(diff / 60000)),
      };
    }
  }

  return nearest;
}

function levelDistancePct(expected, actual) {
  const e = parseNum(expected);
  const a = parseNum(actual);

  if (!Number.isFinite(e) || !Number.isFinite(a) || e <= 0) return null;
  return Math.abs((a - e) / e) * 100;
}

function findBestOpenTradeByHitPrice(symbol, side, hitType, currentPrice, eventTimeMs) {
  if (!Number.isFinite(currentPrice)) return null;

  let best = null;

  for (const [key, trade] of activeTrades.entries()) {
    if (trade.symbol !== symbol) continue;
    if (trade.hit) continue;
    if (side !== "N/A" && trade.side !== side) continue;

    const expected = hitType === "TP" ? trade.tp : trade.sl;
    const distPct = levelDistancePct(expected, currentPrice);
    if (!Number.isFinite(distPct)) continue;

    const timeDiff = Math.abs((trade.createdAtMs || 0) - eventTimeMs);
    const score = 800 - Math.min(600, Math.floor(distPct * 100)) - Math.min(180, Math.floor(timeDiff / 60000));

    if (!best || score > best.score) {
      best = {
        key,
        trade,
        distPct,
        timeDiff,
        matchType: "price_proximity",
        score,
      };
    }
  }

  return best;
}

function getOpenTradesForSymbol(symbol) {
  const items = [];

  for (const [, trade] of activeTrades.entries()) {
    if (trade.symbol !== symbol) continue;
    if (trade.hit) continue;

    items.push({
      refId: trade.refId,
      symbol: trade.symbol,
      side: trade.side,
      entry: trade.entry,
      tp: trade.tp,
      sl: trade.sl,
      createdAtMs: trade.createdAtMs,
      createdAtUtc: formatUtc(trade.createdAtMs),
      alertIds: uniqueStrings(trade.alertIds || []),
    });
  }

  items.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  return items;
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

function resolveChartLink(symbol) {
  return CHARTS[symbol] || "N/A";
}

function looksLikeDirectImageUrl(url) {
  const value = String(url || "").trim();
  if (!/^https?:\/\//i.test(value)) return false;
  if (/\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(value)) return true;
  if (value.includes("/image")) return true;
  if (value.includes("/images/")) return true;
  if (value.includes("chart-image")) return true;
  if (value.includes("snapshot")) return true;
  return false;
}

function resolveChartImageUrl(body, symbol, side = "LONG", refId = "", req = null) {
  const inline = pick(
    body.chart_image_url,
    body.image_url,
    body.snapshot_url,
    body.chart_snapshot,
    body.chart_image,
    body.image,
    body.photo
  );

  if (inline && looksLikeDirectImageUrl(inline)) {
    return String(inline).trim();
  }

  const mapped = CHART_IMAGES[symbol];
  if (mapped && looksLikeDirectImageUrl(mapped)) {
    return String(mapped).trim();
  }

  if (CHART_IMAGE_TEMPLATE && CHART_IMAGE_TEMPLATE.includes("{symbol}")) {
    const built = CHART_IMAGE_TEMPLATE.replace("{symbol}", symbol);
    if (looksLikeDirectImageUrl(built)) {
      return built;
    }
  }

  return buildLocalChartImageUrl({
    req,
    symbol,
    side,
    refId,
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}

function formatChartHtml(chartLink) {
  if (!chartLink || chartLink === "N/A") return "N/A";
  if (!/^https?:\/\//i.test(String(chartLink))) return escapeHtml(chartLink);
  return `<a href="${escapeAttr(chartLink)}">Open chart</a>`;
}

function inferLeverage(symbol, strength) {
  if (strength === "A+" || strength === "A") {
    return isMajorSymbol(symbol) ? "5x" : "4x";
  }
  if (strength === "B") {
    return isMajorSymbol(symbol) ? "4x" : "3x";
  }
  return isMajorSymbol(symbol) ? "3x" : "2x";
}

function resolveLeverage(body, symbol, strength) {
  const raw = pick(
    body.leverage,
    body.lev,
    body.suggested_leverage,
    body.recommended_leverage
  );

  if (raw) {
    const txt = String(raw).trim().toLowerCase().replace(/\s+/g, "");
    if (/^\d+(\.\d+)?x$/.test(txt)) return txt.toUpperCase();
    if (/^\d+(\.\d+)?$/.test(txt)) return `${txt}x`;
    return String(raw).trim();
  }

  return inferLeverage(symbol, strength);
}

function buildAlertText({
  symbol,
  side,
  entry,
  tp,
  sl,
  rr,
  leverage,
  prettyTime,
  whyLine,
  chartLink,
  showChartLink,
  refId,
  tpPct,
}) {
  return `🚨 <b>ALERT • ${escapeHtml(symbol)}</b>
<b>REF</b> ${escapeHtml(refId)}

<b>DIRECTION</b> ${escapeHtml(side)}
<b>ENTRY</b> ${escapeHtml(fmtPrice(entry))}
<b>TP</b> ${escapeHtml(fmtPrice(tp))} (${escapeHtml(fmtPct(tpPct))})
<b>SL</b> ${escapeHtml(fmtPrice(sl))}
<b>RR</b> ${escapeHtml(fmtRR(rr))}
<b>LEVERAGE</b> ${escapeHtml(leverage)}

<b>TIMEFRAME</b> 60M
<b>UTC</b> ${escapeHtml(prettyTime)}

<b>WHY</b> ${escapeHtml(whyLine)}${showChartLink ? `

<b>CHART</b> ${formatChartHtml(chartLink)}` : ""}

NFA`;
}

function buildHitText({
  trade,
  hitType,
  hitTime,
  exitPrice,
  movePct,
  rr,
  chartLink,
  showChartLink,
}) {
  const icon = hitType === "TP" ? "🎯" : "🛑";
  const status = hitType === "TP" ? "TP HIT" : "SL HIT";

  return `${icon} <b>HIT • ${escapeHtml(trade.symbol)}</b>
<b>REF</b> ${escapeHtml(trade.refId)}

<b>STATUS</b> ${escapeHtml(status)}
<b>DIRECTION</b> ${escapeHtml(trade.side)}
<b>ENTRY</b> ${escapeHtml(fmtPrice(trade.entry))}
<b>EXIT</b> ${escapeHtml(fmtPrice(exitPrice))}
<b>TP</b> ${escapeHtml(fmtPrice(trade.tp))}
<b>SL</b> ${escapeHtml(fmtPrice(trade.sl))}
<b>MOVE</b> ${escapeHtml(fmtPct(movePct, { signed: true }))}
<b>RR</b> ${escapeHtml(fmtRR(rr))}
<b>LEVERAGE</b> ${escapeHtml(trade.leverage || "N/A")}

<b>TIMEFRAME</b> 60M
<b>UTC</b> ${escapeHtml(formatUtc(hitTime))}${showChartLink ? `

<b>CHART</b> ${formatChartHtml(chartLink)}` : ""}

NFA`;
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function persistState() {
  savePromise = savePromise
    .then(async () => {
      await ensureDataDir();

      const payload = {
        updatedAt: new Date().toISOString(),
        nextRef,
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

    if (Number.isFinite(Number(parsed?.nextRef))) {
      nextRef = Math.max(100000, Math.min(999999, Number(parsed.nextRef)));
    }

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
    console.log(`Loaded nextRef ${nextRef}`);
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
async function sendTelegramMessage(text) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const data = await response.json();
  console.log("TELEGRAM MESSAGE RESPONSE:", data);

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendMessage failed: ${JSON.stringify(data)}`);
  }
}

async function sendTelegramPhoto(photoUrl, caption) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      photo: photoUrl,
      caption,
      parse_mode: "HTML",
    }),
  });

  const data = await response.json();
  console.log("TELEGRAM PHOTO RESPONSE:", data);

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendPhoto failed: ${JSON.stringify(data)}`);
  }
}

async function sendTelegramAlert({ text, imageUrl = null }) {
  if (imageUrl) {
    try {
      await sendTelegramPhoto(imageUrl, text);
      return { usedPhoto: true };
    } catch (err) {
      console.error("PHOTO SEND FAILED, FALLING BACK TO MESSAGE:", err.message);
    }
  }

  await sendTelegramMessage(text);
  return { usedPhoto: false };
}

async function sendHitAlert({ trade, hitType, hitTime, hitPrice = null }) {
  const exitPrice =
    hitType === "TP"
      ? trade.tp
      : hitType === "SL"
      ? trade.sl
      : hitPrice;

  const rr = rrFromLevels(trade.side, trade.entry, trade.tp, trade.sl);
  const movePct = pctMove(trade.side, trade.entry, exitPrice);
  const chartLink = trade.chartLink || resolveChartLink(trade.symbol);
  const imageUrl = trade.chartImageUrl || null;
  const showChartLink = !imageUrl;

  const hitText = buildHitText({
    trade,
    hitType,
    hitTime,
    exitPrice,
    movePct,
    rr,
    chartLink,
    showChartLink,
  });

  await sendTelegramAlert({
    text: hitText,
    imageUrl,
  });
}

app.get("/chart-template", async (req, res) => {
  try {
    const templatePath = path.join(__dirname, "chart-template.html");
    const html = await fs.readFile(templatePath, "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (err) {
    console.error("CHART TEMPLATE ERROR:", err);
    res.status(500).send("chart template error");
  }
});

app.get("/chart-image", async (req, res) => {
  let browser;

  try {
    const symbol = String(req.query.symbol || "BINANCE:BTCUSDT");
    const side = String(req.query.side || "LONG").toUpperCase();
    const ref = String(req.query.ref || "");
    const interval = String(req.query.interval || "60");

    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>ALRT Chart</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: #0b1220;
      width: 1280px;
      height: 720px;
      overflow: hidden;
      font-family: Arial, sans-serif;
    }
    #wrap {
      width: 1280px;
      height: 720px;
      position: relative;
      background: #0b1220;
    }
    #tv_chart_container {
      width: 1280px;
      height: 720px;
    }
    .badge {
      position: absolute;
      top: 14px;
      left: 14px;
      z-index: 20;
      background: rgba(10, 14, 25, 0.88);
      color: white;
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.3px;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
    }
  </style>
</head>
<body>
  <div id="wrap">
    <div class="badge">${symbol} • ${side}${ref ? ` • REF ${ref}` : ""}</div>
    <div id="tv_chart_container"></div>
  </div>

  <script src="https://s3.tradingview.com/tv.js"></script>
  <script>
    function startWidget() {
      if (!window.TradingView) {
        setTimeout(startWidget, 300);
        return;
      }

      new TradingView.widget({
        autosize: false,
        width: 1280,
        height: 720,
        symbol: ${JSON.stringify(symbol)},
        interval: ${JSON.stringify(interval)},
        timezone: "Etc/UTC",
        theme: "dark",
        style: "1",
        locale: "en",
        hide_top_toolbar: false,
        hide_legend: false,
        allow_symbol_change: false,
        save_image: false,
        studies: [],
        container_id: "tv_chart_container"
      });
    }

    startWidget();
  </script>
</body>
</html>
    `;

    await page.setContent(html, {
      waitUntil: "load",
      timeout: 60000,
    });

    await sleep(6000);

    const png = await page.screenshot({
      type: "png",
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=120");
    res.status(200).send(png);
  } catch (err) {
    console.error("CHART IMAGE ERROR FULL:", err);
    res.status(500).send(`chart image error: ${err?.message || String(err)}`);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
});

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
    nextRef,
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
      pick(body.hit_price, body.last_price, body.market_price, body.price, body.close, body.last)
    );

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

    const leverage = resolveLeverage(body, symbol, strength);
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

    const validLevels = hasValidTradeLevels(side, entryParsed, tpParsed, slParsed);
    const rr = rrFromLevels(side, entryParsed, tpParsed, slParsed);
    const tpPct = tpPctFromLevels(side, entryParsed, tpParsed);

    const incomingRef = parseIncomingRef(body);
    const explicitHitType = detectExplicitHitType(eventType, body);

    const candidateIdsBase = collectAllCandidateIds({
      body,
      symbol,
      side,
      eventTimeMs,
      refId: incomingRef || "",
    });

    if (!BOT_TOKEN || !CHAT_ID) {
      console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
      return;
    }

    const chartLink = resolveChartLink(symbol);

    // ===== HANDLE EXPLICIT TP/SL HIT WEBHOOKS =====
    if (explicitHitType && symbol) {
      let matched =
        findTradeByRefId(incomingRef) ||
        findOpenTradeByCandidateIds(candidateIdsBase) ||
        findBestOpenTradeByHitPrice(symbol, side, explicitHitType, currentPrice, eventTimeMs) ||
        findLatestOpenTradeBySymbolAndSide(symbol, side) ||
        findNearestOpenTradeBySymbolTime(symbol, eventTimeMs, side) ||
        findLatestOpenTradeBySymbol(symbol);

      if (matched) {
        const hitKey = buildRecentHitKey({
          symbol,
          hitType: explicitHitType,
          refId: matched.trade.refId,
          eventTime,
        });

        if (wasRecentHitSent(hitKey)) {
          console.log("DUPLICATE HIT IGNORED:", {
            symbol,
            explicitHitType,
            refId: matched.trade.refId,
            eventTime,
          });
          return;
        }

        matched.trade.hit = true;
        matched.trade.hitType = explicitHitType;
        matched.trade.hitAtMs = Date.now();

        await sendHitAlert({
          trade: matched.trade,
          hitType: explicitHitType,
          hitTime: eventTimeMs,
          hitPrice: currentPrice,
        });

        await markRecentHit(hitKey);

        console.log(`EXPLICIT HIT SENT (${matched.matchType}): ${symbol} ${explicitHitType} REF ${matched.trade.refId}`, {
          incomingRef,
          tradeRef: matched.trade.refId,
          incomingIds: candidateIdsBase,
          tradeIds: uniqueStrings(matched.trade.alertIds || []),
          hitTimeUtc: formatUtc(eventTimeMs),
          tradeTimeUtc: formatUtc(matched.trade.createdAtMs),
          currentPrice,
        });

        await removeTrade(matched.key);
        return;
      }

      console.log("EXPLICIT HIT RECEIVED BUT NO MATCHED TRADE FOUND - NOT SENT TO TELEGRAM:", {
        symbol,
        explicitHitType,
        incomingSide: side,
        incomingRef,
        candidateIds: candidateIdsBase,
        eventTime,
        eventTimeUtc: formatUtc(eventTimeMs),
        currentPrice,
        openTradesForSymbol: getOpenTradesForSymbol(symbol),
        totalActiveTrades: activeTrades.size,
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

        console.log(`INFERRED HIT SENT: ${symbol} ${inferredHit} REF ${trade.refId}`, {
          currentPrice,
          tp: trade.tp,
          sl: trade.sl,
          side: trade.side,
        });

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

    if (!validLevels) {
      console.log("SIGNAL RECEIVED BUT LEVELS INVALID - ALERT STILL SENT, TRADE NOT STORED:", {
        symbol,
        side,
        entry: entryParsed,
        tp: tpParsed,
        sl: slParsed,
        eventType,
        eventTime: prettyTime,
      });
    }

    const refId = incomingRef || allocNextRef();

    const candidateIds = uniqueStrings([
      ...candidateIdsBase,
      refId,
    ]);

    const finalChartImageUrl = resolveChartImageUrl(body, symbol, side, refId, req);

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
        leverage,
        createdAtMs: eventTimeMs,
        hit: false,
        hitType: null,
        hitAtMs: null,
        alertIds: candidateIds,
        setupType,
        strength,
        rr,
        chartLink,
        chartImageUrl: finalChartImageUrl,
      });
    } else {
      await persistState();
    }

    const whyLine = buildWhyLine({
      symbol,
      side,
      setupType,
      strength,
      rsi,
      atrPct,
      eventTime,
      refId,
    });

    const showChartLink = !finalChartImageUrl;

    const text = buildAlertText({
      symbol,
      side,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      rr,
      leverage,
      prettyTime,
      whyLine,
      chartLink,
      showChartLink,
      refId,
      tpPct,
    });

    const sendResult = await sendTelegramAlert({
      text,
      imageUrl: finalChartImageUrl,
    });

    console.log(`ALERT SENT: ${symbol} ${side} REF ${refId}`);
    console.log("ALERT DATA:", {
      symbol,
      side,
      entry: fmtPrice(entryParsed),
      tp: fmtPrice(tpParsed),
      sl: fmtPrice(slParsed),
      tpPct: fmtPct(tpPct),
      rr: fmtRR(rr),
      leverage,
      time: prettyTime,
      refId,
      imageUsed: sendResult.usedPhoto,
      chartImageUrl: finalChartImageUrl,
      chartLink,
      storedForHits: validLevels,
      activeTrades: activeTrades.size,
      eventType,
      candidateIds,
      setupType,
      strength,
      usedDynamicLevels: !validIncomingLevels && validLevels,
      whyLine,
      nextRef,
    });

    if (!finalChartImageUrl) {
      console.log("NO DIRECT CHART IMAGE URL AVAILABLE FOR THIS ALERT:", {
        symbol,
        refId,
        chartLink,
        note: "Telegram can only show a chart image if it receives a real direct image URL like snapshot_url/chart_image_url or a mapped CHART_IMAGE_TEMPLATE/CHART_IMAGES URL.",
      });
    }
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
