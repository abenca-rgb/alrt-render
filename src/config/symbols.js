export const DEFAULT_SYMBOL_CONFIG = {
  enabled: true,
  major: false,
  maxTpPct: 5.0,
  maxSlPct: 2.8,
  minRr: 1.5,
  minScore: 75,
  minGrade: "A",
  fallbackTpPctAPlus: 2.8,
  fallbackTpPctA: 2.2,
  fallbackSlPct: 1.35,
  leverageStrong: "3x",
  leverageNormal: "2x",
};

export const SYMBOL_CONFIGS = {
  BTCUSDT: {
    major: true,
    maxTpPct: 4.0,
    maxSlPct: 2.0,
    minRr: 1.7,
    fallbackTpPctAPlus: 2.2,
    fallbackTpPctA: 1.7,
    fallbackSlPct: 1.0,
    leverageStrong: "4x",
    leverageNormal: "3x",
  },
  ETHUSDT: {
    major: true,
    maxTpPct: 4.0,
    maxSlPct: 2.0,
    minRr: 1.7,
    fallbackTpPctAPlus: 2.2,
    fallbackTpPctA: 1.7,
    fallbackSlPct: 1.0,
    leverageStrong: "4x",
    leverageNormal: "3x",
  },
  SOLUSDT: {
    major: true,
    maxTpPct: 4.5,
    maxSlPct: 2.2,
    minRr: 1.7,
    fallbackTpPctAPlus: 2.4,
    fallbackTpPctA: 1.9,
    fallbackSlPct: 1.1,
    leverageStrong: "4x",
    leverageNormal: "3x",
  },
  BNBUSDT: {
    major: true,
    maxTpPct: 4.0,
    maxSlPct: 2.0,
    minRr: 1.6,
    fallbackTpPctAPlus: 2.1,
    fallbackTpPctA: 1.6,
    fallbackSlPct: 1.0,
    leverageStrong: "4x",
    leverageNormal: "3x",
  },
  XRPUSDT: {
    major: true,
    maxTpPct: 4.5,
    maxSlPct: 2.2,
    minRr: 1.6,
    fallbackTpPctAPlus: 2.4,
    fallbackTpPctA: 1.9,
    fallbackSlPct: 1.1,
    leverageStrong: "4x",
    leverageNormal: "3x",
  },
  LINKUSDT: {
    major: true,
    maxTpPct: 4.8,
    maxSlPct: 2.4,
    minRr: 1.6,
    fallbackTpPctAPlus: 2.5,
    fallbackTpPctA: 2.0,
    fallbackSlPct: 1.15,
    leverageStrong: "4x",
    leverageNormal: "3x",
  },
  AVAXUSDT: {},
  ADAUSDT: {},
  DOGEUSDT: {},
  LTCUSDT: {},
  OPUSDT: {},
  ARBUSDT: {},
  ATOMUSDT: {},
  SHIBUSDT: {
    enabled: false,
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

export function isAllowedTradingSymbol(symbol) {
  const key = String(symbol || "").toUpperCase();
  const config = getSymbolConfig(key);

  return Boolean(key && SYMBOL_CONFIGS[key] && config.enabled !== false);
}
