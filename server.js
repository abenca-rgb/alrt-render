// server.js — D-ALRT / ALRT-Render
// v24.1 full live-safe upgrade
// Includes: paid/free access, Stripe, Telegram, chart images, refs, TP/SL, time exits, expired, daily summaries.

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

const APP_VERSION = "v24.1-elite-pine-timeexit-summary-fix";

// ===== CONFIG =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FREE_CHAT_ID = process.env.FREE_TELEGRAM_CHAT_ID || "";
const PAID_TELEGRAM_CHAT_ID = process.env.PAID_TELEGRAM_CHAT_ID || CHAT_ID;

const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || "https://dalrt.com").replace(/\/+$/, "");
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const CHART_IMAGE_TEMPLATE = process.env.CHART_IMAGE_TEMPLATE || "";

const DAILY_SUMMARY_ENABLED =
  String(process.env.DAILY_SUMMARY_ENABLED || "true").toLowerCase() !== "false";
const DAILY_SUMMARY_UTC_HOUR = Number(process.env.DAILY_SUMMARY_UTC_HOUR || 23);
const DAILY_SUMMARY_UTC_MINUTE = Number(process.env.DAILY_SUMMARY_UTC_MINUTE || 59);

const SUMMARY_ADMIN_TOKEN = process.env.SUMMARY_ADMIN_TOKEN || "";

// ===== PATHS =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.RENDER_DISK_PATH || "/var/data";
const STATE_FILE = path.join(DATA_DIR, "state.json");

// ===== STATE =====
const activeTrades = new Map();
const recentHitKeys = new Map();
const freeSharedRefs = new Map();
const dailyStats = new Map();
const paidMembers = new Map();
const freeMembers = new Map();

const MAX_TRADE_AGE_MS = 24 * 60 * 60 * 1000;
const HIT_DEDUP_TTL_MS = 36 * 60 * 60 * 1000;
const FREE_REF_TTL_MS = 48 * 60 * 60 * 1000;
const FREE_DAILY_LIMIT = 2;

const MIN_RR_TO_SEND = Number(process.env.MIN_RR_TO_SEND || 0);
const MAX_OPEN_TRADES_PER_SYMBOL = Number(process.env.MAX_OPEN_TRADES_PER_SYMBOL || 1);

// BELANGRIJK: refs nooit meer lager dan 100127, tenzij env hoger staat.
const REF_START_FLOOR = Number(process.env.NEXT_REF_START || 100127);

let nextRef = REF_START_FLOOR;
let savePromise = Promise.resolve();
let freePostDate = "";
let freePostsToday = 0;
let lastSummarySentDate = "";

// ===== RAW STRIPE ROUTE MUST BE BEFORE express.json =====
app.post(
  "/webhook/stripe",
  express.raw({ type: "application/json", limit: "2mb" }),
  async (req, res) => {
    let event;

    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch (err) {
      console.error("STRIPE WEBHOOK PARSE ERROR:", err);
      return res.status(400).send("Invalid payload");
    }

    res.status(200).json({ received: true });

    try {
      await handleStripeEvent(event);
    } catch (err) {
      console.error("STRIPE EVENT HANDLE ERROR:", err);
    }
  }
);

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

// ===== HELPERS =====
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

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
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
  if (x.includes("trend_pullback")) return "TREND_PULLBACK";
  if (x.includes("compression_breakout")) return "COMPRESSION_BREAKOUT";
  if (x.includes("liquidity_reclaim")) return "LIQUIDITY_RECLAIM";
  if (x.includes("htf_continuation")) return "HTF_CONTINUATION";
  if (x.includes("reversal_expansion")) return "REVERSAL_EXPANSION";
  if (x.includes("break")) return "COMPRESSION_BREAKOUT";
  if (x.includes("pull")) return "TREND_PULLBACK";
  if (x.includes("reclaim")) return "LIQUIDITY_RECLAIM";
  if (x.includes("trend")) return "HTF_CONTINUATION";
  if (x.includes("reversal") || x.includes("reverse")) return "REVERSAL_EXPANSION";
  if (x.includes("compress") || x.includes("squeeze")) return "COMPRESSION_BREAKOUT";
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

function buildLocalChartImageUrl({ symbol, side, refId }) {
  const baseUrl = getBaseUrl();
  if (!baseUrl || !symbol) return null;

  const params = new URLSearchParams({
    symbol: toTvSymbol(symbol),
    side: String(side || "LONG"),
    ref: String(refId || ""),
    interval: "15",
  });

  return `${baseUrl}/chart-image?${params.toString()}`;
}

function allocNextRef() {
  nextRef += 1;

  if (!Number.isFinite(nextRef) || nextRef < REF_START_FLOOR) {
    nextRef = REF_START_FLOOR;
  }

  if (nextRef > 999999) {
    nextRef = REF_START_FLOOR;
  }

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
  return ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT"].includes(symbol);
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
  }

  if (side === "SHORT") {
    reward = e - t;
    risk = s - e;
  }

  if (!Number.isFinite(reward) || !Number.isFinite(risk) || reward <= 0 || risk <= 0) return null;
  return reward / risk;
}

function applyFallbackLevels(side, entry, strength, symbol) {
  const e = parseNum(entry);
  if (!Number.isFinite(e) || e <= 0) return { tp: null, sl: null };

  const major = isMajorSymbol(symbol);

  const tpPct = strength === "A+" ? (major ? 2.4 : 2.8) : (major ? 2.0 : 2.4);
  const slPct = major ? 1.0 : 1.2;

  if (side === "LONG") {
    return { tp: e * (1 + tpPct / 100), sl: e * (1 - slPct / 100) };
  }

  if (side === "SHORT") {
    return { tp: e * (1 - tpPct / 100), sl: e * (1 + slPct / 100) };
  }

  return { tp: null, sl: null };
}

function getStrengthBucket({ symbol, side, rsi, atrPct, score, risk, incomingStrength }) {
  const explicit = String(incomingStrength || "").trim().toUpperCase();
  if (["A+", "A", "B", "C"].includes(explicit)) return explicit;

  const numericScore = parseNum(score);
  const numericRisk = parseNum(risk);
  const numericRsi = parseNum(rsi);
  const numericAtr = parseNum(atrPct);

  if (Number.isFinite(numericScore)) {
    if (numericScore >= 10) return "A+";
    if (numericScore >= 8) return "A";
    if (numericScore >= 6) return "B";
    return "C";
  }

  if (Number.isFinite(numericRisk)) {
    if (numericRisk >= 5) return "A";
    if (numericRisk >= 4) return "B";
    return "C";
  }

  if (side === "LONG" && Number.isFinite(numericRsi)) {
    if (numericRsi >= 55 && numericAtr <= 3.2) return "A";
    if (numericRsi >= 50) return "B";
    return "C";
  }

  if (side === "SHORT" && Number.isFinite(numericRsi)) {
    if (numericRsi <= 45 && numericAtr <= 3.2) return "A";
    if (numericRsi <= 50) return "B";
    return "C";
  }

  return isMajorSymbol(symbol) ? "B" : "C";
}

function deriveSetupType({ body, side, rsi, atrPct }) {
  const explicit = normalizeSetupType(
    pick(body.setup_type, body.reason_type, body.setup, body.pattern, body.signal_name, body.strategy_name)
  );

  if (explicit) return explicit;

  const numericAtr = parseNum(atrPct);
  const numericRsi = parseNum(rsi);

  if (Number.isFinite(numericAtr) && numericAtr <= 1.2) return "COMPRESSION_BREAKOUT";

  if (side === "LONG") {
    if (Number.isFinite(numericRsi) && numericRsi < 43) return "LIQUIDITY_RECLAIM";
    if (Number.isFinite(numericRsi) && numericRsi >= 55) return "HTF_CONTINUATION";
    return "TREND_PULLBACK";
  }

  if (side === "SHORT") {
    if (Number.isFinite(numericRsi) && numericRsi > 57) return "LIQUIDITY_RECLAIM";
    if (Number.isFinite(numericRsi) && numericRsi <= 45) return "HTF_CONTINUATION";
    return "TREND_PULLBACK";
  }

  return "HTF_CONTINUATION";
}

function resolveLeverage(body, symbol, strength) {
  const raw = pick(body.leverage, body.lev, body.suggested_leverage, body.recommended_leverage);

  if (raw) {
    const txt = String(raw).trim().toLowerCase().replace(/\s+/g, "");
    if (/^\d+(\.\d+)?x$/.test(txt)) return txt.toUpperCase();
    if (/^\d+(\.\d+)?$/.test(txt)) return `${txt}x`;
    return String(raw).trim();
  }

  if (strength === "A+" || strength === "A") return isMajorSymbol(symbol) ? "4x" : "3x";
  return isMajorSymbol(symbol) ? "3x" : "2x";
}

function buildWhyLine({ body, symbol, side, setupType, marketRegime, session, confidence }) {
  const incomingReason = pick(body.reason, body.why, body.comment, body.market_bias);
  if (incomingReason) return String(incomingReason).trim();

  const directionText =
    side === "LONG"
      ? "buyers are trying to continue higher from a structured area"
      : "sellers are trying to continue lower from a structured area";

  return `${setupType} detected on ${symbol}. ${directionText}. Session: ${session || "N/A"}. Regime: ${marketRegime || "N/A"}. Confidence: ${confidence || "N/A"}.`;
}

// ===== EVENT DETECTION =====
function detectExplicitHitType(eventType, body) {
  const normalized = normalizeEventType(eventType);
  const hitType = String(pick(body.hit_type, body.result, "") || "").toLowerCase();
  const rawText = JSON.stringify(body).toLowerCase();

  if (
    normalized.includes("time_exit_profit") ||
    hitType === "time_exit_profit" ||
    rawText.includes("time_exit_profit")
  ) {
    return "TIME_EXIT_PROFIT";
  }

  if (
    normalized.includes("time_exit_loss") ||
    hitType === "time_exit_loss" ||
    rawText.includes("time_exit_loss")
  ) {
    return "TIME_EXIT_LOSS";
  }

  if (
    normalized.includes("tp_hit") ||
    normalized.includes("take_profit_hit") ||
    normalized === "tp" ||
    hitType === "tp" ||
    rawText.includes("tp_hit") ||
    rawText.includes("take_profit")
  ) {
    return "TP";
  }

  if (
    normalized.includes("sl_hit") ||
    normalized.includes("stop_loss_hit") ||
    normalized === "sl" ||
    hitType === "sl" ||
    rawText.includes("sl_hit") ||
    rawText.includes("stop_loss")
  ) {
    return "SL";
  }

  if (
    normalized.includes("expired") ||
    hitType === "expired" ||
    rawText.includes('"event":"expired"')
  ) {
    return "EXPIRED";
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
    pick(body.signal_alert_id),
    pick(body.parent_alert_id),
    pick(body.source_alert_id),
    pick(body.strategy_order_id),
    pick(body.order_id),
    pick(body.id),
    pick(body.ref_id),
  ]);
}

function collectAllCandidateIds({ body, symbol, side, eventTimeMs, refId }) {
  const ms = Number.isFinite(eventTimeMs) ? String(eventTimeMs) : "";
  const sec = Number.isFinite(eventTimeMs) ? String(Math.floor(eventTimeMs / 1000)) : "";

  return uniqueStrings([
    ...collectRawCandidateIds(body),
    refId ? String(refId) : null,
    symbol && side && ms ? `${symbol}-${side}-${ms}` : null,
    symbol && side && sec ? `${symbol}-${side}-${sec}` : null,
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

function countOpenTradesForSymbol(symbol) {
  let count = 0;
  for (const [, trade] of activeTrades.entries()) {
    if (!trade || trade.hit) continue;
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

function getTimeExitResult(trade, currentPrice) {
  const movePct = pctMove(trade.side, trade.entry, currentPrice);
  if (!Number.isFinite(movePct)) return "EXPIRED";
  if (movePct > 0.05) return "TIME_EXIT_PROFIT";
  if (movePct < -0.05) return "TIME_EXIT_LOSS";
  return "EXPIRED";
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

// ===== DAILY STATS =====
function getDailyStat(dateKey = getUtcDateKey(Date.now())) {
  if (!dailyStats.has(dateKey)) {
    dailyStats.set(dateKey, {
      date: dateKey,
      alerts: 0,
      tp: 0,
      sl: 0,
      timeExitProfit: 0,
      timeExitLoss: 0,
      expired: 0,
      freeAlerts: 0,
      bySymbol: {},
      byRef: {},
    });
  }

  const stat = dailyStats.get(dateKey);

  if (stat.timeExitProfit === undefined) stat.timeExitProfit = 0;
  if (stat.timeExitLoss === undefined) stat.timeExitLoss = 0;
  if (stat.expired === undefined) stat.expired = 0;
  if (!stat.bySymbol) stat.bySymbol = {};
  if (!stat.byRef) stat.byRef = {};

  return stat;
}

function ensureSymbolStats(stat, symbol) {
  if (!stat.bySymbol[symbol]) {
    stat.bySymbol[symbol] = {
      alerts: 0,
      tp: 0,
      sl: 0,
      timeExitProfit: 0,
      timeExitLoss: 0,
      expired: 0,
    };
  }

  const s = stat.bySymbol[symbol];
  if (s.timeExitProfit === undefined) s.timeExitProfit = 0;
  if (s.timeExitLoss === undefined) s.timeExitLoss = 0;
  if (s.expired === undefined) s.expired = 0;

  return s;
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
  setupScore,
  trendStrength,
  volatilityState,
  marketRegime,
  session,
  confidenceLevel,
  estimatedHoldDuration,
  ts = Date.now(),
}) {
  const dateKey = getUtcDateKey(ts);
  const stat = getDailyStat(dateKey);
  const symbolStat = ensureSymbolStats(stat, symbol);

  stat.alerts += 1;
  symbolStat.alerts += 1;

  if (sharedToFree) stat.freeAlerts += 1;

  stat.byRef[String(refId)] = {
    refId: String(refId),
    symbol,
    side,
    strength,
    setupType,
    setupScore,
    trendStrength,
    volatilityState,
    marketRegime,
    session,
    confidenceLevel,
    estimatedHoldDuration,
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
    exitPrice: null,
    movePct: null,
  };

  await persistState();
}

async function recordCloseStat({ refId, symbol, result, exitPrice = null, movePct = null, ts = Date.now() }) {
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

  if (result === "TP") {
    stat.tp += 1;
    symbolStat.tp += 1;
  }

  if (result === "SL") {
    stat.sl += 1;
    symbolStat.sl += 1;
  }

  if (result === "TIME_EXIT_PROFIT") {
    stat.timeExitProfit += 1;
    symbolStat.timeExitProfit += 1;
  }

  if (result === "TIME_EXIT_LOSS") {
    stat.timeExitLoss += 1;
    symbolStat.timeExitLoss += 1;
  }

  if (result === "EXPIRED") {
    stat.expired += 1;
    symbolStat.expired += 1;
  }

  if (item) {
    item.result = result;
    item.closedAtMs = ts;
    item.closedAtUtc = formatUtc(ts);
    item.exitPrice = exitPrice;
    item.movePct = movePct;
  }

  await persistState();
}

// ===== FREE CHANNEL =====
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

// ===== HTML / TEXT =====
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function formatChartHtml(chartLink) {
  if (!chartLink || chartLink === "N/A") return "N/A";
  if (!/^https?:\/\//i.test(String(chartLink))) return escapeHtml(chartLink);
  return `<a href="${escapeAttr(chartLink)}">Open chart</a>`;
}

function getStrengthText(strength) {
  return strength || "N/A";
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
  setupType,
  setupScore,
  marketRegime,
  session,
  confidenceLevel,
}) {
  return `🚨 <b>ALERT • ${escapeHtml(symbol)}</b>
<b>REF</b> ${escapeHtml(refId)}

<b>DIRECTION</b> ${escapeHtml(side)}
<b>SETUP</b> ${escapeHtml(setupType || "N/A")}
<b>SCORE</b> ${escapeHtml(setupScore || "N/A")}
<b>CONFIDENCE</b> ${escapeHtml(confidenceLevel || "N/A")}

<b>ENTRY</b> ${escapeHtml(fmtPrice(entry))}
<b>TP</b> ${escapeHtml(fmtPrice(tp))} (${escapeHtml(fmtPct(tpPct))})
<b>SL</b> ${escapeHtml(fmtPrice(sl))}
<b>RR</b> ${escapeHtml(fmtRR(rr))}
<b>STRENGTH</b> ${escapeHtml(getStrengthText(strength))}
<b>LEVERAGE</b> ${escapeHtml(leverage)}

<b>TF</b> 15M execution / 1H bias
<b>SESSION</b> ${escapeHtml(session || "N/A")}
<b>REGIME</b> ${escapeHtml(marketRegime || "N/A")}
<b>UTC</b> ${escapeHtml(prettyTime)}

<b>WHY</b> ${escapeHtml(whyLine)}${showChartLink ? `

<b>CHART</b> ${formatChartHtml(chartLink)}` : ""}

NFA`;
}

function buildHitText({ trade, hitType, exitPrice, movePct, chartLink, showChartLink }) {
  const icon =
    hitType === "TP"
      ? "🎯"
      : hitType === "SL"
      ? "🛑"
      : hitType === "TIME_EXIT_PROFIT"
      ? "⏱️✅"
      : hitType === "TIME_EXIT_LOSS"
      ? "⏱️⚠️"
      : "⌛";

  const status =
    hitType === "TP"
      ? "TP HIT"
      : hitType === "SL"
      ? "SL HIT"
      : hitType === "TIME_EXIT_PROFIT"
      ? "TIME EXIT • PROFIT"
      : hitType === "TIME_EXIT_LOSS"
      ? "TIME EXIT • LOSS"
      : "EXPIRED";

  return `${icon} <b>${escapeHtml(trade.symbol)} ${escapeHtml(trade.side)}</b>

<b>${escapeHtml(status)}</b> • <b>${escapeHtml(fmtPct(movePct, { signed: true }))}</b>

<b>ENTRY</b> ${escapeHtml(fmtPrice(trade.entry))}
<b>EXIT</b> ${escapeHtml(fmtPrice(exitPrice))}
<b>MOVE</b> ${escapeHtml(fmtPct(movePct, { signed: true }))}
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
  const closed = stat.tp + stat.sl + stat.timeExitProfit + stat.timeExitLoss + stat.expired;
  const positive = stat.tp + stat.timeExitProfit;
  const winrate = closed > 0 ? (positive / closed) * 100 : null;
  const openCount = Array.from(activeTrades.values()).filter((t) => !t.hit).length;

  const symbols = Object.entries(stat.bySymbol || {})
    .sort((a, b) => (b[1].alerts || 0) - (a[1].alerts || 0))
    .slice(0, 10)
    .map(([symbol, s]) => {
      return `${symbol}: ${s.alerts || 0} alerts | TP ${s.tp || 0} | SL ${s.sl || 0} | T+ ${s.timeExitProfit || 0} | T- ${s.timeExitLoss || 0} | EXP ${s.expired || 0}`;
    });

  return `📊 <b>D-ALRT DAILY OVERVIEW</b>
<b>UTC DATE</b> ${escapeHtml(dateKey)}

<b>ALERTS</b> ${stat.alerts}
<b>TP HITS</b> ${stat.tp}
<b>SL HITS</b> ${stat.sl}
<b>TIME EXIT PROFIT</b> ${stat.timeExitProfit || 0}
<b>TIME EXIT LOSS</b> ${stat.timeExitLoss || 0}
<b>EXPIRED</b> ${stat.expired || 0}
<b>WINRATE</b> ${closed > 0 ? escapeHtml(fmtPct(winrate)) : "N/A"}
<b>OPEN TRADES</b> ${openCount}

<b>FREE POSTS</b> ${stat.freeAlerts}/${FREE_DAILY_LIMIT}

${symbols.length ? `<b>BY SYMBOL</b>\n${escapeHtml(symbols.join("\n"))}` : "<b>BY SYMBOL</b>\nN/A"}

NFA`;
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

function resolveChartImageUrl(body, symbol, side = "LONG", refId = "") {
  const inline = pick(
    body.chart_image_url,
    body.image_url,
    body.snapshot_url,
    body.chart_snapshot,
    body.chart_image,
    body.image,
    body.photo
  );

  if (inline && looksLikeDirectImageUrl(inline)) return String(inline).trim();

  const mapped = CHART_IMAGES[symbol];
  if (mapped && looksLikeDirectImageUrl(mapped)) return String(mapped).trim();

  if (CHART_IMAGE_TEMPLATE && CHART_IMAGE_TEMPLATE.includes("{symbol}")) {
    const built = CHART_IMAGE_TEMPLATE.replace("{symbol}", symbol);
    if (looksLikeDirectImageUrl(built)) return built;
  }

  return buildLocalChartImageUrl({ symbol, side, refId });
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

  console.log("TELEGRAM MESSAGE RESPONSE:", { chatId, data });

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

  const data = await response.json();
  console.log("TELEGRAM PHOTO RESPONSE:", { chatId, data });

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

async function renderChartImagePngBuffer({
  symbol = "BINANCE:BTCUSDT",
  side = "LONG",
  ref = "",
  interval = "15",
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
<html>
<head>
<meta charset="utf-8" />
<style>
html, body {
  margin:0;
  padding:0;
  background:#0b1220;
  width:1280px;
  height:720px;
  overflow:hidden;
  font-family:Arial,sans-serif;
}
#wrap { width:1280px; height:720px; position:relative; }
#tv_chart_container { width:1280px; height:720px; }
.badge {
  position:absolute;
  top:14px;
  left:14px;
  z-index:20;
  background:rgba(10,14,25,0.88);
  color:white;
  padding:10px 14px;
  border-radius:12px;
  font-size:22px;
  font-weight:700;
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
</html>`;

    await page.setContent(html, { waitUntil: "load", timeout: 60000 });
    await sleep(8000);

    return await page.screenshot({ type: "png" });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

async function buildChartDeliveryAssets({ symbol, side, refId, inlineBody = null }) {
  const imageUrl = resolveChartImageUrl(inlineBody || {}, symbol, side, refId);

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
        interval: "15",
      });

      return {
        imageUrl,
        imageBuffer: pngBuffer,
        imageFilename: `${symbol || "chart"}-${refId || "alert"}.png`,
      };
    } catch (err) {
      console.error("LOCAL CHART RENDER FAILED:", err);
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

async function sendHitAlert({ trade, hitType, hitPrice = null, chatId = CHAT_ID }) {
  const exitPrice =
    hitType === "TP"
      ? trade.tp
      : hitType === "SL"
      ? trade.sl
      : Number.isFinite(parseNum(hitPrice))
      ? parseNum(hitPrice)
      : trade.entry;

  const movePct = pctMove(trade.side, trade.entry, exitPrice);
  const chartLink = trade.chartLink || resolveChartLink(trade.symbol);

  const chartAssets = await buildChartDeliveryAssets({
    symbol: trade.symbol,
    side: trade.side,
    refId: trade.refId,
    inlineBody: { chart_image_url: trade.chartImageUrl },
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

// ===== STRIPE / MEMBERS =====
async function createTelegramInviteLink({ chatId = PAID_TELEGRAM_CHAT_ID, expireHours = 48 } = {}) {
  const expireDate = Math.floor(Date.now() / 1000 + expireHours * 60 * 60);

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      member_limit: 1,
      expire_date: expireDate,
    }),
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram invite failed: ${JSON.stringify(data)}`);
  }

  return data.result.invite_link;
}

async function createFreeTelegramInviteLink({ expireHours = 48 } = {}) {
  if (!FREE_CHAT_ID) throw new Error("FREE_CHAT_ID missing");
  return createTelegramInviteLink({ chatId: FREE_CHAT_ID, expireHours });
}

async function removeTelegramMember(chatId, telegramUserId) {
  if (!chatId || !telegramUserId) return false;

  const banResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/banChatMember`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      user_id: telegramUserId,
    }),
  });

  const banData = await banResponse.json();

  if (!banResponse.ok || !banData.ok) {
    console.error("TELEGRAM BAN FAILED:", banData);
    return false;
  }

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/unbanChatMember`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      user_id: telegramUserId,
      only_if_banned: true,
    }),
  });

  return true;
}

function findPaidMemberByStripe({ stripeCustomerId = null, stripeSubscriptionId = null }) {
  for (const [email, member] of paidMembers.entries()) {
    if (
      (stripeCustomerId && member.stripeCustomerId === stripeCustomerId) ||
      (stripeSubscriptionId && member.stripeSubscriptionId === stripeSubscriptionId)
    ) {
      return { email, member };
    }
  }

  return null;
}

async function handleStripeEvent(event) {
  console.log("STRIPE EVENT:", event?.type);

  if (event?.type === "checkout.session.completed") {
    const session = event.data.object;
    const email = normalizeEmail(pick(session.customer_details?.email, session.customer_email));
    if (!email) return;

    const inviteLink = await createTelegramInviteLink({ expireHours: 48 });
    const existing = paidMembers.get(email) || {};

    paidMembers.set(email, {
      ...existing,
      email,
      status: "active",
      active: true,
      inviteLink,
      inviteCreatedAt: new Date().toISOString(),
      inviteExpireHours: 48,
      stripeCustomerId: session.customer || existing.stripeCustomerId || null,
      stripeSubscriptionId: session.subscription || existing.stripeSubscriptionId || null,
      stripeSessionId: session.id || existing.stripeSessionId || null,
      telegramUserId: existing.telegramUserId || null,
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastStripeEvent: event.type,
    });

    await persistState();

    await sendTelegramMessage(`🔥 <b>NEW PAID MEMBER</b>

<b>Email</b> ${escapeHtml(email)}
<b>Status</b> active
<b>Customer</b> ${escapeHtml(session.customer || "N/A")}
<b>Subscription</b> ${escapeHtml(session.subscription || "N/A")}

<b>Invite Link</b>
${inviteLink}`);

    return;
  }

  if (
    event?.type === "customer.subscription.deleted" ||
    event?.type === "customer.subscription.updated" ||
    event?.type === "invoice.payment_failed" ||
    event?.type === "invoice.payment_succeeded"
  ) {
    const obj = event.data.object;

    const stripeCustomerId = obj.customer || null;
    const stripeSubscriptionId = obj.subscription || obj.id || null;

    const found = findPaidMemberByStripe({ stripeCustomerId, stripeSubscriptionId });

    if (!found) {
      console.log("STRIPE ACCESS EVENT BUT MEMBER NOT FOUND:", {
        type: event.type,
        stripeCustomerId,
        stripeSubscriptionId,
      });
      return;
    }

    const { email, member } = found;

    let newStatus = member.status || "active";
    let shouldRemove = false;

    if (event.type === "invoice.payment_succeeded") {
      newStatus = "active";
      shouldRemove = false;
    }

    if (event.type === "invoice.payment_failed") {
      newStatus = "past_due";
      shouldRemove = false;
    }

    if (event.type === "customer.subscription.deleted") {
      newStatus = "cancelled";
      shouldRemove = true;
    }

    if (event.type === "customer.subscription.updated") {
      const stripeStatus = String(obj.status || "").toLowerCase();

      if (stripeStatus === "active" || stripeStatus === "trialing") {
        newStatus = "active";
        shouldRemove = false;
      }

      if (stripeStatus === "past_due") {
        newStatus = "past_due";
        shouldRemove = false;
      }

      if (
        stripeStatus === "canceled" ||
        stripeStatus === "cancelled" ||
        stripeStatus === "unpaid" ||
        stripeStatus === "incomplete_expired"
      ) {
        newStatus = stripeStatus;
        shouldRemove = true;
      }
    }

    member.status = newStatus;
    member.active = newStatus === "active";
    member.updatedAt = new Date().toISOString();
    member.lastStripeEvent = event.type;

    let removedFromTelegram = false;

    if (shouldRemove && member.telegramUserId) {
      removedFromTelegram = await removeTelegramMember(PAID_TELEGRAM_CHAT_ID, member.telegramUserId);
      member.removedFromTelegramAt = removedFromTelegram ? new Date().toISOString() : null;
    }

    paidMembers.set(email, member);
    await persistState();

    await sendTelegramMessage(`⚠️ <b>PAID MEMBER ACCESS UPDATE</b>

<b>Email</b> ${escapeHtml(email)}
<b>Status</b> ${escapeHtml(newStatus)}
<b>Stripe Event</b> ${escapeHtml(event.type)}
<b>Removed From Telegram</b> ${removedFromTelegram ? "yes" : "no / telegramUserId missing"}`);

    return;
  }
}

// ===== STATE CLEANUP / PERSISTENCE =====
function cleanupState() {
  const now = Date.now();
  let changed = false;

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

  if (changed) void persistState();
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
        version: APP_VERSION,
        nextRef,
        refStartFloor: REF_START_FLOOR,
        activeTrades: Array.from(activeTrades.entries()).map(([key, trade]) => [key, trade]),
        recentHitKeys: Array.from(recentHitKeys.entries()).map(([key, ts]) => [key, ts]),
        freePostDate,
        freePostsToday,
        freeSharedRefs: Array.from(freeSharedRefs.entries()).map(([refId, info]) => [refId, info]),
        dailyStats: Array.from(dailyStats.entries()).map(([dateKey, stat]) => [dateKey, stat]),
        lastSummarySentDate,
        paidMembers: Array.from(paidMembers.entries()).map(([email, info]) => [email, info]),
        freeMembers: Array.from(freeMembers.entries()).map(([email, info]) => [email, info]),
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
      nextRef = Math.max(REF_START_FLOOR, Math.min(999999, Number(parsed.nextRef)));
    } else {
      nextRef = REF_START_FLOOR;
    }

    freePostDate = typeof parsed?.freePostDate === "string" ? parsed.freePostDate : getUtcDateKey(now);
    freePostsToday = Number.isFinite(Number(parsed?.freePostsToday)) ? Math.max(0, Number(parsed.freePostsToday)) : 0;
    lastSummarySentDate = typeof parsed?.lastSummarySentDate === "string" ? parsed.lastSummarySentDate : "";

    resetFreeCounterIfNeeded(now);

    for (const item of active) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [key, trade] = item;

      if (!trade || typeof trade !== "object") continue;
      if (!trade.createdAtMs) continue;
      if (trade.hit) continue;
      if (now - trade.createdAtMs > MAX_TRADE_AGE_MS) continue;

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

    if (Array.isArray(parsed?.paidMembers)) {
      for (const item of parsed.paidMembers) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const [email, info] = item;
        paidMembers.set(email, info);
      }
    }

    if (Array.isArray(parsed?.members)) {
      for (const item of parsed.members) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const [email, info] = item;
        paidMembers.set(email, info);
      }
    }

    if (Array.isArray(parsed?.freeMembers)) {
      for (const item of parsed.freeMembers) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const [email, info] = item;
        freeMembers.set(email, info);
      }
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
    console.log(`Loaded ${paidMembers.size} paid members from disk`);
    console.log(`Loaded ${freeMembers.size} free members from disk`);
    console.log(`Loaded nextRef ${nextRef}`);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("No state.json found yet, starting clean");
      freePostDate = getUtcDateKey(Date.now());
      freePostsToday = 0;
      lastSummarySentDate = "";
      nextRef = REF_START_FLOOR;
      getDailyStat(freePostDate);
      return;
    }

    console.error("PERSIST LOAD ERROR:", err);
  }
}

async function removeTrade(tradeKey) {
  if (activeTrades.delete(tradeKey)) await persistState();
}

async function upsertTrade(tradeKey, trade) {
  activeTrades.set(tradeKey, trade);
  await persistState();
}

// ===== DAILY SUMMARY =====
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
  if (lastSummarySentDate === dateKey) return;

  await sendDailySummary(dateKey, false);
}

// ===== TIME EXIT =====
async function closeTradeByTimeExit(key, trade, nowMs, currentPrice = null) {
  const exitPrice = Number.isFinite(currentPrice) ? currentPrice : trade.entry;
  const movePct = pctMove(trade.side, trade.entry, exitPrice);
  const result = getTimeExitResult(trade, exitPrice);

  trade.hit = true;
  trade.hitType = result;
  trade.hitAtMs = nowMs;

  if (result !== "EXPIRED") {
    await sendHitAlert({
      trade,
      hitType: result,
      hitPrice: exitPrice,
      chatId: CHAT_ID,
    });

    if (wasSharedToFree(trade.refId)) {
      try {
        await sendHitAlert({
          trade,
          hitType: result,
          hitPrice: exitPrice,
          chatId: FREE_CHAT_ID,
        });
      } catch (err) {
        console.error("FREE TIME EXIT SEND FAILED:", {
          refId: trade.refId,
          error: err?.message || String(err),
        });
      }
    }
  }

  await recordCloseStat({
    refId: trade.refId,
    symbol: trade.symbol,
    result,
    exitPrice,
    movePct,
    ts: nowMs,
  });

  await removeTrade(key);

  console.log("TIME EXIT CLOSED:", {
    symbol: trade.symbol,
    side: trade.side,
    refId: trade.refId,
    result,
    exitPrice: fmtPrice(exitPrice),
    movePct: fmtPct(movePct, { signed: true }),
  });
}

// ===== ROUTES =====
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "ALRT-Render",
    version: APP_VERSION,
  });
});

app.get("/health", (req, res) => {
  resetFreeCounterIfNeeded(Date.now());

  res.status(200).json({
    ok: true,
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    dataDir: DATA_DIR,
    stateFile: STATE_FILE,
    activeTrades: activeTrades.size,
    recentHitKeys: recentHitKeys.size,
    nextRef,
    refStartFloor: REF_START_FLOOR,
    nextRefFloorSafe: nextRef >= REF_START_FLOOR,
    maxTradeAgeHours: MAX_TRADE_AGE_MS / 1000 / 60 / 60,
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
    paidMembers: paidMembers.size,
    freeMembers: freeMembers.size,
  });
});

app.get("/chart-image", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "BINANCE:BTCUSDT");
    const side = String(req.query.side || "LONG").toUpperCase();
    const ref = String(req.query.ref || "");
    const interval = String(req.query.interval || "15");

    const png = await renderChartImagePngBuffer({ symbol, side, ref, interval });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=120");
    res.status(200).send(png);
  } catch (err) {
    console.error("CHART IMAGE ERROR FULL:", err);
    res.status(500).send(`chart image error: ${err?.message || String(err)}`);
  }
});

app.post("/summary/send-now", async (req, res) => {
  const token = String(req.query.token || req.headers["x-summary-token"] || "");

  if (!SUMMARY_ADMIN_TOKEN || token !== SUMMARY_ADMIN_TOKEN) {
    return res.status(403).json({
      ok: false,
      error: "manual summary disabled",
    });
  }

  res.status(200).json({ ok: true, message: "summary send requested" });

  try {
    const dateKey = getUtcDateKey(Date.now());
    await sendDailySummary(dateKey, true);
  } catch (err) {
    console.error("MANUAL SUMMARY ERROR:", err);
  }
});

app.post("/signup/free", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email || !email.includes("@")) {
      return res.status(400).json({ ok: false, error: "valid email required" });
    }

    const existing = freeMembers.get(email);

    if (existing?.inviteLink) {
      return res.status(200).json({
        ok: true,
        email,
        inviteLink: existing.inviteLink,
        existing: true,
      });
    }

    const inviteLink = await createFreeTelegramInviteLink({ expireHours: 48 });

    freeMembers.set(email, {
      email,
      status: "free",
      active: true,
      inviteLink,
      inviteCreatedAt: new Date().toISOString(),
      inviteExpireHours: 48,
      telegramUserId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await persistState();

    await sendTelegramMessage(`🆓 <b>NEW FREE MEMBER</b>

<b>Email</b> ${escapeHtml(email)}

<b>Free Invite</b>
${inviteLink}`);

    return res.status(200).json({ ok: true, email, inviteLink });
  } catch (err) {
    console.error("FREE SIGNUP ERROR:", err);
    return res.status(500).json({ ok: false, error: "free signup failed" });
  }
});

app.get("/admin/members", async (req, res) => {
  const token = String(req.query.token || "");

  if (!SUMMARY_ADMIN_TOKEN || token !== SUMMARY_ADMIN_TOKEN) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  res.status(200).json({
    ok: true,
    paidCount: paidMembers.size,
    freeCount: freeMembers.size,
    paidMembers: Array.from(paidMembers.values()),
    freeMembers: Array.from(freeMembers.values()),
  });
});

// ===== TRADINGVIEW WEBHOOK =====
async function handleTradingViewWebhook(req, res) {
  const body = req.body || {};
  const receivedAtMs = Date.now();
  const prettyTime = formatUtc(receivedAtMs);

  res.status(200).json({ ok: true });

  try {
    cleanupState();

    const symbol = normalizeSymbol(pick(body.symbol, body.ticker, body.pair, body.coin, body.market, ""));
    const side = normalizeSide(pick(body.side, body.direction, body.position, body.trade_side, body.action, ""));

    const entryRaw = pick(body.entry, body.entry_price, body.entryPrice, body.price, body.Entry, body.close);
    const tpRaw = pick(body.tp1, body.tp, body.take_profit, body.takeProfit, body.tp_price, body.target, body.target_price, body.TP, body.tpPrice);
    const slRaw = pick(body.sl, body.stop_loss, body.stop, body.stopLoss, body.sl_price, body.stop_price, body.SL, body.slPrice);

    const rsi = pick(body.rsi, body.rsi_value);
    const atrPct = pick(body.atr_pct, body.atrPercent, body.atr_percent);
    const adx = pick(body.adx, body.adx_value);
    const score = pick(body.setup_score, body.score, body.strength_score);
    const risk = pick(body.risk, body.risk_score);
    const incomingStrength = pick(body.strength, body.grade, body.quality);

    const trendStrength = pick(body.trend_strength, body.trendStrength, adx);
    const volatilityState = pick(body.volatility_state, body.volatilityState);
    const marketRegime = pick(body.market_regime, body.marketRegime, volatilityState);
    const session = pick(body.session, body.session_name, body.sessionName);
    const confidenceLevel = pick(body.confidence_level, body.confidence, body.confidenceLevel);
    const estimatedHoldDuration = pick(body.estimated_hold_duration, body.estimatedHoldDuration);

    const eventTime = pick(body.time_close, body.bar_close_time, body.timestamp, body.time, receivedAtMs);
    const eventTimeMs = eventTimeToMs(eventTime);

    const eventType = pick(body.event, body.type, body.event_type, body.kind, body.signal_type, "");

    const currentPrice = parseNum(
      pick(body.hit_price, body.last_price, body.market_price, body.price, body.close, body.last)
    );

    const setupType = deriveSetupType({ body, side, rsi, atrPct });

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

    const entryParsed = parseNum(entryRaw);
    let tpParsed = parseNum(tpRaw);
    let slParsed = parseNum(slRaw);

    const validIncomingLevels = hasValidTradeLevels(side, entryParsed, tpParsed, slParsed);

    if (!validIncomingLevels && Number.isFinite(entryParsed) && (side === "LONG" || side === "SHORT")) {
      const derived = applyFallbackLevels(side, entryParsed, strength, symbol);
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

    console.log("WEBHOOK RECEIVED:", {
      version: APP_VERSION,
      symbol,
      side,
      eventType,
      explicitHitType,
      entry: fmtPrice(entryParsed),
      tp: fmtPrice(tpParsed),
      sl: fmtPrice(slParsed),
      rr: fmtRR(rr),
      setupType,
      score,
      strength,
      session,
      marketRegime,
      currentPrice: fmtPrice(currentPrice),
      activeTrades: activeTrades.size,
      nextRef,
    });

    // Time exit check for same symbol.
    if (symbol) {
      for (const [key, trade] of Array.from(activeTrades.entries())) {
        if (trade.symbol !== symbol) continue;
        if (trade.hit) continue;

        const ageMs = receivedAtMs - (trade.createdAtMs || receivedAtMs);

        if (ageMs >= MAX_TRADE_AGE_MS) {
          await closeTradeByTimeExit(key, trade, receivedAtMs, currentPrice);
        }
      }
    }

    // Explicit close events.
    if (explicitHitType && symbol) {
      const matched =
        findOpenTradeByCandidateIds(candidateIdsBase) ||
        findTradeByRefId(incomingRef) ||
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

        let finalHitType = explicitHitType;
        let exitPrice = currentPrice;

        if (explicitHitType === "EXPIRED") {
          finalHitType = getTimeExitResult(
            matched.trade,
            Number.isFinite(currentPrice) ? currentPrice : matched.trade.entry
          );

          exitPrice = Number.isFinite(currentPrice) ? currentPrice : matched.trade.entry;
        }

        if (!Number.isFinite(exitPrice)) {
          if (finalHitType === "TP") exitPrice = matched.trade.tp;
          else if (finalHitType === "SL") exitPrice = matched.trade.sl;
          else exitPrice = matched.trade.entry;
        }

        matched.trade.hit = true;
        matched.trade.hitType = finalHitType;
        matched.trade.hitAtMs = receivedAtMs;

        if (finalHitType !== "EXPIRED") {
          await sendHitAlert({
            trade: matched.trade,
            hitType: finalHitType,
            hitPrice: exitPrice,
            chatId: CHAT_ID,
          });

          if (wasSharedToFree(matched.trade.refId)) {
            try {
              await sendHitAlert({
                trade: matched.trade,
                hitType: finalHitType,
                hitPrice: exitPrice,
                chatId: FREE_CHAT_ID,
              });
            } catch (err) {
              console.error("FREE HIT SEND FAILED:", {
                refId: matched.trade.refId,
                error: err?.message || String(err),
              });
            }
          }
        }

        await recordCloseStat({
          refId: matched.trade.refId,
          symbol: matched.trade.symbol,
          result: finalHitType,
          exitPrice,
          movePct: pctMove(matched.trade.side, matched.trade.entry, exitPrice),
          ts: receivedAtMs,
        });

        await markRecentHit(hitKey);
        await removeTrade(matched.key);

        console.log(`EXPLICIT CLOSE SENT (${matched.matchType}): ${symbol} ${finalHitType} REF ${matched.trade.refId}`);
        return;
      }

      console.log("EXPLICIT HIT RECEIVED BUT NO MATCHED TRADE FOUND:", {
        symbol,
        explicitHitType,
        incomingRef,
        candidateIdsBase,
        openTradesForSymbol: getOpenTradesForSymbol(symbol),
      });

      return;
    }

    // Infer hit from price on incoming webhook.
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
          hitPrice: currentPrice,
          chatId: CHAT_ID,
        });

        if (wasSharedToFree(trade.refId)) {
          try {
            await sendHitAlert({
              trade,
              hitType: inferredHit,
              hitPrice: currentPrice,
              chatId: FREE_CHAT_ID,
            });
          } catch (err) {
            console.error("FREE INFERRED HIT SEND FAILED:", {
              refId: trade.refId,
              error: err?.message || String(err),
            });
          }
        }

        await recordCloseStat({
          refId: trade.refId,
          symbol: trade.symbol,
          result: inferredHit,
          exitPrice: currentPrice,
          movePct: pctMove(trade.side, trade.entry, currentPrice),
          ts: receivedAtMs,
        });

        await markRecentHit(inferredHitKey);
        hitKeysToRemove.push(key);

        console.log(`INFERRED HIT SENT: ${symbol} ${inferredHit} REF ${trade.refId}`);
      }

      for (const key of hitKeysToRemove) {
        await removeTrade(key);
      }
    }

    // Normal signal.
    const isSignal = isLikelySignalEvent(eventType, side, entryParsed);

    if (!isSignal || !symbol || (side !== "LONG" && side !== "SHORT")) {
      console.log("NON-SIGNAL WEBHOOK RECEIVED:", { symbol, side, eventType });
      return;
    }

    if (!validLevels) {
      console.log("SIGNAL SKIPPED BECAUSE LEVELS INVALID:", {
        symbol,
        side,
        entry: entryParsed,
        tp: tpParsed,
        sl: slParsed,
      });
      return;
    }

    if (hasOpenTradeForSymbol(symbol)) {
      console.log("SIGNAL SKIPPED BY OPEN TRADE FILTER:", {
        symbol,
        openTradesForSymbol: countOpenTradesForSymbol(symbol),
        maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
      });
      return;
    }

    if (Number.isFinite(MIN_RR_TO_SEND) && MIN_RR_TO_SEND > 0 && (!Number.isFinite(rr) || rr < MIN_RR_TO_SEND)) {
      console.log("SIGNAL SKIPPED BY MIN RR FILTER:", {
        minRequired: MIN_RR_TO_SEND,
        symbol,
        rr: fmtRR(rr),
      });
      return;
    }

    const refId = incomingRef || allocNextRef();

    const candidateIds = uniqueStrings([...candidateIdsBase, refId]);
    const primaryAlertId = candidateIds[0] || refId;

    const chartAssets = await buildChartDeliveryAssets({
      symbol,
      side,
      refId,
      inlineBody: body,
    });

    const whyLine = buildWhyLine({
      body,
      symbol,
      side,
      setupType,
      marketRegime,
      session,
      confidence: confidenceLevel,
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
      setupType,
      setupScore: score,
      marketRegime,
      session,
      confidenceLevel,
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

    if (canSendFreeSignal(receivedAtMs)) {
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
      } catch (err) {
        console.error("FREE SIGNAL SEND FAILED:", {
          refId,
          error: err?.message || String(err),
        });
      }
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
      createdAtUtc: prettyTime,
      maxAgeMs: MAX_TRADE_AGE_MS,
      hit: false,
      hitType: null,
      hitAtMs: null,
      primaryAlertId,
      alertIds: candidateIds,
      setupType,
      setupScore: score,
      trendStrength,
      volatilityState,
      marketRegime,
      session,
      confidenceLevel,
      estimatedHoldDuration,
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
      setupScore: score,
      trendStrength,
      volatilityState,
      marketRegime,
      session,
      confidenceLevel,
      estimatedHoldDuration,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      rr,
      sharedToFree,
      ts: receivedAtMs,
    });

    console.log(`ALERT SENT: ${symbol} ${side} REF ${refId}`);

    console.log("ALERT DATA:", {
      version: APP_VERSION,
      symbol,
      side,
      entry: fmtPrice(entryParsed),
      tp: fmtPrice(tpParsed),
      sl: fmtPrice(slParsed),
      tpPct: fmtPct(tpPct),
      rr: fmtRR(rr),
      leverage,
      strength,
      setupType,
      setupScore: score,
      session,
      marketRegime,
      confidenceLevel,
      time: prettyTime,
      refId,
      primaryAlertId,
      imageUsed: sendResult.usedPhoto,
      storedForHits: true,
      activeTrades: activeTrades.size,
      eventType,
      candidateIds,
      freeEnabled: Boolean(FREE_CHAT_ID),
      sharedToFree,
      minRrToSend: MIN_RR_TO_SEND,
      maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
      nextRef,
    });
  } catch (err) {
    console.error("ERROR:", err);
  }
}

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
  console.log("VERSION:", APP_VERSION);

  console.log("REF SETTINGS:", {
    nextRef,
    refStartFloor: REF_START_FLOOR,
    safe: nextRef >= REF_START_FLOOR,
  });

  console.log("QUALITY FILTERS:", {
    minRrToSend: MIN_RR_TO_SEND,
    maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
    maxTradeAgeHours: MAX_TRADE_AGE_MS / 1000 / 60 / 60,
  });

  console.log("FREE CHANNEL:", {
    enabled: Boolean(FREE_CHAT_ID),
    freePostDate,
    freePostsToday,
    freeDailyLimit: FREE_DAILY_LIMIT,
    freeSharedRefs: freeSharedRefs.size,
    freeMembers: freeMembers.size,
  });

  console.log("PAID MEMBERS:", {
    paidMembers: paidMembers.size,
    paidChatId: PAID_TELEGRAM_CHAT_ID,
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
    console.log(`ALRT-Render ${APP_VERSION} running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("STARTUP ERROR:", err);
  process.exit(1);
});
