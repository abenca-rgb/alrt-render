export const DEFAULT_SYMBOL_CONFIG = {
  enabled: true,
  major: false,
  tier: "alt",
  maxTpPct: 5.0,
  maxSlPct: 2.8,
  minTpPct: 0.45,
  minSlPct: 0.25,
  minRr: 1.65,
  preferredRr: 2.0,
  minScore: 78,
  minGrade: "A",
  fallbackTpPctAPlus: 2.8,
  fallbackTpPctA: 2.2,
  fallbackSlPct: 1.35,
  leverageStrong: "3x",
  leverageNormal: "2x",
  rsiLongMin: 48,
  rsiLongMax: 68,
  rsiShortMin: 32,
  rsiShortMax: 52,
  atrMinPct: 0.25,
  atrMaxPct: 2.8,
  avoidSessions: ["dead", "illiquid", "late"],
};

export const SYMBOL_CONFIGS = {
  BTCUSDT: {
    major: true,
    tier: "core",
    maxTpPct: 4.0,
    maxSlPct: 2.0,
    minTpPct: 0.35,
    minSlPct: 0.20,
    minRr: 1.8,
    minScore: 80,
    fallbackTpPctAPlus: 2.2,
    fallbackTpPctA: 1.7,
    fallbackSlPct: 1.0,
    leverageStrong: "4x",
    leverageNormal: "3x",
  },
  ETHUSDT: {
    major: true,
    tier: "core",
    maxTpPct: 4.0,
    maxSlPct: 2.0,
    minTpPct: 0.38,
    minSlPct: 0.22,
    minRr: 1.8,
    minScore: 80,
    fallbackTpPctAPlus: 2.2,
    fallbackTpPctA: 1.7,
    fallbackSlPct: 1.0,
    leverageStrong: "4x",
    leverageNormal: "3x",
  },
  SOLUSDT: {
    major: true,
    tier: "core",
    maxTpPct: 4.5,
    maxSlPct: 2.2,
    minTpPct: 0.50,
    minSlPct: 0.28,
    minRr: 1.8,
    minScore: 81,
    fallbackTpPctAPlus: 2.4,
    fallbackTpPctA: 1.9,
    fallbackSlPct: 1.1,
    leverageStrong: "4x",
    leverageNormal: "3x",
  },
  BNBUSDT: {
    major: true,
    tier: "core",
    maxTpPct: 4.0,
    maxSlPct: 2.0,
    minTpPct: 0.38,
    minSlPct: 0.22,
    minRr: 1.75,
    minScore: 79,
    fallbackTpPctAPlus: 2.1,
    fallbackTpPctA: 1.6,
    fallbackSlPct: 1.0,
    leverageStrong: "4x",
    leverageNormal: "3x",
  },
  XRPUSDT: {
    major: true,
    tier: "core",
    maxTpPct: 4.5,
    maxSlPct: 2.2,
    minTpPct: 0.45,
    minSlPct: 0.25,
    minRr: 1.75,
    minScore: 79,
    fallbackTpPctAPlus: 2.4,
    fallbackTpPctA: 1.9,
    fallbackSlPct: 1.1,
    leverageStrong: "4x",
    leverageNormal: "3x",
  },
  LINKUSDT: {
    major: true,
    tier: "core",
    maxTpPct: 4.8,
    maxSlPct: 2.4,
    minTpPct: 0.48,
    minSlPct: 0.28,
    minRr: 1.75,
    minScore: 79,
    fallbackTpPctAPlus: 2.5,
    fallbackTpPctA: 2.0,
    fallbackSlPct: 1.15,
    leverageStrong: "4x",
    leverageNormal: "3x",
  },
  AVAXUSDT: {
    tier: "satellite",
    minRr: 1.9,
    minScore: 84,
    minGrade: "A+",
    maxTpPct: 5.2,
    maxSlPct: 2.5,
  },
  ADAUSDT: {
    tier: "satellite",
    minRr: 1.9,
    minScore: 84,
    minGrade: "A+",
  },
  DOGEUSDT: {
    tier: "satellite",
    minRr: 2.0,
    minScore: 86,
    minGrade: "A+",
    maxTpPct: 5.5,
    maxSlPct: 2.6,
  },
  LTCUSDT: {
    tier: "satellite",
    minRr: 1.85,
    minScore: 82,
    minGrade: "A",
  },
  OPUSDT: {
    tier: "satellite",
    minRr: 2.0,
    minScore: 86,
    minGrade: "A+",
  },
  ARBUSDT: {
    tier: "satellite",
    minRr: 2.0,
    minScore: 86,
    minGrade: "A+",
  },
  ATOMUSDT: {
    tier: "satellite",
    minRr: 1.9,
    minScore: 84,
    minGrade: "A+",
  },
  SHIBUSDT: {
    enabled: false,
    tier: "disabled",
    minScore: 85,
    minGrade: "A+",
  },
};

export const ALLOWED_SYMBOLS = Object.keys(SYMBOL_CONFIGS).filter((symbol) => {
  return SYMBOL_CONFIGS[symbol]?.enabled !== false;
});

export function getSymbolConfig(symbol) {
  const key = String(symbol || "").toUpperCase();
  const specific = SYMBOL_CONFIGS[key] || {};

  return {
    ...DEFAULT_SYMBOL_CONFIG,
    ...specific,
  };
}

export function getAllowedSymbolsFromEnv(envValue = "") {
  const configured = String(envValue || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);

  if (configured.length > 0) {
    return configured.filter((symbol) => SYMBOL_CONFIGS[symbol]?.enabled !== false);
  }

  return ALLOWED_SYMBOLS;
}

export function isAllowedTradingSymbol(symbol, allowedSymbols = ALLOWED_SYMBOLS) {
  const key = String(symbol || "").toUpperCase();
  const config = getSymbolConfig(key);

  return Boolean(key && allowedSymbols.includes(key) && SYMBOL_CONFIGS[key] && config.enabled !== false);
}
