import { fmtPrice } from "../utils/numbers.js";

function cleanToken(value, fallback = "UNKNOWN") {
  const text = String(value || "").trim().toUpperCase();
  return text || fallback;
}

function priceBucket(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "NA";
  if (Math.abs(n) >= 1000) return n.toFixed(1);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(8);
}

export function buildSignalFingerprint({
  symbol,
  side,
  setupType,
  entry,
  tp,
  sl,
}) {
  return [
    "signal",
    cleanToken(symbol),
    cleanToken(side),
    cleanToken(setupType),
    priceBucket(entry),
    priceBucket(tp),
    priceBucket(sl),
  ].join("|");
}

function buildTradeFingerprint(trade) {
  return buildSignalFingerprint({
    symbol: trade?.symbol,
    side: trade?.side,
    setupType: trade?.setupType,
    entry: trade?.entry,
    tp: trade?.tp,
    sl: trade?.sl,
  });
}

export function buildCloseFingerprint({
  trade,
  closeType,
  hitPrice,
  eventTimeMs,
  windowMs,
}) {
  const timeBucket = Number.isFinite(eventTimeMs) && Number.isFinite(windowMs) && windowMs > 0
    ? Math.floor(eventTimeMs / windowMs)
    : "NA";

  return [
    "close",
    cleanToken(trade?.symbol),
    cleanToken(trade?.side),
    cleanToken(closeType),
    priceBucket(hitPrice),
    timeBucket,
  ].join("|");
}

function cleanupMap(map, now, ttlMs) {
  let changed = false;

  for (const [fingerprint, info] of map.entries()) {
    const atMs = Number(info?.atMs || info);
    if (!Number.isFinite(atMs) || now - atMs > ttlMs) {
      map.delete(fingerprint);
      changed = true;
    }
  }

  return changed;
}

function candidateFromTrade(trade) {
  return {
    refId: trade?.refId || null,
    alertId: trade?.primaryAlertId || null,
    candidateKey: trade?.candidateKey || null,
    createdAtMs: trade?.createdAtMs || null,
    createdAtUtc: trade?.createdAtUtc || null,
  };
}

export function createDuplicateGuardService({
  enabled = true,
  recentAlertFingerprints,
  activeTrades,
  persistState,
  windowMs = 10 * 60 * 1000,
  ttlMs = 36 * 60 * 60 * 1000,
}) {
  function cleanup(now = Date.now()) {
    const changed = cleanupMap(recentAlertFingerprints, now, ttlMs);
    if (changed) void persistState?.();
    return changed;
  }

  function findActiveDuplicate(fingerprint, receivedAtMs) {
    for (const [, trade] of activeTrades.entries()) {
      if (!trade || trade.hit) continue;
      if (buildTradeFingerprint(trade) !== fingerprint) continue;

      const createdAtMs = Number(trade.createdAtMs);
      const ageMs = Number.isFinite(createdAtMs) ? receivedAtMs - createdAtMs : 0;
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs) {
        return candidateFromTrade(trade);
      }
    }

    return null;
  }

  async function reserveSignal({
    context,
    candidateKey,
    alertId,
    receivedAtMs = Date.now(),
  }) {
    if (!enabled) {
      return { blocked: false, enabled: false };
    }

    cleanup(receivedAtMs);

    const fingerprint = buildSignalFingerprint({
      symbol: context?.symbol,
      side: context?.side,
      setupType: context?.setupType,
      entry: context?.entryParsed,
      tp: context?.tpParsed,
      sl: context?.slParsed,
    });

    const existing = recentAlertFingerprints.get(fingerprint);
    const existingAtMs = Number(existing?.atMs || existing);
    if (Number.isFinite(existingAtMs) && receivedAtMs - existingAtMs <= windowMs) {
      return {
        blocked: true,
        reason: "duplicate_signal_fingerprint",
        fingerprint,
        original: existing,
        ageMs: receivedAtMs - existingAtMs,
        windowMs,
      };
    }

    const activeDuplicate = findActiveDuplicate(fingerprint, receivedAtMs);
    if (activeDuplicate) {
      return {
        blocked: true,
        reason: "duplicate_active_trade_fingerprint",
        fingerprint,
        original: activeDuplicate,
        ageMs: Number.isFinite(activeDuplicate.createdAtMs)
          ? receivedAtMs - Number(activeDuplicate.createdAtMs)
          : null,
        windowMs: ttlMs,
      };
    }

    recentAlertFingerprints.set(fingerprint, {
      atMs: receivedAtMs,
      refId: context?.incomingRef || null,
      alertId: alertId || null,
      candidateKey: candidateKey || null,
      symbol: context?.symbol || null,
      side: context?.side || null,
      setupType: context?.setupType || null,
      entry: Number.isFinite(Number(context?.entryParsed)) ? Number(context.entryParsed) : null,
      tp: Number.isFinite(Number(context?.tpParsed)) ? Number(context.tpParsed) : null,
      sl: Number.isFinite(Number(context?.slParsed)) ? Number(context.slParsed) : null,
    });

    await persistState?.();

    return {
      blocked: false,
      fingerprint,
    };
  }

  function describeBlock(block) {
    return {
      reason: block?.reason || "duplicate_signal",
      fingerprint: block?.fingerprint || null,
      original: block?.original || null,
      ageSeconds: Number.isFinite(block?.ageMs) ? Math.round(block.ageMs / 1000) : null,
      windowSeconds: Number.isFinite(block?.windowMs) ? Math.round(block.windowMs / 1000) : null,
    };
  }

  function formatSignalContext(context) {
    return {
      symbol: context?.symbol || null,
      side: context?.side || null,
      setupType: context?.setupType || null,
      entry: fmtPrice(context?.entryParsed),
      tp: fmtPrice(context?.tpParsed),
      sl: fmtPrice(context?.slParsed),
    };
  }

  return {
    reserveSignal,
    cleanup,
    describeBlock,
    formatSignalContext,
  };
}
