export function registerScoreAuditRoutes(app, {
  summaryAdminToken = "",
  scoreAuditService,
} = {}) {
  app.get("/admin/audit/score", async (req, res) => {
    const token = String(req.query.token || req.headers["x-summary-token"] || "");

    if (!summaryAdminToken || token !== summaryAdminToken) {
      return res.status(403).json({
        ok: false,
        error: "forbidden",
      });
    }

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
}
