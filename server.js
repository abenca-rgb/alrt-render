import express from "express";
import fetch from "node-fetch";
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
import { createDailyStatsService } from "./src/services/dailyStatsService.js";
import { createFreeChannelService } from "./src/services/freeChannelService.js";
import { createRecentHitService } from "./src/services/recentHitService.js";
import { buildDailySummaryText as buildDailySummaryMessage } from "./src/services/summaryService.js";
import {
  getLossGuardBlock,
  registerLossStop,
} from "./src/services/lossGuardService.js";
import { createSupabaseService } from "./src/services/supabaseService.js";
import { createTelegramService } from "./src/services/telegramService.js";
import {
  countOpenTradesForSide,
  countOpenTradesForSymbol,
  findOpenTradeByCandidateIds,
  findTradeByRefId,
  getOpenTradesForSymbol,
  hasOpenTradeForSymbol,
} from "./src/services/tradeLookupService.js";
import {
  buildRecentHitKey,
  buildTradeKey,
  collectAllCandidateIds,
  parseIncomingRef,
} from "./src/services/tradeIdentityService.js";
import { registerChartRoutes } from "./src/routes/chartRoutes.js";
import { registerMemberRoutes } from "./src/routes/memberRoutes.js";
import { registerStripeRoutes } from "./src/routes/stripeRoutes.js";
import { registerSystemRoutes } from "./src/routes/systemRoutes.js";
import { registerTradingViewRoutes } from "./src/routes/tradingViewRoutes.js";
import { createStateFileStore } from "./src/state/stateFileStore.js";
import {
  createEmptyRuntimeState,
  hydrateStateFromPayload,
} from "./src/state/stateHydrationService.js";
import { cleanupRuntimeState } from "./src/state/stateCleanupService.js";
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
import {
  detectExplicitCloseType,
  getTimeExitResult,
  isLikelySignalEvent,
  shouldInferHit,
} from "./src/utils/outcomes.js";
import {
  applyFallbackLevels,
  hasValidTradeLevels,
  pctMove,
  rrFromLevels,
  slPctFromLevels,
  tpPctFromLevels,
  validateTradeSanity,
} from "./src/utils/tradeMath.js";

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
const stateFileStore = createStateFileStore({
  dataDir: DATA_DIR,
  stateFile: STATE_FILE,
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

const dailyStatsService = createDailyStatsService({
  dailyStats,
  persistState,
  persistRejectionToSupabase,
});
const {
  getDailyStat,
  recordSignalStat,
  recordCloseStat,
  recordRejectStat,
} = dailyStatsService;

const freeChannelService = createFreeChannelService({
  freeSharedRefs,
  freeChatId: FREE_CHAT_ID,
  freeDailyLimit: FREE_DAILY_LIMIT,
  getFreePostDate: () => freePostDate,
  getFreePostsToday: () => freePostsToday,
  setFreeCounter: ({ freePostDate: nextFreePostDate, freePostsToday: nextFreePostsToday }) => {
    freePostDate = nextFreePostDate;
    freePostsToday = nextFreePostsToday;
  },
  persistState,
});

const recentHitService = createRecentHitService({
  recentHitKeys,
  persistState,
});

// ===== FREE CHANNEL =====
function resetFreeCounterIfNeeded(nowMs = Date.now()) {
  freeChannelService.resetCounterIfNeeded(nowMs);
}

function canSendFreeSignal(nowMs = Date.now()) {
  return freeChannelService.canSendSignal(nowMs);
}

async function markFreeSignalShared({ refId, symbol, side, sharedAtMs = Date.now() }) {
  await freeChannelService.markSignalShared({ refId, symbol, side, sharedAtMs });
}

function wasSharedToFree(refId) {
  return freeChannelService.wasShared(refId);
}

function wasRecentHitSent(hitKey) {
  return recentHitService.wasSent(hitKey);
}

async function markRecentHit(hitKey) {
  await recentHitService.markSent(hitKey);
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
async function persistState() {
  savePromise = savePromise
    .then(async () => {
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

      await stateFileStore.writeStatePayload(payload);
    })
    .catch((err) => {
      console.error("PERSIST SAVE ERROR:", err);
    });

  return savePromise;
}

async function loadState() {
  try {
    await stateFileStore.ensureDataDir();

    const parsed = await stateFileStore.readStatePayload();
    const now = Date.now();
    const hydrated = hydrateStateFromPayload({
      parsed,
      now,
      refStartFloor: REF_START_FLOOR,
      hitDedupTtlMs: HIT_DEDUP_TTL_MS,
      lossGuardRetentionMs: LOSS_GUARD_RETENTION_MS,
      freeRefTtlMs: FREE_REF_TTL_MS,
      maps: {
        activeTrades,
        recentHitKeys,
        recentLossStops,
        freeSharedRefs,
        dailyStats,
        paidMembers,
        freeMembers,
      },
    });

    nextRef = hydrated.nextRef;
    freePostDate = hydrated.freePostDate;
    freePostsToday = hydrated.freePostsToday;
    lastSummarySentDate = hydrated.lastSummarySentDate;

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

      const emptyState = createEmptyRuntimeState({
        refStartFloor: REF_START_FLOOR,
        now: Date.now(),
      });

      nextRef = emptyState.nextRef;
      freePostDate = emptyState.freePostDate;
      freePostsToday = emptyState.freePostsToday;
      lastSummarySentDate = emptyState.lastSummarySentDate;

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
  const { changed } = cleanupRuntimeState({
    maps: {
      recentHitKeys,
      recentLossStops,
      freeSharedRefs,
      dailyStats,
    },
    now,
    hitDedupTtlMs: HIT_DEDUP_TTL_MS,
    lossGuardRetentionMs: LOSS_GUARD_RETENTION_MS,
    freeRefTtlMs: FREE_REF_TTL_MS,
  });

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

  registerLossStop(recentLossStops, trade, finalCloseType, closedAtMs);
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
registerStripeRoutes(app, {
  handleStripeEvent,
});

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
        findOpenTradeByCandidateIds(activeTrades, candidateIdsBase) ||
        findTradeByRefId(activeTrades, incomingRef);

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
        openTradesForSymbol: getOpenTradesForSymbol(activeTrades, symbol),
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

    if (hasOpenTradeForSymbol(activeTrades, symbol, MAX_OPEN_TRADES_PER_SYMBOL)) {
      console.log("SIGNAL SKIPPED BY OPEN TRADE FILTER:", {
        symbol,
        openTradesForSymbol: countOpenTradesForSymbol(activeTrades, symbol),
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

    const openTradesForSide = countOpenTradesForSide(activeTrades, side);

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

    const lossGuard = getLossGuardBlock(recentLossStops, {
      symbol,
      side,
      now: receivedAtMs,
      retentionMs: LOSS_GUARD_RETENTION_MS,
      symbolCooldownMs: LOSS_GUARD_SYMBOL_COOLDOWN_MS,
      marketWindowMs: LOSS_GUARD_MARKET_WINDOW_MS,
      marketCooldownMs: LOSS_GUARD_MARKET_COOLDOWN_MS,
      marketLimit: LOSS_GUARD_MARKET_LIMIT,
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
registerTradingViewRoutes(app, {
  handleTradingViewWebhook,
});

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
