export function registerPublicResultsRoutes(app, { publicResultsService } = {}) {
  app.get("/api/public-results", async (req, res) => {
    try {
      const results = await publicResultsService.getPublicResults();

      res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=900");
      res.status(200).json(results);
    } catch (err) {
      console.error("PUBLIC RESULTS ERROR:", err?.message || String(err));
      res.status(503).json({
        ok: false,
        available: false,
        source: "error",
        error: "results temporarily unavailable",
        generated_at_utc: new Date().toISOString(),
      });
    }
  });
}
