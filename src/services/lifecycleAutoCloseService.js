import { buildRecentHitKey } from "./tradeIdentityService.js";
import { getTimeExitResult } from "../utils/outcomes.js";
import { pctMove } from "../utils/tradeMath.js";

const CLOSE_OUTCOMES = new Set(["TP", "SL", "TIME_EXIT_PROFIT", "TIME_EXIT_LOSS", "EXPIRED", "MANUAL_CLOSE"]);
const PROFIT_LOSS_OUTCOMES = new Set(["TIME_EXIT_PROFIT", "TIME_EXIT_LOSS"]);

function normalizeId(value) {
  return String(value || "").trim();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, decimals = 4) {
  const number = numberOrNull(value);
  if (number === null) return null;
  const factor = 10 ** decimals;
  return Math.round(number * factor) / factor;
}

function alertToTrade(alert) {
  return {
    primaryAlertId: normalizeId(alert.alert_id),
    alertIds: [normalizeId(alert.alert_id)].filter(Boolean),
    refId: normalizeId(alert.ref_id),
    candidateKey: alert.candidate_key || normalizeId(alert.alert_id) || null,
    symbol: alert.symbol || null,
    side: alert.direction || null,
    setupType: alert.setup_type || "UNKNOWN",
    entry: numberOrNull(alert.entry_price),
    tp: numberOrNull(alert.tp_price),
    sl: numberOrNull(alert.sl_price),
    rr: numberOrNull(alert.rr),
    createdAtMs: new Date(alert.signal_time_utc || alert.created_at || 0).getTime(),
  };
}

function isTradeUsable(trade) {
  return Boolean(
    trade &&
      trade.refId &&
      trade.symbol &&
      (trade.side === "LONG" || trade.side === "SHORT") &&
      Number.isFinite(Number(trade.entry)),
  );
}

function ageMsForTrade(trade, nowMs) {
  const createdAtMs = Number(trade?.createdAtMs);
  if (!Number.isFinite(createdAtMs)) return null;
  return Math.max(0, nowMs - createdAtMs);
}

function isFreshPrice(priceResult, nowMs, maxPriceAgeMs) {
  if (!priceResult?.fetched_at_utc) return false;
  const fetchedAtMs = new Date(priceResult.fetched_at_utc).getTime();
  return Number.isFinite(fetchedAtMs) && nowMs - fetchedAtMs <= maxPriceAgeMs;
}

function buildClosePreview({
  key,
  trade,
  source,
  nowMs,
  maxTradeAgeMs,
  maxPriceAgeMs,
  priceResult,
  duplicateClose,
  allowExpiredWithoutPrice,
}) {
  const ageMs = ageMsForTrade(trade, nowMs);
  const stale = ageMs !== null && ageMs >= maxTradeAgeMs;
  const symbolMatches = !priceResult?.symbol || priceResult.symbol === trade.symbol;
  const priceFresh = isFreshPrice(priceResult, nowMs, maxPriceAgeMs);
  const priceReliable = Boolean(priceResult?.reliable && symbolMatches && priceFresh);
  const exitPrice = priceReliable ? priceResult.price : null;
  const suggestedOutcome = exitPrice !== null ? getTimeExitResult(trade, exitPrice) : "EXPIRED";
  const movePct = exitPrice !== null ? pctMove(trade.side, trade.entry, exitPrice) : null;
  const isProfitLoss = PROFIT_LOSS_OUTCOMES.has(suggestedOutcome);
  const expiredWithoutPrice = suggestedOutcome === "EXPIRED" && !priceReliable && allowExpiredWithoutPrice;
  const canWrite =
    source === "runtime_active_trade" &&
    stale &&
    isTradeUsable(trade) &&
    !duplicateClose &&
    ((isProfitLoss && priceReliable) || expiredWithoutPrice) &&
    symbolMatches &&
    (priceFresh || expiredWithoutPrice);

  const canWriteProfitLoss =
    canWrite &&
    isProfitLoss &&
    priceReliable &&
    source === "runtime_active_trade" &&
    !duplicateClose;
  const canWriteExpired = canWrite && suggestedOutcome === "EXPIRED";

  let reason = "ready_for_lifecycle_close";
  if (!stale) reason = "trade_is_not_stale";
  if (!isTradeUsable(trade)) reason = "missing_required_trade_fields";
  if (!priceResult?.reliable) reason = "NO_RELIABLE_PRICE";
  if (priceResult?.reliable && !symbolMatches) reason = "price_symbol_mismatch";
  if (priceResult?.reliable && symbolMatches && !priceFresh) reason = "stale_price";
  if (suggestedOutcome === "EXPIRED" && !priceReliable && !allowExpiredWithoutPrice) reason = "NO_RELIABLE_PRICE";
  if (canWriteExpired) reason = "ready_for_expired_lifecycle_close";
  if (duplicateClose) reason = "close_outcome_already_exists";
  if (source !== "runtime_active_trade") reason = "supabase_only_historical_record_dry_run_only";

  return {
    key,
    source,
    ref_id: trade.refId,
    alert_id: trade.primaryAlertId || trade.alertIds?.[0] || trade.refId,
    symbol: trade.symbol,
    direction: trade.side,
    setup: trade.setupType || "UNKNOWN",
    opened_utc: Number.isFinite(Number(trade.createdAtMs)) ? new Date(trade.createdAtMs).toISOString() : null,
    age_hours: ageMs === null ? null : round(ageMs / 3600000, 2),
    stale,
    exit_price: exitPrice,
    price_provider: priceResult?.provider || priceResult?.source || null,
    price_source: priceResult?.source || priceResult?.provider || null,
    price_fetched_at_utc: priceResult?.fetched_at_utc || null,
    price_freshness: priceResult?.freshness || null,
    price_reliable: priceReliable,
    price_error: priceReliable ? null : priceResult?.error || "NO_RELIABLE_PRICE",
    price_attempts: priceResult?.attempts || [],
    suggested_outcome: suggestedOutcome,
    market_move_pct: round(movePct, 4),
    duplicate_close: Boolean(duplicateClose),
    writable: canWrite,
    writable_profit_loss: canWriteProfitLoss,
    writable_expired: canWriteExpired,
    reason,
  };
}

function buildTotals({ previews, runtimeCandidates, supabaseOnlyCandidates, closed, skipped }) {
  const byProvider = {};
  let noPrice = 0;
  let errors = 0;

  for (const preview of previews) {
    const provider = preview.price_provider || "none";
    byProvider[provider] = (byProvider[provider] || 0) + 1;
    if (!preview.price_reliable) noPrice += 1;
    if (preview.price_error) errors += 1;
  }

  return {
    candidates: previews.length,
    runtime_candidates: runtimeCandidates.length,
    supabase_only_candidates: supabaseOnlyCandidates.length,
    by_provider: byProvider,
    no_price: noPrice,
    writable_profit_loss: previews.filter((preview) => preview.writable_profit_loss).length,
    writable_expired: previews.filter((preview) => preview.writable_expired).length,
    writable_candidates: previews.filter((preview) => preview.writable).length,
    closed: closed.length,
    skipped: skipped.length,
    errors,
  };
}

export function createLifecycleAutoCloseService({
  supabase,
  activeTrades,
  closeCompletionService,
  priceService,
  maxTradeAgeMs,
  maxPriceAgeMs = 5 * 60 * 1000,
} = {}) {
  async function selectRows(table, query) {
    return supabase.selectRows(table, query);
  }

  async function loadClosedOutcomeKeys(nowMs, limit) {
    if (!supabase?.ready?.()) return { alertIds: new Set(), refIds: new Set() };

    const encodedNow = encodeURIComponent(new Date(nowMs).toISOString());
    const rows = await selectRows(
      "outcomes",
      `?select=alert_id,ref_id,outcome_type,outcome_time_utc,closed_at_utc,created_at&outcome_time_utc=lte.${encodedNow}&limit=${limit}`,
    );

    const alertIds = new Set();
    const refIds = new Set();
    for (const row of rows) {
      if (!CLOSE_OUTCOMES.has(row.outcome_type)) continue;
      const alertId = normalizeId(row.alert_id);
      const refId = normalizeId(row.ref_id);
      if (alertId) alertIds.add(alertId);
      if (refId) refIds.add(refId);
    }

    return { alertIds, refIds };
  }

  async function loadSupabaseOnlyStaleAlerts({ nowMs, limit, closedKeys }) {
    if (!supabase?.ready?.()) return [];

    const staleBeforeIso = new Date(nowMs - maxTradeAgeMs).toISOString();
    const rows = await selectRows(
      "alerts",
      `?select=alert_id,ref_id,symbol,direction,setup_type,entry_price,tp_price,sl_price,rr,signal_time_utc,created_at&signal_time_utc=lt.${encodeURIComponent(staleBeforeIso)}&limit=${limit}`,
    );

    const runtimeRefs = new Set();
    for (const [, trade] of activeTrades.entries()) {
      const refId = normalizeId(trade.refId || trade.ref_id || trade.ref);
      const alertId = normalizeId(trade.primaryAlertId || trade.alertId || trade.alert_id || trade.alertIds?.[0]);
      if (refId) runtimeRefs.add(refId);
      if (alertId) runtimeRefs.add(alertId);
    }

    return rows
      .filter((row) => {
        const alertId = normalizeId(row.alert_id);
        const refId = normalizeId(row.ref_id);
        if (closedKeys.alertIds.has(alertId) || closedKeys.refIds.has(refId)) return false;
        if (runtimeRefs.has(alertId) || runtimeRefs.has(refId)) return false;
        return true;
      })
      .map((row) => ({
        key: normalizeId(row.alert_id) || normalizeId(row.ref_id),
        trade: alertToTrade(row),
        source: "supabase_only_historical_record",
      }));
  }

  async function getPriceResults(symbols, options = {}) {
    const resultBySymbol = new Map();
    for (const symbol of symbols) {
      if (!symbol || resultBySymbol.has(symbol)) continue;
      resultBySymbol.set(symbol, await priceService.getLatestPrice(symbol, options));
    }
    return resultBySymbol;
  }

  async function runLifecycleAutoClose({
    dryRun = true,
    confirm = false,
    includeSupabaseOnly = true,
    allowExpiredWithoutPrice = false,
    eventPrice = null,
    eventSymbol = null,
    nowMs = Date.now(),
    limit = 10000,
  } = {}) {
    const closedKeys = await loadClosedOutcomeKeys(nowMs, limit);

    const runtimeCandidates = Array.from(activeTrades.entries())
      .map(([key, trade]) => ({
        key,
        trade,
        source: "runtime_active_trade",
      }))
      .filter(({ trade }) => {
        const ageMs = ageMsForTrade(trade, nowMs);
        return !trade?.hit && ageMs !== null && ageMs >= maxTradeAgeMs;
      });

    const supabaseOnlyCandidates = includeSupabaseOnly
      ? await loadSupabaseOnlyStaleAlerts({ nowMs, limit, closedKeys })
      : [];

    const allCandidates = [...runtimeCandidates, ...supabaseOnlyCandidates];
    const priceResults = await getPriceResults(
      [...new Set(allCandidates.map(({ trade }) => trade.symbol).filter(Boolean))],
      { eventPrice, eventSymbol },
    );

    const previews = allCandidates.map(({ key, trade, source }) => {
      const alertId = normalizeId(trade.primaryAlertId || trade.alertId || trade.alertIds?.[0]);
      const refId = normalizeId(trade.refId);
      return buildClosePreview({
        key,
        trade,
        source,
        nowMs,
        maxTradeAgeMs,
        maxPriceAgeMs,
        priceResult: priceResults.get(trade.symbol),
        duplicateClose: closedKeys.alertIds.has(alertId) || closedKeys.refIds.has(refId),
        allowExpiredWithoutPrice,
      });
    });

    const writeRequested = !dryRun && confirm;
    const closed = [];
    const skipped = [];

    if (writeRequested) {
      for (const preview of previews) {
        if (!preview.writable) {
          skipped.push(preview);
          continue;
        }

        const matched = runtimeCandidates.find((candidate) => candidate.key === preview.key);
        if (!matched) {
          skipped.push({ ...preview, reason: "runtime_trade_not_found_at_write_time" });
          continue;
        }

        const closedAtMs = nowMs;
        const hitKey = buildRecentHitKey({
          symbol: matched.trade.symbol,
          closeType: preview.suggested_outcome,
          refId: matched.trade.refId,
          eventTime: Math.floor(closedAtMs / 60000),
        });

        matched.trade.hit = true;
        matched.trade.hitType = preview.suggested_outcome;
        matched.trade.hitAtMs = closedAtMs;

        await closeCompletionService.completeClosedTrade({
          matched: {
            key: matched.key,
            trade: matched.trade,
            matchType: "lifecycle_auto_close",
          },
          trade: matched.trade,
          finalCloseType: preview.suggested_outcome,
          closedAtMs,
          sent: {
            exitPrice: preview.exit_price,
            movePct: preview.market_move_pct,
          },
          hitKey,
          source: "lifecycle_auto_close",
        });

        closed.push(preview);
      }
    } else {
      skipped.push(...previews);
    }

    return {
      ok: true,
      mode: writeRequested ? "confirmed_write" : "dry_run",
      generated_at_utc: new Date(nowMs).toISOString(),
      lifecycle_limit_hours: round(maxTradeAgeMs / 3600000, 2),
      totals: buildTotals({ previews, runtimeCandidates, supabaseOnlyCandidates, closed, skipped }),
      closed,
      candidates: previews,
    };
  }

  return {
    runLifecycleAutoClose,
  };
}
