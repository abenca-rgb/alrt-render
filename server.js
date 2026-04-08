import express from "express";
import dotenv from "dotenv";
import fetch, { FormData, Blob } from "node-fetch";
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
      if (numericRsi >= 60 && numericAtr <= 2.8) return "A+";
      if (numericRsi >= 56 && numericAtr <= 3.2) return "A";
      if (numericRsi >= 50) return "B";
      return "C";
    }
  }

  if (side === "SHORT") {
    if (Number.isFinite(numericRsi)) {
      if (numericRsi <= 40 && numericAtr <= 2.8) return "A+";
      if (numericRsi <= 44 && numericAtr <= 3.2) return "A";
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
      ? { tpPct: 3.6, slPct: 1.2 }
      : { tpPct: 4.2, slPct: 1.5 };
  }

  if (strength === "A") {
    return major
      ? { tpPct: 3.1, slPct: 1.2 }
      : { tpPct: 3.5, slPct: 1.45 };
  }

  if (strength === "B") {
    return major
      ? { tpPct: 2.4, slPct: 1.1 }
      : { tpPct: 2.8, slPct: 1.35 };
  }

  return major
    ? { tpPct: 1.7, slPct: 1.0 }
    : { tpPct: 1.9, slPct: 1.2 };
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

function getStrengthText(strength) {
  if (!strength) return "N/A";
  return strength;
}

function getWhyLeadPhrases({ setupType, side, atrBucket, rsiBucket }) {
  const bank = {
    COMPRESSION: {
      LONG: [
        "Compression break starting to release higher",
        "Tight range beginning to expand to the upside",
        "Buyers pushing out of a compact range",
        "Range compression breaking with upside pressure",
      ],
      SHORT: [
        "Compression break starting to release lower",
        "Tight range beginning to expand to the downside",
        "Sellers pushing out of a compact range",
        "Range compression breaking with downside pressure",
      ],
    },
    PULLBACK: {
      LONG: [
        "Controlled pullback holding inside the uptrend",
        "Bullish reset finding support after the dip",
        "Pullback continuation forming above support",
        "Higher-low pullback structure staying intact",
      ],
      SHORT: [
        "Weak rebound stalling inside the downtrend",
        "Bearish reset failing near resistance",
        "Pullback continuation forming below resistance",
        "Lower-high rebound structure staying weak",
      ],
    },
    TREND: {
      LONG: [
        "1H trend continuation still holding cleanly",
        "Higher-low structure keeping the trend intact",
        "Buyers maintaining control inside the trend",
        "Trend continuation staying constructive on 1H",
      ],
      SHORT: [
        "1H trend continuation still holding lower",
        "Lower-high structure keeping the trend intact",
        "Sellers maintaining control inside the trend",
        "Trend continuation staying bearish on 1H",
      ],
    },
    BREAKOUT: {
      LONG: [
        "Break above local resistance is holding",
        "Upside breakout is starting to confirm",
        "Buyers are forcing a break through resistance",
        "Resistance break is opening room higher",
      ],
      SHORT: [
        "Break below local support is holding",
        "Downside breakout is starting to confirm",
        "Sellers are forcing a break through support",
        "Support break is opening room lower",
      ],
    },
    REVERSAL: {
      LONG: [
        "Bullish reversal attempt is gaining structure",
        "Failed downside pressure is turning into a reclaim",
        "Buyers are trying to reclaim control from weakness",
        "Reversal structure is forming after the flush",
      ],
      SHORT: [
        "Bearish reversal attempt is gaining structure",
        "Failed upside pressure is turning into a rollover",
        "Sellers are trying to reclaim control from strength",
        "Reversal structure is forming after the squeeze",
      ],
    },
    MOMENTUM: {
      LONG: [
        "Momentum continuation is still pressing higher",
        "Buy-side momentum is staying active on 1H",
        "Upside acceleration remains intact",
        "Momentum drive is supporting continuation higher",
      ],
      SHORT: [
        "Momentum continuation is still pressing lower",
        "Sell-side momentum is staying active on 1H",
        "Downside acceleration remains intact",
        "Momentum drive is supporting continuation lower",
      ],
    },
  };

  const setupBlock = bank[setupType] || bank.TREND;
  let phrases = setupBlock[side] || setupBlock.LONG || [];

  if (atrBucket === "TIGHT") {
    phrases = phrases.concat(
      side === "LONG"
        ? ["Tight structure is starting to open higher"]
        : ["Tight structure is starting to open lower"]
    );
  }

  if (rsiBucket === "HOT" || rsiBucket === "STRONG") {
    phrases = phrases.concat(
      side === "LONG"
        ? ["Momentum-backed structure is pressing higher"]
        : ["Momentum-backed structure is pressing lower"]
    );
  }

  return phrases;
}

function getWhyContextPhrases({ setupType, side, strength, atrBucket, rsiBucket, symbol }) {
  const major = isMajorSymbol(symbol);

  const general = {
    LONG: [
      "with buyers defending structure",
      "while the 1H structure stays supportive",
      "with momentum still leaning upward",
      "while the move remains technically clean",
    ],
    SHORT: [
      "with sellers defending structure",
      "while the 1H structure stays weak",
      "with momentum still leaning downward",
      "while the move remains technically clean",
    ],
  };

  const setupSpecific = {
    COMPRESSION: {
      LONG: [
        "as the range starts to expand",
        "with the squeeze beginning to release",
        "as buyers hold the edge after compression",
      ],
      SHORT: [
        "as the range starts to expand lower",
        "with the squeeze beginning to release downward",
        "as sellers hold the edge after compression",
      ],
    },
    PULLBACK: {
      LONG: [
        "after a controlled retrace into support",
        "with the reset staying shallow",
        "after buyers absorbed the pullback cleanly",
      ],
      SHORT: [
        "after a weak rebound into resistance",
        "with the reset staying corrective",
        "after sellers absorbed the bounce cleanly",
      ],
    },
    TREND: {
      LONG: [
        "while higher-low structure remains intact",
        "with trend pressure still constructive",
        "as continuation conditions stay aligned",
      ],
      SHORT: [
        "while lower-high structure remains intact",
        "with trend pressure still bearish",
        "as continuation conditions stay aligned",
      ],
    },
    BREAKOUT: {
      LONG: [
        "if price keeps holding above the break zone",
        "with breakout structure starting to confirm",
        "as buyers keep control after the push through resistance",
      ],
      SHORT: [
        "if price keeps holding below the break zone",
        "with breakdown structure starting to confirm",
        "as sellers keep control after the push through support",
      ],
    },
    REVERSAL: {
      LONG: [
        "as the failed downside move starts to reverse",
        "with reclaim pressure starting to build",
        "if buyers keep recovering lost structure",
      ],
      SHORT: [
        "as the failed upside move starts to reverse",
        "with rollover pressure starting to build",
        "if sellers keep reclaiming lost structure",
      ],
    },
    MOMENTUM: {
      LONG: [
        "while upside pressure remains active",
        "with buyers still carrying the move",
        "as momentum stays strong through the structure",
      ],
      SHORT: [
        "while downside pressure remains active",
        "with sellers still carrying the move",
        "as momentum stays strong through the structure",
      ],
    },
  };

  let phrases = [
    ...(setupSpecific[setupType]?.[side] || []),
    ...(general[side] || []),
  ];

  if (strength === "A+" || strength === "A") {
    phrases = phrases.concat(
      side === "LONG"
        ? ["with above-average quality for continuation"]
        : ["with above-average quality for downside continuation"]
    );
  }

  if (atrBucket === "EXPANDED") {
    phrases = phrases.concat(
      side === "LONG"
        ? ["even with broader candles on the chart"]
        : ["even with broader candles on the chart"]
    );
  }

  if (atrBucket === "CONTROLLED" || atrBucket === "TIGHT") {
    phrases = phrases.concat(
      side === "LONG"
        ? ["inside a more controlled structure"]
        : ["inside a more controlled structure"]
    );
  }

  if (major && (rsiBucket === "STEADY" || rsiBucket === "STRONG")) {
    phrases = phrases.concat(
      side === "LONG"
        ? ["with majors-style trend stability behind it"]
        : ["with majors-style trend stability behind it"]
    );
  }

  return phrases;
}

function getWhyTailPhrases({ setupType, side, strength, rsiBucket }) {
  const base = {
    LONG: [
      "Upside continuation has room if the structure holds.",
      "The bullish case stays valid while momentum remains intact.",
      "Continuation is favored while buyers keep defending the move.",
      "The upside bias remains intact if this structure holds.",
    ],
    SHORT: [
      "Downside continuation has room if the structure holds.",
      "The bearish case stays valid while momentum remains intact.",
      "Continuation is favored while sellers keep defending the move.",
      "The downside bias remains intact if this structure holds.",
    ],
  };

  const setupTails = {
    BREAKOUT: {
      LONG: [
        "The breakout stays attractive if price keeps holding above the level.",
        "This opens upside room if the break keeps confirming.",
      ],
      SHORT: [
        "The breakdown stays attractive if price keeps holding below the level.",
        "This opens downside room if the break keeps confirming.",
      ],
    },
    REVERSAL: {
      LONG: [
        "The upside case improves if the reclaim keeps building.",
        "This reversal gains quality if buyers hold the recovery.",
      ],
      SHORT: [
        "The downside case improves if the rollover keeps building.",
        "This reversal gains quality if sellers hold the recovery lower.",
      ],
    },
    COMPRESSION: {
      LONG: [
        "Expansion potential improves if buyers keep the range break.",
        "This setup gets stronger if the squeeze continues to release higher.",
      ],
      SHORT: [
        "Expansion potential improves if sellers keep the range break.",
        "This setup gets stronger if the squeeze continues to release lower.",
      ],
    },
  };

  let phrases = [
    ...(setupTails[setupType]?.[side] || []),
    ...(base[side] || []),
  ];

  if (strength === "A+") {
    phrases = phrases.concat(
      side === "LONG"
        ? ["This is one of the cleaner long profiles when the follow-through appears."]
        : ["This is one of the cleaner short profiles when the follow-through appears."]
    );
  }

  if (rsiBucket === "HOT") {
    phrases = phrases.concat(
      side === "LONG"
        ? ["Momentum is already strong enough to support follow-through."]
        : ["Momentum is already strong enough to support follow-through."]
    );
  }

  return phrases;
}

function cleanSentence(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s+\./g, ".")
    .trim();
}

function ensurePeriod(text) {
  const t = cleanSentence(text);
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function buildWhyLine({ symbol, side, setupType, strength, rsi, atrPct, eventTime, refId }) {
  const rsiBucket = getRsiBucket(side, rsi);
  const atrBucket = getAtrBucket(atrPct);
  const seedBase = `${symbol}|${side}|${setupType}|${strength}|${rsiBucket}|${atrBucket}|${eventTime}|${refId}`;

  const lead = chooseVariant(
    `${seedBase}|lead`,
    getWhyLeadPhrases({ setupType, side, atrBucket, rsiBucket })
  );

  const context = chooseVariant(
    `${seedBase}|context`,
    getWhyContextPhrases({ setupType, side, strength, atrBucket, rsiBucket, symbol })
  );

  const tail = chooseVariant(
    `${seedBase}|tail`,
    getWhyTailPhrases({ setupType, side, strength, rsiBucket })
  );

  const finalWhy = `${ensurePeriod(lead)} ${ensurePeriod(context)} ${ensurePeriod(tail)}`.trim();
  return cleanSentence(finalWhy);
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

function isLocalChartImageUrl(url) {
  const value = String(url || "").trim();
  if (!value) return false;
  if (!value.includes("/chart-image")) return false;

  const baseUrl = getBaseUrl();
  if (baseUrl && value.startsWith(baseUrl)) return true;

  try {
    const parsed = new URL(value);
    return parsed.pathname === "/chart-image";
  } catch {
    return value.includes("/chart-image");
  }
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
  strength,
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
<b>STRENGTH</b> ${escapeHtml(getStrengthText(strength))}
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
<b>STRENGTH</b> ${escapeHtml(getStrengthText(trade.strength))}
<b>LEVERAGE</b> ${escapeHtml(trade.leverage || "N/A")}

<b>TIMEFRAME</b> 60M
<b>UTC</b> ${escapeHtml(formatUtc(hitTime))}${showChartLink ? `

<b>CHART</b> ${formatChartHtml(chartLink)}` : ""}

NFA`;
}

function appendChartLinkIfMissing(text, chartLink) {
  if (!chartLink || chartLink === "N/A") return text;
  if (String(text).includes("<b>CHART</b>")) return text;
  return `${text}

<b>CHART</b> ${formatChartHtml(chartLink)}`;
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

async function renderChartImagePngBuffer({
  symbol = "BINANCE:BTCUSDT",
  side = "LONG",
  ref = "",
  interval = "60",
}) {
  let browser;

  try {
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

    return png;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
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

async function sendTelegramPhoto({ photoUrl = null, photoBuffer = null, filename = "chart.png", caption = "" }) {
  let response;
  let data;

  if (photoBuffer) {
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append("photo", new Blob([photoBuffer], { type: "image/png" }), filename);

    response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      body: form,
    });
  } else {
    response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        photo: photoUrl,
        caption,
        parse_mode: "HTML",
      }),
    });
  }

  data = await response.json();
  console.log("TELEGRAM PHOTO RESPONSE:", data);

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendPhoto failed: ${JSON.stringify(data)}`);
  }
}

async function sendTelegramAlert({
  text,
  imageUrl = null,
  imageBuffer = null,
  imageFilename = "chart.png",
  fallbackChartLink = "N/A",
}) {
  if (imageBuffer || imageUrl) {
    try {
      await sendTelegramPhoto({
        photoUrl: imageUrl,
        photoBuffer: imageBuffer,
        filename: imageFilename,
        caption: text,
      });
      return { usedPhoto: true };
    } catch (err) {
      console.error("PHOTO SEND FAILED, FALLING BACK TO MESSAGE:", err.message);
      const fallbackText = appendChartLinkIfMissing(text, fallbackChartLink);
      await sendTelegramMessage(fallbackText);
      return { usedPhoto: false, photoFailed: true };
    }
  }

  const fallbackText = appendChartLinkIfMissing(text, fallbackChartLink);
  await sendTelegramMessage(fallbackText);
  return { usedPhoto: false };
}

async function buildChartDeliveryAssets({
  symbol,
  side,
  refId,
  req = null,
  inlineBody = null,
}) {
  const imageUrl = resolveChartImageUrl(inlineBody || {}, symbol, side, refId, req);

  if (!imageUrl) {
    return {
      imageUrl: null,
      imageBuffer: null,
      imageFilename: `${symbol || "chart"}-${refId || "alert"}.png`,
    };
  }

  if (isLocalChartImageUrl(imageUrl)) {
    try {
      const pngBuffer = await renderChartImagePngBuffer({
        symbol: toTvSymbol(symbol),
        side,
        ref: refId,
        interval: "60",
      });

      return {
        imageUrl,
        imageBuffer: pngBuffer,
        imageFilename: `${symbol || "chart"}-${refId || "alert"}.png`,
      };
    } catch (err) {
      console.error("LOCAL CHART RENDER FOR TELEGRAM FAILED:", err);
      return {
        imageUrl,
        imageBuffer: null,
        imageFilename: `${symbol || "chart"}-${refId || "alert"}.png`,
      };
    }
  }

  return {
    imageUrl,
    imageBuffer: null,
    imageFilename: `${symbol || "chart"}-${refId || "alert"}.png`,
  };
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

  const chartAssets = await buildChartDeliveryAssets({
    symbol: trade.symbol,
    side: trade.side,
    refId: trade.refId,
    inlineBody: {
      chart_image_url: trade.chartImageUrl,
    },
  });

  const showChartLink = !chartAssets.imageUrl && !chartAssets.imageBuffer;

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
    imageUrl: chartAssets.imageUrl,
    imageBuffer: chartAssets.imageBuffer,
    imageFilename: chartAssets.imageFilename,
    fallbackChartLink: chartLink,
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
  try {
    const symbol = String(req.query.symbol || "BINANCE:BTCUSDT");
    const side = String(req.query.side || "LONG").toUpperCase();
    const ref = String(req.query.ref || "");
    const interval = String(req.query.interval || "60");

    const png = await renderChartImagePngBuffer({
      symbol,
      side,
      ref,
      interval,
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=120");
    res.status(200).send(png);
  } catch (err) {
    console.error("CHART IMAGE ERROR FULL:", err);
    res.status(500).send(`chart image error: ${err?.message || String(err)}`);
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

    const chartAssets = await buildChartDeliveryAssets({
      symbol,
      side,
      refId,
      req,
      inlineBody: body,
    });

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
        chartImageUrl: chartAssets.imageUrl,
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

    const showChartLink = !chartAssets.imageUrl && !chartAssets.imageBuffer;

    const text = buildAlertText({
      symbol,
      side,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      rr,
      leverage,
      strength,
      prettyTime,
      whyLine,
      chartLink,
      showChartLink,
      refId,
      tpPct,
    });

    const sendResult = await sendTelegramAlert({
      text,
      imageUrl: chartAssets.imageUrl,
      imageBuffer: chartAssets.imageBuffer,
      imageFilename: chartAssets.imageFilename,
      fallbackChartLink: chartLink,
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
      strength,
      time: prettyTime,
      refId,
      imageUsed: sendResult.usedPhoto,
      chartImageUrl: chartAssets.imageUrl,
      chartBufferBuilt: Boolean(chartAssets.imageBuffer),
      chartLink,
      storedForHits: validLevels,
      activeTrades: activeTrades.size,
      eventType,
      candidateIds,
      setupType,
      usedDynamicLevels: !validIncomingLevels && validLevels,
      whyLine,
      nextRef,
    });

    if (!chartAssets.imageUrl && !chartAssets.imageBuffer) {
      console.log("NO DIRECT CHART IMAGE AVAILABLE FOR THIS ALERT:", {
        symbol,
        refId,
        chartLink,
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
