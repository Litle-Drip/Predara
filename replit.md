# Predara — Prediction Market Analyzer

## Overview
Node.js web app that analyzes Kalshi and Polymarket prediction markets. Users paste a market URL and get a full breakdown of what they're betting on, resolution rules in plain English, a bet calculator, odds, volume, liquidity, and trader analytics.

## Architecture
- **server.js** — HTTP server on port 5000 / 0.0.0.0. Proxies API calls to Kalshi (authenticated via RSA-signed JWT) and Polymarket (public gamma API). Serves static files.
- **app.js** — Client-side rendering. Detects platform from URL, fetches data via `/api/kalshi` or `/api/polymarket`, renders: "WHAT'S THE BET?" explainer, outcomes, bet simulator, resolution rules, timeline, trader analytics, glossary tooltips, and volume stats.
- **index.html** — Single-page app shell with all CSS inline.
- **api/kalshi.js**, **api/polymarket.js** — Vercel serverless functions for predara.org production. **DO NOT MODIFY** these files.

## Page Layout Order (beginner-first)
1. Event title + urgency banner
2. "WHAT'S THE BET?" card — plain-English explanation of what you're betting on
3. Outcomes & probability
4. Bet calculator — interactive "$X bet → win $Y / lose $X" simulator
5. "HOW IT RESOLVES" — resolution rules in plain English (contract jargon removed)
6. Timeline
7. Trader Analytics (EV, Kelly, Break-even, Spread)
8. Volume/Liquidity stats

## Key Features
- **"WHAT'S THE BET?" card**: Derives a plain-English summary from rules_primary (Kalshi) or market.description (Polymarket). Binary markets get "You win if..." / "You lose if...". Multi-outcome markets get "Pick which outcome you think will happen."
- **Bet Calculator**: `betSimulatorHtml(pct)` renders an interactive input. `updateBetSim()` recalculates in real-time via `window._betSimPct`.
- **Plain English Rules**: `plainEnglishRules(text)` rewrites contract language — "the market resolves to Yes" → "you win", strips boilerplate, removes legal disclaimers.
- **Polymarket Resolution Data**: Extracts `market.description`, `market.question`, and `market.resolutionSource` from individual markets (previously unused).
- **Kalshi**: Bid/ask spread per outcome, per-outcome volume & OI (multi-outcome), resolution criteria, mutually exclusive badge, early close condition text, price delta vs previous close, moneyline odds
- **Polymarket**: Topic tags, comment count, bid/ask spread, volume, liquidity, resolution source link
- **Trader Analytics** (both platforms): Break-even %, Expected Value %, Kelly Criterion %, Spread Quality %
- **Urgency Banner**: Time remaining until market close, color-coded (muted >7d, amber 1-7d, red <24h)
- **Glossary Tooltips**: Hover any stat label to see a plain-English definition

## Important Conventions
- `volume_fp` and `open_interest_fp` are in **cents** (divide by 100 for dollars)
- `volume_24h_fp` is cents; `volume_24h` is already dollars — prefer `_fp/100`, fall back to raw
- Multi-outcome detection: `markets.length > 2`
- PEM key normalization in server.js handles any secret storage format
- Outcome rows are paginated 10-at-a-time via `buildOutcomesHtml`/`window._outcomePages`
- `tip(text, key)` wraps jargon in a tooltip span using the GLOSSARY map
- `calcAnalyticsRow(label, prob, ask, bid)` computes EV/Kelly/spread/break-even for one outcome
- `analyticsCard(rows, timeLeft)` renders the TRADER ANALYTICS card
- `plainEnglishRules(text)` strips legal language from contract rules
- `whatsTheBetCard(text)` renders the "WHAT'S THE BET?" explainer card
- `betSimulatorHtml(pct, platform)` renders bet calculator; `updateBetSim()` handles live updates

## Secrets
- `KALSHI_API_KEY_ID` — Kalshi API key member ID
- `KALSHI_PRIVATE_KEY` — RSA private key for JWT signing

## Deployment
- Replit: `node server.js` on port 5000 (autoscale deployment configured)
- Vercel: Uses `api/` serverless functions (separate deployment, do not modify)
