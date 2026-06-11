export function createSupabasePersistenceService({ supabase, getDailyStat, activeTrades }) {
  function ready() {
    return supabase.ready();
  }

  function persistAlert(payload) {
    supabase.persistAlert(payload);
  }

  function persistCandidate(payload) {
    supabase.persistCandidate(payload);
  }

  function updateCandidateDecision(payload) {
    supabase.updateCandidateDecision(payload);
  }

  function persistOutcome(payload) {
    supabase.persistOutcome(payload);
  }

  function persistShadowEvaluation(payload) {
    supabase.persistShadowEvaluation(payload);
  }

  function updateShadowOutcome(payload) {
    supabase.updateShadowOutcome(payload);
  }

  function persistRejection(payload) {
    supabase.persistRejection(payload);
  }

  function persistDailySummary(dateKey) {
    const stat = getDailyStat(dateKey);
    const closed =
      stat.tp +
      stat.sl +
      (stat.timeExitProfit || 0) +
      (stat.timeExitLoss || 0) +
      (stat.expired || 0);
    const wins = stat.tp + (stat.timeExitProfit || 0);
    const winrate = closed > 0 ? (wins / closed) * 100 : null;
    const openCount = Array.from(activeTrades.values()).filter((trade) => !trade.hit).length;

    supabase.persistDailySummary({ dateKey, stat, openCount, winrate });
  }

  function persistOptimizerReport(payload) {
    return supabase.persistOptimizerReport(payload);
  }

  return {
    ready,
    persistAlert,
    persistCandidate,
    updateCandidateDecision,
    persistOutcome,
    persistShadowEvaluation,
    updateShadowOutcome,
    persistRejection,
    persistDailySummary,
    persistOptimizerReport,
  };
}
