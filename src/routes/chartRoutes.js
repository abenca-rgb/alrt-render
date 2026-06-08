import path from "path";
import { promises as fs } from "fs";

export function registerChartRoutes(app, {
  rootDir,
  chartService,
} = {}) {
  app.get("/chart-template", async (req, res) => {
    try {
      const templatePath = path.join(rootDir, "chart-template.html");
      const html = await fs.readFile(templatePath, "utf8");

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(html);
    } catch (err) {
      console.error("CHART TEMPLATE ERROR:", err);
      res.status(500).send("chart template error");
    }
  });

  app.get("/chart-image", async (req, res) => {
    try {
      const symbol = String(req.query.symbol || "BINANCE:BTCUSDT");
      const side = String(req.query.side || "LONG").toUpperCase();
      const ref = String(req.query.ref || "");
      const interval = String(req.query.interval || "60");

      const png = await chartService.renderChartImagePngBuffer({
        symbol,
        side,
        ref,
        interval,
      });

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=120");
      res.status(200).send(png);
    } catch (err) {
      console.error("CHART IMAGE ERROR FULL:", err);
      res.status(500).send(`chart image error: ${err?.message || String(err)}`);
    }
  });
}
