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
import { createChartService } from "./src/services/chartService.js";
import { createCloseCompletionService } from "./src/services/closeCompletionService.js";
import { createCloseFlowService } from "./src/services/closeFlowService.js";
import { appendChartLinkIfMissing } from "./src/services/messageTemplates.js";
import { createInviteService } from "./src/services/inviteService.js";
import { createDailyStatsService } from "./src/services/dailyStatsService.js";
import { createDailySummaryRunnerService } from "./src/services/dailySummaryRunnerService.js";
import { createFreeChannelService } from "./src/services/freeChannelService.js";
import { createHitNotificationService } from "./src/services/hitNotificationService.js";
import { createRecentHitService } from "./src/services/recentHitService.js";
import { createRefAllocatorService } from "./src/services/refAllocatorService.js";
import { createSignalDeliveryService } from "./src/services/signalDeliveryService.js";
import { createStripeMemberService } from "./src/services/stripeMemberService.js";
import { createSupabasePersistenceService } from "./src/services/supabasePersistenceService.js";
import { evaluateSignalAcceptance } from "./src/services/signalFilterService.js";
import { createSupabaseService } from "./src/services/supabaseService.js";
import { createTelegramDispatchService } from "./src/services/telegramDispatchService.js";
import { buildTradingViewContext } from "./src/services/tradingViewContextService.js";
import {
  findOpenTradeByCandidateIds,
  findTradeByRefId,
  getOpenTradesForSymbol,
} from "./src/services/tradeLookupService.js";
import { registerChartRoutes } from "./src/routes/chartRoutes.js";
import { registerMemberRoutes } from "./src/routes/memberRoutes.js";
import { registerStripeRoutes } from "./src/routes/stripeRoutes.js";
import { registerSystemRoutes } from "./src/routes/systemRoutes.js";
import { registerTradingViewRoutes } from "./src/routes/tradingViewRoutes.js";
import { createStateFileStore } from "./src/state/stateFileStore.js";
import { createRuntimeStateService } from "./src/state/runtimeStateService.js";
import { cleanupRuntimeState } from "./src/state/stateCleanupService.js";
import { formatUtc, getUtcDateKey } from "./src/utils/date.js";
import { fmtPct, fmtPrice, fmtRR, parseNum } from "./src/utils/numbers.js";
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
const telegramDispatch = createTelegramDispatchService({
  botToken: BOT_TOKEN,
  defaultChatId: CHAT_ID,
  appendChartLinkIfMissing,
});
const {
  sendTelegramMessage,
  sendTelegramPhoto,
  sendTelegramAlert,
} = telegramDispatch;

// ===== STATE =====
const activeTrades = new Map();
const recentHitKeys = new Map();
const recentLossStops = new Map();
const freeSharedRefs = new Map();
const dailyStats = new Map();
const paidMembers = new Map();
const freeMembers = new Map();

let nextRef = REF_START_FLOOR;
let freePostDate = "";
let freePostsToday = 0;
let lastSummarySentDate = "";

const runtimeState = createRuntimeStateService({
  stateFileStore,
  appVersion: APP_VERSION,
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
  getNextRef: () => nextRef,
  getFreeCounter: () => ({ freePostDate, freePostsToday }),
  getLastSummarySentDate: () => lastSummarySentDate,
  setHydratedState: (hydrated) => {
    nextRef = hydrated.nextRef;
    freePostDate = hydrated.freePostDate;
    freePostsToday = hydrated.freePostsToday;
    lastSummarySentDate = hydrated.lastSummarySentDate;
  },
  ensureDailyStat: (now) => getDailyStat(getUtcDateKey(now)),
});
const persistState = runtimeState.persistState;
const loadState = runtimeState.loadState;

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

// ===== DAILY SUMMARY =====
const dailySummaryRunner = createDailySummaryRunnerService({
  enabled: DAILY_SUMMARY_ENABLED,
  utcHour: DAILY_SUMMARY_UTC_HOUR,
  utcMinute: DAILY_SUMMARY_UTC_MINUTE,
  getDailyStat,
  getActiveTrades: () => Array.from(activeTrades.values()),
  getLastSummarySentDate: () => lastSummarySentDate,
  setLastSummarySentDate: (dateKey) => {
    lastSummarySentDate = dateKey;
  },
  sendTelegramMessage,
  paidChatId: CHAT_ID,
  freeChatId: FREE_CHAT_ID,
  persistDailySummaryToSupabase,
  persistState,
});

const sendDailySummary = dailySummaryRunner.sendDailySummary;
const maybeSendDailySummary = dailySummaryRunner.maybeSendDailySummary;

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

const closeFlowService = createCloseFlowService({
  closeCompletionService,
  hitNotificationService,
  wasRecentHitSent,
  wasSharedToFree,
  paidChatId: CHAT_ID,
  freeChatId: FREE_CHAT_ID,
});

const signalDeliveryService = createSignalDeliveryService({
  allocSignalRef,
  chartService,
  sendTelegramAlert,
  canSendFreeSignal,
  markFreeSignalShared,
  upsertTrade,
  recordSignalStat,
  persistAlertToSupabase,
  maxTradeAgeMs: MAX_TRADE_AGE_MS,
  paidChatId: CHAT_ID,
  freeChatId: FREE_CHAT_ID,
});

const closeTrade = closeFlowService.closeTrade;
// ===== STRIPE / MEMBER HELPERS =====
async function createTelegramInviteLink({ expireHours = 48 } = {}) {
  return inviteService.createPaidInviteLink({ expireHours });
}

async function createFreeTelegramInviteLink({ expireHours = 48 } = {}) {
  return inviteService.createFreeInviteLink({ expireHours });
}

const stripeMemberService = createStripeMemberService({
  paidMembers,
  createPaidInviteLink: createTelegramInviteLink,
  persistState,
  sendTelegramMessage,
});

const handleStripeEvent = stripeMemberService.handleStripeEvent;

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

    const delivery = await signalDeliveryService.deliverSignal({
      body,
      context: {
        symbol,
        side,
        entryParsed,
        tpParsed,
        slParsed,
        rr,
        tpPct,
        leverage,
        strength,
        setupType,
        setupScore,
        trendStrength,
        volatilityState,
        marketRegime,
        session,
        confidenceLevel,
        estimatedHoldDuration,
        timeframe,
        pineVersion,
        risk,
      },
      quality,
      incomingRef,
      candidateIdsBase,
      prettyTime,
      chartLink,
      receivedAtMs,
    });

    console.log("ALERT SENT:", {
      version: APP_VERSION,
      symbol,
      side,
      refId: delivery.refId,
      setupType: delivery.setupType,
      setupScore: delivery.setupScore,
      qualityScore: delivery.qualityScore,
      qualityGrade: delivery.qualityGrade,
      rr: fmtRR(delivery.rr),
      tpPct: fmtPct(delivery.tpPct),
      imageUsed: delivery.imageUsed,
      sharedToFree: delivery.sharedToFree,
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
