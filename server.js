import express from "express";
import fetch from "node-fetch";
import { promises as fs } from "fs";
import {
  ALERT_QUALITY_FILTER_ENABLED,
  ALLOWED_SYMBOLS,
  APP_BASE_URL,
  APP_VERSION,
  BOT_TOKEN,
  CANDIDATE_QUALITY_FILTER_ENABLED,
  CHAT_ID,
  CHART_IMAGE_TEMPLATE,
  DAILY_SL_CIRCUIT_BREAKER,
  DAILY_SUMMARY_ENABLED,
  DAILY_SUMMARY_UTC_HOUR,
  DAILY_SUMMARY_UTC_MINUTE,
  DATA_DIR,
  FREE_CHAT_ID,
  FREE_DAILY_LIMIT,
  FREE_REF_TTL_MS,
  HIT_DEDUP_TTL_MS,
  LOSS_GUARD_MARKET_COOLDOWN_MS,
  LOSS_GUARD_MARKET_LIMIT,
  LOSS_GUARD_MARKET_WINDOW_MS,
  LOSS_GUARD_RETENTION_MS,
  LOSS_GUARD_SYMBOL_COOLDOWN_MS,
  MAX_OPEN_TRADES_PER_SIDE,
  MAX_OPEN_TRADES_PER_SYMBOL,
  MAX_TRADE_AGE_MS,
  MIN_RR_TO_SEND,
  PAID_TELEGRAM_CHAT_ID,
  PORT,
  PUBLIC_SITE_URL,
  REF_START_FLOOR,
  ROOT_DIR,
  STATE_FILE,
  SUMMARY_ADMIN_TOKEN,
  SUPABASE_ENABLED,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "./src/config/env.js";
import { getSymbolConfig, isAllowedTradingSymbol } from "./src/config/symbols.js";
import { scoreAlertQuality } from "./src/services/alertScoring.js";
import { createChartService } from "./src/services/chartService.js";
import {
  appendChartLinkIfMissing,
  buildAlertText,
  buildHitText,
} from "./src/services/messageTemplates.js";
import { createInviteService } from "./src/services/inviteService.js";
import { buildDailySummaryText as buildDailySummaryMessage } from "./src/services/summaryService.js";
import { createSupabaseService } from "./src/services/supabaseService.js";
import { createTelegramService } from "./src/services/telegramService.js";
import { registerChartRoutes } from "./src/routes/chartRoutes.js";
import { registerMemberRoutes } from "./src/routes/memberRoutes.js";
import { registerSystemRoutes } from "./src/routes/systemRoutes.js";
import { eventTimeToMs, formatUtc, getUtcDateKey } from "./src/utils/date.js";
import { fmtPct, fmtPrice, fmtRR, parseNum } from "./src/utils/numbers.js";
import {
  escapeHtml,
  normalizeEmail,
  normalizeEventType,
  normalizeSetupType,
  normalizeSide,
  normalizeSymbol,
  pick,
  sanitizePayloadForStorage,
  uniqueStrings,
} from "./src/utils/payload.js";

const app = express();
const supabase = createSupabaseService({
  enabled: SUPABASE_ENABLED,
  url: SUPABASE_URL,
  serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
  backendVersion: APP_VERSION,
});
const chartService = createChartService({
  appBaseUrl: APP_BASE_URL,
  chartImageTemplate: CHART_IMAGE_TEMPLATE,
});
const inviteService = createInviteService({
  botToken: BOT_TOKEN,
  paidChatId: PAID_TELEGRAM_CHAT_ID,
  freeChatId: FREE_CHAT_ID,
});
let telegram = null;

// ===== STATE =====
const activeTrades = new Map();
const recentHitKeys = new Map();
const recentLossStops = new Map();
const freeSharedRefs = new Map();
const dailyStats = new Map();
const paidMembers = new Map();
const freeMembers = new Map();

let nextRef = REF_START_FLOOR;
let savePromise = Promise.resolve();
let freePostDate = "";
let freePostsToday = 0;
let lastSummarySentDate = "";

// ===== BODY PARSING NOTE =====
// Stripe raw webhook moet vóór express.json staan.
// Daarom wordt /webhook/stripe hieronder eerst geregistreerd.

// ===== BASIC HELPERS =====
function supabaseReady() {
  return supabase.ready();
}

function persistAlertToSupabase(payload) {
  supabase.persistAlert(payload);
}

function persistOutcomeToSupabase(payload) {
  supabase.persistOutcome(payload);
}

function persistRejectionToSupabase(payload) {
  supabase.persistRejection(payload);
}

function persistDailySummaryToSupabase(dateKey) {
  const stat = getDailyStat(dateKey);
  const closed =
    stat.tp +
    stat.sl +
    (stat.timeExitProfit || 0) +
    (stat.timeExitLoss || 0) +
    (stat.expired || 0);
  const wins = stat.tp + (stat.timeExitProfit || 0);
  const winrate = closed > 0 ? (wins / closed) * 100 : null;
  const openCount = Array.from(activeTrades.values()).filter((t) => !t.hit).length;

  supabase.persistDailySummary({ dateKey, stat, openCount, winrate });
}

function isMajorSymbol(symbol) {
  return Boolean(getSymbolConfig(symbol).major);
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

function slPctFromLevels(side, entry, sl) {
  const e = parseNum(entry);
  const s = parseNum(sl);

  if (!Number.isFinite(e) || !Number.isFinite(s) || e <= 0) return null;

  if (side === "LONG") return ((e - s) / e) * 100;
  if (side === "SHORT") return ((s - e) / e) * 100;

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

// Belangrijk: server mag geen absurde Pine-levels accepteren.
// Dit voorkomt opnieuw ETH 23% TP alerts.
function validateTradeSanity({ symbol, side, entry, tp, sl, rr }) {
  const e = parseNum(entry);
  const t = parseNum(tp);
  const s = parseNum(sl);
  const r = parseNum(rr);

  if (!hasValidTradeLevels(side, e, t, s)) {
    return { ok: false, reason: "invalid_trade_levels" };
  }

  const tpPct = Math.abs(tpPctFromLevels(side, e, t));
  const slPct = Math.abs(slPctFromLevels(side, e, s));

  const symbolConfig = getSymbolConfig(symbol);

  // Realistische harde caps voor 15M / intraday.
  // Per-symbol config voorkomt dat BTC en kleinere alts dezelfde caps krijgen.
  const maxTpPct = symbolConfig.maxTpPct;
  const maxSlPct = symbolConfig.maxSlPct;

  if (!Number.isFinite(tpPct) || tpPct <= 0) {
    return { ok: false, reason: "tp_pct_invalid" };
  }

  if (!Number.isFinite(slPct) || slPct <= 0) {
    return { ok: false, reason: "sl_pct_invalid" };
  }

  if (tpPct < symbolConfig.minTpPct) {
    return {
      ok: false,
      reason: "tp_pct_too_small",
      tpPct,
      minTpPct: symbolConfig.minTpPct,
    };
  }

  if (slPct < symbolConfig.minSlPct) {
    return {
      ok: false,
      reason: "sl_pct_too_small",
      slPct,
      minSlPct: symbolConfig.minSlPct,
    };
  }

  if (tpPct > maxTpPct) {
    return {
      ok: false,
      reason: "tp_pct_too_large",
      tpPct,
      maxTpPct,
    };
  }

  if (slPct > maxSlPct) {
    return {
      ok: false,
      reason: "sl_pct_too_large",
      slPct,
      maxSlPct,
    };
  }

  if (Number.isFinite(r) && r > 5.0) {
    return {
      ok: false,
      reason: "rr_unrealistic",
      rr: r,
    };
  }

  return {
    ok: true,
    tpPct,
    slPct,
    minTpPct: symbolConfig.minTpPct,
    minSlPct: symbolConfig.minSlPct,
  };
}

// Fallback levels alleen als Pine geen levels geeft.
// Maar ook fallback blijft realistisch gecapped.
function applyFallbackLevels(side, entry, strength, symbol) {
  const e = parseNum(entry);
  if (!Number.isFinite(e) || e <= 0) return { tp: null, sl: null };

  const symbolConfig = getSymbolConfig(symbol);

  const tpPct =
    strength === "A+"
      ? symbolConfig.fallbackTpPctAPlus
      : symbolConfig.fallbackTpPctA;

  const slPct = symbolConfig.fallbackSlPct;

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

function getStrengthBucket({ symbol, side, rsi, atrPct, score, risk, incomingStrength }) {
  const explicitStrength = String(incomingStrength || "").trim().toUpperCase();

  if (
    explicitStrength === "A+" ||
    explicitStrength === "A" ||
    explicitStrength === "B" ||
    explicitStrength === "C"
  ) {
    return explicitStrength;
  }

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
    if (numericRsi >= 60 && numericAtr <= 3.0) return "A+";
    if (numericRsi >= 54 && numericAtr <= 3.2) return "A";
    if (numericRsi >= 50) return "B";
    return "C";
  }

  if (side === "SHORT" && Number.isFinite(numericRsi)) {
    if (numericRsi <= 40 && numericAtr <= 3.0) return "A+";
    if (numericRsi <= 46 && numericAtr <= 3.2) return "A";
    if (numericRsi <= 50) return "B";
    return "C";
  }

  if (isMajorSymbol(symbol)) return "B";
  return "C";
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

  if (strength === "A+" || strength === "A") return getSymbolConfig(symbol).leverageStrong;
  return getSymbolConfig(symbol).leverageNormal;
}

function deriveSetupType({ body, side, rsi, atrPct }) {
  const explicit = normalizeSetupType(
    pick(body.setup_type, body.reason_type, body.setup, body.pattern, body.signal_name, body.strategy_name)
  );

  if (explicit && explicit !== "UNKNOWN") return explicit;

  const numericRsi = parseNum(rsi);
  const numericAtr = parseNum(atrPct);

  if (Number.isFinite(numericAtr) && numericAtr <= 1.0) return "COMPRESSION_BREAKOUT";

  if (side === "LONG") {
    if (Number.isFinite(numericRsi) && numericRsi < 42) return "LIQUIDITY_RECLAIM";
    if (Number.isFinite(numericRsi) && numericRsi >= 58) return "HTF_CONTINUATION";
    return "TREND_PULLBACK";
  }

  if (side === "SHORT") {
    if (Number.isFinite(numericRsi) && numericRsi > 58) return "LIQUIDITY_RECLAIM";
    if (Number.isFinite(numericRsi) && numericRsi <= 42) return "HTF_CONTINUATION";
    return "TREND_PULLBACK";
  }

  return "UNKNOWN";
}

function buildWhyLine({ body, symbol, side, setupType, strength, rr, session, marketRegime }) {
  const incomingReason = pick(body.reason, body.why, body.comment, body.market_bias);

  if (incomingReason && !/15m live event aligned/i.test(String(incomingReason))) {
    return String(incomingReason).trim();
  }

  const setupText = setupType || "structured setup";
  const sessionText = session ? `${session}` : "session OK";
  const regimeText = marketRegime ? `${marketRegime}` : "market OK";
  const directionText = side === "LONG" ? "upside follow-through" : "downside follow-through";

  return `${setupText} ${side}: ${regimeText} context, ${sessionText}, RR ${fmtRR(rr)}. Looking for ${directionText}; blocked if extended or after recent SL pressure.`;
}

// ===== REF HELPERS =====
function allocNextRef() {
  nextRef += 1;

  if (!Number.isFinite(nextRef) || nextRef < REF_START_FLOOR) {
    nextRef = REF_START_FLOOR;
  }

  return String(nextRef).padStart(6, "0");
}

async function allocSignalRef() {
  if (supabaseReady()) {
    try {
      const allocated = await supabase.rpc("next_alert_ref", {
        floor_value: Math.max(REF_START_FLOOR, Number(nextRef) || REF_START_FLOOR),
      });
      const numericRef = Number(allocated);

      if (Number.isFinite(numericRef) && numericRef >= REF_START_FLOOR) {
        nextRef = Math.max(nextRef, numericRef);
        return String(numericRef).padStart(6, "0");
      }
    } catch (err) {
      console.error("SUPABASE REF ALLOCATOR FAILED - FALLING BACK TO STATE REF:", err?.message || String(err));
    }
  }

  return allocNextRef();
}

function parseIncomingRef(body) {
  const raw = pick(body.ref_id, body.ref, body.reference, body.alert_ref);

  if (!raw) return null;

  const digits = String(raw).replace(/\D/g, "");

  if (digits.length === 6) return digits;

  return null;
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
      rejectedSignals: 0,
      rejectsByReason: {},

      oldClosures: {
        tp: 0,
        sl: 0,
        timeExitProfit: 0,
        timeExitLoss: 0,
        expired: 0,
      },
      orphanClosures: {
        tp: 0,
        sl: 0,
        timeExitProfit: 0,
        timeExitLoss: 0,
        expired: 0,
      },

      bySymbol: {},
      bySetup: {},
      byRef: {},
    });
  }

  const stat = dailyStats.get(dateKey);

  if (stat.timeExitProfit === undefined) stat.timeExitProfit = 0;
  if (stat.timeExitLoss === undefined) stat.timeExitLoss = 0;
  if (stat.expired === undefined) stat.expired = 0;
  if (stat.rejectedSignals === undefined) stat.rejectedSignals = 0;
  if (!stat.rejectsByReason) stat.rejectsByReason = {};
  if (!stat.oldClosures) {
    stat.oldClosures = {
      tp: 0,
      sl: 0,
      timeExitProfit: 0,
      timeExitLoss: 0,
      expired: 0,
    };
  }
  if (!stat.orphanClosures) {
    stat.orphanClosures = {
      tp: 0,
      sl: 0,
      timeExitProfit: 0,
      timeExitLoss: 0,
      expired: 0,
    };
  }
  if (!stat.bySymbol) stat.bySymbol = {};
  if (!stat.bySetup) stat.bySetup = {};
  if (!stat.byRef) stat.byRef = {};

  return stat;
}

function ensureSymbolStats(stat, symbol) {
  const key = symbol || "UNKNOWN";

  if (!stat.bySymbol[key]) {
    stat.bySymbol[key] = {
      alerts: 0,
      tp: 0,
      sl: 0,
      timeExitProfit: 0,
      timeExitLoss: 0,
      expired: 0,
    };
  }

  const s = stat.bySymbol[key];

  if (s.timeExitProfit === undefined) s.timeExitProfit = 0;
  if (s.timeExitLoss === undefined) s.timeExitLoss = 0;
  if (s.expired === undefined) s.expired = 0;

  return s;
}

function ensureSetupStats(stat, setupType) {
  const key = setupType || "UNKNOWN";

  if (!stat.bySetup[key]) {
    stat.bySetup[key] = {
      alerts: 0,
      tp: 0,
      sl: 0,
      timeExitProfit: 0,
      timeExitLoss: 0,
      expired: 0,
    };
  }

  const s = stat.bySetup[key];

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
  setupScore,
  qualityScore,
  qualityGrade,
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
  sharedToFree,
  ts = Date.now(),
}) {
  const dateKey = getUtcDateKey(ts);
  const stat = getDailyStat(dateKey);

  const symbolStat = ensureSymbolStats(stat, symbol);
  const setupStat = ensureSetupStats(stat, setupType);

  stat.alerts += 1;
  symbolStat.alerts += 1;
  setupStat.alerts += 1;

  if (sharedToFree) {
    stat.freeAlerts += 1;
  }

  stat.byRef[String(refId)] = {
    refId: String(refId),
    symbol,
    side,
    strength,
    setupType,
    setupScore,
    qualityScore,
    qualityGrade,
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
    openedDateKey: dateKey,
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

async function recordCloseStat({
  refId,
  symbol,
  setupType = "UNKNOWN",
  result,
  exitPrice = null,
  movePct = null,
  ts = Date.now(),
}) {
  const closeDateKey = getUtcDateKey(ts);
  let stat = getDailyStat(closeDateKey);
  let item = stat.byRef[String(refId)];
  let openedStat = stat;

  if (!item) {
    for (const [, dayStat] of dailyStats.entries()) {
      const found = dayStat?.byRef?.[String(refId)];

      if (found) {
        item = found;
        openedStat = dayStat;
        break;
      }
    }
  }

  const openedDateKey = item?.openedDateKey || item?.openedAtUtc?.slice(0, 10) || null;
  const belongsToToday = openedDateKey === closeDateKey;

  const targetStat = belongsToToday ? openedStat : stat;
  const finalSetupType = item?.setupType || setupType || "UNKNOWN";

  if (item?.result && item.result !== "OPEN") {
    console.log("CLOSE STAT IGNORED - REF ALREADY CLOSED:", {
      refId,
      oldResult: item.result,
      newResult: result,
    });
    return false;
  }

  if (!item) {
    const orphan = stat.orphanClosures || {
      tp: 0,
      sl: 0,
      timeExitProfit: 0,
      timeExitLoss: 0,
      expired: 0,
    };

    if (result === "TP") orphan.tp += 1;
    if (result === "SL") orphan.sl += 1;
    if (result === "TIME_EXIT_PROFIT") orphan.timeExitProfit += 1;
    if (result === "TIME_EXIT_LOSS") orphan.timeExitLoss += 1;
    if (result === "EXPIRED") orphan.expired += 1;

    stat.orphanClosures = orphan;
  } else if (belongsToToday) {
    const symbolStat = ensureSymbolStats(targetStat, symbol);
    const setupStat = ensureSetupStats(targetStat, finalSetupType);

    if (result === "TP") {
      targetStat.tp += 1;
      symbolStat.tp += 1;
      setupStat.tp += 1;
    }

    if (result === "SL") {
      targetStat.sl += 1;
      symbolStat.sl += 1;
      setupStat.sl += 1;
    }

    if (result === "TIME_EXIT_PROFIT") {
      targetStat.timeExitProfit += 1;
      symbolStat.timeExitProfit += 1;
      setupStat.timeExitProfit += 1;
    }

    if (result === "TIME_EXIT_LOSS") {
      targetStat.timeExitLoss += 1;
      symbolStat.timeExitLoss += 1;
      setupStat.timeExitLoss += 1;
    }

    if (result === "EXPIRED") {
      targetStat.expired += 1;
      symbolStat.expired += 1;
      setupStat.expired += 1;
    }
  } else {
    const old = stat.oldClosures || {
      tp: 0,
      sl: 0,
      timeExitProfit: 0,
      timeExitLoss: 0,
      expired: 0,
    };

    if (result === "TP") old.tp += 1;
    if (result === "SL") old.sl += 1;
    if (result === "TIME_EXIT_PROFIT") old.timeExitProfit += 1;
    if (result === "TIME_EXIT_LOSS") old.timeExitLoss += 1;
    if (result === "EXPIRED") old.expired += 1;

    stat.oldClosures = old;
  }

  if (item) {
    item.result = result;
    item.closedAtMs = ts;
    item.closedAtUtc = formatUtc(ts);
    item.exitPrice = exitPrice;
    item.movePct = movePct;
    item.closedDateKey = closeDateKey;
  } else {
    stat.byRef[String(refId)] = {
      refId: String(refId),
      symbol,
      setupType: finalSetupType,
      result,
      openedDateKey: null,
      openedAtMs: null,
      openedAtUtc: null,
      closedDateKey: closeDateKey,
      closedAtMs: ts,
      closedAtUtc: formatUtc(ts),
      exitPrice,
      movePct,
      orphanClose: true,
    };
  }

  await persistState();
  return true;
}

async function recordRejectStat({
  symbol,
  side,
  setupType = "UNKNOWN",
  reason,
  qualityScore = null,
  qualityGrade = null,
  rawPayload = null,
  ts = Date.now(),
}) {
  const stat = getDailyStat(getUtcDateKey(ts));
  const reasonKey = String(reason || "unknown").toLowerCase();

  stat.rejectedSignals += 1;
  stat.rejectsByReason[reasonKey] = (stat.rejectsByReason[reasonKey] || 0) + 1;

  const symbolStat = ensureSymbolStats(stat, symbol || "UNKNOWN");
  symbolStat.rejected = (symbolStat.rejected || 0) + 1;

  const setupStat = ensureSetupStats(stat, setupType || "UNKNOWN");
  setupStat.rejected = (setupStat.rejected || 0) + 1;

  await persistState();

  persistRejectionToSupabase({
    symbol,
    side,
    setupType,
    reason,
    qualityScore,
    qualityGrade,
    rawPayload,
  });
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

// ===== HIT / MATCH HELPERS =====
function normalizeCloseResult(hitType) {
  const x = normalizeEventType(hitType);

  if (x === "tp" || x === "tp_hit" || x.includes("take_profit")) return "TP";
  if (x === "sl" || x === "sl_hit" || x.includes("stop_loss")) return "SL";
  if (x === "time_exit_profit") return "TIME_EXIT_PROFIT";
  if (x === "time_exit_loss") return "TIME_EXIT_LOSS";
  if (x === "expired" || x === "time_exit") return "EXPIRED";

  return null;
}

function detectExplicitCloseType(eventType, body) {
  const normalized = normalizeEventType(eventType);
  const hitType = normalizeEventType(pick(body.hit_type, body.result, "") || "");
  const rawText = JSON.stringify(body).toLowerCase();

  const direct = normalizeCloseResult(normalized) || normalizeCloseResult(hitType);
  if (direct) return direct;

  if (rawText.includes("tp_hit") || rawText.includes("take_profit")) return "TP";
  if (rawText.includes("sl_hit") || rawText.includes("stop_loss")) return "SL";
  if (rawText.includes("time_exit_profit")) return "TIME_EXIT_PROFIT";
  if (rawText.includes("time_exit_loss")) return "TIME_EXIT_LOSS";
  if (rawText.includes("expired")) return "EXPIRED";

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

function buildRecentHitKey({ symbol, closeType, refId, eventTime }) {
  return `${symbol}|${closeType}|${refId}|${String(eventTime || "")}`;
}

function wasRecentHitSent(hitKey) {
  return recentHitKeys.has(hitKey);
}

async function markRecentHit(hitKey) {
  recentHitKeys.set(hitKey, Date.now());
  await persistState();
}

function registerLossStop(trade, closeType, ts) {
  if (!trade || closeType !== "SL") return;

  const atMs = Number.isFinite(Number(ts)) ? Number(ts) : Date.now();
  const key = `${trade.symbol}|${trade.side}|${trade.refId}|${atMs}`;

  recentLossStops.set(key, {
    symbol: trade.symbol,
    side: trade.side,
    setupType: trade.setupType || "UNKNOWN",
    refId: trade.refId,
    atMs,
    atUtc: new Date(atMs).toISOString(),
  });
}

function getFreshLossStops(now = Date.now()) {
  return Array.from(recentLossStops.values()).filter((item) => {
    if (!item?.atMs) return false;
    return now - Number(item.atMs) <= LOSS_GUARD_RETENTION_MS;
  });
}

function getLossGuardBlock({ symbol, side, now = Date.now() }) {
  const recentStops = getFreshLossStops(now);
  const sameSymbolSide = recentStops
    .filter((item) => item.symbol === symbol && item.side === side)
    .sort((a, b) => Number(b.atMs) - Number(a.atMs));

  const latestSymbolStop = sameSymbolSide[0];

  if (latestSymbolStop && now - Number(latestSymbolStop.atMs) <= LOSS_GUARD_SYMBOL_COOLDOWN_MS) {
    return {
      blocked: true,
      reason: "loss_guard_symbol",
      latestRef: latestSymbolStop.refId,
      latestAtUtc: latestSymbolStop.atUtc,
      cooldownMinutes: Math.round(LOSS_GUARD_SYMBOL_COOLDOWN_MS / 60000),
    };
  }

  const marketSideStops = recentStops
    .filter((item) => item.side === side && now - Number(item.atMs) <= LOSS_GUARD_MARKET_WINDOW_MS)
    .sort((a, b) => Number(b.atMs) - Number(a.atMs));

  if (marketSideStops.length >= LOSS_GUARD_MARKET_LIMIT) {
    const latestMarketStop = marketSideStops[0];

    if (now - Number(latestMarketStop.atMs) <= LOSS_GUARD_MARKET_COOLDOWN_MS) {
      return {
        blocked: true,
        reason: "loss_guard_market",
        stopCount: marketSideStops.length,
        latestRef: latestMarketStop.refId,
        latestAtUtc: latestMarketStop.atUtc,
        cooldownMinutes: Math.round(LOSS_GUARD_MARKET_COOLDOWN_MS / 60000),
      };
    }
  }

  return { blocked: false };
}

function findTradeByRefId(refId) {
  if (!refId) return null;

  for (const [key, trade] of activeTrades.entries()) {
    if (trade.hit) continue;

    if (String(trade.refId) === String(refId)) {
      return {
        key,
        trade,
        matchType: "ref_id",
        score: 2000,
      };
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
      return {
        key,
        trade,
        matchType: "candidate_id",
        score: 1000,
      };
    }
  }

  return null;
}

// Alleen voor infer hits vanuit actuele prijs.
// Niet meer gebruiken voor explicit Pine closures.
function findLatestOpenTradeBySymbolForInferenceOnly(symbol) {
  let latest = null;

  for (const [key, trade] of activeTrades.entries()) {
    if (trade.symbol !== symbol) continue;
    if (trade.hit) continue;

    if (!latest || trade.createdAtMs > latest.trade.createdAtMs) {
      latest = {
        key,
        trade,
        matchType: "symbol_latest_inference_only",
        score: 500,
      };
    }
  }

  return latest;
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

function countOpenTradesForSide(side) {
  let count = 0;

  for (const [, trade] of activeTrades.entries()) {
    if (!trade) continue;
    if (trade.hit) continue;
    if (trade.side === side) count += 1;
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

telegram = createTelegramService({
  botToken: BOT_TOKEN,
  defaultChatId: CHAT_ID,
  appendChartLinkIfMissing,
});

// ===== DAILY SUMMARY =====
function buildDailySummaryText(dateKey) {
  const stat = getDailyStat(dateKey);

  return buildDailySummaryMessage({
    dateKey,
    stat,
    activeTrades: Array.from(activeTrades.values()),
  });
}

async function sendDailySummary(dateKey, force = false) {
  if (!DAILY_SUMMARY_ENABLED && !force) return false;
  if (!force && lastSummarySentDate === dateKey) return false;

  const text = buildDailySummaryText(dateKey);

  await sendTelegramMessage(text, CHAT_ID);

  if (FREE_CHAT_ID) {
    await sendTelegramMessage(text, FREE_CHAT_ID);
  }

  persistDailySummaryToSupabase(dateKey);

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
        version: APP_VERSION,
        nextRef,
        refStartFloor: REF_START_FLOOR,
        activeTrades: Array.from(activeTrades.entries()).map(([key, trade]) => [key, trade]),
        recentHitKeys: Array.from(recentHitKeys.entries()).map(([key, ts]) => [key, ts]),
        recentLossStops: Array.from(recentLossStops.entries()).map(([key, info]) => [key, info]),
        freePostDate,
        freePostsToday,
        freeSharedRefs: Array.from(freeSharedRefs.entries()).map(([refId, info]) => [refId, info]),
        dailyStats: Array.from(dailyStats.entries()).map(([dateKey, stat]) => [dateKey, stat]),
        lastSummarySentDate,
        paidMembers: Array.from(paidMembers.entries()).map(([email, info]) => [email, info]),
        freeMembers: Array.from(freeMembers.entries()).map(([email, info]) => [email, info]),
      };

      const serialized = JSON.stringify(payload, null, 2);
      const tmpFile = `${STATE_FILE}.tmp`;
      const backupFile = `${STATE_FILE}.bak`;

      await fs.writeFile(tmpFile, serialized, "utf8");

      try {
        await fs.copyFile(STATE_FILE, backupFile);
      } catch (err) {
        if (err.code !== "ENOENT") {
          console.error("PERSIST BACKUP ERROR:", err);
        }
      }

      await fs.rename(tmpFile, STATE_FILE);
    })
    .catch((err) => {
      console.error("PERSIST SAVE ERROR:", err);
    });

  return savePromise;
}

async function readStatePayload() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") throw err;

    console.error("PRIMARY STATE READ FAILED, TRYING BACKUP:", err?.message || String(err));

    const rawBackup = await fs.readFile(`${STATE_FILE}.bak`, "utf8");
    return JSON.parse(rawBackup);
  }
}

async function loadState() {
  try {
    await ensureDataDir();

    const parsed = await readStatePayload();

    const active = Array.isArray(parsed?.activeTrades) ? parsed.activeTrades : [];
    const hits = Array.isArray(parsed?.recentHitKeys) ? parsed.recentHitKeys : [];
    const lossStops = Array.isArray(parsed?.recentLossStops) ? parsed.recentLossStops : [];
    const freeRefs = Array.isArray(parsed?.freeSharedRefs) ? parsed.freeSharedRefs : [];
    const stats = Array.isArray(parsed?.dailyStats) ? parsed.dailyStats : [];

    const now = Date.now();

    if (Number.isFinite(Number(parsed?.nextRef))) {
      nextRef = Math.max(REF_START_FLOOR, Number(parsed.nextRef));
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

      activeTrades.set(key, trade);
    }

    for (const item of hits) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [key, ts] = item;

      if (!ts || now - ts > HIT_DEDUP_TTL_MS) continue;

      recentHitKeys.set(key, ts);
    }

    for (const item of lossStops) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [key, info] = item;
      const atMs = Number(info?.atMs);

      if (!key || !Number.isFinite(atMs)) continue;
      if (now - atMs > LOSS_GUARD_RETENTION_MS) continue;

      recentLossStops.set(String(key), info);
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
    console.log(`Loaded ${recentLossStops.size} recent loss stops from disk`);
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
  if (activeTrades.delete(tradeKey)) {
    await persistState();
  }
}

async function upsertTrade(tradeKey, trade) {
  activeTrades.set(tradeKey, trade);
  await persistState();
}

function cleanupState() {
  const now = Date.now();
  let changed = false;

  for (const [key, ts] of recentHitKeys.entries()) {
    if (!ts || now - ts > HIT_DEDUP_TTL_MS) {
      recentHitKeys.delete(key);
      changed = true;
    }
  }

  for (const [key, info] of recentLossStops.entries()) {
    if (!info?.atMs || now - Number(info.atMs) > LOSS_GUARD_RETENTION_MS) {
      recentLossStops.delete(key);
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

// ===== TELEGRAM =====
async function sendTelegramMessage(text, chatId = CHAT_ID) {
  return telegram.sendMessage(text, chatId);
}

async function sendTelegramPhoto({
  photoUrl = null,
  photoBuffer = null,
  filename = "chart.png",
  caption = "",
  chatId = CHAT_ID,
}) {
  return telegram.sendPhoto({ photoUrl, photoBuffer, filename, caption, chatId });
}

async function sendTelegramAlert({
  text,
  imageUrl = null,
  imageBuffer = null,
  imageFilename = "chart.png",
  fallbackChartLink = "N/A",
  chatId = CHAT_ID,
}) {
  return telegram.sendAlert({
    text,
    imageUrl,
    imageBuffer,
    imageFilename,
    fallbackChartLink,
    chatId,
  });
}

async function sendHitAlert({
  trade,
  closeType,
  hitPrice = null,
  chatId = CHAT_ID,
}) {
  const exitPrice =
    closeType === "TP"
      ? trade.tp
      : closeType === "SL"
      ? trade.sl
      : Number.isFinite(parseNum(hitPrice))
      ? parseNum(hitPrice)
      : trade.entry;

  const movePct = pctMove(trade.side, trade.entry, exitPrice);
  const chartLink = trade.chartLink || chartService.resolveChartLink(trade.symbol);

  const chartAssets = await chartService.buildChartDeliveryAssets({
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
    closeType,
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

  return {
    exitPrice,
    movePct,
  };
}

// ===== CENTRAL CLOSE FLOW =====
async function closeTrade({
  matched,
  closeType,
  eventTime,
  currentPrice,
  source = "unknown",
}) {
  if (!matched?.trade || !matched?.key) {
    return false;
  }

  const trade = matched.trade;
  const closedAtMs = eventTimeToMs(eventTime);
  const hitEventBucket = Number.isFinite(closedAtMs) ? Math.floor(closedAtMs / 60000) : eventTime;

  const hitKey = buildRecentHitKey({
    symbol: trade.symbol,
    closeType,
    refId: trade.refId,
    eventTime: hitEventBucket,
  });

  if (wasRecentHitSent(hitKey)) {
    console.log("DUPLICATE CLOSE IGNORED:", {
      symbol: trade.symbol,
      closeType,
      refId: trade.refId,
      eventTime,
      source,
    });
    return false;
  }

  let finalCloseType = closeType;
  let exitPrice = currentPrice;

  if (closeType === "EXPIRED") {
    exitPrice = Number.isFinite(parseNum(currentPrice)) ? parseNum(currentPrice) : trade.entry;
    finalCloseType = getTimeExitResult(trade, exitPrice);
  }

  trade.hit = true;
  trade.hitType = finalCloseType;
  trade.hitAtMs = closedAtMs;

  const sent = await sendHitAlert({
    trade,
    closeType: finalCloseType,
    hitPrice: exitPrice,
    chatId: CHAT_ID,
  });

  if (wasSharedToFree(trade.refId)) {
    try {
      await sendHitAlert({
        trade,
        closeType: finalCloseType,
        hitPrice: exitPrice,
        chatId: FREE_CHAT_ID,
      });
    } catch (err) {
      console.error("FREE CLOSE SEND FAILED:", {
        refId: trade.refId,
        error: err?.message || String(err),
      });
    }
  }

  await recordCloseStat({
    refId: trade.refId,
    symbol: trade.symbol,
    setupType: trade.setupType || "UNKNOWN",
    result: finalCloseType,
    exitPrice: sent.exitPrice,
    movePct: sent.movePct,
    ts: closedAtMs,
  });

  persistOutcomeToSupabase({
    trade,
    outcomeType: finalCloseType,
    outcomeTimeMs: closedAtMs,
    pnlPercent: sent.movePct,
    durationMinutes: Number.isFinite(closedAtMs) && Number.isFinite(trade.createdAtMs)
      ? Math.max(0, Math.round((closedAtMs - trade.createdAtMs) / 60000))
      : null,
    exitPrice: sent.exitPrice,
    rawPayload: {
      source,
      matchType: matched.matchType,
    },
  });

  registerLossStop(trade, finalCloseType, closedAtMs);
  await markRecentHit(hitKey);
  await removeTrade(matched.key);

  console.log("TRADE CLOSED:", {
    symbol: trade.symbol,
    side: trade.side,
    refId: trade.refId,
    closeType: finalCloseType,
    source,
    matchType: matched.matchType,
    exitPrice: fmtPrice(sent.exitPrice),
    movePct: fmtPct(sent.movePct, { signed: true }),
  });

  return true;
}
// ===== STRIPE / MEMBER HELPERS =====
async function createTelegramInviteLink({ expireHours = 48 } = {}) {
  return inviteService.createPaidInviteLink({ expireHours });
}

async function createFreeTelegramInviteLink({ expireHours = 48 } = {}) {
  return inviteService.createFreeInviteLink({ expireHours });
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

    const email = normalizeEmail(
      pick(session.customer_details?.email, session.customer_email)
    );

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

    await sendTelegramMessage(
`🔥 <b>NEW PAID MEMBER</b>

<b>Email</b> ${escapeHtml(email)}
<b>Status</b> active
<b>Customer</b> ${escapeHtml(session.customer || "N/A")}
<b>Subscription</b> ${escapeHtml(session.subscription || "N/A")}

<b>Invite Link</b>
${inviteLink}`
    );

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

    const found = findPaidMemberByStripe({
      stripeCustomerId,
      stripeSubscriptionId,
    });

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

    if (event.type === "invoice.payment_succeeded") {
      newStatus = "active";
    }

    if (event.type === "invoice.payment_failed") {
      newStatus = "past_due";
    }

    if (event.type === "customer.subscription.deleted") {
      newStatus = "cancelled";
    }

    if (event.type === "customer.subscription.updated") {
      const stripeStatus = String(obj.status || "").toLowerCase();

      if (stripeStatus === "active" || stripeStatus === "trialing") {
        newStatus = "active";
      } else if (stripeStatus === "past_due") {
        newStatus = "past_due";
      } else if (
        stripeStatus === "canceled" ||
        stripeStatus === "cancelled" ||
        stripeStatus === "unpaid" ||
        stripeStatus === "incomplete_expired"
      ) {
        newStatus = stripeStatus;
      }
    }

    member.status = newStatus;
    member.active = newStatus === "active";
    member.updatedAt = new Date().toISOString();
    member.lastStripeEvent = event.type;

    paidMembers.set(email, member);
    await persistState();

    await sendTelegramMessage(
`⚠️ <b>PAID MEMBER ACCESS UPDATE</b>

<b>Email</b> ${escapeHtml(email)}
<b>Status</b> ${escapeHtml(newStatus)}
<b>Stripe Event</b> ${escapeHtml(event.type)}`
    );
  }
}

// Stripe raw body route MUST be before express.json()
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

// ===== ROUTES =====
registerChartRoutes(app, {
  rootDir: ROOT_DIR,
  chartService,
});

function getHealthState() {
  resetFreeCounterIfNeeded(Date.now());

  return {
    supabaseReady: supabaseReady(),
    activeTrades: activeTrades.size,
    recentHitKeys: recentHitKeys.size,
    recentLossStops: recentLossStops.size,
    nextRef,
    freePostDate,
    freePostsToday,
    freeSharedRefs: freeSharedRefs.size,
    dailyStatsDays: dailyStats.size,
    lastSummarySentDate,
    paidMembers: paidMembers.size,
    freeMembers: freeMembers.size,
  };
}

registerSystemRoutes(app, {
  config: {
    appVersion: APP_VERSION,
    dataDir: DATA_DIR,
    stateFile: STATE_FILE,
    supabaseEnabled: SUPABASE_ENABLED,
    refStartFloor: REF_START_FLOOR,
    maxTradeAgeMs: MAX_TRADE_AGE_MS,
    lossGuardSymbolCooldownMs: LOSS_GUARD_SYMBOL_COOLDOWN_MS,
    lossGuardMarketWindowMs: LOSS_GUARD_MARKET_WINDOW_MS,
    lossGuardMarketCooldownMs: LOSS_GUARD_MARKET_COOLDOWN_MS,
    lossGuardMarketLimit: LOSS_GUARD_MARKET_LIMIT,
    minRrToSend: MIN_RR_TO_SEND,
    maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
    maxOpenTradesPerSide: MAX_OPEN_TRADES_PER_SIDE,
    dailySlCircuitBreaker: DAILY_SL_CIRCUIT_BREAKER,
    alertQualityFilterEnabled: ALERT_QUALITY_FILTER_ENABLED,
    candidateQualityFilterEnabled: CANDIDATE_QUALITY_FILTER_ENABLED,
    allowedSymbols: ALLOWED_SYMBOLS,
    freeChatId: FREE_CHAT_ID,
    freeDailyLimit: FREE_DAILY_LIMIT,
    dailySummaryEnabled: DAILY_SUMMARY_ENABLED,
    dailySummaryUtcHour: DAILY_SUMMARY_UTC_HOUR,
    dailySummaryUtcMinute: DAILY_SUMMARY_UTC_MINUTE,
    summaryAdminToken: SUMMARY_ADMIN_TOKEN,
  },
  getHealthState,
  sendDailySummary,
  getUtcDateKey,
});

registerMemberRoutes(app, {
  summaryAdminToken: SUMMARY_ADMIN_TOKEN,
  getFreeMember: (email) => freeMembers.get(email),
  setFreeMember: (email, member) => freeMembers.set(email, member),
  getPaidMembers: () => Array.from(paidMembers.values()),
  getFreeMembers: () => Array.from(freeMembers.values()),
  createFreeInviteLink: createFreeTelegramInviteLink,
  persistState,
  sendTelegramMessage,
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
    const score = pick(body.setup_score, body.score, body.strength_score);
    const risk = pick(body.risk, body.risk_score);
    const incomingStrength = pick(body.strength, body.grade, body.quality);

    const setupScore = pick(body.setup_score, body.score);
    const trendStrength = pick(body.trend_strength, body.adx);
    const volatilityState = pick(body.volatility_state, body.market_regime);
    const marketRegime = pick(body.market_regime, body.volatility_state);
    const session = pick(body.session, body.session_name);
    const confidenceLevel = pick(body.confidence_level, body.confidence);
    const estimatedHoldDuration = pick(body.estimated_hold_duration, body.hold_duration);
    const timeframe = pick(body.tf, body.timeframe, body.interval);
    const pineVersion = pick(body.version, body.pine_version, body.engine_version);

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

    const normalizedEventType = normalizeEventType(eventType);
    const isCandidateEvent =
      normalizedEventType.includes("candidate") ||
      normalizedEventType.includes("setup_candidate") ||
      normalizedEventType.includes("trade_candidate");

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

    const entryParsed = parseNum(entryRaw);
    let tpParsed = parseNum(tpRaw);
    let slParsed = parseNum(slRaw);

    const validIncomingLevels = hasValidTradeLevels(side, entryParsed, tpParsed, slParsed);

    if (!validIncomingLevels && Number.isFinite(entryParsed) && (side === "LONG" || side === "SHORT")) {
      const derived = applyFallbackLevels(side, entryParsed, strength, symbol);
      tpParsed = derived.tp;
      slParsed = derived.sl;
    }

    const rr = rrFromLevels(side, entryParsed, tpParsed, slParsed);
    const tpPct = tpPctFromLevels(side, entryParsed, tpParsed);

    const incomingRef = parseIncomingRef(body);
    const explicitCloseType = detectExplicitCloseType(eventType, body);

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

    const chartLink = chartService.resolveChartLink(symbol);

    console.log("WEBHOOK RECEIVED:", {
      version: APP_VERSION,
      symbol,
      side,
      eventType,
      explicitCloseType,
      entry: fmtPrice(entryParsed),
      tp: fmtPrice(tpParsed),
      sl: fmtPrice(slParsed),
      rr: fmtRR(rr),
      strength,
      setupType,
      currentPrice: fmtPrice(currentPrice),
      activeTrades: activeTrades.size,
      nextRef,
    });

    // ===== SERVER TIME EXIT CHECK =====
    // Alleen als er voor dit symbool een nieuwe webhook binnenkomt.
    // Pine time-exits blijven leidend.
    if (symbol) {
      for (const [key, trade] of Array.from(activeTrades.entries())) {
        if (trade.symbol !== symbol) continue;
        if (trade.hit) continue;

        const ageMs = receivedAtMs - (trade.createdAtMs || receivedAtMs);

        if (ageMs >= MAX_TRADE_AGE_MS) {
          const finalPrice = Number.isFinite(currentPrice) ? currentPrice : trade.entry;
          const result = getTimeExitResult(trade, finalPrice);

          await closeTrade({
            matched: {
              key,
              trade,
              matchType: "server_time_exit",
            },
            closeType: result,
            eventTime,
            currentPrice: finalPrice,
            source: "server_time_exit",
          });
        }
      }
    }

    // ===== EXPLICIT PINE CLOSES =====
    // Belangrijk: GEEN latest-symbol fallback meer.
    // Alleen ref/candidate ID matching.
    if (explicitCloseType && symbol) {
      const matched =
        findOpenTradeByCandidateIds(candidateIdsBase) ||
        findTradeByRefId(incomingRef);

      if (matched) {
        await closeTrade({
          matched,
          closeType: explicitCloseType,
          eventTime,
          currentPrice,
          source: "explicit_pine_close",
        });

        return;
      }

      console.log("EXPLICIT CLOSE RECEIVED BUT NO MATCHED TRADE FOUND - IGNORING OLD/UNMATCHED CLOSE:", {
        symbol,
        explicitCloseType,
        incomingRef,
        candidateIdsBase,
        openTradesForSymbol: getOpenTradesForSymbol(symbol),
      });

      await recordRejectStat({
        symbol,
        side,
        setupType,
        reason: `unmatched_${String(explicitCloseType).toLowerCase()}`,
        ts: receivedAtMs,
      });

      return;
    }

    // ===== INFER HITS FROM PRICE =====
    // Alleen voor eigen open trades en alleen als prijs level raakt.
    if (symbol && Number.isFinite(currentPrice)) {
      const hitKeysToRemove = [];

      for (const [key, trade] of activeTrades.entries()) {
        if (trade.symbol !== symbol) continue;
        if (trade.hit) continue;

        const inferredHit = shouldInferHit(trade, currentPrice);
        if (!inferredHit) continue;

        const inferredHitKey = `${symbol}|${trade.refId}|${inferredHit}|${Math.floor(receivedAtMs / 60000)}`;
        if (wasRecentHitSent(inferredHitKey)) continue;

        const closed = await closeTrade({
          matched: {
            key,
            trade,
            matchType: "price_inference",
          },
          closeType: inferredHit,
          eventTime: receivedAtMs,
          currentPrice,
          source: "price_inference",
        });

        if (closed) {
          hitKeysToRemove.push(key);
        }
      }
    }

    // ===== NORMAL SIGNAL =====
    const isSignal = isLikelySignalEvent(eventType, side, entryParsed);

    if (!isSignal || !symbol || (side !== "LONG" && side !== "SHORT")) {
      console.log("NON-SIGNAL WEBHOOK RECEIVED:", {
        symbol,
        side,
        eventType,
      });
      return;
    }

    if (!isAllowedTradingSymbol(symbol, ALLOWED_SYMBOLS)) {
      console.log("SIGNAL SKIPPED BY SYMBOL FILTER:", {
        symbol,
        allowedSymbols: ALLOWED_SYMBOLS,
      });
      await recordRejectStat({
        symbol,
        side,
        setupType,
        reason: "symbol_filter",
        ts: receivedAtMs,
      });
      return;
    }

    const symbolConfig = getSymbolConfig(symbol);

    const sanity = validateTradeSanity({
      symbol,
      side,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      rr,
    });

    if (!sanity.ok) {
      console.log("SIGNAL SKIPPED BY SANITY FILTER:", {
        reason: sanity.reason,
        symbol,
        side,
        entry: fmtPrice(entryParsed),
        tp: fmtPrice(tpParsed),
        sl: fmtPrice(slParsed),
        rr: fmtRR(rr),
        tpPct: sanity.tpPct,
        slPct: sanity.slPct,
        minTpPct: sanity.minTpPct,
        minSlPct: sanity.minSlPct,
        maxTpPct: sanity.maxTpPct,
        maxSlPct: sanity.maxSlPct,
      });
      await recordRejectStat({
        symbol,
        side,
        setupType,
        reason: sanity.reason || "sanity_filter",
        ts: receivedAtMs,
      });
      return;
    }

    if (hasOpenTradeForSymbol(symbol)) {
      console.log("SIGNAL SKIPPED BY OPEN TRADE FILTER:", {
        symbol,
        openTradesForSymbol: countOpenTradesForSymbol(symbol),
        maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
      });
      await recordRejectStat({
        symbol,
        side,
        setupType,
        reason: "open_trade_filter",
        ts: receivedAtMs,
      });
      return;
    }

    const todayStat = getDailyStat(getUtcDateKey(receivedAtMs));

    if (DAILY_SL_CIRCUIT_BREAKER > 0 && (todayStat.sl || 0) >= DAILY_SL_CIRCUIT_BREAKER) {
      console.log("SIGNAL SKIPPED BY DAILY SL CIRCUIT BREAKER:", {
        symbol,
        side,
        setupType,
        slToday: todayStat.sl || 0,
        dailySlCircuitBreaker: DAILY_SL_CIRCUIT_BREAKER,
      });
      await recordRejectStat({
        symbol,
        side,
        setupType,
        reason: "daily_sl_circuit_breaker",
        ts: receivedAtMs,
      });
      return;
    }

    const openTradesForSide = countOpenTradesForSide(side);

    if (openTradesForSide >= MAX_OPEN_TRADES_PER_SIDE) {
      console.log("SIGNAL SKIPPED BY SIDE EXPOSURE FILTER:", {
        symbol,
        side,
        openTradesForSide,
        maxOpenTradesPerSide: MAX_OPEN_TRADES_PER_SIDE,
      });
      await recordRejectStat({
        symbol,
        side,
        setupType,
        reason: "side_exposure_filter",
        ts: receivedAtMs,
      });
      return;
    }

    const lossGuard = getLossGuardBlock({
      symbol,
      side,
      now: receivedAtMs,
    });

    if (lossGuard.blocked) {
      console.log("SIGNAL SKIPPED BY LOSS GUARD:", {
        reason: lossGuard.reason,
        symbol,
        side,
        setupType,
        latestRef: lossGuard.latestRef,
        latestAtUtc: lossGuard.latestAtUtc,
        stopCount: lossGuard.stopCount,
        cooldownMinutes: lossGuard.cooldownMinutes,
      });
      await recordRejectStat({
        symbol,
        side,
        setupType,
        reason: lossGuard.reason,
        ts: receivedAtMs,
      });
      return;
    }

    const effectiveMinRr =
      Number.isFinite(MIN_RR_TO_SEND) && MIN_RR_TO_SEND > 0
        ? MIN_RR_TO_SEND
        : symbolConfig.minRr;

    if (Number.isFinite(effectiveMinRr) && effectiveMinRr > 0 && (!Number.isFinite(rr) || rr < effectiveMinRr)) {
      console.log("SIGNAL SKIPPED BY MIN RR FILTER:", {
        minRequired: effectiveMinRr,
        symbol,
        rr: fmtRR(rr),
      });
      await recordRejectStat({
        symbol,
        side,
        setupType,
        reason: "min_rr_filter",
        ts: receivedAtMs,
      });
      return;
    }

    const quality = scoreAlertQuality({
      symbolConfig,
      side,
      setupType,
      rr,
      tpPct,
      slPct: sanity.slPct,
      strength,
      setupScore,
      trendStrength,
      volatilityState,
      marketRegime,
      session,
      rsi,
      atrPct,
    });

    const enforceQualityFilter =
      ALERT_QUALITY_FILTER_ENABLED ||
      (CANDIDATE_QUALITY_FILTER_ENABLED && isCandidateEvent);

    if (enforceQualityFilter && !quality.passed) {
      console.log("SIGNAL SKIPPED BY QUALITY FILTER:", {
        symbol,
        side,
        isCandidateEvent,
        qualityScore: quality.score,
        qualityGrade: quality.grade,
        minScore: quality.minScore,
        minGrade: quality.minGrade,
        reasons: quality.reasons,
        penalties: quality.penalties,
      });
      await recordRejectStat({
        symbol,
        side,
        setupType,
        reason: "quality_filter",
        ts: receivedAtMs,
      });
      return;
    }

    const refId = incomingRef || await allocSignalRef();

    const candidateIds = uniqueStrings([
      ...candidateIdsBase,
      refId,
    ]);

    const primaryAlertId = candidateIds[0] || refId;

    const chartAssets = await chartService.buildChartDeliveryAssets({
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
      strength,
      rr,
      session,
      marketRegime,
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
      setupScore,
      qualityScore: quality.score,
      qualityGrade: quality.grade,
      session,
      marketRegime,
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
      setupScore,
      qualityScore: quality.score,
      qualityGrade: quality.grade,
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
      setupScore,
      qualityScore: quality.score,
      qualityGrade: quality.grade,
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

    persistAlertToSupabase({
      alertId: primaryAlertId,
      refId,
      symbol,
      side,
      timeframe,
      setupType,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      rr,
      riskScore: parseNum(risk),
      qualityScore: quality.score,
      qualityGrade: quality.grade,
      whyText: whyLine,
      signalTimeMs: receivedAtMs,
      session,
      marketRegime,
      pineVersion,
      isFreeShared: sharedToFree,
      rawPayload: sanitizePayloadForStorage(body),
    });

    console.log("ALERT SENT:", {
      version: APP_VERSION,
      symbol,
      side,
      refId,
      setupType,
      setupScore,
      qualityScore: quality.score,
      qualityGrade: quality.grade,
      rr: fmtRR(rr),
      tpPct: fmtPct(tpPct),
      imageUsed: sendResult.usedPhoto,
      sharedToFree,
      nextRef,
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
  console.log("VERSION:", APP_VERSION);

  console.log("REF SETTINGS:", {
    nextRef,
    refStartFloor: REF_START_FLOOR,
    nextRefFloorSafe: nextRef >= REF_START_FLOOR,
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
