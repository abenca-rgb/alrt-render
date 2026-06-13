export function registerSystemRoutes(app, {
  config,
  getHealthState,
  sendDailySummary,
  summaryService,
  runOptimizerReport,
  getUtcDateKey,
} = {}) {
  function authorizeSummary(req, res) {
    const token = String(req.query.token || req.headers["x-summary-token"] || "");

    if (!config.summaryAdminToken || token !== config.summaryAdminToken) {
      res.status(403).json({
        ok: false,
        error: "manual summary disabled",
      });
      return false;
    }

    return true;
  }

  function forceRequested(req) {
    return String(req.query.force || req.body?.force || "false").toLowerCase() === "true";
  }

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
      wordpressSyncEnabled: Boolean(config.wordpressSyncEnabled),
      wordpressSyncReady: Boolean(config.wordpressSyncReady),
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
      clusterGuardrailEnabled: config.clusterGuardrailEnabled,
      clusterGuardrailWindowMinutes: config.clusterGuardrailWindowMinutes,
      clusterGuardrailMode: config.clusterGuardrailMode,
      clusterGuardrailVersion: config.clusterGuardrailVersion,
      clusterGuardrailRollbackEnabled: config.clusterGuardrailRollbackEnabled,
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
      summaryDispatchScope: config.summaryDispatchScope,
      manualSummaryEnabled: Boolean(config.summaryAdminToken),
      manualOptimizerEnabled: Boolean(config.summaryAdminToken && config.optimizerReportsEnabled),
      paidMembers: state.paidMembers,
      freeMembers: state.freeMembers,
    });
  });

  app.post("/summary/send-now", async (req, res) => {
    if (!authorizeSummary(req, res)) return;

    try {
      const dateKey = getUtcDateKey(Date.now());
      const sent = await sendDailySummary(dateKey, forceRequested(req));
      res.status(200).json({
        ok: true,
        periodType: "daily",
        periodKey: dateKey,
        sent,
      });
    } catch (err) {
      console.error("MANUAL SUMMARY ERROR:", err);
      res.status(500).json({
        ok: false,
        error: err?.message || String(err),
      });
    }
  });

  app.get("/summary/daily/preview", async (req, res) => {
    if (!authorizeSummary(req, res)) return;

    try {
      const dateKey = String(req.query.date || getUtcDateKey(Date.now()));
      const summary = await summaryService.preview({
        periodType: "daily",
        periodKey: dateKey,
      });

      res.status(200).json({
        ok: true,
        periodType: "daily",
        periodKey: dateKey,
        source: summary.source,
        stats: {
          alerts: summary.stat.alerts,
          tp: summary.stat.tp,
          sl: summary.stat.sl,
          timeExitProfit: summary.stat.timeExitProfit,
          timeExitLoss: summary.stat.timeExitLoss,
          expired: summary.stat.expired,
          rejectedSignals: summary.stat.rejectedSignals,
          openTotal: summary.openTotal,
        },
        text: summary.text,
      });
    } catch (err) {
      console.error("DAILY SUMMARY PREVIEW ERROR:", err);
      res.status(500).json({
        ok: false,
        error: err?.message || String(err),
      });
    }
  });

  app.post("/summary/daily/send-now", async (req, res) => {
    if (!authorizeSummary(req, res)) return;

    try {
      const dateKey = String(req.query.date || getUtcDateKey(Date.now()));
      const result = await summaryService.send({
        periodType: "daily",
        periodKey: dateKey,
        force: forceRequested(req),
      });

      res.status(200).json(result);
    } catch (err) {
      console.error("DAILY SUMMARY SEND ERROR:", err);
      res.status(500).json({
        ok: false,
        error: err?.message || String(err),
      });
    }
  });

  app.get("/summary/weekly/preview", async (req, res) => {
    if (!authorizeSummary(req, res)) return;

    try {
      const weekKey = String(req.query.week || summaryService.getUtcWeekKey(Date.now()));
      const summary = await summaryService.preview({
        periodType: "weekly",
        periodKey: weekKey,
      });

      res.status(200).json({
        ok: true,
        periodType: "weekly",
        periodKey: weekKey,
        source: summary.source,
        stats: {
          alerts: summary.stat.alerts,
          tp: summary.stat.tp,
          sl: summary.stat.sl,
          timeExitProfit: summary.stat.timeExitProfit,
          timeExitLoss: summary.stat.timeExitLoss,
          expired: summary.stat.expired,
          rejectedSignals: summary.stat.rejectedSignals,
          openTotal: summary.openTotal,
        },
        text: summary.text,
      });
    } catch (err) {
      console.error("WEEKLY SUMMARY PREVIEW ERROR:", err);
      res.status(500).json({
        ok: false,
        error: err?.message || String(err),
      });
    }
  });

  app.post("/summary/weekly/send-now", async (req, res) => {
    if (!authorizeSummary(req, res)) return;

    try {
      const weekKey = String(req.query.week || summaryService.getUtcWeekKey(Date.now()));
      const result = await summaryService.send({
        periodType: "weekly",
        periodKey: weekKey,
        force: forceRequested(req),
      });

      res.status(200).json(result);
    } catch (err) {
      console.error("WEEKLY SUMMARY SEND ERROR:", err);
      res.status(500).json({
        ok: false,
        error: err?.message || String(err),
      });
    }
  });

  app.post("/optimizer/run-now", async (req, res) => {
    const token = String(req.query.token || req.headers["x-summary-token"] || "");
    const periodType = String(req.query.period || req.body?.period || "all");
    const detail = String(req.query.detail || req.body?.detail || "compact");

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
      if (periodType === "all_periods") {
        const periods = ["daily", "weekly", "monthly", "all"];
        const reports = [];
        for (const period of periods) {
          reports.push(await runOptimizerReport({ periodType: period, detail: "compact" }));
        }
        return res.status(200).json({
          ok: true,
          periods: reports.map((report) => ({
            periodType: report.periodType,
            generatedAtUtc: report.generatedAtUtc,
            summary: report.summary,
            recommendationCount: report.recommendations?.length || 0,
          })),
        });
      }

      const report = await runOptimizerReport({ periodType, detail });
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
