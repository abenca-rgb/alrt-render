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

function identityPriceBucket(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "NA";
  if (Math.abs(n) >= 10000) return (Math.round(n / 10) * 10).toFixed(0);
  if (Math.abs(n) >= 1000) return (Math.round(n / 5) * 5).toFixed(0);
  if (Math.abs(n) >= 100) return (Math.round(n * 2) / 2).toFixed(1);
  if (Math.abs(n) >= 1) return (Math.round(n * 10) / 10).toFixed(1);
  return (Math.round(n * 1000) / 1000).toFixed(3);
}

function timeBucket(value, bucketMs) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isFinite(bucketMs) || bucketMs <= 0) return "NA";
  return Math.floor(n / bucketMs);
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

export function buildSignalEntryFingerprint({
  symbol,
  side,
  setupType,
  entry,
}) {
  return [
    "signal-entry",
    cleanToken(symbol),
    cleanToken(side),
    cleanToken(setupType),
    priceBucket(entry),
  ].join("|");
}

export function buildSignalIdentityFingerprint({
  symbol,
  side,
  setupType,
  timeframe,
  entry,
  tp,
  sl,
  eventTimeMs,
  receivedAtMs,
  bucketMinutes = 10,
}) {
  const bucketMs = bucketMinutes * 60 * 1000;
  const effectiveTimeMs = Number.isFinite(Number(eventTimeMs)) ? Number(eventTimeMs) : Number(receivedAtMs);

  return [
    "signal-identity",
    cleanToken(symbol),
    cleanToken(side),
    cleanToken(setupType),
    cleanToken(timeframe),
    identityPriceBucket(entry),
    identityPriceBucket(tp),
    identityPriceBucket(sl),
    timeBucket(effectiveTimeMs, bucketMs),
  ].join("|");
}

export function buildSignalEntryIdentityFingerprint({
  symbol,
  side,
  setupType,
  timeframe,
  entry,
  eventTimeMs,
  receivedAtMs,
  bucketMinutes = 15,
}) {
  const bucketMs = bucketMinutes * 60 * 1000;
  const effectiveTimeMs = Number.isFinite(Number(eventTimeMs)) ? Number(eventTimeMs) : Number(receivedAtMs);

  return [
    "signal-entry-identity",
    cleanToken(symbol),
    cleanToken(side),
    cleanToken(setupType),
    cleanToken(timeframe),
    identityPriceBucket(entry),
    timeBucket(effectiveTimeMs, bucketMs),
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

function buildTradeEntryFingerprint(trade) {
  return buildSignalEntryFingerprint({
    symbol: trade?.symbol,
    side: trade?.side,
    setupType: trade?.setupType,
    entry: trade?.entry,
  });
}

function buildTradeIdentityFingerprint(trade, receivedAtMs) {
  return buildSignalIdentityFingerprint({
    symbol: trade?.symbol,
    side: trade?.side,
    setupType: trade?.setupType,
    timeframe: trade?.timeframe,
    entry: trade?.entry,
    tp: trade?.tp,
    sl: trade?.sl,
    eventTimeMs: trade?.eventTimeMs || trade?.createdAtMs,
    receivedAtMs,
  });
}

function buildTradeEntryIdentityFingerprint(trade, receivedAtMs) {
  return buildSignalEntryIdentityFingerprint({
    symbol: trade?.symbol,
    side: trade?.side,
    setupType: trade?.setupType,
    timeframe: trade?.timeframe,
    entry: trade?.entry,
    eventTimeMs: trade?.eventTimeMs || trade?.createdAtMs,
    receivedAtMs,
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
  const processingIdentities = new Map();
  const recentTelegramSendFingerprints = new Map();
  const processingTtlMs = Math.min(windowMs, 2 * 60 * 1000);

  function cleanup(now = Date.now()) {
    const changed = cleanupMap(recentAlertFingerprints, now, ttlMs);
    cleanupMap(processingIdentities, now, processingTtlMs);
    cleanupMap(recentTelegramSendFingerprints, now, ttlMs);
    if (changed) void persistState?.();
    return changed;
  }

  function findActiveDuplicate(fingerprint, receivedAtMs, buildFingerprint = buildTradeFingerprint) {
    for (const [, trade] of activeTrades.entries()) {
      if (!trade || trade.hit) continue;
      if (buildFingerprint(trade) !== fingerprint) continue;

      const createdAtMs = Number(trade.createdAtMs);
      const ageMs = Number.isFinite(createdAtMs) ? receivedAtMs - createdAtMs : 0;
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs) {
        return candidateFromTrade(trade);
      }
    }

    return null;
  }

  function findExistingIdentity(fingerprints, receivedAtMs, { includeProcessing = true, map = recentAlertFingerprints } = {}) {
    for (const fingerprint of fingerprints) {
      const existing = map.get(fingerprint);
      const existingAtMs = Number(existing?.atMs || existing);
      if (Number.isFinite(existingAtMs) && receivedAtMs - existingAtMs <= ttlMs) {
        return {
          fingerprint,
          original: existing,
          ageMs: receivedAtMs - existingAtMs,
        };
      }

      if (!includeProcessing) continue;

      const processing = processingIdentities.get(fingerprint);
      const processingAtMs = Number(processing?.atMs || processing);
      if (Number.isFinite(processingAtMs) && receivedAtMs - processingAtMs <= processingTtlMs) {
        return {
          fingerprint,
          original: processing,
          ageMs: receivedAtMs - processingAtMs,
          processing: true,
        };
      }
    }

    return null;
  }

  function buildIdentityFingerprints({ context, receivedAtMs, prefix = "" }) {
    const full = buildSignalIdentityFingerprint({
      symbol: context?.symbol,
      side: context?.side,
      setupType: context?.setupType,
      timeframe: context?.timeframe,
      entry: context?.entryParsed,
      tp: context?.tpParsed,
      sl: context?.slParsed,
      eventTimeMs: context?.eventTimeMs,
      receivedAtMs,
      bucketMinutes: 10,
    });
    const entry = buildSignalEntryIdentityFingerprint({
      symbol: context?.symbol,
      side: context?.side,
      setupType: context?.setupType,
      timeframe: context?.timeframe,
      entry: context?.entryParsed,
      eventTimeMs: context?.eventTimeMs,
      receivedAtMs,
      bucketMinutes: 15,
    });

    return prefix ? [`${prefix}|${full}`, `${prefix}|${entry}`] : [full, entry];
  }

  function candidateInfo({ context, candidateKey, alertId, receivedAtMs }) {
    return {
      atMs: receivedAtMs,
      refId: context?.incomingRef || null,
      alertId: alertId || null,
      candidateKey: candidateKey || null,
      symbol: context?.symbol || null,
      side: context?.side || null,
      setupType: context?.setupType || null,
      timeframe: context?.timeframe || null,
      entry: Number.isFinite(Number(context?.entryParsed)) ? Number(context.entryParsed) : null,
      tp: Number.isFinite(Number(context?.tpParsed)) ? Number(context.tpParsed) : null,
      sl: Number.isFinite(Number(context?.slParsed)) ? Number(context.slParsed) : null,
      eventTimeMs: Number.isFinite(Number(context?.eventTimeMs)) ? Number(context.eventTimeMs) : null,
    };
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
    const entryFingerprint = buildSignalEntryFingerprint({
      symbol: context?.symbol,
      side: context?.side,
      setupType: context?.setupType,
      entry: context?.entryParsed,
    });
    const identityFingerprints = buildIdentityFingerprints({ context, receivedAtMs });
    const info = candidateInfo({ context, candidateKey, alertId, receivedAtMs });

    const processingMatch = findExistingIdentity(identityFingerprints, receivedAtMs, {
      includeProcessing: true,
    });
    if (processingMatch?.processing) {
      return {
        blocked: true,
        reason: "duplicate_processing_lock",
        fingerprint: processingMatch.fingerprint,
        original: processingMatch.original,
        ageMs: processingMatch.ageMs,
        windowMs: processingTtlMs,
      };
    }

    for (const identity of identityFingerprints) {
      processingIdentities.set(identity, {
        ...info,
        mode: "processing",
      });
    }

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

    const existingEntry = recentAlertFingerprints.get(entryFingerprint);
    const existingEntryAtMs = Number(existingEntry?.atMs || existingEntry);
    if (Number.isFinite(existingEntryAtMs) && receivedAtMs - existingEntryAtMs <= windowMs) {
      return {
        blocked: true,
        reason: "duplicate_signal_entry_fingerprint",
        fingerprint: entryFingerprint,
        original: existingEntry,
        ageMs: receivedAtMs - existingEntryAtMs,
        windowMs,
      };
    }

    const existingIdentity = findExistingIdentity(identityFingerprints, receivedAtMs, {
      includeProcessing: false,
    });
    if (existingIdentity) {
      return {
        blocked: true,
        reason: existingIdentity.fingerprint.includes("signal-entry-identity")
          ? "duplicate_signal_entry_identity"
          : "duplicate_signal_identity",
        fingerprint: existingIdentity.fingerprint,
        original: existingIdentity.original,
        ageMs: existingIdentity.ageMs,
        windowMs: ttlMs,
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

    const activeEntryDuplicate = findActiveDuplicate(entryFingerprint, receivedAtMs, buildTradeEntryFingerprint);
    if (activeEntryDuplicate) {
      return {
        blocked: true,
        reason: "duplicate_active_trade_entry_fingerprint",
        fingerprint: entryFingerprint,
        original: activeEntryDuplicate,
        ageMs: Number.isFinite(activeEntryDuplicate.createdAtMs)
          ? receivedAtMs - Number(activeEntryDuplicate.createdAtMs)
          : null,
        windowMs: ttlMs,
      };
    }

    const activeIdentityDuplicate =
      findActiveDuplicate(identityFingerprints[0], receivedAtMs, (trade) => buildTradeIdentityFingerprint(trade, receivedAtMs)) ||
      findActiveDuplicate(identityFingerprints[1], receivedAtMs, (trade) => buildTradeEntryIdentityFingerprint(trade, receivedAtMs));
    if (activeIdentityDuplicate) {
      return {
        blocked: true,
        reason: "duplicate_active_trade_identity",
        fingerprint: identityFingerprints[0],
        original: activeIdentityDuplicate,
        ageMs: Number.isFinite(activeIdentityDuplicate.createdAtMs)
          ? receivedAtMs - Number(activeIdentityDuplicate.createdAtMs)
          : null,
        windowMs: ttlMs,
      };
    }

    recentAlertFingerprints.set(fingerprint, {
      ...info,
    });
    recentAlertFingerprints.set(entryFingerprint, {
      ...info,
      mode: "entry",
    });
    for (const identity of identityFingerprints) {
      recentAlertFingerprints.set(identity, {
        ...info,
        mode: "identity",
      });
    }

    await persistState?.();

    return {
      blocked: false,
      fingerprint,
    };
  }

  async function reserveTelegramSend({
    context,
    candidateKey,
    alertId,
    refId,
    receivedAtMs = Date.now(),
  }) {
    if (!enabled) return { blocked: false, enabled: false };

    cleanup(receivedAtMs);

    const fingerprints = buildIdentityFingerprints({
      context,
      receivedAtMs,
      prefix: "telegram",
    });
    const existing = findExistingIdentity(fingerprints, receivedAtMs, {
      includeProcessing: false,
      map: recentTelegramSendFingerprints,
    });

    if (existing) {
      return {
        blocked: true,
        reason: "duplicate_telegram_send_guard",
        fingerprint: existing.fingerprint,
        original: existing.original,
        ageMs: existing.ageMs,
        windowMs: ttlMs,
      };
    }

    const info = {
      ...candidateInfo({ context, candidateKey, alertId, receivedAtMs }),
      refId: refId || context?.incomingRef || null,
      mode: "telegram",
    };

    for (const fingerprint of fingerprints) {
      recentTelegramSendFingerprints.set(fingerprint, info);
    }

    return {
      blocked: false,
      fingerprint: fingerprints[0],
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
    reserveTelegramSend,
    cleanup,
    describeBlock,
    formatSignalContext,
  };
}
