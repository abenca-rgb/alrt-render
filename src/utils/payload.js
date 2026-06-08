export function pick(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

export function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map((v) => String(v).trim()).filter(Boolean))];
}

export function sanitizePayloadForStorage(payload) {
  if (!payload || typeof payload !== "object") return null;

  const copy = { ...payload };

  for (const key of Object.keys(copy)) {
    if (/secret|token|key|password/i.test(key)) {
      copy[key] = "[redacted]";
    }
  }

  return copy;
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function normalizeSymbol(v) {
  return String(v || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(".P", "")
    .replace("BINANCE:", "")
    .replace("/", "");
}

export function normalizeSide(v) {
  const x = String(v || "").toUpperCase().trim();

  if (x === "LONG" || x === "SHORT") return x;
  if (x === "BUY") return "LONG";
  if (x === "SELL") return "SHORT";

  return "N/A";
}

export function normalizeEventType(v) {
  return String(v || "").toLowerCase().trim().replace(/\s+/g, "_");
}

export function normalizeSetupType(v) {
  const x = String(v || "").toLowerCase().trim();

  if (!x) return "UNKNOWN";

  if (x.includes("trend_pullback")) return "TREND_PULLBACK";
  if (x.includes("compression_breakout")) return "COMPRESSION_BREAKOUT";
  if (x.includes("liquidity_reclaim")) return "LIQUIDITY_RECLAIM";
  if (x.includes("htf_continuation")) return "HTF_CONTINUATION";
  if (x.includes("reversal_expansion")) return "REVERSAL_EXPANSION";

  if (x.includes("pull")) return "TREND_PULLBACK";
  if (x.includes("compress") || x.includes("squeeze") || x.includes("break")) return "COMPRESSION_BREAKOUT";
  if (x.includes("reclaim")) return "LIQUIDITY_RECLAIM";
  if (x.includes("trend")) return "HTF_CONTINUATION";
  if (x.includes("reversal") || x.includes("reverse")) return "REVERSAL_EXPANSION";

  return x.toUpperCase();
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}
