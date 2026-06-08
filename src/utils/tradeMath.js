import { getSymbolConfig } from "../config/symbols.js";
import { parseNum } from "./numbers.js";

export function hasValidTradeLevels(side, entry, tp, sl) {
  const e = parseNum(entry);
  const t = parseNum(tp);
  const s = parseNum(sl);

  if (!Number.isFinite(e) || !Number.isFinite(t) || !Number.isFinite(s)) return false;
  if (e <= 0 || t <= 0 || s <= 0) return false;

  if (side === "LONG") return t > e && s < e;
  if (side === "SHORT") return t < e && s > e;

  return false;
}

export function pctMove(side, entry, price) {
  const e = parseNum(entry);
  const p = parseNum(price);

  if (!Number.isFinite(e) || !Number.isFinite(p) || e <= 0) return null;

  if (side === "LONG") return ((p - e) / e) * 100;
  if (side === "SHORT") return ((e - p) / e) * 100;

  return null;
}

export function tpPctFromLevels(side, entry, tp) {
  const e = parseNum(entry);
  const t = parseNum(tp);

  if (!Number.isFinite(e) || !Number.isFinite(t) || e <= 0) return null;

  if (side === "LONG") return ((t - e) / e) * 100;
  if (side === "SHORT") return ((e - t) / e) * 100;

  return null;
}

export function slPctFromLevels(side, entry, sl) {
  const e = parseNum(entry);
  const s = parseNum(sl);

  if (!Number.isFinite(e) || !Number.isFinite(s) || e <= 0) return null;

  if (side === "LONG") return ((e - s) / e) * 100;
  if (side === "SHORT") return ((s - e) / e) * 100;

  return null;
}

export function rrFromLevels(side, entry, tp, sl) {
  const e = parseNum(entry);
  const t = parseNum(tp);
  const s = parseNum(sl);

  if (!Number.isFinite(e) || !Number.isFinite(t) || !Number.isFinite(s)) return null;

  let reward = null;
  let risk = null;

  if (side === "LONG") {
    reward = t - e;
    risk = e - s;
  }

  if (side === "SHORT") {
    reward = e - t;
    risk = s - e;
  }

  if (!Number.isFinite(reward) || !Number.isFinite(risk) || reward <= 0 || risk <= 0) return null;

  return reward / risk;
}

export function validateTradeSanity({ symbol, side, entry, tp, sl, rr }) {
  const e = parseNum(entry);
  const t = parseNum(tp);
  const s = parseNum(sl);
  const r = parseNum(rr);

  if (!hasValidTradeLevels(side, e, t, s)) {
    return { ok: false, reason: "invalid_trade_levels" };
  }

  const tpPct = Math.abs(tpPctFromLevels(side, e, t));
  const slPct = Math.abs(slPctFromLevels(side, e, s));

  const symbolConfig = getSymbolConfig(symbol);
  const maxTpPct = symbolConfig.maxTpPct;
  const maxSlPct = symbolConfig.maxSlPct;

  if (!Number.isFinite(tpPct) || tpPct <= 0) {
    return { ok: false, reason: "tp_pct_invalid" };
  }

  if (!Number.isFinite(slPct) || slPct <= 0) {
    return { ok: false, reason: "sl_pct_invalid" };
  }

  if (tpPct < symbolConfig.minTpPct) {
    return {
      ok: false,
      reason: "tp_pct_too_small",
      tpPct,
      minTpPct: symbolConfig.minTpPct,
    };
  }

  if (slPct < symbolConfig.minSlPct) {
    return {
      ok: false,
      reason: "sl_pct_too_small",
      slPct,
      minSlPct: symbolConfig.minSlPct,
    };
  }

  if (tpPct > maxTpPct) {
    return {
      ok: false,
      reason: "tp_pct_too_large",
      tpPct,
      maxTpPct,
    };
  }

  if (slPct > maxSlPct) {
    return {
      ok: false,
      reason: "sl_pct_too_large",
      slPct,
      maxSlPct,
    };
  }

  if (Number.isFinite(r) && r > 5.0) {
    return {
      ok: false,
      reason: "rr_unrealistic",
      rr: r,
    };
  }

  return {
    ok: true,
    tpPct,
    slPct,
    minTpPct: symbolConfig.minTpPct,
    minSlPct: symbolConfig.minSlPct,
  };
}

export function applyFallbackLevels(side, entry, strength, symbol) {
  const e = parseNum(entry);
  if (!Number.isFinite(e) || e <= 0) return { tp: null, sl: null };

  const symbolConfig = getSymbolConfig(symbol);

  const tpPct =
    strength === "A+"
      ? symbolConfig.fallbackTpPctAPlus
      : symbolConfig.fallbackTpPctA;

  const slPct = symbolConfig.fallbackSlPct;

  if (side === "LONG") {
    return {
      tp: e * (1 + tpPct / 100),
      sl: e * (1 - slPct / 100),
    };
  }

  if (side === "SHORT") {
    return {
      tp: e * (1 - tpPct / 100),
      sl: e * (1 + slPct / 100),
    };
  }

  return { tp: null, sl: null };
}
