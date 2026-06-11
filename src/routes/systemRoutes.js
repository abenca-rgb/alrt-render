export function registerSystemRoutes(app, {
  config,
  getHealthState,
  sendDailySummary,
  runOptimizerReport,
  getUtcDateKey,
} = {}) {
  app.get("/", (req, res) => {
    res.status(200).json({
      ok: true,
      service: "ALRT-Render",
      version: config.appVersion,
    });
  });

  app.get("/health", (req, res) => {
    const state = getHealthState();

    res.status(200).json({
      ok: true,
      version: config.appVersion,
      timestamp: new Date().toISOString(),
      dataDir: config.dataDir,
      stateFile: config.stateFile,
      supabaseEnabled: config.supabaseEnabled,
      supabaseReady: state.supabaseReady,
      activeTrades: state.activeTrades,
      recentHitKeys: state.recentHitKeys,
      recentLossStops: state.recentLossStops,
      nextRef: state.nextRef,
      refStartFloor: config.refStartFloor,
      nextRefFloorSafe: state.nextRef >= config.refStartFloor,
      maxTradeAgeHours: config.maxTradeAgeMs / 1000 / 60 / 60,
      lossGuardSymbolCooldownMinutes: Math.round(config.lossGuardSymbolCooldownMs / 60000),
      lossGuardMarketWindowMinutes: Math.round(config.lossGuardMarketWindowMs / 60000),
      lossGuardMarketCooldownMinutes: Math.round(config.lossGuardMarketCooldownMs / 60000),
      lossGuardMarketLimit: config.lossGuardMarketLimit,
      minRrToSend: config.minRrToSend,
      maxOpenTradesPerSymbol: config.maxOpenTradesPerSymbol,
      maxOpenTradesPerSide: config.maxOpenTradesPerSide,
      dailySlCircuitBreaker: config.dailySlCircuitBreaker,
      alertQualityFilterEnabled: config.alertQualityFilterEnabled,
      candidateQualityFilterEnabled: config.candidateQualityFilterEnabled,
      learningLoggingEnabled: config.learningLoggingEnabled,
      candidateLoggingEnabled: config.candidateLoggingEnabled,
      shadowValidationEnabled: config.shadowValidationEnabled,
      optimizerReportsEnabled: config.optimizerReportsEnabled,
      historicalQualityAdjustmentsEnabled: config.historicalQualityAdjustmentsEnabled,
      duplicateSuppressionEnabled: config.duplicateSuppressionEnabled,
      allowedSymbols: config.allowedSymbols,
      freeEnabled: Boolean(config.freeChatId),
      freePostDate: state.freePostDate,
      freePostsToday: state.freePostsToday,
      freeDailyLimit: config.freeDailyLimit,
      freeSharedRefs: state.freeSharedRefs,
      dailyStatsDays: state.dailyStatsDays,
      lastSummarySentDate: state.lastSummarySentDate,
      dailySummaryEnabled: config.dailySummaryEnabled,
      dailySummaryUtcHour: config.dailySummaryUtcHour,
      dailySummaryUtcMinute: config.dailySummaryUtcMinute,
      manualSummaryEnabled: Boolean(config.summaryAdminToken),
      manualOptimizerEnabled: Boolean(config.summaryAdminToken && config.optimizerReportsEnabled),
      paidMembers: state.paidMembers,
      freeMembers: state.freeMembers,
    });
  });

  app.post("/summary/send-now", async (req, res) => {
    const token = String(req.query.token || req.headers["x-summary-token"] || "");

    if (!config.summaryAdminToken || token !== config.summaryAdminToken) {
      return res.status(403).json({
        ok: false,
        error: "manual summary disabled",
      });
    }

    res.status(200).json({
      ok: true,
      message: "summary send requested",
    });

    try {
      const dateKey = getUtcDateKey(Date.now());
      await sendDailySummary(dateKey, true);
    } catch (err) {
      console.error("MANUAL SUMMARY ERROR:", err);
    }
  });

  app.post("/optimizer/run-now", async (req, res) => {
    const token = String(req.query.token || req.headers["x-summary-token"] || "");
    const periodType = String(req.query.period || req.body?.period || "all");

    if (!config.summaryAdminToken || token !== config.summaryAdminToken) {
      return res.status(403).json({
        ok: false,
        error: "manual optimizer disabled",
      });
    }

    if (!config.optimizerReportsEnabled || !runOptimizerReport) {
      return res.status(503).json({
        ok: false,
        error: "optimizer reports disabled",
      });
    }

    try {
      const report = await runOptimizerReport({ periodType });
      res.status(200).json(report);
    } catch (err) {
      console.error("MANUAL OPTIMIZER ERROR:", err);
      res.status(500).json({
        ok: false,
        error: err?.message || String(err),
      });
    }
  });
}
