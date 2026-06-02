# ALRT Production Setup

This is the fixed direction for D-ALRT / ALRT-Render.

## Core Decision

The system must not depend on Pine being a perfect final alert engine.

Pine detects market events. Render decides whether the event becomes a paid/free Telegram alert.

That means:

- Pine sends `candidate`, `tp_hit`, `sl_hit`, `time_exit_profit`, `time_exit_loss`, and `expired`.
- Render validates symbol, levels, RR, duplicate active trades, quality score, REF, Telegram, free/paid routing, state, and summaries.
- Render records rejected candidates, so silence is measurable.

## Stable Flow

1. TradingView runs `ALRT-Next v30 STABLE CORE EVENT ENGINE` on 15M charts.
2. Pine uses 1H context but does not block hard 15M breakdown/breakout events just because the move is already strong.
3. Pine sends a `candidate` payload with entry, TP, SL, RR, setup type, score, RSI, ATR, ADX, session, and market regime.
4. Render accepts or rejects the candidate.
5. Accepted candidates become Telegram alerts with REF, UTC, entry, TP, SL, RR, setup, grade, WHY, context, and chart fallback.
6. Active trades remain in state until TP, SL, time exit, expired, or manual close.
7. Daily summaries separate:
   - today's trades opened and closed today,
   - today's trades still open,
   - old trades closed today,
   - orphan/unmatched closes,
   - rejected candidates.

## Why This Fixes The Current Failure

The v27-v29 approach put too much final filtering in Pine. When filters were too strict, TradingView generated no alert log at all. That made the system blind.

The v30 approach makes Pine less fragile and makes Render responsible for professional filtering. If there are no published alerts, the daily summary and logs can now show whether:

- Pine sent nothing,
- Render rejected candidates,
- a symbol was blocked,
- RR was too low,
- levels were invalid,
- a trade was already open,
- quality score was too low.

## Symbol Policy

Start production with core symbols only:

- BTCUSDT
- ETHUSDT
- SOLUSDT
- BNBUSDT
- XRPUSDT
- LINKUSDT

Satellite symbols can be tested later:

- AVAXUSDT
- ADAUSDT
- DOGEUSDT
- LTCUSDT
- OPUSDT
- ARBUSDT
- ATOMUSDT

SHIBUSDT stays disabled.

## Backend Rules

Render remains the source of truth for:

- REF allocation
- REF floor safety
- active trade state
- TP/SL/time exit matching
- duplicate prevention
- free/paid channel routing
- Stripe members
- Telegram invite links
- chart fallback
- daily summaries
- reject statistics

## Pine Rules

Pine should not:

- hide SL from payloads,
- invent REF numbers,
- decide free vs paid,
- reset lifecycle state outside its own chart,
- over-filter so hard that market events vanish.

Pine should:

- run on 15M,
- use 1H context,
- alert once per confirmed bar close,
- send entry/TP/SL/RR every time,
- keep one active chart trade until TP/SL/time exit,
- send explicit close events.

## Required TradingView Alert Setup

For every active symbol:

- Condition: `ALRT-Next v30 STABLE CORE EVENT ENGINE`
- Option: `Any alert() function call`
- Frequency: `Once per bar close`
- Message: empty / None
- Staging webhook: `https://alrt-render-staging.onrender.com/webhook`
- Live webhook: `https://alrt-render.onrender.com/webhook/tradingview`

Old alerts must be deleted after replacing Pine. TradingView stores script snapshots.

## Production Safety

Do not switch paid live traffic straight to new logic without staging validation.

Recommended order:

1. Deploy backend `v25.5.0-candidate-diagnostics` to staging.
2. Put Pine v30 on core staging symbols only.
3. Confirm TradingView logs show candidates during active market movement.
4. Confirm Render logs show accepted/rejected candidates.
5. Confirm Telegram shows accepted alerts with REF, UTC, SL.
6. Confirm TP/SL closes match active trades.
7. Run daily summary manually once.
8. Only then merge/deploy live.

## Do Not Touch Yet

Do not rewrite Stripe, Telegram invite links, member storage, chart rendering, or daily summary scheduling while fixing alert generation. Those features already work and should stay isolated.
