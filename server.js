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
const FREE_CHAT_ID = process.env.FREE_TELEGRAM_CHAT_ID || "";

const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const CHART_IMAGE_TEMPLATE = process.env.CHART_IMAGE_TEMPLATE || "";

// Daily summary settings
const DAILY_SUMMARY_ENABLED =
  String(process.env.DAILY_SUMMARY_ENABLED || "true").toLowerCase() !== "false";
const DAILY_SUMMARY_UTC_HOUR = Number(process.env.DAILY_SUMMARY_UTC_HOUR || 23);
const DAILY_SUMMARY_UTC_MINUTE = Number(process.env.DAILY_SUMMARY_UTC_MINUTE || 59);

// ===== PATHS =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// IMPORTANT:
// Voor staging mag /tmp, maar beter is een Render disk.
// Als je staging refs/state wil bewaren na deploys, zet RENDER_DISK_PATH goed.
const DATA_DIR = process.env.RENDER_DISK_PATH || process.env.DATA_DIR || "/tmp";
const STATE_FILE = path.join(DATA_DIR, "state.json");

// ===== STATE =====
const activeTrades = new Map();
const recentHitKeys = new Map();
const freeSharedRefs = new Map();
const dailyStats = new Map();

const MAX_TRADE_AGE_MS = 24 * 60 * 60 * 1000;
const HIT_DEDUP_TTL_MS = 36 * 60 * 60 * 1000;
const FREE_REF_TTL_MS = 48 * 60 * 60 * 1000;
const FREE_DAILY_LIMIT = 2;

// HARD QUALITY FILTERS
const MIN_RR_TO_SEND = Number(process.env.MIN_RR_TO_SEND || 0.9);
const MAX_OPEN_TRADES_PER_SYMBOL = 1;

let nextRef = 100000;
let savePromise = Promise.resolve();
let freePostDate = "";
let freePostsToday = 0;
let lastSummarySentDate = "";

app.use(express.json({ limit: "2mb" }));

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

const CHART_IMAGES = {};

// ===== BASIC HELPERS =====
function pick(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
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
  return String(v || "").toLowerCase().trim().replace(/\s+/g, "_");
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

function getUtcDateKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

function getBaseUrl() {
  if (!APP_BASE_URL) {
    console.error("APP_BASE_URL ontbreekt");
    return "";
  }
  return APP_BASE_URL;
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

// ===== TRADE MATH =====
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

// ===== QUALITY HELPERS =====
function getStrengthBucket({ symbol, side, rsi, atrPct, score, risk, incomingStrength }) {
  const explicitStrength = String(incomingStrength || "").trim().toUpperCase();
  if (explicitStrength === "A+" || explicitStrength === "A" || explicitStrength === "B" || explicitStrength === "C") {
    return explicitStrength;
  }

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

  if (side === "LONG" && Number.isFinite(numericRsi)) {
    if (numericRsi >= 60 && numericAtr <= 2.8) return "A+";
    if (numericRsi >= 56 && numericAtr <= 3.2) return "A";
    if (numericRsi >= 50) return "B";
    return "C";
  }

  if (side === "SHORT" && Number.isFinite(numericRsi)) {
    if (numericRsi <= 40 && numericAtr <= 2.8) return "A+";
    if (numericRsi <= 44 && numericAtr <= 3.2) return "A";
    if (numericRsi <= 50) return "B";
    return "C";
  }

  if (isMajorSymbol(symbol)) return "B";
  return "C";
}

function getTargetProfile({ symbol, strength }) {
  const major = isMajorSymbol(symbol);

  if (strength === "A+") {
    return major ? { tpPct: 3.4, slPct: 1.45 } : { tpPct: 3.9, slPct: 1.65 };
  }

  if (strength === "A") {
    return major ? { tpPct: 2.8, slPct: 1.45 } : { tpPct: 3.2, slPct: 1.65 };
  }

  if (strength === "B") {
    return major ? { tpPct: 2.6, slPct: 1.45 } : { tpPct: 3.0, slPct: 1.65 };
  }

  return major ? { tpPct: 2.3, slPct: 1.45 } : { tpPct: 2.7, slPct: 1.65 };
}

function applyProfileLevels(side, entry, tpPct, slPct) {
  const e = parseNum(entry);
  if (!Number.isFinite(e) || e <= 0) return { tp: null, sl: null };

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
    pick(body.setup_type, body.reason_type, body.setup, body.pattern, body.signal_name, body.strategy_name)
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

function cleanSentence(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s+\./g, ".")
    .trim();
}

function getStrengthText(strength) {
  if (!strength) return "N/A";
  return strength;
}

function shouldSkipStrength(strength) {
  return strength === "C";
}

function getWhyLeadPhrases({ setupType, side, atrBucket, rsiBucket }) {
  const bank = {
    BREAKOUT: {
      LONG: [
        "Price is trying to hold after the breakout",
        "The break is active and can still extend",
      ],
      SHORT: [
        "Price is trying to hold after the breakdown",
        "The break is active and can still extend lower",
      ],
    },
    PULLBACK: {
      LONG: [
        "Clean pullback into support",
        "Buyers are absorbing the dip without breaking structure",
      ],
      SHORT: [
        "Weak bounce into resistance",
        "Sellers are absorbing the bounce without losing structure",
      ],
    },
    TREND: {
      LONG: [
        "Trend still looks strong here",
        "Buyers still control the bigger move",
      ],
      SHORT: [
        "Trend still looks weak here",
        "Sellers still control the bigger move",
      ],
    },
    COMPRESSION: {
      LONG: [
        "Tight range, now trying to break higher",
        "Compression is starting to release upward",
      ],
      SHORT: [
        "Tight range, now trying to break lower",
        "Compression is starting to release downward",
      ],
    },
    REVERSAL: {
      LONG: [
        "There is an early turn higher here",
        "Buyers are trying to shift momentum back up",
      ],
      SHORT: [
        "There is an early turn lower here",
        "Sellers are trying to shift momentum back down",
      ],
    },
    MOMENTUM: {
      LONG: [
        "Momentum is still behind this move",
        "Buyers are still pressing price higher",
      ],
      SHORT: [
        "Momentum is still behind this move",
        "Sellers are still pressing price lower",
      ],
    },
  };

  const setupBlock = bank[setupType] || bank.TREND;
  let phrases = setupBlock[side] || setupBlock.LONG || [];

  if (atrBucket === "TIGHT") {
    phrases = phrases.concat(
      side === "LONG"
        ? ["Still tight enough to expand higher if buyers push"]
        : ["Still tight enough to expand lower if sellers push"]
    );
  }

  if (rsiBucket === "HOT" || rsiBucket === "STRONG") {
    phrases = phrases.concat(["Momentum is strong enough to keep this moving"]);
  }

  return phrases;
}

function getWhyContextPhrases({ side, strength, atrBucket }) {
  const general = {
    LONG: [
      "Buyers still look in control",
      "The chart still looks orderly enough for continuation",
    ],
    SHORT: [
      "Sellers still look in control",
      "The 1H structure still supports continuation lower",
    ],
  };

  let phrases = [...(general[side] || [])];

  if (strength === "A+") {
    phrases = phrases.concat(
      side === "LONG"
        ? ["This is one of the cleaner long profiles"]
        : ["This is one of the cleaner short profiles"]
    );
  }

  if (strength === "A") {
    phrases = phrases.concat(["Quality is good enough to pay attention here"]);
  }

  if (atrBucket === "CONTROLLED" || atrBucket === "TIGHT") {
    phrases = phrases.concat(["Volatility still looks controlled"]);
  }

  return phrases;
}

function getWhyTailPhrases({ setupType, side, rsiBucket }) {
  const base = {
    LONG: [
      "If price holds here, the upside is still there",
      "The idea stays valid while buyers defend this area",
    ],
    SHORT: [
      "If price holds here, the downside is still there",
      "The idea stays valid while sellers defend this area",
    ],
  };

  const setupTails = {
    BREAKOUT: {
      LONG: ["This gets stronger if the breakout starts acting like support"],
      SHORT: ["This gets stronger if the breakdown starts acting like resistance"],
    },
    COMPRESSION: {
      LONG: ["This gets interesting if the squeeze really opens up"],
      SHORT: ["This gets interesting if the squeeze really opens up lower"],
    },
  };

  let phrases = [...(setupTails[setupType]?.[side] || []), ...(base[side] || [])];

  if (rsiBucket === "HOT") {
    phrases = phrases.concat(["Momentum is already there, so now it is about follow-through"]);
  }

  return phrases;
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
    getWhyContextPhrases({ side, strength, atrBucket })
  );

  const tail = chooseVariant(
    `${seedBase}|tail`,
    getWhyTailPhrases({ setupType, side, rsiBucket })
  );

  const parts = [lead, context, tail].filter(Boolean);
  let why = parts.join(". ");
  if (why && !/[.!?]$/.test(why)) why += ".";
  return cleanSentence(why);
}

// ===== FREE CHANNEL HELPERS =====
function resetFreeCounterIfNeeded(nowMs = Date.now()) {
  const today = getUtcDateKey(nowMs);
  if (freePostDate !== today) {
    freePostDate = today;
    freePostsToday = 0;
  }
}

function canSendFreeSignal(nowMs = Date.now()) {
  resetFreeCounterIfNeeded(nowMs);
  return Boolean(FREE_CHAT_ID) && freePostsToday < FREE_DAILY_LIMIT;
}

async function markFreeSignalShared({ refId, symbol, side, sharedAtMs = Date.now() }) {
  if (!refId) return;

  resetFreeCounterIfNeeded(sharedAtMs);
  freePostsToday += 1;

  freeSharedRefs.set(String(refId), {
    refId: String(refId),
    symbol,
    side,
    sharedAtMs,
    sharedAtUtc: formatUtc(sharedAtMs),
  });

  await persistState();
}

function wasSharedToFree(refId) {
  if (!refId) return false;
  return freeSharedRefs.has(String(refId));
}

// ===== DAILY STATS =====
function getDailyStat(dateKey = getUtcDateKey(Date.now())) {
  if (!dailyStats.has(dateKey)) {
    dailyStats.set(dateKey, {
      date: dateKey,
      alerts: 0,
      tp: 0,
      sl: 0,
      expired: 0,
      freeAlerts: 0,
      bySymbol: {},
      byRef: {},
    });
  }

  return dailyStats.get(dateKey);
}

function ensureSymbolStats(stat, symbol) {
  if (!stat.bySymbol[symbol]) {
    stat.bySymbol[symbol] = {
      alerts: 0,
      tp: 0,
      sl: 0,
      expired: 0,
    };
  }

  return stat.bySymbol[symbol];
}

async function recordSignalStat({
  refId,
  symbol,
  side,
  strength,
  setupType,
  entry,
  tp,
  sl,
  rr,
  sharedToFree,
  ts = Date.now(),
}) {
  const dateKey = getUtcDateKey(ts);
  const stat = getDailyStat(dateKey);
  const symbolStat = ensureSymbolStats(stat, symbol);

  stat.alerts += 1;
  symbolStat.alerts += 1;

  if (sharedToFree) {
    stat.freeAlerts += 1;
  }

  stat.byRef[String(refId)] = {
    refId: String(refId),
    symbol,
    side,
    strength,
    setupType,
    entry,
    tp,
    sl,
    rr,
    sharedToFree: Boolean(sharedToFree),
    openedAtMs: ts,
    openedAtUtc: formatUtc(ts),
    result: "OPEN",
    closedAtMs: null,
    closedAtUtc: null,
  };

  await persistState();
}

async function recordHitStat({ refId, symbol, hitType, ts = Date.now() }) {
  const todayKey = getUtcDateKey(ts);
  let stat = getDailyStat(todayKey);

  let item = stat.byRef[String(refId)];

  if (!item) {
    for (const [, dayStat] of dailyStats.entries()) {
      const found = dayStat?.byRef?.[String(refId)];
      if (found) {
        stat = dayStat;
        item = found;
        break;
      }
    }
  }

  const symbolStat = ensureSymbolStats(stat, symbol);

  if (hitType === "TP") {
    stat.tp += 1;
    symbolStat.tp += 1;
  }

  if (hitType === "SL") {
    stat.sl += 1;
    symbolStat.sl += 1;
  }

  if (item) {
    item.result = hitType;
    item.closedAtMs = ts;
    item.closedAtUtc = formatUtc(ts);
  }

  await persistState();
}

async function recordExpiredTrade(trade, ts = Date.now()) {
  const todayKey = getUtcDateKey(ts);
  let stat = getDailyStat(todayKey);

  let item = stat.byRef[String(trade.refId)];

  if (!item) {
    for (const [, dayStat] of dailyStats.entries()) {
      const found = dayStat?.byRef?.[String(trade.refId)];
      if (found) {
        stat = dayStat;
        item = found;
        break;
      }
    }
  }

  const symbolStat = ensureSymbolStats(stat, trade.symbol);

  stat.expired += 1;
  symbolStat.expired += 1;

  if (item) {
    item.result = "EXPIRED";
    item.closedAtMs = ts;
    item.closedAtUtc = formatUtc(ts);
  }

  await persistState();
}

// ===== STATE CLEANUP =====
function cleanupState() {
  const now = Date.now();
  let changed = false;

  for (const [key, trade] of activeTrades.entries()) {
    if (!trade?.createdAtMs || now - trade.createdAtMs > MAX_TRADE_AGE_MS) {
      void recordExpiredTrade(trade, now);
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

  for (const [refId, info] of freeSharedRefs.entries()) {
    if (!info?.sharedAtMs || now - info.sharedAtMs > FREE_REF_TTL_MS) {
      freeSharedRefs.delete(refId);
      changed = true;
    }
  }

  const keepAfterMs = now - 10 * 24 * 60 * 60 * 1000;
  for (const [dateKey] of dailyStats.entries()) {
    const statDateMs = Date.parse(`${dateKey}T00:00:00Z`);
    if (Number.isFinite(statDateMs) && statDateMs < keepAfterMs) {
      dailyStats.delete(dateKey);
      changed = true;
    }
  }

  resetFreeCounterIfNeeded(now);

  if (changed) {
    void persistState();
  }
}

// ===== SIGNAL / HIT DETECTION HELPERS =====
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

function collectSignalIds(body) {
  return uniqueStrings([
    pick(body.alert_id),
    pick(body.signal_alert_id),
    pick(body.parent_alert_id),
    pick(body.source_alert_id),
    pick(body.strategy_order_id),
    pick(body.order_id),
    pick(body.id),
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

    const tradeIds = uniqueStrings([
      trade.primaryAlertId,
      ...(Array.isArray(trade.alertIds) ? trade.alertIds : []),
    ]);

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
    const score =
      800 -
      Math.min(600, Math.floor(distPct * 100)) -
      Math.min(180, Math.floor(timeDiff / 60000));

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
      primaryAlertId: trade.primaryAlertId || null,
      alertIds: uniqueStrings(trade.alertIds || []),
    });
  }

  items.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  return items;
}

function countOpenTradesForSymbol(symbol) {
  let count = 0;

  for (const [, trade] of activeTrades.entries()) {
    if (!trade) continue;
    if (trade.hit) continue;
    if (trade.symbol === symbol) count += 1;
  }

  return count;
}

function hasOpenTradeForSymbol(symbol) {
  return countOpenTradesForSymbol(symbol) >= MAX_OPEN_TRADES_PER_SYMBOL;
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

// ===== CHART HELPERS =====
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
// ===== HTML / TELEGRAM TEXT HELPERS =====
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

  if (!/^https?:\/\//i.test(String(chartLink))) {
    return escapeHtml(chartLink);
  }

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
  exitPrice,
  movePct,
  chartLink,
  showChartLink,
}) {
  const isTp = hitType === "TP";
  const icon = isTp ? "🎯" : "🛑";
  const status = isTp ? "TP HIT" : "SL HIT";
  const resultWord = isTp ? "PROFIT" : "LOSS";

  return `${icon} <b>${escapeHtml(trade.symbol)} ${escapeHtml(trade.side)}</b>

<b>${escapeHtml(status)}</b> • <b>${escapeHtml(fmtPct(movePct, { signed: true }))}</b>

<b>ENTRY</b> ${escapeHtml(fmtPrice(trade.entry))}
<b>EXIT</b> ${escapeHtml(fmtPrice(exitPrice))}
<b>${escapeHtml(resultWord)}</b> ${escapeHtml(fmtPct(movePct, { signed: true }))}
<b>REF</b> ${escapeHtml(trade.refId)}${showChartLink ? `

<b>CHART</b> ${formatChartHtml(chartLink)}` : ""}`;
}

function appendChartLinkIfMissing(text, chartLink) {
  if (!chartLink || chartLink === "N/A") return text;
  if (String(text).includes("<b>CHART</b>")) return text;

  return `${text}

<b>CHART</b> ${formatChartHtml(chartLink)}`;
}

function buildDailySummaryText(dateKey) {
  const stat = getDailyStat(dateKey);
  const closed = stat.tp + stat.sl;
  const winrate = closed > 0 ? (stat.tp / closed) * 100 : null;
  const openCount = Array.from(activeTrades.values()).filter((t) => !t.hit).length;

  const symbols = Object.entries(stat.bySymbol || {})
    .sort((a, b) => (b[1].alerts || 0) - (a[1].alerts || 0))
    .slice(0, 8)
    .map(([symbol, s]) => {
      return `${symbol}: ${s.alerts || 0} alerts | TP ${s.tp || 0} | SL ${s.sl || 0} | EXP ${s.expired || 0}`;
    });

  return `📊 <b>D-ALRT DAILY OVERVIEW</b>
<b>UTC DATE</b> ${escapeHtml(dateKey)}

<b>ALERTS</b> ${stat.alerts}
<b>TP HITS</b> ${stat.tp}
<b>SL HITS</b> ${stat.sl}
<b>EXPIRED</b> ${stat.expired}
<b>WINRATE</b> ${closed > 0 ? escapeHtml(fmtPct(winrate)) : "N/A"}
<b>OPEN TRADES</b> ${openCount}

<b>FREE POSTS</b> ${stat.freeAlerts}/${FREE_DAILY_LIMIT}

${symbols.length ? `<b>BY SYMBOL</b>\n${escapeHtml(symbols.join("\n"))}` : "<b>BY SYMBOL</b>\nN/A"}

NFA`;
}

async function sendDailySummary(dateKey, force = false) {
  if (!DAILY_SUMMARY_ENABLED && !force) return false;
  if (!force && lastSummarySentDate === dateKey) return false;

  const text = buildDailySummaryText(dateKey);

  await sendTelegramMessage(text, CHAT_ID);

  if (FREE_CHAT_ID) {
    await sendTelegramMessage(text, FREE_CHAT_ID);
  }

  lastSummarySentDate = dateKey;
  await persistState();

  console.log("DAILY SUMMARY SENT:", {
    dateKey,
    force,
    lastSummarySentDate,
  });

  return true;
}

async function maybeSendDailySummary() {
  if (!DAILY_SUMMARY_ENABLED) return;

  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  if (hour !== DAILY_SUMMARY_UTC_HOUR || minute !== DAILY_SUMMARY_UTC_MINUTE) return;

  const dateKey = getUtcDateKey(Date.now());
  await sendDailySummary(dateKey, false);
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
        nextRef,
        activeTrades: Array.from(activeTrades.entries()).map(([key, trade]) => [key, trade]),
        recentHitKeys: Array.from(recentHitKeys.entries()).map(([key, ts]) => [key, ts]),
        freePostDate,
        freePostsToday,
        freeSharedRefs: Array.from(freeSharedRefs.entries()).map(([refId, info]) => [refId, info]),
        dailyStats: Array.from(dailyStats.entries()).map(([dateKey, stat]) => [dateKey, stat]),
        lastSummarySentDate,
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
    const freeRefs = Array.isArray(parsed?.freeSharedRefs) ? parsed.freeSharedRefs : [];
    const stats = Array.isArray(parsed?.dailyStats) ? parsed.dailyStats : [];
    const now = Date.now();

    if (Number.isFinite(Number(parsed?.nextRef))) {
      nextRef = Math.max(100000, Math.min(999999, Number(parsed.nextRef)));
    }

    freePostDate =
      typeof parsed?.freePostDate === "string"
        ? parsed.freePostDate
        : getUtcDateKey(now);

    freePostsToday =
      Number.isFinite(Number(parsed?.freePostsToday))
        ? Math.max(0, Number(parsed.freePostsToday))
        : 0;

    lastSummarySentDate =
      typeof parsed?.lastSummarySentDate === "string"
        ? parsed.lastSummarySentDate
        : "";

    resetFreeCounterIfNeeded(now);

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

    for (const item of freeRefs) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [refId, info] = item;

      if (!refId || !info?.sharedAtMs) continue;
      if (now - info.sharedAtMs > FREE_REF_TTL_MS) continue;

      freeSharedRefs.set(String(refId), info);
    }

    for (const item of stats) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [dateKey, stat] = item;
      if (!dateKey || !stat || typeof stat !== "object") continue;

      dailyStats.set(String(dateKey), stat);
    }

    getDailyStat(getUtcDateKey(now));

    console.log(`Loaded ${activeTrades.size} active trades from disk`);
    console.log(`Loaded ${recentHitKeys.size} recent hit keys from disk`);
    console.log(`Loaded ${freeSharedRefs.size} free shared refs from disk`);
    console.log(`Loaded ${dailyStats.size} daily stat days from disk`);
    console.log(`Loaded free counter ${freePostsToday}/${FREE_DAILY_LIMIT} for ${freePostDate}`);
    console.log(`Loaded nextRef ${nextRef}`);
    console.log(`Loaded lastSummarySentDate ${lastSummarySentDate || "none"}`);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("No state.json found yet, starting clean");
      freePostDate = getUtcDateKey(Date.now());
      freePostsToday = 0;
      lastSummarySentDate = "";
      getDailyStat(freePostDate);
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

// ===== CHART RENDER =====
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

    await sleep(8000);

    return await page.screenshot({
      type: "png",
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

// ===== TELEGRAM =====
async function sendTelegramMessage(text, chatId = CHAT_ID) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const data = await response.json();

  console.log("TELEGRAM MESSAGE RESPONSE:", {
    chatId,
    data,
  });

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendMessage failed: ${JSON.stringify(data)}`);
  }
}

async function sendTelegramPhoto({
  photoUrl = null,
  photoBuffer = null,
  filename = "chart.png",
  caption = "",
  chatId = CHAT_ID,
}) {
  let response;
  let data;

  if (photoBuffer) {
    const form = new FormData();

    form.append("chat_id", chatId);
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
        chat_id: chatId,
        photo: photoUrl,
        caption,
        parse_mode: "HTML",
      }),
    });
  }

  data = await response.json();

  console.log("TELEGRAM PHOTO RESPONSE:", {
    chatId,
    data,
  });

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
  chatId = CHAT_ID,
}) {
  if (imageBuffer || imageUrl) {
    try {
      await sendTelegramPhoto({
        photoUrl: imageUrl,
        photoBuffer: imageBuffer,
        filename: imageFilename,
        caption: text,
        chatId,
      });

      return { usedPhoto: true };
    } catch (err) {
      console.error("PHOTO SEND FAILED, FALLING BACK TO MESSAGE:", err.message);

      const fallbackText = appendChartLinkIfMissing(text, fallbackChartLink);
      await sendTelegramMessage(fallbackText, chatId);

      return { usedPhoto: false, photoFailed: true };
    }
  }

  const fallbackText = appendChartLinkIfMissing(text, fallbackChartLink);
  await sendTelegramMessage(fallbackText, chatId);

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

  console.log("CHART ASSET INPUT:", {
    symbol,
    side,
    refId,
    imageUrl,
  });

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

async function sendHitAlert({
  trade,
  hitType,
  hitTime,
  hitPrice = null,
  chatId = CHAT_ID,
}) {
  const exitPrice =
    hitType === "TP"
      ? trade.tp
      : hitType === "SL"
      ? trade.sl
      : hitPrice;

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
    exitPrice,
    movePct,
    chartLink,
    showChartLink,
  });

  await sendTelegramAlert({
    text: hitText,
    imageUrl: chartAssets.imageUrl,
    imageBuffer: chartAssets.imageBuffer,
    imageFilename: chartAssets.imageFilename,
    fallbackChartLink: chartLink,
    chatId,
  });
}

// ===== ROUTES =====
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

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "ALRT-Render-STAGING",
  });
});

app.get("/health", (req, res) => {
  resetFreeCounterIfNeeded(Date.now());

  res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    activeTrades: activeTrades.size,
    recentHitKeys: recentHitKeys.size,
    nextRef,
    minRrToSend: MIN_RR_TO_SEND,
    maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
    freeEnabled: Boolean(FREE_CHAT_ID),
    freePostDate,
    freePostsToday,
    freeDailyLimit: FREE_DAILY_LIMIT,
    freeSharedRefs: freeSharedRefs.size,
    dailyStatsDays: dailyStats.size,
    lastSummarySentDate,
    dailySummaryEnabled: DAILY_SUMMARY_ENABLED,
    dailySummaryUtcHour: DAILY_SUMMARY_UTC_HOUR,
    dailySummaryUtcMinute: DAILY_SUMMARY_UTC_MINUTE,
  });
});

app.post("/summary/send-now", async (req, res) => {
  res.status(200).json({ ok: true, message: "summary send requested" });

  try {
    const dateKey = getUtcDateKey(Date.now());
    await sendDailySummary(dateKey, true);
  } catch (err) {
    console.error("MANUAL SUMMARY ERROR:", err);
  }
});

// ===== WEBHOOK HANDLER =====
async function handleTradingViewWebhook(req, res) {
  const body = req.body || {};
  const receivedAtMs = Date.now();
  const prettyTime = formatUtc(receivedAtMs);

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
    const incomingStrength = pick(body.strength, body.grade, body.quality);

    const eventTime = pick(
      body.time_close,
      body.bar_close_time,
      body.timestamp,
      body.time,
      receivedAtMs
    );

    const eventTimeMs = eventTimeToMs(eventTime);

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
      incomingStrength,
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

    const signalIds = collectSignalIds(body);

    if (!BOT_TOKEN || !CHAT_ID) {
      console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
      return;
    }

    console.log("WEBHOOK RECEIVED:", {
      symbol,
      side,
      eventType,
      eventTime: prettyTime,
      entryRaw,
      tpRaw,
      slRaw,
      incomingRef,
      signalIds,
      candidateIdsBase,
      rr: fmtRR(rr),
      strength,
    });

    const chartLink = resolveChartLink(symbol);

    // ===== HANDLE EXPLICIT TP/SL HIT WEBHOOKS =====
    if (explicitHitType && symbol) {
      let matched =
        findOpenTradeByCandidateIds(signalIds) ||
        findTradeByRefId(incomingRef) ||
        findOpenTradeByCandidateIds(candidateIdsBase) ||
        findBestOpenTradeByHitPrice(symbol, "N/A", explicitHitType, currentPrice, eventTimeMs) ||
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
        matched.trade.hitAtMs = receivedAtMs;

        await sendHitAlert({
          trade: matched.trade,
          hitType: explicitHitType,
          hitTime: receivedAtMs,
          hitPrice: currentPrice,
          chatId: CHAT_ID,
        });

        if (wasSharedToFree(matched.trade.refId)) {
          try {
            await sendHitAlert({
              trade: matched.trade,
              hitType: explicitHitType,
              hitTime: receivedAtMs,
              hitPrice: currentPrice,
              chatId: FREE_CHAT_ID,
            });

            console.log(`FREE HIT SENT: ${symbol} ${explicitHitType} REF ${matched.trade.refId}`);
          } catch (err) {
            console.error("FREE HIT SEND FAILED:", {
              symbol,
              refId: matched.trade.refId,
              error: err?.message || String(err),
            });
          }
        }

        await recordHitStat({
          refId: matched.trade.refId,
          symbol: matched.trade.symbol,
          hitType: explicitHitType,
          ts: receivedAtMs,
        });

        await markRecentHit(hitKey);

        console.log(`EXPLICIT HIT SENT (${matched.matchType}): ${symbol} ${explicitHitType} REF ${matched.trade.refId}`, {
          incomingRef,
          tradeRef: matched.trade.refId,
          hitTimeUtc: formatUtc(receivedAtMs),
          currentPrice,
          freeForwarded: wasSharedToFree(matched.trade.refId),
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
        signalIds,
        eventTime,
        eventTimeUtc: formatUtc(eventTimeMs),
        receivedAtUtc: prettyTime,
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

        const inferredHitKey = `${symbol}|${trade.refId}|${inferredHit}|${Math.floor(receivedAtMs / 60000)}`;
        if (wasRecentHitSent(inferredHitKey)) continue;

        trade.hit = true;
        trade.hitType = inferredHit;
        trade.hitAtMs = receivedAtMs;

        await sendHitAlert({
          trade,
          hitType: inferredHit,
          hitTime: receivedAtMs,
          hitPrice: currentPrice,
          chatId: CHAT_ID,
        });

        if (wasSharedToFree(trade.refId)) {
          try {
            await sendHitAlert({
              trade,
              hitType: inferredHit,
              hitTime: receivedAtMs,
              hitPrice: currentPrice,
              chatId: FREE_CHAT_ID,
            });

            console.log(`FREE INFERRED HIT SENT: ${symbol} ${inferredHit} REF ${trade.refId}`);
          } catch (err) {
            console.error("FREE INFERRED HIT SEND FAILED:", {
              symbol,
              refId: trade.refId,
              error: err?.message || String(err),
            });
          }
        }

        await recordHitStat({
          refId: trade.refId,
          symbol: trade.symbol,
          hitType: inferredHit,
          ts: receivedAtMs,
        });

        await markRecentHit(inferredHitKey);

        console.log(`INFERRED HIT SENT: ${symbol} ${inferredHit} REF ${trade.refId}`, {
          currentPrice,
          tp: trade.tp,
          sl: trade.sl,
          side: trade.side,
          freeForwarded: wasSharedToFree(trade.refId),
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
      console.log("SIGNAL SKIPPED BECAUSE LEVELS INVALID:", {
        symbol,
        side,
        entry: entryParsed,
        tp: tpParsed,
        sl: slParsed,
        eventType,
        eventTime: prettyTime,
      });
      return;
    }

    if (shouldSkipStrength(strength)) {
      console.log("SIGNAL SKIPPED BY SAFE FILTER:", {
        reason: "strength_c_filtered",
        symbol,
        side,
        strength,
        entry: fmtPrice(entryParsed),
        tp: fmtPrice(tpParsed),
        sl: fmtPrice(slParsed),
        tpPct: fmtPct(tpPct),
        rr: fmtRR(rr),
        eventType,
        time: prettyTime,
      });
      return;
    }

    if (hasOpenTradeForSymbol(symbol)) {
      console.log("SIGNAL SKIPPED BY OPEN TRADE FILTER:", {
        reason: "open_trade_already_exists_for_symbol",
        symbol,
        openTradesForSymbol: countOpenTradesForSymbol(symbol),
        maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
        side,
        entry: fmtPrice(entryParsed),
        tp: fmtPrice(tpParsed),
        sl: fmtPrice(slParsed),
        rr: fmtRR(rr),
        eventType,
        time: prettyTime,
      });
      return;
    }

    if (!Number.isFinite(rr) || rr < MIN_RR_TO_SEND) {
      console.log("SIGNAL SKIPPED BY MIN RR FILTER:", {
        reason: "rr_too_low",
        minRequired: MIN_RR_TO_SEND,
        symbol,
        side,
        entry: fmtPrice(entryParsed),
        tp: fmtPrice(tpParsed),
        sl: fmtPrice(slParsed),
        rr: fmtRR(rr),
        eventType,
        time: prettyTime,
      });
      return;
    }

    const refId = incomingRef || allocNextRef();

    const candidateIds = uniqueStrings([
      ...signalIds,
      ...candidateIdsBase,
      refId,
    ]);

    const primaryAlertId = signalIds[0] || candidateIds[0] || refId;

    const chartAssets = await buildChartDeliveryAssets({
      symbol,
      side,
      refId,
      req,
      inlineBody: body,
    });

    const whyLine = buildWhyLine({
      symbol,
      side,
      setupType,
      strength,
      rsi,
      atrPct,
      eventTime: receivedAtMs,
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
      chatId: CHAT_ID,
    });

    let sharedToFree = false;

    if (validLevels && canSendFreeSignal(receivedAtMs)) {
      try {
        await sendTelegramAlert({
          text,
          imageUrl: chartAssets.imageUrl,
          imageBuffer: chartAssets.imageBuffer,
          imageFilename: chartAssets.imageFilename,
          fallbackChartLink: chartLink,
          chatId: FREE_CHAT_ID,
        });

        await markFreeSignalShared({
          refId,
          symbol,
          side,
          sharedAtMs: receivedAtMs,
        });

        sharedToFree = true;

        console.log(`FREE SIGNAL SENT: ${symbol} ${side} REF ${refId}`, {
          freePostsToday,
          freeDailyLimit: FREE_DAILY_LIMIT,
          freePostDate,
        });
      } catch (err) {
        console.error("FREE SIGNAL SEND FAILED:", {
          symbol,
          side,
          refId,
          error: err?.message || String(err),
        });
      }
    } else {
      console.log("FREE SIGNAL NOT SENT:", {
        reason: !FREE_CHAT_ID
          ? "free_chat_id_missing"
          : !validLevels
          ? "invalid_levels"
          : "daily_limit_reached",
        symbol,
        side,
        refId,
        freePostsToday,
        freeDailyLimit: FREE_DAILY_LIMIT,
        freePostDate,
      });
    }

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
      createdAtMs: receivedAtMs,
      hit: false,
      hitType: null,
      hitAtMs: null,
      primaryAlertId,
      alertIds: candidateIds,
      setupType,
      strength,
      rr,
      chartLink,
      chartImageUrl: chartAssets.imageUrl,
      postedUtc: prettyTime,
    });

    await recordSignalStat({
      refId,
      symbol,
      side,
      strength,
      setupType,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      rr,
      sharedToFree,
      ts: receivedAtMs,
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
      primaryAlertId,
      imageUsed: sendResult.usedPhoto,
      chartImageUrl: chartAssets.imageUrl,
      chartBufferBuilt: Boolean(chartAssets.imageBuffer),
      chartLink,
      storedForHits: true,
      activeTrades: activeTrades.size,
      eventType,
      signalIds,
      candidateIds,
      setupType,
      usedDynamicLevels: !validIncomingLevels && validLevels,
      whyLine,
      nextRef,
      freeEnabled: Boolean(FREE_CHAT_ID),
      freePostsToday,
      freePostDate,
      sharedToFree,
      minRrToSend: MIN_RR_TO_SEND,
      maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
    });
  } catch (err) {
    console.error("ERROR:", err);
  }
}

// ===== WEBHOOK ROUTES =====
app.post("/webhook", handleTradingViewWebhook);
app.post("/webhook/tradingview", handleTradingViewWebhook);

// ===== 404 =====
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Not found",
  });
});

// ===== START =====
async function startServer() {
  await loadState();
  await persistState();

  console.log("STATE FILE PATH:", STATE_FILE);
  console.log("DATA DIR:", DATA_DIR);

  console.log("QUALITY FILTERS:", {
    minRrToSend: MIN_RR_TO_SEND,
    maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
  });

  console.log("FREE CHANNEL:", {
    enabled: Boolean(FREE_CHAT_ID),
    freePostDate,
    freePostsToday,
    freeDailyLimit: FREE_DAILY_LIMIT,
    freeSharedRefs: freeSharedRefs.size,
  });

  console.log("DAILY SUMMARY:", {
    enabled: DAILY_SUMMARY_ENABLED,
    utcHour: DAILY_SUMMARY_UTC_HOUR,
    utcMinute: DAILY_SUMMARY_UTC_MINUTE,
    lastSummarySentDate,
  });

  setInterval(() => {
    maybeSendDailySummary().catch((err) => {
      console.error("DAILY SUMMARY INTERVAL ERROR:", err);
    });
  }, 30 * 1000);

  app.listen(PORT, () => {
    console.log(`ALRT-Render-STAGING running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("STARTUP ERROR:", err);
  process.exit(1);
});
