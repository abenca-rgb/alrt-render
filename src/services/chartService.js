import { chromium } from "playwright";
import { sleep } from "../utils/date.js";
import { normalizeSymbol, pick } from "../utils/payload.js";

const CHARTS = {
  BTCUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT",
  ETHUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:ETHUSDT",
  XRPUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:XRPUSDT",
  SOLUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:SOLUSDT",
  BNBUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:BNBUSDT",
  DOGEUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:DOGEUSDT",
  LTCUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:LTCUSDT",
  ADAUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:ADAUSDT",
  OPUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:OPUSDT",
  ARBUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:ARBUSDT",
  ATOMUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:ATOMUSDT",
  LINKUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:LINKUSDT",
  AVAXUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:AVAXUSDT",
  SHIBUSDT: "https://www.tradingview.com/chart/?symbol=BINANCE:SHIBUSDT",
};

const CHART_IMAGES = {};

function toTvSymbol(symbol) {
  const clean = normalizeSymbol(symbol);
  if (!clean) return "BINANCE:BTCUSDT";
  return `BINANCE:${clean}`;
}

function looksLikeDirectImageUrl(url) {
  const value = String(url || "").trim();

  if (!/^https?:\/\//i.test(value)) return false;
  if (/\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(value)) return true;
  if (value.includes("/image")) return true;
  if (value.includes("/images/")) return true;
  if (value.includes("chart-image")) return true;
  if (value.includes("snapshot")) return true;

  return false;
}

export function createChartService({
  appBaseUrl = "",
  chartImageTemplate = "",
} = {}) {
  function getBaseUrl() {
    if (!appBaseUrl) {
      console.error("APP_BASE_URL ontbreekt");
      return "";
    }

    return appBaseUrl;
  }

  function resolveChartLink(symbol) {
    return CHARTS[symbol] || "N/A";
  }

  function isLocalChartImageUrl(url) {
    const value = String(url || "").trim();

    if (!value) return false;
    if (!value.includes("/chart-image")) return false;

    const baseUrl = getBaseUrl();

    if (baseUrl && value.startsWith(baseUrl)) return true;

    try {
      const parsed = new URL(value);
      return parsed.pathname === "/chart-image";
    } catch {
      return value.includes("/chart-image");
    }
  }

  function buildLocalChartImageUrl({ symbol, side, refId }) {
    const baseUrl = getBaseUrl();

    if (!baseUrl || !symbol) return null;

    const params = new URLSearchParams({
      symbol: toTvSymbol(symbol),
      side: String(side || "LONG"),
      ref: String(refId || ""),
      interval: "60",
    });

    return `${baseUrl}/chart-image?${params.toString()}`;
  }

  function resolveChartImageUrl(body, symbol, side = "LONG", refId = "") {
    const inline = pick(
      body.chart_image_url,
      body.image_url,
      body.snapshot_url,
      body.chart_snapshot,
      body.chart_image,
      body.image,
      body.photo
    );

    if (inline && looksLikeDirectImageUrl(inline)) {
      return String(inline).trim();
    }

    const mapped = CHART_IMAGES[symbol];

    if (mapped && looksLikeDirectImageUrl(mapped)) {
      return String(mapped).trim();
    }

    if (chartImageTemplate && chartImageTemplate.includes("{symbol}")) {
      const built = chartImageTemplate.replace("{symbol}", symbol);

      if (looksLikeDirectImageUrl(built)) {
        return built;
      }
    }

    return buildLocalChartImageUrl({
      symbol,
      side,
      refId,
    });
  }

  async function renderChartImagePngBuffer({
    symbol = "BINANCE:BTCUSDT",
    side = "LONG",
    ref = "",
    interval = "60",
  }) {
    let browser;

    try {
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });

      const page = await browser.newPage({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      });

      const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>ALRT Chart</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: #0b1220;
      width: 1280px;
      height: 720px;
      overflow: hidden;
      font-family: Arial, sans-serif;
    }
    #wrap {
      width: 1280px;
      height: 720px;
      position: relative;
      background: #0b1220;
    }
    #tv_chart_container {
      width: 1280px;
      height: 720px;
    }
    .badge {
      position: absolute;
      top: 14px;
      left: 14px;
      z-index: 20;
      background: rgba(10, 14, 25, 0.88);
      color: white;
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.3px;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
    }
  </style>
</head>
<body>
  <div id="wrap">
    <div class="badge">${symbol} • ${side}${ref ? ` • REF ${ref}` : ""}</div>
    <div id="tv_chart_container"></div>
  </div>

  <script src="https://s3.tradingview.com/tv.js"></script>
  <script>
    function startWidget() {
      if (!window.TradingView) {
        setTimeout(startWidget, 300);
        return;
      }

      new TradingView.widget({
        autosize: false,
        width: 1280,
        height: 720,
        symbol: ${JSON.stringify(symbol)},
        interval: ${JSON.stringify(interval)},
        timezone: "Etc/UTC",
        theme: "dark",
        style: "1",
        locale: "en",
        hide_top_toolbar: false,
        hide_legend: false,
        allow_symbol_change: false,
        save_image: false,
        studies: [],
        container_id: "tv_chart_container"
      });
    }

    startWidget();
  </script>
</body>
</html>
    `;

      await page.setContent(html, {
        waitUntil: "load",
        timeout: 60000,
      });

      await sleep(8000);

      return await page.screenshot({
        type: "png",
      });
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch {}
      }
    }
  }

  async function buildChartDeliveryAssets({
    symbol,
    side,
    refId,
    inlineBody = null,
  }) {
    const imageUrl = resolveChartImageUrl(inlineBody || {}, symbol, side, refId);

    if (!imageUrl) {
      return {
        imageUrl: null,
        imageBuffer: null,
        imageFilename: `${symbol || "chart"}-${refId || "alert"}.png`,
      };
    }

    if (isLocalChartImageUrl(imageUrl)) {
      try {
        const pngBuffer = await renderChartImagePngBuffer({
          symbol: toTvSymbol(symbol),
          side,
          ref: refId,
          interval: "60",
        });

        return {
          imageUrl,
          imageBuffer: pngBuffer,
          imageFilename: `${symbol || "chart"}-${refId || "alert"}.png`,
        };
      } catch (err) {
        console.error("LOCAL CHART RENDER FOR TELEGRAM FAILED:", err);

        return {
          imageUrl,
          imageBuffer: null,
          imageFilename: `${symbol || "chart"}-${refId || "alert"}.png`,
        };
      }
    }

    return {
      imageUrl,
      imageBuffer: null,
      imageFilename: `${symbol || "chart"}-${refId || "alert"}.png`,
    };
  }

  return {
    resolveChartLink,
    renderChartImagePngBuffer,
    buildChartDeliveryAssets,
  };
}
