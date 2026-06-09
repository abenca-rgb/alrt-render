import { getSymbolConfig } from "../config/symbols.js";
import { fmtRR, parseNum } from "../utils/numbers.js";
import { normalizeSetupType, pick } from "../utils/payload.js";

function isMajorSymbol(symbol) {
  return Boolean(getSymbolConfig(symbol).major);
}

export function getStrengthBucket({ symbol, side, rsi, atrPct, score, risk, incomingStrength }) {
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

export function resolveLeverage(body, symbol, strength) {
  const raw = pick(
    body.leverage,
    body.lev,
    body.suggested_leverage,
    body.recommended_leverage,
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

export function deriveSetupType({ body, side, rsi, atrPct }) {
  const explicit = normalizeSetupType(
    pick(body.setup_type, body.reason_type, body.setup, body.pattern, body.signal_name, body.strategy_name),
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

export function buildWhyLine({ body, side, setupType, rr, session, marketRegime }) {
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
