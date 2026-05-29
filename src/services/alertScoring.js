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
  if (score >= 85) return "A+";
  if (score >= 75) return "A";
  if (score >= 65) return "B";
  return "C";
}

function meetsMinGrade(grade, minGrade) {
  const current = GRADE_ORDER[normalizeGrade(grade) || "C"] || 0;
  const required = GRADE_ORDER[normalizeGrade(minGrade) || "A"] || GRADE_ORDER.A;

  return current >= required;
}

export function scoreAlertQuality({
  symbolConfig,
  side,
  rr,
  strength,
  setupScore,
  trendStrength,
  volatilityState,
  marketRegime,
  session,
  rsi,
  atrPct,
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

  if (incomingGrade === "A+") score += 20;
  else if (incomingGrade === "A") score += 14;
  else if (incomingGrade === "B") score += 5;
  else if (incomingGrade === "C") score -= 10;

  if (Number.isFinite(numericSetupScore)) {
    if (numericSetupScore >= 8) {
      score += 10;
      reasons.push("strong setup score");
    } else if (numericSetupScore >= 6) {
      score += 4;
    } else {
      score -= 8;
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
    if (numericRr >= 2.0) score += 8;
    else if (numericRr >= symbolConfig.minRr) score += 3;
    else {
      score -= 18;
      penalties.push("risk/reward below symbol requirement");
    }
  }

  if (Number.isFinite(numericAtr)) {
    if (numericAtr >= 0.25 && numericAtr <= 2.8) score += 7;
    else if (numericAtr > 3.5) {
      score -= 12;
      penalties.push("volatility is too stretched");
    } else if (numericAtr < 0.15) {
      score -= 8;
      penalties.push("volatility is too compressed");
    }
  }

  if (side === "LONG" && Number.isFinite(numericRsi)) {
    if (numericRsi >= 48 && numericRsi <= 68) score += 7;
    if (numericRsi > 74) {
      score -= 12;
      penalties.push("long signal is near RSI exhaustion");
    }
  }

  if (side === "SHORT" && Number.isFinite(numericRsi)) {
    if (numericRsi >= 32 && numericRsi <= 52) score += 7;
    if (numericRsi < 26) {
      score -= 12;
      penalties.push("short signal is near RSI exhaustion");
    }
  }

  const regimeText = String(marketRegime || volatilityState || "").toLowerCase();
  if (/(trend|expansion|continuation|clean)/.test(regimeText)) {
    score += 8;
    reasons.push("market regime is supportive");
  }
  if (/(chop|range|sideways|noise)/.test(regimeText)) {
    score -= 18;
    penalties.push("market regime is choppy");
  }

  const sessionText = String(session || "").toLowerCase();
  if (/(london|new_york|ny|us|eu|overlap)/.test(sessionText)) score += 5;
  if (/(dead|late|illiquid|asia_late)/.test(sessionText)) {
    score -= 6;
    penalties.push("session quality is weak");
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
