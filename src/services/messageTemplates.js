import { fmtPct, fmtPrice, fmtRR } from "../utils/numbers.js";
import { escapeAttr, escapeHtml } from "../utils/payload.js";

export function formatChartHtml(chartLink) {
  if (!chartLink || chartLink === "N/A") return "N/A";

  if (!/^https?:\/\//i.test(String(chartLink))) {
    return escapeHtml(chartLink);
  }

  return `<a href="${escapeAttr(chartLink)}">Open chart</a>`;
}

export function buildAlertText({
  symbol,
  side,
  entry,
  tp,
  sl,
  rr,
  strength,
  prettyTime,
  whyLine,
  chartLink,
  showChartLink,
  refId,
  tpPct,
  setupType,
  qualityScore,
  qualityGrade,
  session,
  marketRegime,
  confidenceLevel,
}) {
  return `🚨 <b>${escapeHtml(symbol)} ${escapeHtml(side)}</b>
<b>REF</b> ${escapeHtml(refId)}
<b>UTC</b> ${escapeHtml(prettyTime)}

<b>SETUP</b> ${escapeHtml(setupType || "N/A")}
<b>GRADE</b> ${escapeHtml(qualityGrade || strength || "N/A")} ${qualityScore ? `(${escapeHtml(qualityScore)}/100)` : ""}

<b>ENTRY</b> ${escapeHtml(fmtPrice(entry))}
<b>TP</b> ${escapeHtml(fmtPrice(tp))} (${escapeHtml(fmtPct(tpPct))})
<b>SL</b> ${escapeHtml(fmtPrice(sl))}
<b>RR</b> ${escapeHtml(fmtRR(rr))}

<b>WHY</b> ${escapeHtml(whyLine)}

<b>CONTEXT</b> ${escapeHtml(marketRegime || "N/A")} • ${escapeHtml(session || "N/A")} • 15M/1H${confidenceLevel ? ` • ${escapeHtml(confidenceLevel)}` : ""}${showChartLink ? `

<b>CHART</b> ${formatChartHtml(chartLink)}` : ""}

NFA`;
}

export function buildHitText({
  trade,
  closeType,
  exitPrice,
  movePct,
  chartLink,
  showChartLink,
}) {
  const isTp = closeType === "TP";
  const isSl = closeType === "SL";
  const isTimeProfit = closeType === "TIME_EXIT_PROFIT";

  const icon = isTp ? "🎯" : isSl ? "🛑" : isTimeProfit ? "⏱️✅" : "⏱️⚠️";

  const status =
    closeType === "TP"
      ? "TP HIT"
      : closeType === "SL"
      ? "SL HIT"
      : closeType === "TIME_EXIT_PROFIT"
      ? "TIME EXIT • PROFIT"
      : closeType === "TIME_EXIT_LOSS"
      ? "TIME EXIT • LOSS"
      : "EXPIRED";

  return `${icon} <b>${escapeHtml(trade.symbol)} ${escapeHtml(trade.side)}</b>

<b>${escapeHtml(status)}</b> • <b>${escapeHtml(fmtPct(movePct, { signed: true }))}</b>

<b>SETUP</b> ${escapeHtml(trade.setupType || "N/A")}
<b>ENTRY</b> ${escapeHtml(fmtPrice(trade.entry))}
<b>EXIT</b> ${escapeHtml(fmtPrice(exitPrice))}
<b>MOVE</b> ${escapeHtml(fmtPct(movePct, { signed: true }))}
<b>REF</b> ${escapeHtml(trade.refId)}${showChartLink ? `

<b>CHART</b> ${formatChartHtml(chartLink)}` : ""}`;
}

export function appendChartLinkIfMissing(text, chartLink) {
  if (!chartLink || chartLink === "N/A") return text;
  if (String(text).includes("<b>CHART</b>")) return text;

  return `${text}

<b>CHART</b> ${formatChartHtml(chartLink)}`;
}
