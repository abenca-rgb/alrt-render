const GRADE_ORDER = {
  "C": 1,
  "B": 2,
  "A": 3,
  "A+": 4,
};

function parseNum(value) {
  if (value === null || value === undefined || value === "") return null;

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeGrade(value) {
  const grade = String(value || "").trim().toUpperCase();
  return GRADE_ORDER[grade] ? grade : null;
}

function gradeFromScore(score) {
  if (score >= 92) return "A+";
  if (score >= 84) return "A";
  if (score >= 72) return "B";
  return "C";
}

function meetsMinGrade(grade, minGrade) {
  const current = GRADE_ORDER[normalizeGrade(grade) || "C"] || 0;
  const required = GRADE_ORDER[normalizeGrade(minGrade) || "A"] || GRADE_ORDER.A;

  return current >= required;
}

export function scoreAlertQuality({
  symbolConfig,
  symbol,
  side,
  setupType,
  rr,
  tpPct,
  slPct,
  strength,
  setupScore,
  trendStrength,
  volatilityState,
  marketRegime,
  session,
  rsi,
  atrPct,
  eventTimeMs,
  historicalQualityAdjustmentsEnabled = false,
}) {
  let score = 50;
  const reasons = [];
  const penalties = [];

  const incomingGrade = normalizeGrade(strength);
  const numericSetupScore = parseNum(setupScore);
  const numericTrend = parseNum(trendStrength);
  const numericRsi = parseNum(rsi);
  const numericAtr = parseNum(atrPct);
  const numericRr = parseNum(rr);
  const numericTpPct = parseNum(tpPct);
  const numericSlPct = parseNum(slPct);
  if (historicalQualityAdjustmentsEnabled) {
    const symbolKey = String(symbol || "").toUpperCase();

    const historicalCoinAdjustment = {
      ETHUSDT: 4,
      LINKUSDT: 4,
      AVAXUSDT: 3,
      BNBUSDT: 1,
      XRPUSDT: 0,
      SOLUSDT: -2,
      BTCUSDT: -5,
      ADAUSDT: -6,
      LTCUSDT: -8,
      DOGEUSDT: -10,
    }[symbolKey] || 0;

    if (historicalCoinAdjustment > 0) {
      score += historicalCoinAdjustment;
      reasons.push("historical coin performance supports this symbol");
    } else if (historicalCoinAdjustment < 0) {
      score += historicalCoinAdjustment;
      penalties.push("historical coin performance requires stricter confirmation");
    }

    const time = Number.isFinite(eventTimeMs) ? new Date(eventTimeMs) : null;
    const utcHour = time ? time.getUTCHours() : null;
    const utcDay = time ? time.getUTCDay() : null;

    if ([4, 6, 10, 17, 23].includes(utcHour)) {
      score += 8;
      reasons.push("historically strong UTC hour");
    }

    if ([14, 15, 18].includes(utcHour)) {
      score -= 14;
      penalties.push("historically weak UTC hour");
    }

    if (utcDay === 0) {
      score += 4;
      reasons.push("historically stronger weekday");
    } else if (utcDay === 1 || utcDay === 2) {
      score -= 4;
      penalties.push("historically weaker weekday");
    }
  }

  if (incomingGrade === "A+") score += 4;
  else if (incomingGrade === "A") score += 2;
  else if (incomingGrade === "B") score -= 4;
  else if (incomingGrade === "C") score -= 10;

  if (Number.isFinite(numericSetupScore)) {
    if (numericSetupScore >= 13) {
      score += 6;
      reasons.push("strong setup score");
    } else if (numericSetupScore >= 10) {
      score += 2;
    } else {
      score -= 10;
      penalties.push("weak setup score");
    }
  }

  if (Number.isFinite(numericTrend)) {
    if (numericTrend >= 22) {
      score += 8;
      reasons.push("trend strength supports continuation");
    } else if (numericTrend < 14) {
      score -= 8;
      penalties.push("trend strength is weak");
    }
  }

  if (Number.isFinite(numericRr)) {
    if (numericRr >= symbolConfig.preferredRr) score += 10;
    else if (numericRr >= symbolConfig.minRr) score += 3;
    else {
      score -= 24;
      penalties.push("risk/reward below symbol requirement");
    }
  }

  if (Number.isFinite(numericTpPct)) {
    if (numericTpPct >= symbolConfig.minTpPct && numericTpPct <= symbolConfig.maxTpPct) score += 4;
    if (numericTpPct < symbolConfig.minTpPct) {
      score -= 8;
      penalties.push("target is too small to justify the trade");
    }
  }

  if (Number.isFinite(numericSlPct)) {
    if (numericSlPct >= symbolConfig.minSlPct && numericSlPct <= symbolConfig.maxSlPct) score += 4;
    if (numericSlPct < symbolConfig.minSlPct) {
      score -= 10;
      penalties.push("stop is too tight and likely to be wicked");
    }
  }

  if (Number.isFinite(numericAtr)) {
    if (numericAtr >= symbolConfig.atrMinPct && numericAtr <= symbolConfig.atrMaxPct) score += 8;
    else if (numericAtr > symbolConfig.atrMaxPct) {
      score -= 14;
      penalties.push("volatility is too stretched");
    } else if (numericAtr < symbolConfig.atrMinPct) {
      score -= 10;
      penalties.push("volatility is too compressed");
    }
  }

  if (side === "LONG" && Number.isFinite(numericRsi)) {
    if (numericRsi >= symbolConfig.rsiLongMin && numericRsi <= symbolConfig.rsiLongMax) score += 8;
    if (numericRsi > symbolConfig.rsiLongMax + 6) {
      score -= 14;
      penalties.push("long signal is near RSI exhaustion");
    }
  }

  if (side === "SHORT" && Number.isFinite(numericRsi)) {
    if (numericRsi >= symbolConfig.rsiShortMin && numericRsi <= symbolConfig.rsiShortMax) score += 8;
    if (numericRsi < symbolConfig.rsiShortMin - 6) {
      score -= 14;
      penalties.push("short signal is near RSI exhaustion");
    }
  }

  const regimeText = String(marketRegime || volatilityState || "").toLowerCase();
  if (/(trend|continuation|clean)/.test(regimeText)) {
    score += 8;
    reasons.push("market regime is supportive");
  }
  if (historicalQualityAdjustmentsEnabled && /expansion/.test(regimeText)) {
    score += 6;
    reasons.push("historically supportive expansion regime");
  }
  if (historicalQualityAdjustmentsEnabled && /compression/.test(regimeText)) {
    score -= 10;
    penalties.push("compression regime needs stronger confirmation");
  }
  if (/extended/.test(regimeText)) {
    score -= 30;
    penalties.push("price is extended from value");
  }
  if (/(chop|range|sideways|noise|mean_reversion)/.test(regimeText)) {
    score -= 24;
    penalties.push("market regime is choppy");
  }

  const sessionText = String(session || "").toLowerCase();
  if (/(overlap)/.test(sessionText)) score += 4;
  else if (/(london|new_york|ny|us|eu)/.test(sessionText)) score += 2;
  else {
    score -= 12;
    penalties.push("session quality is neutral");
  }
  if (symbolConfig.avoidSessions.some((bad) => sessionText.includes(bad))) {
    score -= 10;
    penalties.push("session quality is weak");
  }

  const setupText = String(setupType || "").toLowerCase();
  if (/continuation/.test(setupText)) {
    score -= 8;
    penalties.push("continuation setup needs extra confirmation");
  }
  if (historicalQualityAdjustmentsEnabled && /break/.test(setupText) && /expansion/.test(regimeText)) {
    score -= 4;
    penalties.push("breakout during expansion needs chase protection");
  }
  if (/pullback|reclaim/.test(setupText)) {
    score += 3;
  }

  if (symbolConfig.tier === "satellite") {
    score -= 4;
    penalties.push("satellite symbol requires stronger confirmation");
  }

  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  const grade = gradeFromScore(clampedScore);

  return {
    score: clampedScore,
    grade,
    passed: clampedScore >= symbolConfig.minScore && meetsMinGrade(grade, symbolConfig.minGrade),
    minScore: symbolConfig.minScore,
    minGrade: symbolConfig.minGrade,
    reasons,
    penalties,
  };
}
