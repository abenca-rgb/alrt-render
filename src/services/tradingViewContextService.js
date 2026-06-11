import {
  deriveSetupType,
  getStrengthBucket,
  resolveLeverage,
} from "./alertEnrichmentService.js";
import {
  collectAllCandidateIds,
  parseIncomingRef,
} from "./tradeIdentityService.js";
import { eventTimeToMs } from "../utils/date.js";
import { parseNum } from "../utils/numbers.js";
import { detectExplicitCloseType } from "../utils/outcomes.js";
import {
  applyFallbackLevels,
  hasValidTradeLevels,
  rrFromLevels,
  tpPctFromLevels,
} from "../utils/tradeMath.js";
import {
  normalizeEventType,
  normalizeSide,
  normalizeSymbol,
  pick,
} from "../utils/payload.js";

export function buildTradingViewContext({ body, receivedAtMs }) {
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
  const tp2Raw = pick(body.tp2, body.take_profit_2, body.tp2_price, body.target2, body.target_2);
  const tp3Raw = pick(body.tp3, body.take_profit_3, body.tp3_price, body.target3, body.target_3);

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
  const volatilityPct = pick(body.volatility_pct, body.volatilityPercent, body.volatility_percent);
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
  const tp2Parsed = parseNum(tp2Raw);
  const tp3Parsed = parseNum(tp3Raw);
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
  const candidateKey = candidateIdsBase[0] || incomingRef || `${symbol}-${side}-${eventTimeMs}`;

  return {
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
    tp2Parsed,
    tp3Parsed,
    slParsed,
    rr,
    tpPct,
    incomingRef,
    explicitCloseType,
    candidateIdsBase,
    eventTime,
    eventTimeMs,
    rsi,
    atrPct,
    volatilityPct,
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
    candidateKey,
  };
}
