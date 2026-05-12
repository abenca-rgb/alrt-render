function buildDailySummaryText(dateKey) {
  const stat = getDailyStat(dateKey);
  const closed = stat.tp + stat.sl + stat.timeExitProfit + stat.timeExitLoss;
  const positive = stat.tp + stat.timeExitProfit;
  const winrate = closed > 0 ? (positive / closed) * 100 : null;
  const openCount = Array.from(activeTrades.values()).filter((t) => !t.hit).length;

  const symbols = Object.entries(stat.bySymbol || {})
    .sort((a, b) => (b[1].alerts || 0) - (a[1].alerts || 0))
    .slice(0, 8)
    .map(([symbol, s]) => {
      return `${symbol}: ${s.alerts || 0} alerts | TP ${s.tp || 0} | SL ${s.sl || 0} | T+ ${s.timeExitProfit || 0} | T- ${s.timeExitLoss || 0}`;
    });

  return `📊 <b>D-ALRT DAILY OVERVIEW</b>
<b>UTC DATE</b> ${escapeHtml(dateKey)}

<b>ALERTS</b> ${stat.alerts}
<b>TP HITS</b> ${stat.tp}
<b>SL HITS</b> ${stat.sl}
<b>TIME EXIT PROFIT</b> ${stat.timeExitProfit || 0}
<b>TIME EXIT LOSS</b> ${stat.timeExitLoss || 0}
<b>EXPIRED</b> ${stat.expired || 0}
<b>WINRATE</b> ${closed > 0 ? escapeHtml(fmtPct(winrate)) : "N/A"}
<b>OPEN TRADES</b> ${openCount}

<b>FREE POSTS</b> ${stat.freeAlerts}/${FREE_DAILY_LIMIT}

${symbols.length ? `<b>BY SYMBOL</b>\n${escapeHtml(symbols.join("\n"))}` : "<b>BY SYMBOL</b>\nN/A"}

NFA`;
}

async function sendDailySummary(dateKey, force = false) {
  if (!DAILY_SUMMARY_ENABLED && !force) return false;
  if (!force && lastSummarySentDate === dateKey) return false;

  const text = buildDailySummaryText(dateKey);

  await sendTelegramMessage(text, CHAT_ID);

  if (FREE_CHAT_ID) {
    await sendTelegramMessage(text, FREE_CHAT_ID);
  }

  lastSummarySentDate = dateKey;
  await persistState();

  console.log("DAILY SUMMARY SENT:", {
    dateKey,
    force,
    lastSummarySentDate,
  });

  return true;
}

async function maybeSendDailySummary() {
  if (!DAILY_SUMMARY_ENABLED) return;

  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  if (hour !== DAILY_SUMMARY_UTC_HOUR || minute !== DAILY_SUMMARY_UTC_MINUTE) return;

  const dateKey = getUtcDateKey(Date.now());

  if (lastSummarySentDate === dateKey) return;

  await sendDailySummary(dateKey, false);
}

// ===== TIME EXIT =====
async function closeTradeByTimeExit(key, trade, nowMs, currentPrice = null) {
  const exitPrice = Number.isFinite(currentPrice) ? currentPrice : trade.entry;
  const movePct = pctMove(trade.side, trade.entry, exitPrice);
  const result = getTimeExitResult(trade, exitPrice);

  trade.hit = true;
  trade.hitType = result;
  trade.hitAtMs = nowMs;

  await sendHitAlert({
    trade,
    hitType: result,
    hitTime: nowMs,
    hitPrice: exitPrice,
    chatId: CHAT_ID,
  });

  if (wasSharedToFree(trade.refId)) {
    try {
      await sendHitAlert({
        trade,
        hitType: result,
        hitTime: nowMs,
        hitPrice: exitPrice,
        chatId: FREE_CHAT_ID,
      });
    } catch (err) {
      console.error("FREE TIME EXIT SEND FAILED:", {
        refId: trade.refId,
        error: err?.message || String(err),
      });
    }
  }

  await recordCloseStat({
    refId: trade.refId,
    symbol: trade.symbol,
    result,
    exitPrice,
    movePct,
    ts: nowMs,
  });

  await removeTrade(key);

  console.log("TIME EXIT CLOSED:", {
    symbol: trade.symbol,
    side: trade.side,
    refId: trade.refId,
    result,
    exitPrice: fmtPrice(exitPrice),
    movePct: fmtPct(movePct, { signed: true }),
  });
}

function cleanupState() {
  const now = Date.now();
  let changed = false;

  for (const [key, ts] of recentHitKeys.entries()) {
    if (!ts || now - ts > HIT_DEDUP_TTL_MS) {
      recentHitKeys.delete(key);
      changed = true;
    }
  }

  for (const [refId, info] of freeSharedRefs.entries()) {
    if (!info?.sharedAtMs || now - info.sharedAtMs > FREE_REF_TTL_MS) {
      freeSharedRefs.delete(refId);
      changed = true;
    }
  }

  const keepAfterMs = now - 10 * 24 * 60 * 60 * 1000;
  for (const [dateKey] of dailyStats.entries()) {
    const statDateMs = Date.parse(`${dateKey}T00:00:00Z`);
    if (Number.isFinite(statDateMs) && statDateMs < keepAfterMs) {
      dailyStats.delete(dateKey);
      changed = true;
    }
  }

  resetFreeCounterIfNeeded(now);

  if (changed) {
    void persistState();
  }
}

// ===== PERSISTENCE =====
async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function persistState() {
  savePromise = savePromise
    .then(async () => {
      await ensureDataDir();

      const payload = {
        updatedAt: new Date().toISOString(),
        version: APP_VERSION,
        nextRef,
        refStartFloor: REF_START_FLOOR,
        activeTrades: Array.from(activeTrades.entries()).map(([key, trade]) => [key, trade]),
        recentHitKeys: Array.from(recentHitKeys.entries()).map(([key, ts]) => [key, ts]),
        freePostDate,
        freePostsToday,
        freeSharedRefs: Array.from(freeSharedRefs.entries()).map(([refId, info]) => [refId, info]),
        dailyStats: Array.from(dailyStats.entries()).map(([dateKey, stat]) => [dateKey, stat]),
        lastSummarySentDate,
        paidMembers: Array.from(paidMembers.entries()).map(([email, info]) => [email, info]),
        freeMembers: Array.from(freeMembers.entries()).map(([email, info]) => [email, info]),
      };

      await fs.writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
    })
    .catch((err) => {
      console.error("PERSIST SAVE ERROR:", err);
    });

  return savePromise;
}

async function loadState() {
  try {
    await ensureDataDir();

    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    const active = Array.isArray(parsed?.activeTrades) ? parsed.activeTrades : [];
    const hits = Array.isArray(parsed?.recentHitKeys) ? parsed.recentHitKeys : [];
    const freeRefs = Array.isArray(parsed?.freeSharedRefs) ? parsed.freeSharedRefs : [];
    const stats = Array.isArray(parsed?.dailyStats) ? parsed.dailyStats : [];
    const now = Date.now();

    if (Number.isFinite(Number(parsed?.nextRef))) {
      nextRef = Math.min(999999, Number(parsed.nextRef));
    } else {
      nextRef = REF_START_FLOOR;
    }

    freePostDate = typeof parsed?.freePostDate === "string" ? parsed.freePostDate : getUtcDateKey(now);
    freePostsToday = Number.isFinite(Number(parsed?.freePostsToday)) ? Math.max(0, Number(parsed.freePostsToday)) : 0;
    lastSummarySentDate = typeof parsed?.lastSummarySentDate === "string" ? parsed.lastSummarySentDate : "";

    resetFreeCounterIfNeeded(now);

    for (const item of active) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [key, trade] = item;

      if (!trade || typeof trade !== "object") continue;
      if (!trade.createdAtMs) continue;
      if (trade.hit) continue;

      if (now - trade.createdAtMs > MAX_TRADE_AGE_MS) continue;

      activeTrades.set(key, trade);
    }

    for (const item of hits) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [key, ts] = item;

      if (!ts || now - ts > HIT_DEDUP_TTL_MS) continue;

      recentHitKeys.set(key, ts);
    }

    for (const item of freeRefs) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [refId, info] = item;

      if (!refId || !info?.sharedAtMs) continue;
      if (now - info.sharedAtMs > FREE_REF_TTL_MS) continue;

      freeSharedRefs.set(String(refId), info);
    }

    if (Array.isArray(parsed?.paidMembers)) {
      for (const item of parsed.paidMembers) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const [email, info] = item;
        paidMembers.set(email, info);
      }
    }

    if (Array.isArray(parsed?.members)) {
      for (const item of parsed.members) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const [email, info] = item;
        paidMembers.set(email, info);
      }
    }

    if (Array.isArray(parsed?.freeMembers)) {
      for (const item of parsed.freeMembers) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const [email, info] = item;
        freeMembers.set(email, info);
      }
    }

    for (const item of stats) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [dateKey, stat] = item;
      if (!dateKey || !stat || typeof stat !== "object") continue;

      dailyStats.set(String(dateKey), stat);
    }

    getDailyStat(getUtcDateKey(now));

    console.log(`Loaded ${activeTrades.size} active trades from disk`);
    console.log(`Loaded ${recentHitKeys.size} recent hit keys from disk`);
    console.log(`Loaded ${freeSharedRefs.size} free shared refs from disk`);
    console.log(`Loaded ${dailyStats.size} daily stat days from disk`);
    console.log(`Loaded ${paidMembers.size} paid members from disk`);
    console.log(`Loaded ${freeMembers.size} free members from disk`);
    console.log(`Loaded nextRef ${nextRef}`);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("No state.json found yet, starting clean");
      freePostDate = getUtcDateKey(Date.now());
      freePostsToday = 0;
      lastSummarySentDate = "";
      nextRef = Math.max(REF_START_FLOOR, 100000);
      getDailyStat(freePostDate);
      return;
    }

    console.error("PERSIST LOAD ERROR:", err);
  }
}

async function removeTrade(tradeKey) {
  if (activeTrades.delete(tradeKey)) {
    await persistState();
  }
}

async function upsertTrade(tradeKey, trade) {
  activeTrades.set(tradeKey, trade);
  await persistState();
}

// ===== CHART RENDER =====
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

// ===== TELEGRAM =====
async function sendTelegramMessage(text, chatId = CHAT_ID) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const data = await response.json();

  console.log("TELEGRAM MESSAGE RESPONSE:", {
    chatId,
    data,
  });

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendMessage failed: ${JSON.stringify(data)}`);
  }
}

async function sendTelegramPhoto({
  photoUrl = null,
  photoBuffer = null,
  filename = "chart.png",
  caption = "",
  chatId = CHAT_ID,
}) {
  let response;
  let data;

  if (photoBuffer) {
    const form = new FormData();

    form.append("chat_id", chatId);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append("photo", new Blob([photoBuffer], { type: "image/png" }), filename);

    response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      body: form,
    });
  } else {
    response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption,
        parse_mode: "HTML",
      }),
    });
  }

  data = await response.json();

  console.log("TELEGRAM PHOTO RESPONSE:", {
    chatId,
    data,
  });

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendPhoto failed: ${JSON.stringify(data)}`);
  }
}

async function sendTelegramAlert({
  text,
  imageUrl = null,
  imageBuffer = null,
  imageFilename = "chart.png",
  fallbackChartLink = "N/A",
  chatId = CHAT_ID,
}) {
  if (imageBuffer || imageUrl) {
    try {
      await sendTelegramPhoto({
        photoUrl: imageUrl,
        photoBuffer: imageBuffer,
        filename: imageFilename,
        caption: text,
        chatId,
      });

      return { usedPhoto: true };
    } catch (err) {
      console.error("PHOTO SEND FAILED, FALLING BACK TO MESSAGE:", err.message);

      const fallbackText = appendChartLinkIfMissing(text, fallbackChartLink);
      await sendTelegramMessage(fallbackText, chatId);

      return { usedPhoto: false, photoFailed: true };
    }
  }

  const fallbackText = appendChartLinkIfMissing(text, fallbackChartLink);
  await sendTelegramMessage(fallbackText, chatId);

  return { usedPhoto: false };
}

async function buildChartDeliveryAssets({
  symbol,
  side,
  refId,
  req = null,
  inlineBody = null,
}) {
  const imageUrl = resolveChartImageUrl(inlineBody || {}, symbol, side, refId, req);

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

async function sendHitAlert({
  trade,
  hitType,
  hitTime,
  hitPrice = null,
  chatId = CHAT_ID,
}) {
  const exitPrice =
    hitType === "TP"
      ? trade.tp
      : hitType === "SL"
      ? trade.sl
      : Number.isFinite(parseNum(hitPrice))
      ? parseNum(hitPrice)
      : trade.entry;

  const movePct = pctMove(trade.side, trade.entry, exitPrice);
  const chartLink = trade.chartLink || resolveChartLink(trade.symbol);

  const chartAssets = await buildChartDeliveryAssets({
    symbol: trade.symbol,
    side: trade.side,
    refId: trade.refId,
    inlineBody: {
      chart_image_url: trade.chartImageUrl,
    },
  });

  const showChartLink = !chartAssets.imageUrl && !chartAssets.imageBuffer;

  const hitText = buildHitText({
    trade,
    hitType,
    exitPrice,
    movePct,
    chartLink,
    showChartLink,
  });

  await sendTelegramAlert({
    text: hitText,
    imageUrl: chartAssets.imageUrl,
    imageBuffer: chartAssets.imageBuffer,
    imageFilename: chartAssets.imageFilename,
    fallbackChartLink: chartLink,
    chatId,
  });
}

// ===== ROUTES =====
app.get("/chart-template", async (req, res) => {
  try {
    const templatePath = path.join(__dirname, "chart-template.html");
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

    const png = await renderChartImagePngBuffer({
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

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "ALRT-Render",
    version: APP_VERSION,
  });
});

app.get("/health", (req, res) => {
  resetFreeCounterIfNeeded(Date.now());

  res.status(200).json({
    ok: true,
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    dataDir: DATA_DIR,
    stateFile: STATE_FILE,
    activeTrades: activeTrades.size,
    recentHitKeys: recentHitKeys.size,
    nextRef,
    refStartFloor: REF_START_FLOOR,
    maxTradeAgeHours: MAX_TRADE_AGE_MS / 1000 / 60 / 60,
    minRrToSend: MIN_RR_TO_SEND,
    maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
    freeEnabled: Boolean(FREE_CHAT_ID),
    freePostDate,
    freePostsToday,
    freeDailyLimit: FREE_DAILY_LIMIT,
    freeSharedRefs: freeSharedRefs.size,
    dailyStatsDays: dailyStats.size,
    lastSummarySentDate,
    dailySummaryEnabled: DAILY_SUMMARY_ENABLED,
    dailySummaryUtcHour: DAILY_SUMMARY_UTC_HOUR,
    dailySummaryUtcMinute: DAILY_SUMMARY_UTC_MINUTE,
    paidMembers: paidMembers.size,
    freeMembers: freeMembers.size,
  });
});

app.post("/summary/send-now", async (req, res) => {
  const token = String(req.query.token || req.headers["x-summary-token"] || "");
  const expected = String(process.env.SUMMARY_ADMIN_TOKEN || "");

  if (!expected || token !== expected) {
    return res.status(403).json({
      ok: false,
      error: "manual summary disabled",
    });
  }

  res.status(200).json({ ok: true, message: "summary send requested" });

  try {
    const dateKey = getUtcDateKey(Date.now());
    await sendDailySummary(dateKey, true);
  } catch (err) {
    console.error("MANUAL SUMMARY ERROR:", err);
  }
});

app.post("/signup/free", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        ok: false,
        error: "valid email required",
      });
    }

    const existing = freeMembers.get(email);

    if (existing?.inviteLink) {
      return res.status(200).json({
        ok: true,
        email,
        inviteLink: existing.inviteLink,
        existing: true,
      });
    }

    const inviteLink = await createFreeTelegramInviteLink({ expireHours: 48 });

    freeMembers.set(email, {
      email,
      status: "free",
      active: true,
      inviteLink,
      inviteCreatedAt: new Date().toISOString(),
      inviteExpireHours: 48,
      telegramUserId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await persistState();

    await sendTelegramMessage(
`🆓 <b>NEW FREE MEMBER</b>

<b>Email</b> ${escapeHtml(email)}

<b>Free Invite</b>
${inviteLink}`
    );

    return res.status(200).json({
      ok: true,
      email,
      inviteLink,
    });
  } catch (err) {
    console.error("FREE SIGNUP ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "free signup failed",
    });
  }
});

app.get("/admin/members", async (req, res) => {
  const token = String(req.query.token || "");
  const expected = String(process.env.SUMMARY_ADMIN_TOKEN || "");

  if (!expected || token !== expected) {
    return res.status(403).json({
      ok: false,
      error: "forbidden",
    });
  }

  res.status(200).json({
    ok: true,
    paidCount: paidMembers.size,
    freeCount: freeMembers.size,
    paidMembers: Array.from(paidMembers.values()),
    freeMembers: Array.from(freeMembers.values()),
  });
});

// ===== WEBHOOK HANDLER =====
async function handleTradingViewWebhook(req, res) {
  const body = req.body || {};
  const receivedAtMs = Date.now();
  const prettyTime = formatUtc(receivedAtMs);

  res.status(200).json({ ok: true });

  try {
    cleanupState();

    const symbol = normalizeSymbol(
      pick(body.symbol, body.ticker, body.pair, body.coin, body.market, "")
    );

    const side = normalizeSide(
      pick(body.side, body.direction, body.position, body.trade_side, body.action, "")
    );

    const entryRaw = pick(
      body.entry,
      body.entry_price,
      body.entryPrice,
      body.price,
      body.Entry,
      body.close
    );

    const tpRaw = pick(
      body.tp1,
      body.tp,
      body.take_profit,
      body.takeProfit,
      body.tp_price,
      body.target,
      body.target_price,
      body.TP,
      body.tpPrice
    );

    const slRaw = pick(
      body.sl,
      body.stop_loss,
      body.stop,
      body.stopLoss,
      body.sl_price,
      body.stop_price,
      body.SL,
      body.slPrice
    );

    const rsi = pick(body.rsi, body.rsi_value);
    const atrPct = pick(body.atr_pct, body.atrPercent, body.atr_percent);
    const score = pick(body.score, body.strength_score, body.setup_score);
    const risk = pick(body.risk, body.risk_score);
    const incomingStrength = pick(body.strength, body.grade, body.quality);

    const eventTime = pick(
      body.time_close,
      body.bar_close_time,
      body.timestamp,
      body.time,
      receivedAtMs
    );

    const eventTimeMs = eventTimeToMs(eventTime);

    const eventType = pick(
      body.event,
      body.type,
      body.event_type,
      body.kind,
      body.signal_type,
      ""
    );

    const currentPrice = parseNum(
      pick(body.hit_price, body.last_price, body.market_price, body.price, body.close, body.last)
    );

    const setupType = deriveSetupType({
      body,
      side,
      rsi,
      atrPct,
    });

    const strength = getStrengthBucket({
      symbol,
      side,
      rsi,
      atrPct,
      score,
      risk,
      incomingStrength,
    });

    const leverage = resolveLeverage(body, symbol, strength);

    const entryParsed = parseNum(entryRaw);
    let tpParsed = parseNum(tpRaw);
    let slParsed = parseNum(slRaw);

    const validIncomingLevels = hasValidTradeLevels(side, entryParsed, tpParsed, slParsed);

    if (!validIncomingLevels && Number.isFinite(entryParsed) && (side === "LONG" || side === "SHORT")) {
      const derived = applyFallbackLevels(side, entryParsed, strength, symbol);
      tpParsed = derived.tp;
      slParsed = derived.sl;
    }

    const validLevels = hasValidTradeLevels(side, entryParsed, tpParsed, slParsed);
    const rr = rrFromLevels(side, entryParsed, tpParsed, slParsed);
    const tpPct = tpPctFromLevels(side, entryParsed, tpParsed);

    const incomingRef = parseIncomingRef(body);
    const explicitHitType = detectExplicitHitType(eventType, body);

    const candidateIdsBase = collectAllCandidateIds({
      body,
      symbol,
      side,
      eventTimeMs,
      refId: incomingRef || "",
    });

    if (!BOT_TOKEN || !CHAT_ID) {
      console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
      return;
    }

    const chartLink = resolveChartLink(symbol);

    console.log("WEBHOOK RECEIVED:", {
      version: APP_VERSION,
      symbol,
      side,
      eventType,
      entry: fmtPrice(entryParsed),
      tp: fmtPrice(tpParsed),
      sl: fmtPrice(slParsed),
      rr: fmtRR(rr),
      strength,
      currentPrice: fmtPrice(currentPrice),
      activeTrades: activeTrades.size,
      nextRef,
    });

    if (symbol) {
      for (const [key, trade] of Array.from(activeTrades.entries())) {
        if (trade.symbol !== symbol) continue;
        if (trade.hit) continue;

        const ageMs = receivedAtMs - (trade.createdAtMs || receivedAtMs);

        if (ageMs >= MAX_TRADE_AGE_MS) {
          await closeTradeByTimeExit(key, trade, receivedAtMs, currentPrice);
        }
      }
    }

    if (explicitHitType && symbol) {
      const matched =
        findOpenTradeByCandidateIds(candidateIdsBase) ||
        findTradeByRefId(incomingRef) ||
        findLatestOpenTradeBySymbol(symbol);

      if (matched) {
        const hitKey = buildRecentHitKey({
          symbol,
          hitType: explicitHitType,
          refId: matched.trade.refId,
          eventTime,
        });

        if (wasRecentHitSent(hitKey)) {
          console.log("DUPLICATE HIT IGNORED:", {
            symbol,
            explicitHitType,
            refId: matched.trade.refId,
            eventTime,
          });
          return;
        }

        let finalHitType = explicitHitType;
        let exitPrice = currentPrice;

        if (explicitHitType === "EXPIRED") {
          finalHitType = getTimeExitResult(
            matched.trade,
            Number.isFinite(currentPrice) ? currentPrice : matched.trade.entry
          );
          exitPrice = Number.isFinite(currentPrice) ? currentPrice : matched.trade.entry;
        }

        matched.trade.hit = true;
        matched.trade.hitType = finalHitType;
        matched.trade.hitAtMs = receivedAtMs;

        await sendHitAlert({
          trade: matched.trade,
          hitType: finalHitType,
          hitTime: receivedAtMs,
          hitPrice: exitPrice,
          chatId: CHAT_ID,
        });

        if (wasSharedToFree(matched.trade.refId)) {
          try {
            await sendHitAlert({
              trade: matched.trade,
              hitType: finalHitType,
              hitTime: receivedAtMs,
              hitPrice: exitPrice,
              chatId: FREE_CHAT_ID,
            });
          } catch (err) {
            console.error("FREE HIT SEND FAILED:", {
              refId: matched.trade.refId,
              error: err?.message || String(err),
            });
          }
        }

        await recordCloseStat({
          refId: matched.trade.refId,
          symbol: matched.trade.symbol,
          result: finalHitType,
          exitPrice,
          movePct: pctMove(matched.trade.side, matched.trade.entry, exitPrice),
          ts: receivedAtMs,
        });

        await markRecentHit(hitKey);
        await removeTrade(matched.key);

        console.log(`EXPLICIT CLOSE SENT (${matched.matchType}): ${symbol} ${finalHitType} REF ${matched.trade.refId}`);
        return;
      }

      console.log("EXPLICIT HIT RECEIVED BUT NO MATCHED TRADE FOUND:", {
        symbol,
        explicitHitType,
        incomingRef,
        candidateIdsBase,
        openTradesForSymbol: getOpenTradesForSymbol(symbol),
      });

      return;
    }

    if (symbol && Number.isFinite(currentPrice)) {
      const hitKeysToRemove = [];

      for (const [key, trade] of activeTrades.entries()) {
        if (trade.symbol !== symbol) continue;
        if (trade.hit) continue;

        const inferredHit = shouldInferHit(trade, currentPrice);
        if (!inferredHit) continue;

        const inferredHitKey = `${symbol}|${trade.refId}|${inferredHit}|${Math.floor(receivedAtMs / 60000)}`;
        if (wasRecentHitSent(inferredHitKey)) continue;

        trade.hit = true;
        trade.hitType = inferredHit;
        trade.hitAtMs = receivedAtMs;

        await sendHitAlert({
          trade,
          hitType: inferredHit,
          hitTime: receivedAtMs,
          hitPrice: currentPrice,
          chatId: CHAT_ID,
        });

        if (wasSharedToFree(trade.refId)) {
          try {
            await sendHitAlert({
              trade,
              hitType: inferredHit,
              hitTime: receivedAtMs,
              hitPrice: currentPrice,
              chatId: FREE_CHAT_ID,
            });
          } catch (err) {
            console.error("FREE INFERRED HIT SEND FAILED:", {
              refId: trade.refId,
              error: err?.message || String(err),
            });
          }
        }

        await recordCloseStat({
          refId: trade.refId,
          symbol: trade.symbol,
          result: inferredHit,
          exitPrice: currentPrice,
          movePct: pctMove(trade.side, trade.entry, currentPrice),
          ts: receivedAtMs,
        });

        await markRecentHit(inferredHitKey);
        hitKeysToRemove.push(key);

        console.log(`INFERRED HIT SENT: ${symbol} ${inferredHit} REF ${trade.refId}`);
      }

      for (const key of hitKeysToRemove) {
        await removeTrade(key);
      }
    }

    const isSignal = isLikelySignalEvent(eventType, side, entryParsed);

    if (!isSignal || !symbol || (side !== "LONG" && side !== "SHORT")) {
      console.log("NON-SIGNAL WEBHOOK RECEIVED:", {
        symbol,
        side,
        eventType,
      });
      return;
    }

    if (!validLevels) {
      console.log("SIGNAL SKIPPED BECAUSE LEVELS INVALID:", {
        symbol,
        side,
        entry: entryParsed,
        tp: tpParsed,
        sl: slParsed,
      });
      return;
    }

    if (hasOpenTradeForSymbol(symbol)) {
      console.log("SIGNAL SKIPPED BY OPEN TRADE FILTER:", {
        symbol,
        openTradesForSymbol: countOpenTradesForSymbol(symbol),
        maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
      });
      return;
    }

    if (Number.isFinite(MIN_RR_TO_SEND) && MIN_RR_TO_SEND > 0 && (!Number.isFinite(rr) || rr < MIN_RR_TO_SEND)) {
      console.log("SIGNAL SKIPPED BY MIN RR FILTER:", {
        minRequired: MIN_RR_TO_SEND,
        symbol,
        rr: fmtRR(rr),
      });
      return;
    }

    const refId = incomingRef || allocNextRef();

    const candidateIds = uniqueStrings([
      ...candidateIdsBase,
      refId,
    ]);

    const primaryAlertId = candidateIds[0] || refId;

    const chartAssets = await buildChartDeliveryAssets({
      symbol,
      side,
      refId,
      req,
      inlineBody: body,
    });

    const whyLine = buildWhyLine({
      body,
      symbol,
      side,
      setupType,
      strength,
    });

    const showChartLink = !chartAssets.imageUrl && !chartAssets.imageBuffer;

    const text = buildAlertText({
      symbol,
      side,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      rr,
      leverage,
      strength,
      prettyTime,
      whyLine,
      chartLink,
      showChartLink,
      refId,
      tpPct,
    });

    const sendResult = await sendTelegramAlert({
      text,
      imageUrl: chartAssets.imageUrl,
      imageBuffer: chartAssets.imageBuffer,
      imageFilename: chartAssets.imageFilename,
      fallbackChartLink: chartLink,
      chatId: CHAT_ID,
    });

    let sharedToFree = false;

    if (canSendFreeSignal(receivedAtMs)) {
      try {
        await sendTelegramAlert({
          text,
          imageUrl: chartAssets.imageUrl,
          imageBuffer: chartAssets.imageBuffer,
          imageFilename: chartAssets.imageFilename,
          fallbackChartLink: chartLink,
          chatId: FREE_CHAT_ID,
        });

        await markFreeSignalShared({
          refId,
          symbol,
          side,
          sharedAtMs: receivedAtMs,
        });

        sharedToFree = true;
      } catch (err) {
        console.error("FREE SIGNAL SEND FAILED:", {
          refId,
          error: err?.message || String(err),
        });
      }
    }

    const tradeKey = buildTradeKey(symbol, side, refId);

    await upsertTrade(tradeKey, {
      tradeKey,
      refId,
      symbol,
      side,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      leverage,
      createdAtMs: receivedAtMs,
      createdAtUtc: prettyTime,
      maxAgeMs: MAX_TRADE_AGE_MS,
      hit: false,
      hitType: null,
      hitAtMs: null,
      primaryAlertId,
      alertIds: candidateIds,
      setupType,
      strength,
      rr,
      chartLink,
      chartImageUrl: chartAssets.imageUrl,
      postedUtc: prettyTime,
    });

    await recordSignalStat({
      refId,
      symbol,
      side,
      strength,
      setupType,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      rr,
      sharedToFree,
      ts: receivedAtMs,
    });

    console.log(`ALERT SENT: ${symbol} ${side} REF ${refId}`);

    console.log("ALERT DATA:", {
      version: APP_VERSION,
      symbol,
      side,
      entry: fmtPrice(entryParsed),
      tp: fmtPrice(tpParsed),
      sl: fmtPrice(slParsed),
      tpPct: fmtPct(tpPct),
      rr: fmtRR(rr),
      leverage,
      strength,
      time: prettyTime,
      refId,
      primaryAlertId,
      imageUsed: sendResult.usedPhoto,
      storedForHits: true,
      activeTrades: activeTrades.size,
      eventType,
      candidateIds,
      setupType,
      freeEnabled: Boolean(FREE_CHAT_ID),
      sharedToFree,
      minRrToSend: MIN_RR_TO_SEND,
      maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
      nextRef,
    });
  } catch (err) {
    console.error("ERROR:", err);
  }
}

// ===== WEBHOOK ROUTES =====
app.post("/webhook", handleTradingViewWebhook);
app.post("/webhook/tradingview", handleTradingViewWebhook);

// ===== 404 =====
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Not found",
  });
});

// ===== START =====
async function startServer() {
  await loadState();
  await persistState();

  console.log("STATE FILE PATH:", STATE_FILE);
  console.log("DATA DIR:", DATA_DIR);

  console.log("VERSION:", APP_VERSION);

  console.log("REF SETTINGS:", {
    nextRef,
    refStartFloor: REF_START_FLOOR,
  });

  console.log("QUALITY FILTERS:", {
    minRrToSend: MIN_RR_TO_SEND,
    maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
    maxTradeAgeHours: MAX_TRADE_AGE_MS / 1000 / 60 / 60,
  });

  console.log("FREE CHANNEL:", {
    enabled: Boolean(FREE_CHAT_ID),
    freePostDate,
    freePostsToday,
    freeDailyLimit: FREE_DAILY_LIMIT,
    freeSharedRefs: freeSharedRefs.size,
    freeMembers: freeMembers.size,
  });

  console.log("PAID MEMBERS:", {
    paidMembers: paidMembers.size,
    paidChatId: PAID_TELEGRAM_CHAT_ID,
  });

  console.log("DAILY SUMMARY:", {
    enabled: DAILY_SUMMARY_ENABLED,
    utcHour: DAILY_SUMMARY_UTC_HOUR,
    utcMinute: DAILY_SUMMARY_UTC_MINUTE,
    lastSummarySentDate,
  });

  setInterval(() => {
    maybeSendDailySummary().catch((err) => {
      console.error("DAILY SUMMARY INTERVAL ERROR:", err);
    });
  }, 30 * 1000);

  app.listen(PORT, () => {
    console.log(`ALRT-Render ${APP_VERSION} running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("STARTUP ERROR:", err);
  process.exit(1);
});
function buildDailySummaryText(dateKey) {
  const stat = getDailyStat(dateKey);
  const closed = stat.tp + stat.sl + stat.timeExitProfit + stat.timeExitLoss;
  const positive = stat.tp + stat.timeExitProfit;
  const winrate = closed > 0 ? (positive / closed) * 100 : null;
  const openCount = Array.from(activeTrades.values()).filter((t) => !t.hit).length;

  const symbols = Object.entries(stat.bySymbol || {})
    .sort((a, b) => (b[1].alerts || 0) - (a[1].alerts || 0))
    .slice(0, 8)
    .map(([symbol, s]) => {
      return `${symbol}: ${s.alerts || 0} alerts | TP ${s.tp || 0} | SL ${s.sl || 0} | T+ ${s.timeExitProfit || 0} | T- ${s.timeExitLoss || 0}`;
    });

  return `📊 <b>D-ALRT DAILY OVERVIEW</b>
<b>UTC DATE</b> ${escapeHtml(dateKey)}

<b>ALERTS</b> ${stat.alerts}
<b>TP HITS</b> ${stat.tp}
<b>SL HITS</b> ${stat.sl}
<b>TIME EXIT PROFIT</b> ${stat.timeExitProfit || 0}
<b>TIME EXIT LOSS</b> ${stat.timeExitLoss || 0}
<b>EXPIRED</b> ${stat.expired || 0}
<b>WINRATE</b> ${closed > 0 ? escapeHtml(fmtPct(winrate)) : "N/A"}
<b>OPEN TRADES</b> ${openCount}

<b>FREE POSTS</b> ${stat.freeAlerts}/${FREE_DAILY_LIMIT}

${symbols.length ? `<b>BY SYMBOL</b>\n${escapeHtml(symbols.join("\n"))}` : "<b>BY SYMBOL</b>\nN/A"}

NFA`;
}

async function sendDailySummary(dateKey, force = false) {
  if (!DAILY_SUMMARY_ENABLED && !force) return false;
  if (!force && lastSummarySentDate === dateKey) return false;

  const text = buildDailySummaryText(dateKey);

  await sendTelegramMessage(text, CHAT_ID);

  if (FREE_CHAT_ID) {
    await sendTelegramMessage(text, FREE_CHAT_ID);
  }

  lastSummarySentDate = dateKey;
  await persistState();

  console.log("DAILY SUMMARY SENT:", {
    dateKey,
    force,
    lastSummarySentDate,
  });

  return true;
}

async function maybeSendDailySummary() {
  if (!DAILY_SUMMARY_ENABLED) return;

  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  if (hour !== DAILY_SUMMARY_UTC_HOUR || minute !== DAILY_SUMMARY_UTC_MINUTE) return;

  const dateKey = getUtcDateKey(Date.now());

  if (lastSummarySentDate === dateKey) return;

  await sendDailySummary(dateKey, false);
}

// ===== TIME EXIT =====
async function closeTradeByTimeExit(key, trade, nowMs, currentPrice = null) {
  const exitPrice = Number.isFinite(currentPrice) ? currentPrice : trade.entry;
  const movePct = pctMove(trade.side, trade.entry, exitPrice);
  const result = getTimeExitResult(trade, exitPrice);

  trade.hit = true;
  trade.hitType = result;
  trade.hitAtMs = nowMs;

  await sendHitAlert({
    trade,
    hitType: result,
    hitTime: nowMs,
    hitPrice: exitPrice,
    chatId: CHAT_ID,
  });

  if (wasSharedToFree(trade.refId)) {
    try {
      await sendHitAlert({
        trade,
        hitType: result,
        hitTime: nowMs,
        hitPrice: exitPrice,
        chatId: FREE_CHAT_ID,
      });
    } catch (err) {
      console.error("FREE TIME EXIT SEND FAILED:", {
        refId: trade.refId,
        error: err?.message || String(err),
      });
    }
  }

  await recordCloseStat({
    refId: trade.refId,
    symbol: trade.symbol,
    result,
    exitPrice,
    movePct,
    ts: nowMs,
  });

  await removeTrade(key);

  console.log("TIME EXIT CLOSED:", {
    symbol: trade.symbol,
    side: trade.side,
    refId: trade.refId,
    result,
    exitPrice: fmtPrice(exitPrice),
    movePct: fmtPct(movePct, { signed: true }),
  });
}

function cleanupState() {
  const now = Date.now();
  let changed = false;

  for (const [key, ts] of recentHitKeys.entries()) {
    if (!ts || now - ts > HIT_DEDUP_TTL_MS) {
      recentHitKeys.delete(key);
      changed = true;
    }
  }

  for (const [refId, info] of freeSharedRefs.entries()) {
    if (!info?.sharedAtMs || now - info.sharedAtMs > FREE_REF_TTL_MS) {
      freeSharedRefs.delete(refId);
      changed = true;
    }
  }

  const keepAfterMs = now - 10 * 24 * 60 * 60 * 1000;
  for (const [dateKey] of dailyStats.entries()) {
    const statDateMs = Date.parse(`${dateKey}T00:00:00Z`);
    if (Number.isFinite(statDateMs) && statDateMs < keepAfterMs) {
      dailyStats.delete(dateKey);
      changed = true;
    }
  }

  resetFreeCounterIfNeeded(now);

  if (changed) {
    void persistState();
  }
}

// ===== PERSISTENCE =====
async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function persistState() {
  savePromise = savePromise
    .then(async () => {
      await ensureDataDir();

      const payload = {
        updatedAt: new Date().toISOString(),
        version: APP_VERSION,
        nextRef,
        refStartFloor: REF_START_FLOOR,
        activeTrades: Array.from(activeTrades.entries()).map(([key, trade]) => [key, trade]),
        recentHitKeys: Array.from(recentHitKeys.entries()).map(([key, ts]) => [key, ts]),
        freePostDate,
        freePostsToday,
        freeSharedRefs: Array.from(freeSharedRefs.entries()).map(([refId, info]) => [refId, info]),
        dailyStats: Array.from(dailyStats.entries()).map(([dateKey, stat]) => [dateKey, stat]),
        lastSummarySentDate,
        paidMembers: Array.from(paidMembers.entries()).map(([email, info]) => [email, info]),
        freeMembers: Array.from(freeMembers.entries()).map(([email, info]) => [email, info]),
      };

      await fs.writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
    })
    .catch((err) => {
      console.error("PERSIST SAVE ERROR:", err);
    });

  return savePromise;
}

async function loadState() {
  try {
    await ensureDataDir();

    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    const active = Array.isArray(parsed?.activeTrades) ? parsed.activeTrades : [];
    const hits = Array.isArray(parsed?.recentHitKeys) ? parsed.recentHitKeys : [];
    const freeRefs = Array.isArray(parsed?.freeSharedRefs) ? parsed.freeSharedRefs : [];
    const stats = Array.isArray(parsed?.dailyStats) ? parsed.dailyStats : [];
    const now = Date.now();

    if (Number.isFinite(Number(parsed?.nextRef))) {
      nextRef = Math.min(999999, Number(parsed.nextRef));
    } else {
      nextRef = REF_START_FLOOR;
    }

    freePostDate = typeof parsed?.freePostDate === "string" ? parsed.freePostDate : getUtcDateKey(now);
    freePostsToday = Number.isFinite(Number(parsed?.freePostsToday)) ? Math.max(0, Number(parsed.freePostsToday)) : 0;
    lastSummarySentDate = typeof parsed?.lastSummarySentDate === "string" ? parsed.lastSummarySentDate : "";

    resetFreeCounterIfNeeded(now);

    for (const item of active) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [key, trade] = item;

      if (!trade || typeof trade !== "object") continue;
      if (!trade.createdAtMs) continue;
      if (trade.hit) continue;

      if (now - trade.createdAtMs > MAX_TRADE_AGE_MS) continue;

      activeTrades.set(key, trade);
    }

    for (const item of hits) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [key, ts] = item;

      if (!ts || now - ts > HIT_DEDUP_TTL_MS) continue;

      recentHitKeys.set(key, ts);
    }

    for (const item of freeRefs) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [refId, info] = item;

      if (!refId || !info?.sharedAtMs) continue;
      if (now - info.sharedAtMs > FREE_REF_TTL_MS) continue;

      freeSharedRefs.set(String(refId), info);
    }

    if (Array.isArray(parsed?.paidMembers)) {
      for (const item of parsed.paidMembers) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const [email, info] = item;
        paidMembers.set(email, info);
      }
    }

    if (Array.isArray(parsed?.members)) {
      for (const item of parsed.members) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const [email, info] = item;
        paidMembers.set(email, info);
      }
    }

    if (Array.isArray(parsed?.freeMembers)) {
      for (const item of parsed.freeMembers) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const [email, info] = item;
        freeMembers.set(email, info);
      }
    }

    for (const item of stats) {
      if (!Array.isArray(item) || item.length !== 2) continue;

      const [dateKey, stat] = item;
      if (!dateKey || !stat || typeof stat !== "object") continue;

      dailyStats.set(String(dateKey), stat);
    }

    getDailyStat(getUtcDateKey(now));

    console.log(`Loaded ${activeTrades.size} active trades from disk`);
    console.log(`Loaded ${recentHitKeys.size} recent hit keys from disk`);
    console.log(`Loaded ${freeSharedRefs.size} free shared refs from disk`);
    console.log(`Loaded ${dailyStats.size} daily stat days from disk`);
    console.log(`Loaded ${paidMembers.size} paid members from disk`);
    console.log(`Loaded ${freeMembers.size} free members from disk`);
    console.log(`Loaded nextRef ${nextRef}`);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("No state.json found yet, starting clean");
      freePostDate = getUtcDateKey(Date.now());
      freePostsToday = 0;
      lastSummarySentDate = "";
      nextRef = Math.max(REF_START_FLOOR, 100000);
      getDailyStat(freePostDate);
      return;
    }

    console.error("PERSIST LOAD ERROR:", err);
  }
}

async function removeTrade(tradeKey) {
  if (activeTrades.delete(tradeKey)) {
    await persistState();
  }
}

async function upsertTrade(tradeKey, trade) {
  activeTrades.set(tradeKey, trade);
  await persistState();
}

// ===== CHART RENDER =====
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

// ===== TELEGRAM =====
async function sendTelegramMessage(text, chatId = CHAT_ID) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const data = await response.json();

  console.log("TELEGRAM MESSAGE RESPONSE:", {
    chatId,
    data,
  });

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendMessage failed: ${JSON.stringify(data)}`);
  }
}

async function sendTelegramPhoto({
  photoUrl = null,
  photoBuffer = null,
  filename = "chart.png",
  caption = "",
  chatId = CHAT_ID,
}) {
  let response;
  let data;

  if (photoBuffer) {
    const form = new FormData();

    form.append("chat_id", chatId);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append("photo", new Blob([photoBuffer], { type: "image/png" }), filename);

    response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      body: form,
    });
  } else {
    response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption,
        parse_mode: "HTML",
      }),
    });
  }

  data = await response.json();

  console.log("TELEGRAM PHOTO RESPONSE:", {
    chatId,
    data,
  });

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendPhoto failed: ${JSON.stringify(data)}`);
  }
}

async function sendTelegramAlert({
  text,
  imageUrl = null,
  imageBuffer = null,
  imageFilename = "chart.png",
  fallbackChartLink = "N/A",
  chatId = CHAT_ID,
}) {
  if (imageBuffer || imageUrl) {
    try {
      await sendTelegramPhoto({
        photoUrl: imageUrl,
        photoBuffer: imageBuffer,
        filename: imageFilename,
        caption: text,
        chatId,
      });

      return { usedPhoto: true };
    } catch (err) {
      console.error("PHOTO SEND FAILED, FALLING BACK TO MESSAGE:", err.message);

      const fallbackText = appendChartLinkIfMissing(text, fallbackChartLink);
      await sendTelegramMessage(fallbackText, chatId);

      return { usedPhoto: false, photoFailed: true };
    }
  }

  const fallbackText = appendChartLinkIfMissing(text, fallbackChartLink);
  await sendTelegramMessage(fallbackText, chatId);

  return { usedPhoto: false };
}

async function buildChartDeliveryAssets({
  symbol,
  side,
  refId,
  req = null,
  inlineBody = null,
}) {
  const imageUrl = resolveChartImageUrl(inlineBody || {}, symbol, side, refId, req);

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

async function sendHitAlert({
  trade,
  hitType,
  hitTime,
  hitPrice = null,
  chatId = CHAT_ID,
}) {
  const exitPrice =
    hitType === "TP"
      ? trade.tp
      : hitType === "SL"
      ? trade.sl
      : Number.isFinite(parseNum(hitPrice))
      ? parseNum(hitPrice)
      : trade.entry;

  const movePct = pctMove(trade.side, trade.entry, exitPrice);
  const chartLink = trade.chartLink || resolveChartLink(trade.symbol);

  const chartAssets = await buildChartDeliveryAssets({
    symbol: trade.symbol,
    side: trade.side,
    refId: trade.refId,
    inlineBody: {
      chart_image_url: trade.chartImageUrl,
    },
  });

  const showChartLink = !chartAssets.imageUrl && !chartAssets.imageBuffer;

  const hitText = buildHitText({
    trade,
    hitType,
    exitPrice,
    movePct,
    chartLink,
    showChartLink,
  });

  await sendTelegramAlert({
    text: hitText,
    imageUrl: chartAssets.imageUrl,
    imageBuffer: chartAssets.imageBuffer,
    imageFilename: chartAssets.imageFilename,
    fallbackChartLink: chartLink,
    chatId,
  });
}

// ===== ROUTES =====
app.get("/chart-template", async (req, res) => {
  try {
    const templatePath = path.join(__dirname, "chart-template.html");
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

    const png = await renderChartImagePngBuffer({
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

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "ALRT-Render",
    version: APP_VERSION,
  });
});

app.get("/health", (req, res) => {
  resetFreeCounterIfNeeded(Date.now());

  res.status(200).json({
    ok: true,
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    dataDir: DATA_DIR,
    stateFile: STATE_FILE,
    activeTrades: activeTrades.size,
    recentHitKeys: recentHitKeys.size,
    nextRef,
    refStartFloor: REF_START_FLOOR,
    maxTradeAgeHours: MAX_TRADE_AGE_MS / 1000 / 60 / 60,
    minRrToSend: MIN_RR_TO_SEND,
    maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
    freeEnabled: Boolean(FREE_CHAT_ID),
    freePostDate,
    freePostsToday,
    freeDailyLimit: FREE_DAILY_LIMIT,
    freeSharedRefs: freeSharedRefs.size,
    dailyStatsDays: dailyStats.size,
    lastSummarySentDate,
    dailySummaryEnabled: DAILY_SUMMARY_ENABLED,
    dailySummaryUtcHour: DAILY_SUMMARY_UTC_HOUR,
    dailySummaryUtcMinute: DAILY_SUMMARY_UTC_MINUTE,
    paidMembers: paidMembers.size,
    freeMembers: freeMembers.size,
  });
});

app.post("/summary/send-now", async (req, res) => {
  const token = String(req.query.token || req.headers["x-summary-token"] || "");
  const expected = String(process.env.SUMMARY_ADMIN_TOKEN || "");

  if (!expected || token !== expected) {
    return res.status(403).json({
      ok: false,
      error: "manual summary disabled",
    });
  }

  res.status(200).json({ ok: true, message: "summary send requested" });

  try {
    const dateKey = getUtcDateKey(Date.now());
    await sendDailySummary(dateKey, true);
  } catch (err) {
    console.error("MANUAL SUMMARY ERROR:", err);
  }
});

app.post("/signup/free", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        ok: false,
        error: "valid email required",
      });
    }

    const existing = freeMembers.get(email);

    if (existing?.inviteLink) {
      return res.status(200).json({
        ok: true,
        email,
        inviteLink: existing.inviteLink,
        existing: true,
      });
    }

    const inviteLink = await createFreeTelegramInviteLink({ expireHours: 48 });

    freeMembers.set(email, {
      email,
      status: "free",
      active: true,
      inviteLink,
      inviteCreatedAt: new Date().toISOString(),
      inviteExpireHours: 48,
      telegramUserId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await persistState();

    await sendTelegramMessage(
`🆓 <b>NEW FREE MEMBER</b>

<b>Email</b> ${escapeHtml(email)}

<b>Free Invite</b>
${inviteLink}`
    );

    return res.status(200).json({
      ok: true,
      email,
      inviteLink,
    });
  } catch (err) {
    console.error("FREE SIGNUP ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "free signup failed",
    });
  }
});

app.get("/admin/members", async (req, res) => {
  const token = String(req.query.token || "");
  const expected = String(process.env.SUMMARY_ADMIN_TOKEN || "");

  if (!expected || token !== expected) {
    return res.status(403).json({
      ok: false,
      error: "forbidden",
    });
  }

  res.status(200).json({
    ok: true,
    paidCount: paidMembers.size,
    freeCount: freeMembers.size,
    paidMembers: Array.from(paidMembers.values()),
    freeMembers: Array.from(freeMembers.values()),
  });
});

// ===== WEBHOOK HANDLER =====
async function handleTradingViewWebhook(req, res) {
  const body = req.body || {};
  const receivedAtMs = Date.now();
  const prettyTime = formatUtc(receivedAtMs);

  res.status(200).json({ ok: true });

  try {
    cleanupState();

    const symbol = normalizeSymbol(
      pick(body.symbol, body.ticker, body.pair, body.coin, body.market, "")
    );

    const side = normalizeSide(
      pick(body.side, body.direction, body.position, body.trade_side, body.action, "")
    );

    const entryRaw = pick(
      body.entry,
      body.entry_price,
      body.entryPrice,
      body.price,
      body.Entry,
      body.close
    );

    const tpRaw = pick(
      body.tp1,
      body.tp,
      body.take_profit,
      body.takeProfit,
      body.tp_price,
      body.target,
      body.target_price,
      body.TP,
      body.tpPrice
    );

    const slRaw = pick(
      body.sl,
      body.stop_loss,
      body.stop,
      body.stopLoss,
      body.sl_price,
      body.stop_price,
      body.SL,
      body.slPrice
    );

    const rsi = pick(body.rsi, body.rsi_value);
    const atrPct = pick(body.atr_pct, body.atrPercent, body.atr_percent);
    const score = pick(body.score, body.strength_score, body.setup_score);
    const risk = pick(body.risk, body.risk_score);
    const incomingStrength = pick(body.strength, body.grade, body.quality);

    const eventTime = pick(
      body.time_close,
      body.bar_close_time,
      body.timestamp,
      body.time,
      receivedAtMs
    );

    const eventTimeMs = eventTimeToMs(eventTime);

    const eventType = pick(
      body.event,
      body.type,
      body.event_type,
      body.kind,
      body.signal_type,
      ""
    );

    const currentPrice = parseNum(
      pick(body.hit_price, body.last_price, body.market_price, body.price, body.close, body.last)
    );

    const setupType = deriveSetupType({
      body,
      side,
      rsi,
      atrPct,
    });

    const strength = getStrengthBucket({
      symbol,
      side,
      rsi,
      atrPct,
      score,
      risk,
      incomingStrength,
    });

    const leverage = resolveLeverage(body, symbol, strength);

    const entryParsed = parseNum(entryRaw);
    let tpParsed = parseNum(tpRaw);
    let slParsed = parseNum(slRaw);

    const validIncomingLevels = hasValidTradeLevels(side, entryParsed, tpParsed, slParsed);

    if (!validIncomingLevels && Number.isFinite(entryParsed) && (side === "LONG" || side === "SHORT")) {
      const derived = applyFallbackLevels(side, entryParsed, strength, symbol);
      tpParsed = derived.tp;
      slParsed = derived.sl;
    }

    const validLevels = hasValidTradeLevels(side, entryParsed, tpParsed, slParsed);
    const rr = rrFromLevels(side, entryParsed, tpParsed, slParsed);
    const tpPct = tpPctFromLevels(side, entryParsed, tpParsed);

    const incomingRef = parseIncomingRef(body);
    const explicitHitType = detectExplicitHitType(eventType, body);

    const candidateIdsBase = collectAllCandidateIds({
      body,
      symbol,
      side,
      eventTimeMs,
      refId: incomingRef || "",
    });

    if (!BOT_TOKEN || !CHAT_ID) {
      console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
      return;
    }

    const chartLink = resolveChartLink(symbol);

    console.log("WEBHOOK RECEIVED:", {
      version: APP_VERSION,
      symbol,
      side,
      eventType,
      entry: fmtPrice(entryParsed),
      tp: fmtPrice(tpParsed),
      sl: fmtPrice(slParsed),
      rr: fmtRR(rr),
      strength,
      currentPrice: fmtPrice(currentPrice),
      activeTrades: activeTrades.size,
      nextRef,
    });

    if (symbol) {
      for (const [key, trade] of Array.from(activeTrades.entries())) {
        if (trade.symbol !== symbol) continue;
        if (trade.hit) continue;

        const ageMs = receivedAtMs - (trade.createdAtMs || receivedAtMs);

        if (ageMs >= MAX_TRADE_AGE_MS) {
          await closeTradeByTimeExit(key, trade, receivedAtMs, currentPrice);
        }
      }
    }

    if (explicitHitType && symbol) {
      const matched =
        findOpenTradeByCandidateIds(candidateIdsBase) ||
        findTradeByRefId(incomingRef) ||
        findLatestOpenTradeBySymbol(symbol);

      if (matched) {
        const hitKey = buildRecentHitKey({
          symbol,
          hitType: explicitHitType,
          refId: matched.trade.refId,
          eventTime,
        });

        if (wasRecentHitSent(hitKey)) {
          console.log("DUPLICATE HIT IGNORED:", {
            symbol,
            explicitHitType,
            refId: matched.trade.refId,
            eventTime,
          });
          return;
        }

        let finalHitType = explicitHitType;
        let exitPrice = currentPrice;

        if (explicitHitType === "EXPIRED") {
          finalHitType = getTimeExitResult(
            matched.trade,
            Number.isFinite(currentPrice) ? currentPrice : matched.trade.entry
          );
          exitPrice = Number.isFinite(currentPrice) ? currentPrice : matched.trade.entry;
        }

        matched.trade.hit = true;
        matched.trade.hitType = finalHitType;
        matched.trade.hitAtMs = receivedAtMs;

        await sendHitAlert({
          trade: matched.trade,
          hitType: finalHitType,
          hitTime: receivedAtMs,
          hitPrice: exitPrice,
          chatId: CHAT_ID,
        });

        if (wasSharedToFree(matched.trade.refId)) {
          try {
            await sendHitAlert({
              trade: matched.trade,
              hitType: finalHitType,
              hitTime: receivedAtMs,
              hitPrice: exitPrice,
              chatId: FREE_CHAT_ID,
            });
          } catch (err) {
            console.error("FREE HIT SEND FAILED:", {
              refId: matched.trade.refId,
              error: err?.message || String(err),
            });
          }
        }

        await recordCloseStat({
          refId: matched.trade.refId,
          symbol: matched.trade.symbol,
          result: finalHitType,
          exitPrice,
          movePct: pctMove(matched.trade.side, matched.trade.entry, exitPrice),
          ts: receivedAtMs,
        });

        await markRecentHit(hitKey);
        await removeTrade(matched.key);

        console.log(`EXPLICIT CLOSE SENT (${matched.matchType}): ${symbol} ${finalHitType} REF ${matched.trade.refId}`);
        return;
      }

      console.log("EXPLICIT HIT RECEIVED BUT NO MATCHED TRADE FOUND:", {
        symbol,
        explicitHitType,
        incomingRef,
        candidateIdsBase,
        openTradesForSymbol: getOpenTradesForSymbol(symbol),
      });

      return;
    }

    if (symbol && Number.isFinite(currentPrice)) {
      const hitKeysToRemove = [];

      for (const [key, trade] of activeTrades.entries()) {
        if (trade.symbol !== symbol) continue;
        if (trade.hit) continue;

        const inferredHit = shouldInferHit(trade, currentPrice);
        if (!inferredHit) continue;

        const inferredHitKey = `${symbol}|${trade.refId}|${inferredHit}|${Math.floor(receivedAtMs / 60000)}`;
        if (wasRecentHitSent(inferredHitKey)) continue;

        trade.hit = true;
        trade.hitType = inferredHit;
        trade.hitAtMs = receivedAtMs;

        await sendHitAlert({
          trade,
          hitType: inferredHit,
          hitTime: receivedAtMs,
          hitPrice: currentPrice,
          chatId: CHAT_ID,
        });

        if (wasSharedToFree(trade.refId)) {
          try {
            await sendHitAlert({
              trade,
              hitType: inferredHit,
              hitTime: receivedAtMs,
              hitPrice: currentPrice,
              chatId: FREE_CHAT_ID,
            });
          } catch (err) {
            console.error("FREE INFERRED HIT SEND FAILED:", {
              refId: trade.refId,
              error: err?.message || String(err),
            });
          }
        }

        await recordCloseStat({
          refId: trade.refId,
          symbol: trade.symbol,
          result: inferredHit,
          exitPrice: currentPrice,
          movePct: pctMove(trade.side, trade.entry, currentPrice),
          ts: receivedAtMs,
        });

        await markRecentHit(inferredHitKey);
        hitKeysToRemove.push(key);

        console.log(`INFERRED HIT SENT: ${symbol} ${inferredHit} REF ${trade.refId}`);
      }

      for (const key of hitKeysToRemove) {
        await removeTrade(key);
      }
    }

    const isSignal = isLikelySignalEvent(eventType, side, entryParsed);

    if (!isSignal || !symbol || (side !== "LONG" && side !== "SHORT")) {
      console.log("NON-SIGNAL WEBHOOK RECEIVED:", {
        symbol,
        side,
        eventType,
      });
      return;
    }

    if (!validLevels) {
      console.log("SIGNAL SKIPPED BECAUSE LEVELS INVALID:", {
        symbol,
        side,
        entry: entryParsed,
        tp: tpParsed,
        sl: slParsed,
      });
      return;
    }

    if (hasOpenTradeForSymbol(symbol)) {
      console.log("SIGNAL SKIPPED BY OPEN TRADE FILTER:", {
        symbol,
        openTradesForSymbol: countOpenTradesForSymbol(symbol),
        maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
      });
      return;
    }

    if (Number.isFinite(MIN_RR_TO_SEND) && MIN_RR_TO_SEND > 0 && (!Number.isFinite(rr) || rr < MIN_RR_TO_SEND)) {
      console.log("SIGNAL SKIPPED BY MIN RR FILTER:", {
        minRequired: MIN_RR_TO_SEND,
        symbol,
        rr: fmtRR(rr),
      });
      return;
    }

    const refId = incomingRef || allocNextRef();

    const candidateIds = uniqueStrings([
      ...candidateIdsBase,
      refId,
    ]);

    const primaryAlertId = candidateIds[0] || refId;

    const chartAssets = await buildChartDeliveryAssets({
      symbol,
      side,
      refId,
      req,
      inlineBody: body,
    });

    const whyLine = buildWhyLine({
      body,
      symbol,
      side,
      setupType,
      strength,
    });

    const showChartLink = !chartAssets.imageUrl && !chartAssets.imageBuffer;

    const text = buildAlertText({
      symbol,
      side,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      rr,
      leverage,
      strength,
      prettyTime,
      whyLine,
      chartLink,
      showChartLink,
      refId,
      tpPct,
    });

    const sendResult = await sendTelegramAlert({
      text,
      imageUrl: chartAssets.imageUrl,
      imageBuffer: chartAssets.imageBuffer,
      imageFilename: chartAssets.imageFilename,
      fallbackChartLink: chartLink,
      chatId: CHAT_ID,
    });

    let sharedToFree = false;

    if (canSendFreeSignal(receivedAtMs)) {
      try {
        await sendTelegramAlert({
          text,
          imageUrl: chartAssets.imageUrl,
          imageBuffer: chartAssets.imageBuffer,
          imageFilename: chartAssets.imageFilename,
          fallbackChartLink: chartLink,
          chatId: FREE_CHAT_ID,
        });

        await markFreeSignalShared({
          refId,
          symbol,
          side,
          sharedAtMs: receivedAtMs,
        });

        sharedToFree = true;
      } catch (err) {
        console.error("FREE SIGNAL SEND FAILED:", {
          refId,
          error: err?.message || String(err),
        });
      }
    }

    const tradeKey = buildTradeKey(symbol, side, refId);

    await upsertTrade(tradeKey, {
      tradeKey,
      refId,
      symbol,
      side,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      leverage,
      createdAtMs: receivedAtMs,
      createdAtUtc: prettyTime,
      maxAgeMs: MAX_TRADE_AGE_MS,
      hit: false,
      hitType: null,
      hitAtMs: null,
      primaryAlertId,
      alertIds: candidateIds,
      setupType,
      strength,
      rr,
      chartLink,
      chartImageUrl: chartAssets.imageUrl,
      postedUtc: prettyTime,
    });

    await recordSignalStat({
      refId,
      symbol,
      side,
      strength,
      setupType,
      entry: entryParsed,
      tp: tpParsed,
      sl: slParsed,
      rr,
      sharedToFree,
      ts: receivedAtMs,
    });

    console.log(`ALERT SENT: ${symbol} ${side} REF ${refId}`);

    console.log("ALERT DATA:", {
      version: APP_VERSION,
      symbol,
      side,
      entry: fmtPrice(entryParsed),
      tp: fmtPrice(tpParsed),
      sl: fmtPrice(slParsed),
      tpPct: fmtPct(tpPct),
      rr: fmtRR(rr),
      leverage,
      strength,
      time: prettyTime,
      refId,
      primaryAlertId,
      imageUsed: sendResult.usedPhoto,
      storedForHits: true,
      activeTrades: activeTrades.size,
      eventType,
      candidateIds,
      setupType,
      freeEnabled: Boolean(FREE_CHAT_ID),
      sharedToFree,
      minRrToSend: MIN_RR_TO_SEND,
      maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
      nextRef,
    });
  } catch (err) {
    console.error("ERROR:", err);
  }
}

// ===== WEBHOOK ROUTES =====
app.post("/webhook", handleTradingViewWebhook);
app.post("/webhook/tradingview", handleTradingViewWebhook);

// ===== 404 =====
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Not found",
  });
});

// ===== START =====
async function startServer() {
  await loadState();
  await persistState();

  console.log("STATE FILE PATH:", STATE_FILE);
  console.log("DATA DIR:", DATA_DIR);

  console.log("VERSION:", APP_VERSION);

  console.log("REF SETTINGS:", {
    nextRef,
    refStartFloor: REF_START_FLOOR,
  });

  console.log("QUALITY FILTERS:", {
    minRrToSend: MIN_RR_TO_SEND,
    maxOpenTradesPerSymbol: MAX_OPEN_TRADES_PER_SYMBOL,
    maxTradeAgeHours: MAX_TRADE_AGE_MS / 1000 / 60 / 60,
  });

  console.log("FREE CHANNEL:", {
    enabled: Boolean(FREE_CHAT_ID),
    freePostDate,
    freePostsToday,
    freeDailyLimit: FREE_DAILY_LIMIT,
    freeSharedRefs: freeSharedRefs.size,
    freeMembers: freeMembers.size,
  });

  console.log("PAID MEMBERS:", {
    paidMembers: paidMembers.size,
    paidChatId: PAID_TELEGRAM_CHAT_ID,
  });

  console.log("DAILY SUMMARY:", {
    enabled: DAILY_SUMMARY_ENABLED,
    utcHour: DAILY_SUMMARY_UTC_HOUR,
    utcMinute: DAILY_SUMMARY_UTC_MINUTE,
    lastSummarySentDate,
  });

  setInterval(() => {
    maybeSendDailySummary().catch((err) => {
      console.error("DAILY SUMMARY INTERVAL ERROR:", err);
    });
  }, 30 * 1000);

  app.listen(PORT, () => {
    console.log(`ALRT-Render ${APP_VERSION} running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("STARTUP ERROR:", err);
  process.exit(1);
});
