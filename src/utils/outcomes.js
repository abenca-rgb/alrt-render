import { normalizeEventType, pick } from "./payload.js";
import { pctMove } from "./tradeMath.js";

export function normalizeCloseResult(hitType) {
  const x = normalizeEventType(hitType);

  if (x === "tp" || x === "tp_hit" || x.includes("take_profit")) return "TP";
  if (x === "sl" || x === "sl_hit" || x.includes("stop_loss")) return "SL";
  if (x === "time_exit_profit") return "TIME_EXIT_PROFIT";
  if (x === "time_exit_loss") return "TIME_EXIT_LOSS";
  if (x === "expired" || x === "time_exit") return "EXPIRED";

  return null;
}

export function detectExplicitCloseType(eventType, body) {
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

export function isLikelySignalEvent(eventType, side, entry) {
  const normalized = normalizeEventType(eventType);

  if (normalized.includes("signal")) return true;
  if (normalized.includes("entry")) return true;
  if (normalized.includes("alert")) return true;

  return (side === "LONG" || side === "SHORT") && entry !== null && entry !== undefined && entry !== "";
}

export function shouldInferHit(trade, currentPrice) {
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

export function getTimeExitResult(trade, currentPrice) {
  const movePct = pctMove(trade.side, trade.entry, currentPrice);

  if (!Number.isFinite(movePct)) return "EXPIRED";
  if (movePct > 0.05) return "TIME_EXIT_PROFIT";
  if (movePct < -0.05) return "TIME_EXIT_LOSS";

  return "EXPIRED";
}
