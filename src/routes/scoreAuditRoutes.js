export function registerScoreAuditRoutes(app, {
  summaryAdminToken = "",
  scoreAuditService,
  openTradeAuditService,
  lifecycleAutoCloseService,
} = {}) {
  function authorize(req, res) {
    const token = String(req.query.token || req.headers["x-summary-token"] || "");

    if (!summaryAdminToken || token !== summaryAdminToken) {
      res.status(403).json({
        ok: false,
        error: "forbidden",
      });
      return false;
    }

    return true;
  }

  app.get("/admin/audit/score", async (req, res) => {
    if (!authorize(req, res)) return;

    try {
      const report = await scoreAuditService.runScoreAudit();

      res.set("Cache-Control", "no-store");
      return res.status(report.ok ? 200 : 503).json(report);
    } catch (err) {
      console.error("SCORE AUDIT ERROR:", err?.message || String(err));
      return res.status(500).json({
        ok: false,
        error: "score audit failed",
        generated_at_utc: new Date().toISOString(),
      });
    }
  });

  app.get("/admin/audit/shadow-score", async (req, res) => {
    if (!authorize(req, res)) return;

    try {
      const report = await scoreAuditService.getShadowScoreReport();

      res.set("Cache-Control", "no-store");
      return res.status(report.ok ? 200 : 503).json(report);
    } catch (err) {
      console.error("SHADOW SCORE REPORT ERROR:", err?.message || String(err));
      return res.status(500).json({
        ok: false,
        error: "shadow score report failed",
        generated_at_utc: new Date().toISOString(),
      });
    }
  });

  app.post("/admin/audit/shadow-score/backfill", async (req, res) => {
    if (!authorize(req, res)) return;

    try {
      const result = await scoreAuditService.backfillShadowScoreHistory();

      res.set("Cache-Control", "no-store");
      return res.status(result.ok ? 200 : 503).json(result);
    } catch (err) {
      console.error("SHADOW SCORE BACKFILL ERROR:", err?.message || String(err));
      return res.status(500).json({
        ok: false,
        error: "shadow score backfill failed",
        generated_at_utc: new Date().toISOString(),
      });
    }
  });

  app.get("/admin/audit/open-trades", async (req, res) => {
    if (!authorize(req, res)) return;

    try {
      const report = await openTradeAuditService.runOpenTradeAudit();

      res.set("Cache-Control", "no-store");
      return res.status(report.ok ? 200 : 503).json(report);
    } catch (err) {
      console.error("OPEN TRADE AUDIT ERROR:", err?.message || String(err));
      return res.status(500).json({
        ok: false,
        error: "open trade audit failed",
        generated_at_utc: new Date().toISOString(),
      });
    }
  });

  app.post("/admin/audit/open-trades/auto-close", async (req, res) => {
    if (!authorize(req, res)) return;

    try {
      const dryRun = String(req.query.dry_run ?? "1") !== "0";
      const confirm = String(req.query.confirm || "") === "1";
      const includeSupabaseOnly = String(req.query.include_supabase_only ?? "1") !== "0";

      const report = await lifecycleAutoCloseService.runLifecycleAutoClose({
        dryRun,
        confirm,
        includeSupabaseOnly,
      });

      res.set("Cache-Control", "no-store");
      return res.status(report.ok ? 200 : 503).json(report);
    } catch (err) {
      console.error("LIFECYCLE AUTO-CLOSE ERROR:", err?.message || String(err));
      return res.status(500).json({
        ok: false,
        error: "lifecycle auto-close failed",
        generated_at_utc: new Date().toISOString(),
      });
    }
  });
}
