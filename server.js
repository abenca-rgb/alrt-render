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
import { buildWhyLine } from "./src/services/alertEnrichmentService.js";
import { createChartService } from "./src/services/chartService.js";
import { createCloseCompletionService } from "./src/services/closeCompletionService.js";
import {
  appendChartLinkIfMissing,
  buildAlertText,
} from "./src/services/messageTemplates.js";
import { createInviteService } from "./src/services/inviteService.js";
import { createDailyStatsService } from "./src/services/dailyStatsService.js";
import { createFreeChannelService } from "./src/services/freeChannelService.js";
import { createHitNotificationService } from "./src/services/hitNotificationService.js";
import { createRecentHitService } from "./src/services/recentHitService.js";
import { createRefAllocatorService } from "./src/services/refAllocatorService.js";
import { buildDailySummaryText as buildDailySummaryMessage } from "./src/services/summaryService.js";
import { createSupabasePersistenceService } from "./src/services/supabasePersistenceService.js";
import { evaluateSignalAcceptance } from "./src/services/signalFilterService.js";
import { createSupabaseService } from "./src/services/supabaseService.js";
import { createTelegramService } from "./src/services/telegramService.js";
import { buildTradingViewContext } from "./src/services/tradingViewContextService.js";
import {
  findOpenTradeByCandidateIds,
  findTradeByRefId,
  getOpenTradesForSymbol,
} from "./src/services/tradeLookupService.js";
import {
  buildRecentHitKey,
  buildTradeKey,
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
  pick,
  sanitizePayloadForStorage,
  uniqueStrings,
} from "./src/utils/payload.js";
import {
  getTimeExitResult,
  isLikelySignalEvent,
  shouldInferHit,
} from "./src/utils/outcomes.js";

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

const refAllocator = createRefAllocatorService({
  supabase,
  refStartFloor: REF_START_FLOOR,
  getNextRef: () => nextRef,
  setNextRef: (value) => {
    nextRef = value;
  },
});

// ===== REF HELPERS =====
function allocNextRef() {
  return refAllocator.allocStateRef();
}

async function allocSignalRef() {
  return refAllocator.allocSignalRef();
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

const supabasePersistence = createSupabasePersistenceService({
  supabase,
  getDailyStat,
  activeTrades,
});

function supabaseReady() {
  return supabasePersistence.ready();
}

function persistAlertToSupabase(payload) {
  supabasePersistence.persistAlert(payload);
}

function persistOutcomeToSupabase(payload) {
  supabasePersistence.persistOutcome(payload);
}

function persistRejectionToSupabase(payload) {
  supabasePersistence.persistRejection(payload);
}

function persistDailySummaryToSupabase(dateKey) {
  supabasePersistence.persistDailySummary(dateKey);
}

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

const hitNotificationService = createHitNotificationService({
  chartService,
  sendTelegramAlert,
  defaultChatId: CHAT_ID,
});

const closeCompletionService = createCloseCompletionService({
  recentLossStops,
  recordCloseStat,
  persistOutcomeToSupabase,
  markRecentHit,
  removeTrade,
});

async function sendHitAlert({
  trade,
  closeType,
  hitPrice = null,
  chatId = CHAT_ID,
}) {
  return hitNotificationService.sendHitAlert({
    trade,
    closeType,
    hitPrice,
    chatId,
  });
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

  await closeCompletionService.completeClosedTrade({
    matched,
    trade,
    finalCloseType,
    closedAtMs,
    sent,
    hitKey,
    source,
  });

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

    const {
      symbol,
      side,
      eventType,
      isCandidateEvent,
      currentPrice,
      setupType,
      strength,
      leverage,
      entryParsed,
      tpParsed,
      slParsed,
      rr,
      tpPct,
      incomingRef,
      explicitCloseType,
      candidateIdsBase,
      eventTime,
      rsi,
      atrPct,
      risk,
      setupScore,
      trendStrength,
      volatilityState,
      marketRegime,
      session,
      confidenceLevel,
      estimatedHoldDuration,
      timeframe,
      pineVersion,
    } = buildTradingViewContext({
      body,
      receivedAtMs,
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

    const signalGate = evaluateSignalAcceptance({
      activeTrades,
      recentLossStops,
      getDailyStat,
      allowedSymbols: ALLOWED_SYMBOLS,
      maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
      maxOpenTradesPerSide: MAX_OPEN_TRADES_PER_SIDE,
      dailySlCircuitBreaker: DAILY_SL_CIRCUIT_BREAKER,
      minRrToSend: MIN_RR_TO_SEND,
      alertQualityFilterEnabled: ALERT_QUALITY_FILTER_ENABLED,
      candidateQualityFilterEnabled: CANDIDATE_QUALITY_FILTER_ENABLED,
      lossGuardRetentionMs: LOSS_GUARD_RETENTION_MS,
      lossGuardSymbolCooldownMs: LOSS_GUARD_SYMBOL_COOLDOWN_MS,
      lossGuardMarketWindowMs: LOSS_GUARD_MARKET_WINDOW_MS,
      lossGuardMarketCooldownMs: LOSS_GUARD_MARKET_COOLDOWN_MS,
      lossGuardMarketLimit: LOSS_GUARD_MARKET_LIMIT,
      context: {
        symbol,
        side,
        setupType,
        entryParsed,
        tpParsed,
        slParsed,
        rr,
        tpPct,
        strength,
        setupScore,
        trendStrength,
        volatilityState,
        marketRegime,
        session,
        rsi,
        atrPct,
        isCandidateEvent,
      },
      receivedAtMs,
    });

    if (!signalGate.accepted) {
      const details = signalGate.details || {};

      if (signalGate.reason === "symbol_filter") {
        console.log("SIGNAL SKIPPED BY SYMBOL FILTER:", details);
      } else if (String(signalGate.reason || "").includes("sanity") || signalGate.sanity) {
        console.log("SIGNAL SKIPPED BY SANITY FILTER:", {
          ...details,
          entry: fmtPrice(details.entry),
          tp: fmtPrice(details.tp),
          sl: fmtPrice(details.sl),
          rr: fmtRR(details.rr),
        });
      } else if (signalGate.reason === "open_trade_filter") {
        console.log("SIGNAL SKIPPED BY OPEN TRADE FILTER:", details);
      } else if (signalGate.reason === "daily_sl_circuit_breaker") {
        console.log("SIGNAL SKIPPED BY DAILY SL CIRCUIT BREAKER:", details);
      } else if (signalGate.reason === "side_exposure_filter") {
        console.log("SIGNAL SKIPPED BY SIDE EXPOSURE FILTER:", details);
      } else if (signalGate.lossGuard) {
        console.log("SIGNAL SKIPPED BY LOSS GUARD:", details);
      } else if (signalGate.reason === "min_rr_filter") {
        console.log("SIGNAL SKIPPED BY MIN RR FILTER:", {
          ...details,
          rr: fmtRR(details.rr),
        });
      } else if (signalGate.reason === "quality_filter") {
        console.log("SIGNAL SKIPPED BY QUALITY FILTER:", details);
      } else {
        console.log("SIGNAL SKIPPED:", {
          reason: signalGate.reason,
          ...details,
        });
      }

      await recordRejectStat({
        symbol,
        side,
        setupType,
        reason: signalGate.reason || "signal_filter",
        ts: receivedAtMs,
      });
      return;
    }

    const { quality } = signalGate;

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
