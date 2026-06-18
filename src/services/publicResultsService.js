const WIN_OUTCOMES = new Set(["TP", "TIME_EXIT_PROFIT"]);
const LOSS_OUTCOMES = new Set(["SL", "TIME_EXIT_LOSS"]);
const CLOSED_OUTCOMES = new Set(["TP", "SL", "TIME_EXIT_PROFIT", "TIME_EXIT_LOSS", "EXPIRED", "MANUAL_CLOSE"]);

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, decimals = 2) {
  const number = toNumber(value);
  if (number === null) return null;
  const factor = 10 ** decimals;
  return Math.round(number * factor) / factor;
}

function pct(part, total) {
  if (!total) return null;
  return round((part / total) * 100, 2);
}

function normalizeSymbol(symbol) {
  return String(symbol || "UNKNOWN").toUpperCase();
}

function resultLabel(outcomeType) {
  if (WIN_OUTCOMES.has(outcomeType)) return "TP";
  if (LOSS_OUTCOMES.has(outcomeType)) return "SL";
  return outcomeType || "CLOSED";
}

function buildEmptyResult({ generatedAtUtc, source = "supabase" } = {}) {
  return {
    ok: true,
    available: false,
    source,
    generated_at_utc: generatedAtUtc || new Date().toISOString(),
    alerts_last_7_days: 0,
    alerts_last_30_days: 0,
    win_rate_pct: null,
    closed_trades: 0,
    average_market_move_pct: null,
    latest_closed_results: [],
    disclaimer:
      "Signals are not financial advice. Results are based on market movement, not guaranteed personal profit.",
  };
}

export function createPublicResultsService({ supabase } = {}) {
  async function selectRows(table, query) {
    return supabase.selectRows(table, query);
  }

  function ready() {
    return Boolean(supabase?.ready?.());
  }

  async function getPublicResults({ now = new Date() } = {}) {
    const generatedAtUtc = toIso(now);

    if (!ready()) {
      return buildEmptyResult({ generatedAtUtc, source: "supabase-unavailable" });
    }

    const start7 = addDays(now, -7).toISOString();
    const start30 = addDays(now, -30).toISOString();

    const [alerts7, performance30, latestClosed] = await Promise.all([
      selectRows(
        "alerts",
        `?select=alert_id&signal_time_utc=gte.${encodeURIComponent(start7)}&limit=10000`,
      ),
      selectRows(
        "alert_performance",
        `?select=alert_id,ref_id,symbol,direction,signal_time_utc,outcome_type,outcome_time_utc,pnl_percent&signal_time_utc=gte.${encodeURIComponent(start30)}&limit=10000`,
      ),
      selectRows(
        "alert_performance",
        "?select=ref_id,symbol,direction,signal_time_utc,outcome_type,outcome_time_utc,pnl_percent&outcome_type=not.is.null&order=outcome_time_utc.desc&limit=12",
      ),
    ]);

    const uniqueAlerts30 = new Set();
    let closedTrades = 0;
    let winCount = 0;
    let moveSum = 0;
    let moveCount = 0;

    for (const row of performance30) {
      const alertId = String(row.alert_id || "");
      if (alertId) uniqueAlerts30.add(alertId);

      if (!CLOSED_OUTCOMES.has(row.outcome_type)) continue;

      closedTrades += 1;
      if (WIN_OUTCOMES.has(row.outcome_type)) winCount += 1;

      const movePct = toNumber(row.pnl_percent);
      if (movePct !== null) {
        moveSum += movePct;
        moveCount += 1;
      }
    }

    const averageMarketMovePct = moveCount ? round(moveSum / moveCount, 2) : null;

    return {
      ok: true,
      available: performance30.length > 0 || alerts7.length > 0,
      source: "supabase",
      generated_at_utc: generatedAtUtc,
      alerts_last_7_days: alerts7.length,
      alerts_last_30_days: uniqueAlerts30.size,
      win_rate_pct: pct(winCount, closedTrades),
      closed_trades: closedTrades,
      average_market_move_pct: averageMarketMovePct,
      latest_closed_results: latestClosed.map((row) => ({
        ref_id: row.ref_id ? String(row.ref_id) : null,
        symbol: normalizeSymbol(row.symbol),
        direction: row.direction || null,
        result: resultLabel(row.outcome_type),
        market_move_pct: round(row.pnl_percent, 2),
        opened_at_utc: row.signal_time_utc || null,
        closed_at_utc: row.outcome_time_utc || null,
      })),
      disclaimer:
        "Signals are not financial advice. Results are based on market movement, not guaranteed personal profit.",
    };
  }

  return {
    getPublicResults,
    ready,
  };
}
