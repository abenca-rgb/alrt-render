export function parseNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function fmtPrice(v) {
  if (v === null || v === undefined || v === "") return "N/A";

  const n = Number(v);

  if (!Number.isFinite(n)) return String(v);
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  if (n >= 0.0001) return n.toFixed(8);

  return n.toFixed(10);
}

export function fmtPct(v, { signed = false } = {}) {
  const n = Number(v);

  if (!Number.isFinite(n)) return "N/A";
  if (signed && n > 0) return `+${n.toFixed(2)}%`;
  if (signed && n < 0) return `${n.toFixed(2)}%`;

  return `${n.toFixed(2)}%`;
}

export function fmtRR(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "N/A";
  return `${n.toFixed(2)}R`;
}
