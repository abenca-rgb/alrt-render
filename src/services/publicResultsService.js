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
    tp_hits: 0,
    sl_hits: 0,
    time_exit_profit_hits: 0,
    time_exit_loss_hits: 0,
    time_closed_trades: 0,
    tp_hit_pct: null,
    sl_hit_pct: null,
    win_rate_pct: null,
    open_trades: 0,
    closed_trades: 0,
    average_market_move_pct: null,
    example_return_4x_before_fees_pct: null,
    best_performing_coins: [],
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
    let tpCount = 0;
    let slCount = 0;
    let timeExitProfitCount = 0;
    let timeExitLossCount = 0;
    let winCount = 0;
    let moveSum = 0;
    let moveCount = 0;
    const closedAlertIds = new Set();
    const symbolStats = new Map();

    for (const row of performance30) {
      const alertId = String(row.alert_id || "");
      if (alertId) uniqueAlerts30.add(alertId);

      if (!CLOSED_OUTCOMES.has(row.outcome_type)) continue;

      closedTrades += 1;
      if (alertId) closedAlertIds.add(alertId);
      if (row.outcome_type === "TP") tpCount += 1;
      if (row.outcome_type === "SL") slCount += 1;
      if (row.outcome_type === "TIME_EXIT_PROFIT") timeExitProfitCount += 1;
      if (row.outcome_type === "TIME_EXIT_LOSS") timeExitLossCount += 1;
      if (WIN_OUTCOMES.has(row.outcome_type)) winCount += 1;

      const movePct = toNumber(row.pnl_percent);
      if (movePct !== null) {
        moveSum += movePct;
        moveCount += 1;
      }

      const symbol = normalizeSymbol(row.symbol);
      const bucket = symbolStats.get(symbol) || { symbol, closed: 0, wins: 0, moveSum: 0, moveCount: 0 };
      bucket.closed += 1;
      if (WIN_OUTCOMES.has(row.outcome_type)) bucket.wins += 1;
      if (movePct !== null) {
        bucket.moveSum += movePct;
        bucket.moveCount += 1;
      }
      symbolStats.set(symbol, bucket);
    }

    const openTrades = Array.from(uniqueAlerts30).filter((alertId) => !closedAlertIds.has(alertId)).length;
    const averageMarketMovePct = moveCount ? round(moveSum / moveCount, 2) : null;

    const bestPerformingCoins = Array.from(symbolStats.values())
      .map((bucket) => ({
        symbol: bucket.symbol,
        closed_trades: bucket.closed,
        win_rate_pct: pct(bucket.wins, bucket.closed),
        average_market_move_pct: bucket.moveCount ? round(bucket.moveSum / bucket.moveCount, 2) : null,
      }))
      .sort((a, b) => {
        const moveDelta = (b.average_market_move_pct ?? -Infinity) - (a.average_market_move_pct ?? -Infinity);
        if (moveDelta !== 0) return moveDelta;
        return b.closed_trades - a.closed_trades;
      })
      .slice(0, 6);

    return {
      ok: true,
      available: performance30.length > 0 || alerts7.length > 0,
      source: "supabase",
      generated_at_utc: generatedAtUtc,
      alerts_last_7_days: alerts7.length,
      alerts_last_30_days: uniqueAlerts30.size,
      tp_hits: tpCount,
      sl_hits: slCount,
      time_exit_profit_hits: timeExitProfitCount,
      time_exit_loss_hits: timeExitLossCount,
      time_closed_trades: timeExitProfitCount + timeExitLossCount,
      tp_hit_pct: pct(tpCount, closedTrades),
      sl_hit_pct: pct(slCount, closedTrades),
      win_rate_pct: pct(winCount, closedTrades),
      open_trades: openTrades,
      closed_trades: closedTrades,
      average_market_move_pct: averageMarketMovePct,
      example_return_4x_before_fees_pct:
        averageMarketMovePct === null ? null : round(averageMarketMovePct * 4, 2),
      best_performing_coins: bestPerformingCoins,
      latest_closed_results: latestClosed.map((row) => ({
        ref_id: row.ref_id ? String(row.ref_id) : null,
        symbol: normalizeSymbol(row.symbol),
        direction: row.direction || null,
        result: resultLabel(row.outcome_type),
        market_move_pct: round(row.pnl_percent, 2),
        example_return_4x_before_fees_pct:
          toNumber(row.pnl_percent) === null ? null : round(toNumber(row.pnl_percent) * 4, 2),
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
