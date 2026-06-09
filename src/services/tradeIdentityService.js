import { pick, uniqueStrings } from "../utils/payload.js";

export function parseIncomingRef(body) {
  const raw = pick(body.ref_id, body.ref, body.reference, body.alert_ref);

  if (!raw) return null;

  const digits = String(raw).replace(/\D/g, "");

  if (digits.length === 6) return digits;

  return null;
}

export function buildTradeKey(symbol, side, refId) {
  return `${symbol}|${side}|${refId}`;
}

export function collectRawCandidateIds(body) {
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

export function collectAllCandidateIds({ body, symbol, side, eventTimeMs, refId }) {
  const ms = Number.isFinite(eventTimeMs) ? String(eventTimeMs) : "";
  const sec = Number.isFinite(eventTimeMs) ? String(Math.floor(eventTimeMs / 1000)) : "";

  return uniqueStrings([
    ...collectRawCandidateIds(body),
    refId ? String(refId) : null,
    symbol && side && ms ? `${symbol}-${side}-${ms}` : null,
    symbol && side && sec ? `${symbol}-${side}-${sec}` : null,
  ]);
}

export function buildRecentHitKey({ symbol, closeType, refId, eventTime }) {
  return `${symbol}|${closeType}|${refId}|${String(eventTime || "")}`;
}
